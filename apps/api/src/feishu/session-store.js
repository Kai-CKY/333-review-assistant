import { randomUUID } from 'node:crypto';
import { ConversationMemory, conversationScope } from '../agent/memory.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const ACTIVE_STATES = new Set(['awaiting_answer', 'answer_saving', 'awaiting_rating', 'rating_saving']);
const CLAIM_STALE_MS = 60_000;
const GROUP_CHECKIN_KIND = 'today_study_checkin';

function ensureState(data) {
  data.feishu ??= { sessions: [] };
  data.feishu.sessions ??= [];
  data.feishu.privateChats ??= [];
  data.feishu.conversations ??= [];
  data.feishu.groupCheckinPrompts ??= [];
  return data.feishu;
}

function safeConversationText(value) {
  return String(value ?? '')
    .replace(/\bark-[A-Za-z0-9-]{12,}\b/g, '[已隐藏密钥]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/gi, 'Bearer [已隐藏]')
    .slice(0, 2_000)
    .trim();
}

function findSession(data, sessionId) {
  return ensureState(data).sessions.find((item) => item.id === sessionId);
}

function isOwnedBy(session, openId) {
  return session && session.openId === openId;
}

function trimHistory(sessions) {
  if (sessions.length > 80) sessions.splice(0, sessions.length - 80);
}

function isStale(session, now) {
  return now - Date.parse(session.updatedAt ?? '') >= CLAIM_STALE_MS;
}

function recoverStaleClaims(data, openId, now = Date.now()) {
  const state = ensureState(data);
  for (const session of state.sessions) {
    if (session.openId !== openId || !isStale(session, now)) continue;
    if (session.status === 'answer_saving') {
      const attempt = data.answerAttempts.find((item) => item.sourceId === session.answerSourceId);
      if (attempt) {
        session.status = 'awaiting_rating';
        session.answerAttemptId = attempt.id;
      } else {
        session.status = 'awaiting_answer';
      }
      session.updatedAt = new Date(now).toISOString();
    }
    if (session.status === 'rating_saving') {
      const reviewLog = data.reviewLogs.find((item) => item.sourceId === session.ratingSourceId);
      if (reviewLog) {
        session.status = 'completed';
        session.reviewLogId = reviewLog.id;
        session.completedAt = new Date(now).toISOString();
      } else {
        session.status = 'awaiting_rating';
      }
      session.updatedAt = new Date(now).toISOString();
    }
  }
}

/** Persists only Feishu conversation state; learning data stays in StudyService. */
export class FeishuSessionStore {
  constructor(repository) {
    this.repository = repository;
    this.memory = new ConversationMemory(repository);
    this.context = new AsyncLocalStorage();
  }

  withMessage(message, operation) { return this.context.run(message, operation); }

  scope(openId, chatId, threadId) {
    const active = this.context.getStore();
    return conversationScope({ appId: process.env.FEISHU_APP_ID || '333', chatType: 'p2p', chatId: chatId || active?.chatId || 'legacy-private', senderId: openId, threadId: threadId ?? active?.threadId ?? '' });
  }

  async createAwaitingAnswer({ actionKey, openId, chatId, task }) {
    const threadId = this.context.getStore()?.threadId || '';
    return this.repository.mutate((data) => {
      const state = ensureState(data);
      const existing = state.sessions.find((item) => item.actionKey === actionKey);
      if (existing) return { session: existing, created: false };
      const now = new Date().toISOString();
      state.sessions.forEach((item) => {
        if (item.openId === openId && item.chatId === chatId && (item.threadId || '') === threadId && ACTIVE_STATES.has(item.status)) {
          item.status = 'cancelled';
          item.updatedAt = now;
        }
      });
      const session = {
        id: randomUUID(),
        actionKey,
        openId,
        chatId,
        threadId,
        task,
        status: 'awaiting_answer',
        createdAt: now,
        updatedAt: now
      };
      state.sessions.push(session);
      trimHistory(state.sessions);
      return { session, created: true };
    });
  }

  async getActive(openId, chatId) {
    const activeThread = this.context.getStore()?.threadId || '';
    return this.repository.mutate((data) => {
      recoverStaleClaims(data, openId);
      const sessions = ensureState(data).sessions;
      return [...sessions].reverse().find((item) => item.openId === openId && (!chatId || item.chatId === chatId) && (item.threadId || '') === activeThread && ACTIVE_STATES.has(item.status)) ?? null;
    });
  }

  async rememberPrivateChat({ openId, chatId }) {
    return this.repository.mutate((data) => {
      const state = ensureState(data);
      const existing = state.privateChats.find((item) => item.openId === openId && item.chatId === chatId);
      if (existing) {
        existing.updatedAt = new Date().toISOString();
        return;
      }
      state.privateChats.push({ openId, chatId, updatedAt: new Date().toISOString() });
      if (state.privateChats.length > 20) state.privateChats.splice(0, state.privateChats.length - 20);
    });
  }

  async isKnownPrivateChat({ openId, chatId }) {
    const data = await this.repository.read();
    return ensureState(data).privateChats.some((item) => item.openId === openId && item.chatId === chatId);
  }

  /**
   * Claims the one-off group-test prompt atomically. The record is deliberately
   * separate from study sessions: joining a test group must not start a review
   * task or alter Yangyang's learning state.
   */
  async claimGroupCheckinPrompt({ chatId, targetOpenId }) {
    return this.repository.mutate((data) => {
      const state = ensureState(data);
      const now = new Date().toISOString();
      let prompt = state.groupCheckinPrompts.find((item) => (
        item.kind === GROUP_CHECKIN_KIND
        && item.chatId === chatId
        && item.targetOpenId === targetOpenId
      ));
      if (prompt?.status === 'sent') return { claimed: false, prompt: { ...prompt } };
      if (prompt?.status === 'sending' && !isStale(prompt, Date.now())) {
        return { claimed: false, prompt: { ...prompt } };
      }
      if (!prompt) {
        prompt = {
          id: randomUUID(),
          kind: GROUP_CHECKIN_KIND,
          chatId,
          targetOpenId,
          createdAt: now
        };
        state.groupCheckinPrompts.push(prompt);
        if (state.groupCheckinPrompts.length > 20) state.groupCheckinPrompts.splice(0, state.groupCheckinPrompts.length - 20);
      }
      prompt.status = 'sending';
      // A stale process must not be allowed to complete or release a newer
      // claim. The prompt ID itself remains the outbound Feishu idempotency
      // key, while this token protects our local state transition.
      prompt.claimToken = randomUUID();
      prompt.claimedAt = now;
      prompt.updatedAt = now;
      return { claimed: true, prompt: { ...prompt } };
    });
  }

  async completeGroupCheckinPrompt({ promptId, claimToken, messageId }) {
    return this.repository.mutate((data) => {
      const prompt = ensureState(data).groupCheckinPrompts.find((item) => item.id === promptId);
      if (!prompt) return null;
      if (prompt.status === 'sent') return { ...prompt, idempotent: true };
      if (prompt.status !== 'sending' || prompt.claimToken !== claimToken) {
        return { ...prompt, completed: false };
      }
      prompt.status = 'sent';
      prompt.messageId = messageId ?? null;
      prompt.sentAt = new Date().toISOString();
      prompt.updatedAt = prompt.sentAt;
      delete prompt.claimToken;
      return { ...prompt, idempotent: false };
    });
  }

  async releaseGroupCheckinPrompt({ promptId, claimToken }) {
    return this.repository.mutate((data) => {
      const prompt = ensureState(data).groupCheckinPrompts.find((item) => item.id === promptId);
      if (!prompt || prompt.status === 'sent') return prompt ? { ...prompt } : null;
      if (prompt.status !== 'sending' || prompt.claimToken !== claimToken) {
        return { ...prompt, released: false };
      }
      prompt.status = 'queued';
      delete prompt.claimedAt;
      delete prompt.claimToken;
      prompt.updatedAt = new Date().toISOString();
      return { ...prompt };
    });
  }

  async claimAnswer({ sessionId, openId, messageId }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      if (!isOwnedBy(session, openId) || session.status !== 'awaiting_answer') return { claimed: false, session };
      session.status = 'answer_saving';
      session.answerMessageId = messageId;
      session.answerSourceId = `feishu:answer:${session.id}:${messageId}`;
      delete session.pendingMessage;
      session.updatedAt = new Date().toISOString();
      return { claimed: true, session: { ...session } };
    });
  }

  async stagePendingMessage({ sessionId, openId, messageId, content }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      if (!isOwnedBy(session, openId) || session.status !== 'awaiting_answer') return { staged: false, session };
      session.pendingMessage = {
        messageId,
        content: String(content ?? '').trim().slice(0, 8_000),
        createdAt: new Date().toISOString()
      };
      session.updatedAt = new Date().toISOString();
      return { staged: true, session: { ...session } };
    });
  }

  async claimPendingAnswer({ sessionId, openId, messageId }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      const pending = session?.pendingMessage;
      if (!isOwnedBy(session, openId) || session.status !== 'awaiting_answer' || pending?.messageId !== messageId) {
        return { claimed: false, session };
      }
      session.status = 'answer_saving';
      session.answerMessageId = messageId;
      session.answerSourceId = `feishu:answer:${session.id}:${messageId}`;
      session.updatedAt = new Date().toISOString();
      delete session.pendingMessage;
      return { claimed: true, session: { ...session }, content: pending.content };
    });
  }

  async dismissPendingMessage({ sessionId, openId, messageId }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      const pending = session?.pendingMessage;
      if (!isOwnedBy(session, openId) || session.status !== 'awaiting_answer' || pending?.messageId !== messageId) {
        return { dismissed: false, session };
      }
      delete session.pendingMessage;
      session.updatedAt = new Date().toISOString();
      return { dismissed: true, session: { ...session }, content: pending.content };
    });
  }

  async finishAnswer({ sessionId, openId, attemptId }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      if (!isOwnedBy(session, openId)) return null;
      if (session.status === 'awaiting_rating') return { ...session };
      if (session.status !== 'answer_saving') return null;
      session.status = 'awaiting_rating';
      session.answerAttemptId = attemptId;
      session.updatedAt = new Date().toISOString();
      return { ...session };
    });
  }

  async releaseAnswer({ sessionId, openId }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      if (isOwnedBy(session, openId) && session.status === 'answer_saving') {
        session.status = 'awaiting_answer';
        session.updatedAt = new Date().toISOString();
      }
      return session ? { ...session } : null;
    });
  }

  async claimRating({ sessionId, openId, rating }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      if (!isOwnedBy(session, openId) || session.status !== 'awaiting_rating') return { claimed: false, session };
      session.status = 'rating_saving';
      session.rating = rating;
      session.ratingSourceId = `feishu:rating:${session.id}`;
      session.updatedAt = new Date().toISOString();
      return { claimed: true, session: { ...session } };
    });
  }

  async finishRating({ sessionId, openId, reviewLogId }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      if (!isOwnedBy(session, openId)) return null;
      if (session.status === 'completed') return { ...session };
      if (session.status !== 'rating_saving') return null;
      session.status = 'completed';
      session.reviewLogId = reviewLogId;
      session.completedAt = new Date().toISOString();
      session.updatedAt = session.completedAt;
      return { ...session };
    });
  }

  async releaseRating({ sessionId, openId }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      if (isOwnedBy(session, openId) && session.status === 'rating_saving') {
        session.status = 'awaiting_rating';
        session.updatedAt = new Date().toISOString();
      }
      return session ? { ...session } : null;
    });
  }

  async cancel({ sessionId, openId }) {
    return this.repository.mutate((data) => {
      const session = findSession(data, sessionId);
      if (!isOwnedBy(session, openId)) return null;
      if (!ACTIVE_STATES.has(session.status)) return { ...session, cancelled: false };
      session.status = 'cancelled';
      session.updatedAt = new Date().toISOString();
      return { ...session, cancelled: true };
    });
  }

  async getConversationHistory(openId, chatId, threadId) {
    return this.memory.history(this.scope(openId, chatId, threadId), 8);
  }

  async rememberConversationTurn({ openId, chatId, threadId, userText, assistantText }) {
    return this.memory.append(this.scope(openId, chatId, threadId), { type: 'turn', user: safeConversationText(userText), assistant: safeConversationText(assistantText) });
  }
}
