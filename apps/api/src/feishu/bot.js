import * as lark from '@larksuiteoapi/node-sdk';
import { ratings } from '../domain/scheduler.js';
import { addDays, todayKey } from '../domain/date.js';
import { ArkStudyAgent } from '../ark/agent.js';
import { FeedbackService } from '../feedback-service.js';
import { completionReportFrom, deterministicConversationReply, deterministicNaturalIntent, routeActiveMessage } from '../agent/router.js';
import {
  answerIntentCard,
  answerSavedCard,
  completionHistoryCard,
  completionRecordedCard,
  completionVoidedCard,
  helpCard,
  infoCard,
  modelFeedbackCard,
  ratingCompleteCard,
  sessionCancelledCard,
  taskPromptCard,
  taskSuggestionCard,
  todayPlanCard,
  weaknessCard
} from './cards.js';
import { FeishuSessionStore } from './session-store.js';
import { createGroupConversation } from './group-conversation.js';
import { SourcePhotoService } from '../knowledge/source-service.js';
import { SourcePhotoModel } from '../knowledge/source-model.js';
import { SourcePhotoVerifier } from '../knowledge/source-verifier.js';
import { ClarificationService } from '../knowledge/clarifications.js';
import { feishuIdentityConfig, identifySender, canReceivePrivate, identityDescription } from '../agent/identity.js';
import { ReviewReminders } from './reminders.js';

const validRatings = new Set(ratings);
const GROUP_TEST_POLL_MS = 5_000;
const GROUP_TEST_MAX_RETRY_MS = 60_000;
const GROUP_TEST_PROMPT = '羊羊，今天的学习情况怎么样？请告诉我：今天完成了什么、哪里卡住了、接下来准备做哪一步。';

function enabled(value) {
  return ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());
}

function optionalText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function validGroupChatId(value) {
  return /^oc_[A-Za-z0-9]+$/.test(value ?? '');
}

function validOpenId(value) {
  return /^ou_[A-Za-z0-9]+$/.test(value ?? '');
}

function readConfig() {
  const testGroupId = optionalText(process.env.FEISHU_TEST_GROUP_ID);
  const groupTargetOpenId = optionalText(process.env.FEISHU_GROUP_TARGET_OPEN_ID);
  const groupTestRequested = enabled(process.env.FEISHU_GROUP_TEST_ENABLED);
  let groupTestConfigurationError = null;
  if (groupTestRequested && !validGroupChatId(testGroupId)) {
    groupTestConfigurationError = 'FEISHU_GROUP_TEST_ENABLED is set, but FEISHU_TEST_GROUP_ID is not a valid oc_ chat ID; group test remains disabled.';
  } else if (groupTestRequested && !validOpenId(groupTargetOpenId)) {
    groupTestConfigurationError = 'FEISHU_GROUP_TEST_ENABLED is set, but FEISHU_GROUP_TARGET_OPEN_ID is not a valid ou_ open ID; group test remains disabled.';
  }
  return {
    ...feishuIdentityConfig(),
    enabled: enabled(process.env.FEISHU_ENABLED),
    appId: process.env.FEISHU_APP_ID?.trim(),
    appSecret: process.env.FEISHU_APP_SECRET?.trim(),
    testerOpenId: optionalText(process.env.FEISHU_TESTER_OPEN_ID),
    testGroupId,
    groupChatEnabled: enabled(process.env.FEISHU_GROUP_CHAT_ENABLED) && validGroupChatId(testGroupId),
    groupTargetOpenId,
    groupTestEnabled: groupTestRequested && !groupTestConfigurationError,
    groupTestConfigurationError
  };
}

function commandFrom(content) {
  const value = content.trim();
  const commands = new Map([
    ['/今日', 'today'], ['今日', 'today'],
    ['/薄弱', 'weaknesses'], ['薄弱', 'weaknesses'],
    ['/进度', 'progress'], ['进度', 'progress'],
    ['/记录', 'completions'], ['最近完成', 'completions'],
    ['/帮助', 'help'], ['帮助', 'help'],
    ['/取消', 'cancel'], ['取消', 'cancel'],
    ['/继续', 'continue'], ['继续', 'continue']
  ]);
  return commands.get(value) ?? null;
}

function parseStartCommand(content) {
  const match = content.trim().match(/^\/(?:开始|开始复习)\s+([1-9]\d{0,3})$/);
  return match ? Number(match[1]) : null;
}

function actionValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value.action === 'string' ? value : null;
}

function statusMessage(session) {
  if (!session) return '可以直接问我“今天学什么”，或输入 `/今日` 查看任务。';
  if (session.status === 'awaiting_answer') return '请发送答案；想明确区分时，可用 `答案：……` 或 `问：……`。';
  if (session.status === 'answer_saving') return '答案正在保存，请稍候，不要重复发送。';
  if (session.status === 'awaiting_rating') return '答案已经保存。请完成四档自评，或输入 `/继续` 重新打开自评卡。';
  if (session.status === 'rating_saving') return '自评正在保存，请稍候。';
  return '这张卡片已经处理过，不会重复计分。';
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'unknown_error';
}

function feedbackText(result) {
  const nested = result?.feedback?.feedback ?? result?.job?.answerFeedback?.feedback;
  if (typeof nested === 'string') return nested;
  return typeof result?.feedback === 'string' ? result.feedback : '';
}

async function updateOrSend(channel, event, card, logger) {
  try {
    await channel.updateCard(event.messageId, card);
  } catch (error) {
    logger.warn('Unable to update Feishu card; sending a replacement card instead.', error.message);
    await channel.send(event.chatId, { card });
  }
}

/** Starts the single-user study agent, optionally arming one narrow group check-in test. */
export async function startFeishuBot({
  studyService,
  repository,
  feedbackService = null,
  modelProvider = null,
  sourcePhotoService = null,
  studyAgent = null,
  channelFactory = lark.createLarkChannel,
  logger = console,
  groupPollIntervalMs = GROUP_TEST_POLL_MS
}) {
  const config = readConfig();
  if (!config.enabled) return { status: 'disabled' };
  if (!config.appId || !config.appSecret || (config.dmMode === 'allowlist' && !config.dmAllowlist.length && !config.groupChatEnabled)) {
    return { status: 'waiting_for_configuration', message: 'Configure Feishu credentials and identity bindings, or explicitly select FEISHU_DM_MODE=open.' };
  }

  const sessionStore = new FeishuSessionStore(repository);
  const feedbackProvider = modelProvider ?? studyService.modelProvider;
  const sharedFeedbackService = feedbackService ?? studyService.feedbackService ?? new FeedbackService({
    repository,
    provider: feedbackProvider,
    profileProvider: () => studyService.getProfile()
  });
  const naturalAgent = studyAgent ?? new ArkStudyAgent({ provider: feedbackProvider, repository });
  const channel = channelFactory({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    policy: {
      dmMode: config.dmMode,
      dmAllowlist: config.dmAllowlist,
      // Even if the app later receives a group-message scope, only the
      // explicitly armed test group can cross the channel policy.
      groupAllowlist: config.groupChatEnabled || config.groupTestEnabled ? [config.testGroupId] : ['__group_test_disabled__'],
      requireMention: !config.groupChatEnabled
    },
    safety: {
      dedup: { ttl: 10 * 60 * 1000, maxEntries: 500 },
      chatQueue: { enabled: true },
      batch: { text: { delayMs: 0 } }
    },
    source: '333-review-assistant'
  });
  const modelReplyQueues = new Map();
  const originalSend = channel.send.bind(channel);
  channel.send = async (chatId, payload, options) => {
    const sent = await originalSend(chatId, payload, options);
    const message = sessionStore.context.getStore();
    if (message?.chatType === 'p2p' && message.chatId === chatId && canReceivePrivate(message.senderId, config)) {
      await sessionStore.memory.append(sessionStore.scope(message.senderId, chatId), { type: 'outbound', text: payload.text || JSON.stringify(payload.card || {}), replyTo: options?.replyTo, messageId: sent?.messageId });
    }
    return sent;
  };
  const knowledgeService = sourcePhotoService ?? new SourcePhotoService({ repository,
    model: new SourcePhotoModel(feedbackProvider), verifier: new SourcePhotoVerifier({ repository }),
    approverId: config.learnerId, logger });
  if (!sourcePhotoService) await knowledgeService.reconcile();
  const clarificationService = new ClarificationService({ repository, approverId: config.learnerId });
  const groupConversation = createGroupConversation({
    repository, provider: feedbackProvider, channel, chatId: config.testGroupId,
    yangyangOpenId: config.learnerId, ownerOpenId: config.ownerId, logger,
    appId: config.appId, knowledgeService, clarificationService
  });
  const receiptReactionAvailable = typeof channel.addReaction === 'function';
  let receiptReactionFailureLogged = false;

  function queueModelReply(chatId, label, operation) {
    const previous = modelReplyQueues.get(chatId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(operation)
      .catch((error) => logger.warn(`${label} failed (${safeErrorCode(error)}).`))
      .finally(() => {
        if (modelReplyQueues.get(chatId) === current) modelReplyQueues.delete(chatId);
      });
    modelReplyQueues.set(chatId, current);
  }

  function acknowledgeMessage(messageId) {
    if (!receiptReactionAvailable || !messageId) return;
    void channel.addReaction(messageId, 'DONE')
      .then(() => { receiptReactionFailureLogged = false; })
      .catch((error) => {
        if (!receiptReactionFailureLogged) {
          receiptReactionFailureLogged = true;
          logger.warn(`Feishu DONE receipt reaction is unavailable (${safeErrorCode(error)}).`);
        }
      });
  }

  function armGroupCheckinWatch() {
    if (!config.groupTestEnabled || !config.testGroupId || !config.groupTargetOpenId) return;
    const intervalMs = Math.max(100, Math.min(60_000, Number(groupPollIntervalMs) || GROUP_TEST_POLL_MS));
    let inFlight = false;
    let stopped = false;
    let timer = null;
    let retryDelayMs = intervalMs;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = (delayMs) => {
      if (stopped || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, delayMs);
      timer.unref?.();
    };

    const terminalError = (code, message) => {
      const error = new Error(message);
      error.code = code;
      error.groupCheckinTerminal = true;
      return error;
    };

    const requireLarkSuccess = (response, operation) => {
      if (response?.code === undefined || response?.code === null || Number(response.code) === 0) return response;
      throw terminalError(`feishu_${response.code}`, `${operation} failed: ${optionalText(response?.msg) ?? 'unknown error'}`);
    };

    const targetIsInGroup = async (listMembers) => {
      let pageToken = null;
      const seenTokens = new Set();
      for (let page = 0; page < 50; page += 1) {
        const params = { member_id_type: 'open_id', page_size: 100 };
        if (pageToken) params.page_token = pageToken;
        const response = requireLarkSuccess(await listMembers({
          path: { chat_id: config.testGroupId },
          params
        }), 'Group member lookup');
        if ((response?.data?.items ?? []).some((member) => member?.member_id === config.groupTargetOpenId)) return true;
        if (!response?.data?.has_more) return false;
        const nextPageToken = optionalText(response?.data?.page_token);
        if (!nextPageToken || seenTokens.has(nextPageToken)) {
          throw terminalError('group_member_page_token_invalid', 'Group member lookup returned an invalid page token.');
        }
        seenTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw terminalError('group_member_page_limit', 'Group member lookup exceeded the one-shot test page limit.');
    };

    const sendGroupCheckinPrompt = async (promptId) => {
      const createMessage = channel.rawClient?.im?.v1?.message?.create;
      if (typeof createMessage !== 'function') {
        throw terminalError('group_message_sender_unavailable', 'group message sender is unavailable');
      }
      const response = requireLarkSuccess(await createMessage({
        data: {
          receive_id: config.testGroupId,
          msg_type: 'text',
          content: JSON.stringify({ text: `<at user_id="${config.groupTargetOpenId}"></at> 今天的任务完成情况怎么样？完成了哪些、哪里卡住了，还有哪些需要调整？` }),
          // Reuse the durable prompt ID on every retry. Feishu then de-duplicates
          // the remote send even if a process dies after the API accepts it.
          uuid: promptId
        },
        params: { receive_id_type: 'chat_id' }
      }), 'Group check-in send');
      const messageId = optionalText(response?.data?.message_id);
      if (!messageId) {
        throw terminalError('group_message_id_missing', 'Group check-in send returned no message ID.');
      }
      return messageId;
    };

    const poll = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const listMembers = channel.rawClient?.im?.v1?.chatMembers?.get;
        if (typeof listMembers !== 'function') {
          throw terminalError('group_member_reader_unavailable', 'chat-members reader is unavailable');
        }
        if (!await targetIsInGroup(listMembers)) {
          retryDelayMs = intervalMs;
          schedule(intervalMs);
          return;
        }

        const claim = await sessionStore.claimGroupCheckinPrompt({
          chatId: config.testGroupId,
          targetOpenId: config.groupTargetOpenId
        });
        if (!claim.claimed) {
          if (claim.prompt?.status === 'sent') stop();
          else schedule(intervalMs);
          return;
        }
        try {
          const messageId = await sendGroupCheckinPrompt(claim.prompt.id);
          await sessionStore.completeGroupCheckinPrompt({
            promptId: claim.prompt.id,
            claimToken: claim.prompt.claimToken,
            messageId
          });
          logger.log('Group test check-in prompt sent.');
          stop();
        } catch (error) {
          await sessionStore.releaseGroupCheckinPrompt({
            promptId: claim.prompt.id,
            claimToken: claim.prompt.claimToken
          });
          throw error;
        }
      } catch (error) {
        if (error?.groupCheckinTerminal) {
          // Permission, membership, or configuration failures need an explicit
          // fix, so do not repeatedly call Feishu after a terminal response.
          logger.warn(`Group test check-in is unavailable (${safeErrorCode(error)}).`);
          stop();
        } else {
          retryDelayMs = Math.min(GROUP_TEST_MAX_RETRY_MS, Math.max(intervalMs, retryDelayMs * 2));
          logger.warn(`Group test check-in will retry after a transient error (${safeErrorCode(error)}).`);
          schedule(retryDelayMs);
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
  }

  async function showToday(chatId) {
    const dashboard = await studyService.getDashboard();
    await channel.send(chatId, { card: todayPlanCard(dashboard) });
  }

  async function showWeaknesses(chatId) {
    const dashboard = await studyService.getDashboard();
    await channel.send(chatId, { card: weaknessCard(dashboard.weakPoints) });
  }

  async function showProgress(chatId) {
    const dashboard = await studyService.getDashboard();
    await channel.send(chatId, {
      card: infoCard('今日进度', `今天完成了 **${dashboard.completedToday}** 次复习闭环，另有 **${dashboard.selfReportedCompletedToday}** 条任务完成自报；当前还有 **${dashboard.tasks.length}** 个候选任务。`, 'blue')
    });
  }

  async function showCompletions(chatId) {
    const entries = await studyService.getRecentTaskCompletions();
    await channel.send(chatId, { card: completionHistoryCard(entries) });
  }

  async function recordCompletion(message, report) {
    try {
      const entry = await studyService.recordTaskCompletion({
        content: report.content,
        reportedOn: addDays(todayKey(), report.dayOffset),
        sourceId: `feishu:completion:${message.messageId}`,
        source: 'feishu_self_report'
      });
      await channel.send(message.chatId, { card: completionRecordedCard(entry) }, { replyTo: message.messageId });
      await sessionStore.rememberConversationTurn({
        openId: message.senderId,
        chatId: message.chatId,
        userText: message.content,
        assistantText: `已记入 ${entry.reportedOn} 的最近完成备案。`
      });
    } catch (error) {
      logger.error(`Feishu task completion save failed (${safeErrorCode(error)}).`);
      await channel.send(message.chatId, { text: '这条完成情况还没有保存成功，请原样再发一次。' }, { replyTo: message.messageId });
    }
  }

  async function voidCompletion(event, completionId) {
    try {
      const entry = await studyService.voidTaskCompletion({
        completionId,
        sourceId: `feishu:void-completion:${event.messageId}:${completionId}`
      });
      await updateOrSend(channel, event, completionVoidedCard(entry), logger);
    } catch (error) {
      logger.warn(`Feishu task completion undo failed (${safeErrorCode(error)}).`);
      await channel.send(event.chatId, { text: '这条记录没有撤销成功，请稍后再试。' });
    }
  }

  async function startTask({ chatId, openId, task, actionKey, cardEvent }) {
    const active = await sessionStore.getActive(openId, chatId);
    if (active && active.actionKey !== actionKey) {
      await channel.send(chatId, {
        card: infoCard('当前题目仍在进行', '先完成当前题目或输入 `/取消`，再开始新的知识点；已有答案和进度不会被覆盖。', 'yellow')
      });
      return;
    }
    const started = await sessionStore.createAwaitingAnswer({ actionKey, openId, chatId, task });
    if (!started.created) {
      await channel.send(chatId, { card: infoCard('本题已开始', statusMessage(started.session), 'grey') });
      return;
    }
    const card = taskPromptCard(started.session);
    if (cardEvent) await updateOrSend(channel, cardEvent, card, logger);
    else await channel.send(chatId, { card });
  }

  async function beginTodayTask({ chatId, openId, taskId, actionKey, cardEvent }) {
    const task = await studyService.getTodayTask(taskId);
    await startTask({ chatId, openId, task, actionKey, cardEvent });
  }

  async function beginWeaknessTask({ chatId, openId, knowledgePointId, actionKey, cardEvent }) {
    const task = await studyService.getWeaknessTask(knowledgePointId);
    await startTask({ chatId, openId, task, actionKey, cardEvent });
  }

  async function beginPracticeTask({ chatId, openId, knowledgePointId, actionKey, cardEvent }) {
    const task = await studyService.getPracticeTask(knowledgePointId);
    await startTask({ chatId, openId, task, actionKey, cardEvent });
  }

  async function proposePractice(chatId, query) {
    const task = await studyService.findPracticeTask(query);
    if (!task) {
      await channel.send(chatId, { card: infoCard('没有找到唯一知识点', '换一个更具体的知识点名称，或先查看今日任务。', 'grey') });
      return showToday(chatId);
    }
    await channel.send(chatId, { card: taskSuggestionCard(task) });
  }

  async function startNamedPractice(message, query) {
    const task = await studyService.findPracticeTask(query);
    if (!task) return proposePractice(message.chatId, query);
    return startTask({
      chatId: message.chatId,
      openId: message.senderId,
      task,
      actionKey: `text-practice:${message.messageId}:${task.knowledgePointId}`
    });
  }

  async function rememberAndSend({ chatId, openId, userText, assistantText, replyTo }) {
    await channel.send(chatId, { text: assistantText }, replyTo ? { replyTo } : undefined);
    await sessionStore.rememberConversationTurn({ openId, chatId, userText, assistantText });
  }

  async function sendNaturalChat(message, activeSession = null) {
    if (!naturalAgent.isConfigured()) {
      await channel.send(message.chatId, { card: helpCard() }, { replyTo: message.messageId });
      return;
    }
    try {
      const [profile, dashboard, history] = await Promise.all([
        studyService.getProfile(),
        studyService.getDashboard(),
        sessionStore.getConversationHistory(message.senderId, message.chatId)
      ]);
      const result = await naturalAgent.chat({
        message: message.content,
        profile,
        history,
        runtimeSummary: {
          scopedMemoryNotes: (await sessionStore.memory.notes(sessionStore.scope(message.senderId, message.chatId))).map(n => n.text),
          date: dashboard.date,
          completedToday: dashboard.completedToday,
          todayTasks: dashboard.tasks.map((task) => ({ title: task.title, label: task.label, source: task.source })),
          weakPoints: dashboard.weakPoints.map((point) => ({ title: point.title, mastery: point.mastery })),
          recentTaskCompletions: dashboard.recentTaskCompletions.map((entry) => ({
            reportedOn: entry.reportedOn,
            content: entry.content,
            evidenceStatus: entry.evidenceStatus
          })),
          dataMode: dashboard.system.dataMode,
          activeSession: activeSession ? { status: activeSession.status, taskTitle: activeSession.task?.title } : null
        }
      });
      await rememberAndSend({
        chatId: message.chatId,
        openId: message.senderId,
        userText: message.content,
        assistantText: result.text,
        replyTo: message.messageId
      });
    } catch (error) {
      logger.warn(`Natural-language reply is unavailable (${safeErrorCode(error)}).`);
      await channel.send(message.chatId, {
        card: infoCard('自然语言回复暂不可用', '卡片和命令仍可使用。可以说“今天学什么”，或输入 `/今日`。', 'grey')
      }, { replyTo: message.messageId });
    }
  }

  async function sendCoach({ chatId, openId, userText, task, replyTo }) {
    if (!naturalAgent.isConfigured()) {
      await channel.send(chatId, { text: '练习建议：先写出 3 个关键词，再按“观点—依据—评价或例子”组织。完成后用 `答案：……` 提交。' }, { replyTo });
      return;
    }
    try {
      const [profile, history] = await Promise.all([
        studyService.getProfile(),
        sessionStore.getConversationHistory(openId, chatId)
      ]);
      const result = await naturalAgent.coach({ message: userText, profile, task, history });
      await rememberAndSend({ chatId, openId, userText, assistantText: result.text, replyTo });
    } catch (error) {
      logger.warn(`Coaching reply is unavailable (${safeErrorCode(error)}).`);
      await channel.send(chatId, { text: '练习建议：先列出你能想到的 3 个关键词，我再帮你组织。' }, { replyTo });
    }
  }

  async function sendModelFeedback({ chatId, replyTo, jobId }) {
    try {
      const result = await sharedFeedbackService.process(jobId);
      const job = result?.job;
      const feedback = feedbackText(result);
      if (job?.status === 'succeeded' && feedback) {
        await channel.send(chatId, { card: modelFeedbackCard(feedback) }, { replyTo });
        return;
      }
      if (job?.status === 'failed') {
        await channel.send(chatId, {
          card: infoCard('豆包提示暂不可用', '答案已经保存，自评和复习计划不受影响；稍后可继续下一题。', 'grey')
        }, { replyTo });
        return;
      }
      logger.warn(`Feedback job ${jobId} finished without a terminal result (${job?.status ?? 'unknown'}).`);
    } catch (error) {
      logger.warn(`Feedback job is unavailable (${safeErrorCode(error)}).`);
      await channel.send(chatId, {
        card: infoCard('豆包提示暂不可用', '答案已经保存，自评和复习计划不受影响；稍后可继续下一题。', 'grey')
      }, { replyTo });
    }
  }

  async function persistClaimedAnswer({ claim, answer, openId, chatId, replyTo, cardEvent = null }) {
    try {
      const attempt = await studyService.saveAnswer({
        knowledgePointId: claim.session.task.knowledgePointId,
        content: answer,
        taskSnapshot: claim.session.task,
        sourceId: claim.session.answerSourceId
      });
      const completed = await sessionStore.finishAnswer({
        sessionId: claim.session.id,
        openId,
        attemptId: attempt.id
      });
      let feedbackJob = null;
      try {
        const queued = await sharedFeedbackService.enqueue({
          attempt,
          task: completed.task,
          idempotencyKey: `feishu:feedback:${attempt.id}`,
          channel: 'feishu'
        });
        feedbackJob = queued.job;
      } catch (error) {
        logger.warn(`Feedback job could not be queued (${safeErrorCode(error)}).`);
      }
      const card = answerSavedCard(completed, {
        feedbackEnabled: Boolean(feedbackJob) && sharedFeedbackService.isConfigured()
      });
      if (cardEvent) await updateOrSend(channel, cardEvent, card, logger);
      else await channel.send(chatId, { card }, { replyTo });
      if (feedbackJob) {
        queueModelReply(chatId, 'Answer feedback', () => sendModelFeedback({ chatId, replyTo, jobId: feedbackJob.id }));
      }
    } catch (error) {
      await sessionStore.releaseAnswer({ sessionId: claim.session.id, openId });
      await channel.send(chatId, { text: '答案未保存；原消息仍在聊天中，请再次发送或输入 `/取消`。' }, { replyTo });
      logger.error('Feishu answer save failed:', error.message);
    }
  }

  async function saveTextAnswer(message, answer = message.content) {
    const session = await sessionStore.getActive(message.senderId, message.chatId);
    if (!session || session.status !== 'awaiting_answer') {
      await channel.send(message.chatId, { card: infoCard('学习入口', statusMessage(session)) }, { replyTo: message.messageId });
      return;
    }
    const claim = await sessionStore.claimAnswer({
      sessionId: session.id,
      openId: message.senderId,
      messageId: message.messageId
    });
    if (!claim.claimed) {
      await channel.send(message.chatId, { text: statusMessage(claim.session) }, { replyTo: message.messageId });
      return;
    }
    await persistClaimedAnswer({ claim, answer, openId: message.senderId, chatId: message.chatId, replyTo: message.messageId });
  }

  async function stageAmbiguousMessage(message, session) {
    const staged = await sessionStore.stagePendingMessage({
      sessionId: session.id,
      openId: message.senderId,
      messageId: message.messageId,
      content: message.content
    });
    if (!staged.staged) {
      await channel.send(message.chatId, { text: statusMessage(staged.session) }, { replyTo: message.messageId });
      return;
    }
    await channel.send(message.chatId, { card: answerIntentCard(staged.session, message.messageId) }, { replyTo: message.messageId });
  }

  async function confirmPendingAnswer(event, value) {
    const claim = await sessionStore.claimPendingAnswer({
      sessionId: value.sessionId,
      openId: event.operator.openId,
      messageId: value.messageId
    });
    if (!claim.claimed) {
      await channel.send(event.chatId, { text: statusMessage(claim.session) });
      return;
    }
    await persistClaimedAnswer({
      claim,
      answer: claim.content,
      openId: event.operator.openId,
      chatId: event.chatId,
      replyTo: value.messageId,
      cardEvent: event
    });
  }

  async function pendingAsQuestion(event, value) {
    const dismissed = await sessionStore.dismissPendingMessage({
      sessionId: value.sessionId,
      openId: event.operator.openId,
      messageId: value.messageId
    });
    if (!dismissed.dismissed) {
      await channel.send(event.chatId, { text: statusMessage(dismissed.session) });
      return;
    }
    await updateOrSend(channel, event, infoCard('已按提问处理', '这句话没有保存为答案，当前题目仍然继续。', 'blue'), logger);
    queueModelReply(event.chatId, 'Coaching reply', () => sendCoach({
      chatId: event.chatId,
      openId: event.operator.openId,
      userText: dismissed.content,
      task: dismissed.session.task,
      replyTo: value.messageId
    }));
  }

  async function resumeSession(chatId, openId) {
    const session = await sessionStore.getActive(openId, chatId);
    if (!session) return showToday(chatId);
    if (session.status === 'awaiting_answer') return channel.send(chatId, { card: taskPromptCard(session) });
    if (session.status === 'awaiting_rating') {
      return channel.send(chatId, { card: answerSavedCard(session, { feedbackEnabled: sharedFeedbackService.isConfigured() }) });
    }
    await channel.send(chatId, { text: statusMessage(session) });
  }

  async function cancelSession({ chatId, openId, sessionId, cardEvent }) {
    const session = sessionId
      ? await sessionStore.cancel({ sessionId, openId })
      : await (async () => {
        const active = await sessionStore.getActive(openId, chatId);
        return active ? sessionStore.cancel({ sessionId: active.id, openId }) : null;
      })();
    if (!session?.cancelled) {
      await channel.send(chatId, { text: statusMessage(session) });
      return;
    }
    const card = sessionCancelledCard(session);
    if (cardEvent) await updateOrSend(channel, cardEvent, card, logger);
    else await channel.send(chatId, { card });
  }

  async function applyRating({ chatId, openId, sessionId, rating, cardEvent = null }) {
    if (!validRatings.has(rating) || typeof sessionId !== 'string') return;
    const claim = await sessionStore.claimRating({ sessionId, openId, rating });
    if (!claim.claimed) {
      await channel.send(chatId, { card: infoCard('本题已处理', statusMessage(claim.session)) });
      return;
    }
    try {
      const result = await studyService.recordReview({
        knowledgePointId: claim.session.task.knowledgePointId,
        rating: claim.session.rating,
        sourceId: claim.session.ratingSourceId
      });
      const completed = await sessionStore.finishRating({
        sessionId: claim.session.id,
        openId,
        reviewLogId: result.reviewLog.id
      });
      const dashboard = await studyService.getDashboard();
      const card = ratingCompleteCard({ session: completed, result, completedToday: dashboard.completedToday });
      if (cardEvent) await updateOrSend(channel, cardEvent, card, logger);
      else await channel.send(chatId, { card });
    } catch (error) {
      await sessionStore.releaseRating({ sessionId: claim.session.id, openId });
      await channel.send(chatId, { text: '自评暂未保存，请再试一次。' });
      logger.error('Feishu review save failed:', error.message);
    }
  }

  async function handleReadOnlyIntent(type, chatId) {
    if (type === 'show_today') return showToday(chatId);
    if (type === 'show_progress') return showProgress(chatId);
    if (type === 'show_weaknesses') return showWeaknesses(chatId);
    if (type === 'show_completions') return showCompletions(chatId);
    if (type === 'help') return channel.send(chatId, { card: helpCard() });
    return null;
  }

  async function handleActiveNatural(message, session) {
    const route = routeActiveMessage(message.content, session.status);
    if (route.type === 'navigation') return handleReadOnlyIntent(route.intent, message.chatId);
    if (route.type === 'start_blocked') {
      await channel.send(message.chatId, {
        card: infoCard('当前题目仍在进行', '先完成或输入 `/取消`，再开始新的知识点；当前答案不会被覆盖。', 'yellow')
      }, { replyTo: message.messageId });
      return;
    }
    if (route.type === 'submit_answer') return saveTextAnswer(message, route.answer);
    if (route.type === 'empty_answer') {
      return channel.send(message.chatId, { text: '“答案：”后面还没有内容，请补充后再发送。' }, { replyTo: message.messageId });
    }
    if (route.type === 'coach') {
      queueModelReply(message.chatId, 'Coaching reply', () => sendCoach({
        chatId: message.chatId,
        openId: message.senderId,
        userText: route.question,
        task: session.task,
        replyTo: message.messageId
      }));
      return;
    }
    if (route.type === 'ambiguous') return stageAmbiguousMessage(message, session);
    if (route.type === 'rate') {
      return applyRating({ chatId: message.chatId, openId: message.senderId, sessionId: session.id, rating: route.rating });
    }
    if (route.type === 'rating_ambiguous') {
      await channel.send(message.chatId, { text: '“还行”不够确定，我不会替你猜。请选择下面最接近真实回忆感受的一档。' }, { replyTo: message.messageId });
      return channel.send(message.chatId, { card: answerSavedCard(session, { feedbackEnabled: sharedFeedbackService.isConfigured() }) });
    }
    if (route.type === 'chat') {
      const quickReply = deterministicConversationReply(message.content);
      if (quickReply) {
        return rememberAndSend({
          chatId: message.chatId,
          openId: message.senderId,
          userText: message.content,
          assistantText: quickReply,
          replyTo: message.messageId
        });
      }
      queueModelReply(message.chatId, 'Natural-language reply', () => sendNaturalChat(message, session));
      return;
    }
    await channel.send(message.chatId, { text: statusMessage(session) }, { replyTo: message.messageId });
  }

  async function handleInactiveNatural(message) {
    const deterministic = deterministicNaturalIntent(message.content);
    if (deterministic?.type === 'start_task') return startNamedPractice(message, deterministic.query);
    if (deterministic) return handleReadOnlyIntent(deterministic.type, message.chatId);
    const quickReply = deterministicConversationReply(message.content);
    if (quickReply) {
      return rememberAndSend({
        chatId: message.chatId,
        openId: message.senderId,
        userText: message.content,
        assistantText: quickReply,
        replyTo: message.messageId
      });
    }
    if (!naturalAgent.isConfigured()) {
      await channel.send(message.chatId, { card: helpCard() }, { replyTo: message.messageId });
      return;
    }
    queueModelReply(message.chatId, 'Natural-language intent', async () => {
      try {
        const [profile, dashboard, history] = await Promise.all([
          studyService.getProfile(),
          studyService.getDashboard(),
          sessionStore.getConversationHistory(message.senderId, message.chatId)
        ]);
        const runtimeSummary = {
          scopedMemoryNotes: (await sessionStore.memory.notes(sessionStore.scope(message.senderId, message.chatId))).map(n => n.text),
          date: dashboard.date,
          completedToday: dashboard.completedToday,
          selfReportedCompletedToday: dashboard.selfReportedCompletedToday,
          todayTasks: dashboard.tasks.map((task) => ({ title: task.title, label: task.label, source: task.source })),
          weakPoints: dashboard.weakPoints.map((point) => ({ title: point.title, mastery: point.mastery })),
          recentTaskCompletions: dashboard.recentTaskCompletions.map((entry) => ({
            reportedOn: entry.reportedOn,
            content: entry.content,
            evidenceStatus: entry.evidenceStatus
          })),
          dataMode: dashboard.system.dataMode,
          activeSession: null
        };
        const decision = await naturalAgent.classify({
          message: message.content,
          profile,
          runtimeSummary,
          history
        });
        if (['show_today', 'show_progress', 'show_weaknesses', 'show_completions', 'help'].includes(decision.intent)) {
          await handleReadOnlyIntent(decision.intent, message.chatId);
          return;
        }
        if (decision.intent === 'propose_task') return proposePractice(message.chatId, decision.taskQuery);
        if (decision.intent === 'ask_hint') {
          await channel.send(message.chatId, { card: infoCard('先选一道题', '提示需要依附于当前题目。先从今日任务开始，我会陪你逐步回忆。', 'wathet') });
          await showToday(message.chatId);
          return;
        }
        if (decision.intent === 'ambiguous') {
          await channel.send(message.chatId, { text: decision.reply || '我还没完全明白。你是想看任务、练一个知识点，还是聊聊学习状态？' }, { replyTo: message.messageId });
          return;
        }
        const assistantText = decision.reply || '我在。你可以直接告诉我今天完成了什么，或者说“今天学什么”。';
        await rememberAndSend({
          chatId: message.chatId,
          openId: message.senderId,
          userText: message.content,
          assistantText,
          replyTo: message.messageId
        });
      } catch (error) {
        logger.warn(`Natural-language intent is unavailable (${safeErrorCode(error)}).`);
        await channel.send(message.chatId, { card: helpCard() }, { replyTo: message.messageId });
      }
    });
  }

  async function handleNonLearner(message, identity) {
    const send = text => channel.send(message.chatId, { text }, { replyTo: message.messageId });
    const command = commandFrom(message.content);
    const natural = deterministicNaturalIntent(message.content.replace(/羊羊的?/g, '我的'));
    const readIntent = command || ({ show_today: 'today', show_progress: 'progress', show_weaknesses: 'weaknesses', show_completions: 'completions' }[natural?.type]);
    if (identity.role === 'unbound') {
      return send('当前账号尚未绑定身份，不会按羊羊处理，也不能查看她的学习记录。发送 /身份 获取你的账号标识，由管理员在服务器配置绑定。');
    }
    if (['today', 'progress', 'weaknesses', 'completions'].includes(readIntent)) {
      const dashboard = await studyService.getDashboard();
      const rows = readIntent === 'weaknesses' ? dashboard.weakPoints.map(p => p.title)
        : readIntent === 'completions' ? dashboard.recentTaskCompletions.map(p => `${p.reportedOn}：${p.content}`)
        : dashboard.tasks.map((p, i) => `${i + 1}. ${p.title}（${p.label}）`);
      return send(`羊羊的学习数据（管理员只读）\n${dashboard.date}：已完成 ${dashboard.completedToday} 次复习，${dashboard.selfReportedCompletedToday} 条完成自报。\n${rows.join('\n') || '暂无记录。'}`);
    }
    if (command || completionReportFrom(message.content) || /^\/(开始|开始复习)/.test(message.content)) {
      return send('你是系统管理员，不建立学习档案，也不代替羊羊作答、自评或写入完成记录。可以发送 /今日、/进度、/薄弱、/记录 查看羊羊的数据。');
    }
    const quick = deterministicConversationReply(message.content, identity.role);
    if (quick) return send(quick);
    if (!naturalAgent.isConfigured()) return send('你是系统管理员。可用 /今日、/进度、/薄弱、/记录 查看羊羊的学习数据。');
    queueModelReply(message.chatId, 'Administrator chat', async () => {
      const dashboard = await studyService.getDashboard();
      const scope = sessionStore.scope(message.senderId, message.chatId);
      const result = await naturalAgent.chat({ message: message.content, profile: identity,
        runtimeSummary: { subject: '羊羊', access: 'read_only', dashboard }, history: await sessionStore.memory.history(scope) });
      await send(result.text);
      await sessionStore.memory.append(scope, { type: 'turn', eventId: message.messageId, user: message.content, assistant: result.text });
    });
  }

  channel.on('message', (message) => sessionStore.withMessage(message, async () => {
    if (message.chatType === 'group') {
      if (!config.groupChatEnabled || message.chatId !== config.testGroupId) return;
      if (!message.senderId || message.senderId === channel.botIdentity?.openId) return;
      if (!['text', 'post', 'image', 'file'].includes(message.rawContentType)) {
        return;
      }
      queueModelReply(message.chatId, 'Group conversation', () => groupConversation(message));
      return;
    }
    if (message.chatType !== 'p2p' || !canReceivePrivate(message.senderId, config)) return;
    const identity = identifySender(message.senderId, config);
    acknowledgeMessage(message.messageId);
    await sessionStore.rememberPrivateChat({ openId: message.senderId, chatId: message.chatId });
    const privateScope = sessionStore.scope(message.senderId, message.chatId);
    await sessionStore.memory.append(privateScope, { type: 'inbound', eventId: message.messageId, text: message.content, senderId: message.senderId });
    if (message.content.trim() === '/身份') return channel.send(message.chatId, { text: identityDescription(identity, { chatType: 'p2p', openId: message.senderId, chatId: message.chatId }) });
    if (['/new', '/reset', '/重置上下文', '重置上下文', '清空上下文'].includes(message.content.trim())) {
      queueModelReply(message.chatId, 'Reset private session', async () => {
        const active = await sessionStore.getActive(message.senderId, message.chatId);
        if (active) await sessionStore.cancel({ sessionId: active.id, openId: message.senderId });
        await sessionStore.memory.reset(privateScope);
        await channel.send(message.chatId, { text: '私聊已开启新会话。旧聊天归档，当前练习已退出；已保存的学习记录与长期备注保留，不影响群聊。' }, { replyTo: message.messageId });
      });
      return;
    }
    if (message.content.startsWith('记住：')) {
      await sessionStore.memory.remember(privateScope, message.content.slice(3).trim(), message.messageId);
      return channel.send(message.chatId, { text: '已记为本私聊范围的长期备注，不会带入群聊。' }, { replyTo: message.messageId });
    }
    if (message.content.startsWith('查历史：')) {
      const hits = await sessionStore.memory.search(privateScope, message.content.slice(4).trim());
      return channel.send(message.chatId, { text: hits.length ? hits.map(h => `${h.at} ${h.user || h.text || ''} ${h.assistant || ''}`).join('\n').slice(0, 6000) : '本私聊范围未找到匹配记录。' }, { replyTo: message.messageId });
    }
    if (message.rawContentType !== 'text' || !message.content.trim()) {
      await channel.send(message.chatId, { text: '首测暂时只支持文字消息；图片、语音和文件不会被保存。' }, { replyTo: message.messageId });
      return;
    }

    if (identity.role !== 'learner') return handleNonLearner(message, identity);
    const command = commandFrom(message.content);
    if (command === 'today') return showToday(message.chatId);
    if (command === 'weaknesses') return showWeaknesses(message.chatId);
    if (command === 'progress') return showProgress(message.chatId);
    if (command === 'completions') return showCompletions(message.chatId);
    if (command === 'help') return channel.send(message.chatId, { card: helpCard() });
    if (command === 'cancel') return cancelSession({ chatId: message.chatId, openId: message.senderId });
    if (command === 'continue') return resumeSession(message.chatId, message.senderId);

    const completionReport = completionReportFrom(message.content);
    if (completionReport) return recordCompletion(message, completionReport);

    const active = await sessionStore.getActive(message.senderId, message.chatId);
    const taskNumber = parseStartCommand(message.content);
    if (taskNumber) {
      if (active) {
        return channel.send(message.chatId, {
          card: infoCard('当前题目仍在进行', '先完成当前题目或输入 `/取消`，再开始新的知识点；已有答案和进度不会被覆盖。', 'yellow')
        }, { replyTo: message.messageId });
      }
      const dashboard = await studyService.getDashboard();
      const task = dashboard.tasks[taskNumber - 1];
      if (!task) return channel.send(message.chatId, { text: '没有这个序号的今日任务。输入 `/今日` 查看列表。' });
      return beginTodayTask({
        chatId: message.chatId,
        openId: message.senderId,
        taskId: task.id,
        actionKey: `text-start:${message.messageId}`
      });
    }

    if (active) return handleActiveNatural(message, active);
    return handleInactiveNatural(message);
  }));

  channel.on('cardAction', async (event) => {
    if (!canReceivePrivate(event.operator.openId, config)) return;
    if (!await sessionStore.isKnownPrivateChat({ openId: event.operator.openId, chatId: event.chatId })) return;
    const value = actionValue(event.action.value);
    if (!value || value.v !== '1') return;
    if (identifySender(event.operator.openId, config).role !== 'learner') {
      return channel.send(event.chatId, { text: '当前账号不能操作羊羊的练习卡片。管理员请通过 /今日、/进度、/薄弱、/记录 查看数据。' });
    }
    if (typeof value.sessionId === 'string') {
      const record = (await repository.read()).feishu?.sessions?.find(s => s.id === value.sessionId);
      if (!record || record.openId !== event.operator.openId || record.chatId !== event.chatId) return;
    }
    if (value.action === 'show_today') return showToday(event.chatId);
    if (value.action === 'show_weaknesses') return showWeaknesses(event.chatId);
    if (value.action === 'show_completions') return showCompletions(event.chatId);
    if (value.action === 'void_completion' && typeof value.completionId === 'string') {
      return voidCompletion(event, value.completionId);
    }
    if (value.action === 'show_help') return channel.send(event.chatId, { card: helpCard() });
    if (value.action === 'start_task' && typeof value.taskId === 'string') {
      return beginTodayTask({
        chatId: event.chatId,
        openId: event.operator.openId,
        taskId: value.taskId,
        actionKey: `card-start:${event.messageId}:${value.taskId}`,
        cardEvent: event
      });
    }
    if (value.action === 'start_weakness' && typeof value.knowledgePointId === 'string') {
      return beginWeaknessTask({
        chatId: event.chatId,
        openId: event.operator.openId,
        knowledgePointId: value.knowledgePointId,
        actionKey: `card-weakness:${event.messageId}:${value.knowledgePointId}`,
        cardEvent: event
      });
    }
    if (value.action === 'start_practice' && typeof value.knowledgePointId === 'string') {
      return beginPracticeTask({
        chatId: event.chatId,
        openId: event.operator.openId,
        knowledgePointId: value.knowledgePointId,
        actionKey: `card-practice:${event.messageId}:${value.knowledgePointId}`,
        cardEvent: event
      });
    }
    if (value.action === 'ask_hint' && typeof value.sessionId === 'string') {
      const session = await sessionStore.getActive(event.operator.openId, event.chatId);
      if (!session || session.id !== value.sessionId || session.status !== 'awaiting_answer') return;
      queueModelReply(event.chatId, 'Coaching reply', () => sendCoach({ chatId: event.chatId, openId: event.operator.openId, userText: '给我一个一级提示', task: session.task, replyTo: event.messageId }));
      return;
    }
    if (value.action === 'confirm_pending_answer' && typeof value.sessionId === 'string' && typeof value.messageId === 'string') {
      return confirmPendingAnswer(event, value);
    }
    if (value.action === 'pending_as_question' && typeof value.sessionId === 'string' && typeof value.messageId === 'string') {
      return pendingAsQuestion(event, value);
    }
    if (value.action === 'cancel_session' && typeof value.sessionId === 'string') {
      return cancelSession({ chatId: event.chatId, openId: event.operator.openId, sessionId: value.sessionId, cardEvent: event });
    }
    if (value.action === 'rate') {
      return applyRating({ chatId: event.chatId, openId: event.operator.openId, sessionId: value.sessionId, rating: value.rating, cardEvent: event });
    }
  });

  channel.on('error', (error) => logger.error('Feishu channel error:', error.code, error.message));
  channel.on('reconnecting', () => logger.warn('Feishu long connection is reconnecting.'));
  channel.on('reconnected', () => logger.log('Feishu long connection reconnected.'));
  await channel.connect();
  if (!sourcePhotoService) {
    void Promise.resolve().then(() => knowledgeService.processQueued())
      .catch(error => logger.warn(`Source photo worker failed (${safeErrorCode(error)}).`));
  }
  if (config.groupTestConfigurationError) {
    logger.warn(config.groupTestConfigurationError);
  }
  armGroupCheckinWatch();
  const reminders = new ReviewReminders({ repository, send: channel.send.bind(channel), chatId: config.groupChatEnabled ? config.testGroupId : null, learnerId: config.learnerId, logger });
  reminders.start();
  logger.log(`Feishu bot connected as ${channel.botIdentity?.name ?? 'bot'} (${config.groupChatEnabled ? 'group conversation + private' : config.groupTestEnabled ? 'private + one group check-in test' : 'single-user private test'} mode).`);
  return {
    status: 'connected',
    transport: 'websocket',
    privateTestMode: config.dmMode === 'allowlist',
    dmMode: config.dmMode,
    identityBindings: { learner: Boolean(config.learnerId), administrator: Boolean(config.ownerId) },
    groupConversation: config.groupChatEnabled ? { status: 'enabled', chatId: config.testGroupId } : { status: 'disabled' },
    groupCheckinTest: config.groupTestEnabled ? { status: 'armed', chatId: config.testGroupId } : { status: 'disabled' },
    naturalLanguage: naturalAgent.isConfigured() ? 'configured' : 'disabled',
    receiptReaction: receiptReactionAvailable ? 'configured' : 'unavailable',
    photoKnowledge: 'source-restoration-background-v1',
    conversationIsolation: 'app-chat-kind-peer-topic-session-v1'
  };
}
