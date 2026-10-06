import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalRepository } from '../src/repository.js';
import { createGroupConversation } from '../src/feishu/group-conversation.js';
import { ConversationMemory, conversationScope } from '../src/agent/memory.js';
import { ClarificationService } from '../src/knowledge/clarifications.js';

const scope = conversationScope({ appId: 'source-app', chatType: 'group', chatId: 'group' });
const message = (id, content, more = {}) => ({ chatId: scope.chatId, chatType: 'group', senderId: 'learner', messageId: id, content, rawContentType: 'text', ...more });

async function fixture(t, { downloadFailure = false, deliveryFailure = false, realClarifications = false, modelFailure = false, modelContent = '知识点解答' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'source-group-routing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = new LocalRepository(path.join(dir, 'data.json'));
  const memory = new ConversationMemory(repository);
  const calls = { enqueue: [], downloads: 0, worker: 0, model: [], next: [], bind: [], resolve: [], answer: [], defer: [], logs: [], sends: [] };
  let releaseWorker;
  const worker = new Promise(resolve => { releaseWorker = resolve; });
  t.after(releaseWorker);
  const knowledgeService = {
    mode: 'source_restoration',
    enqueue: async (...args) => { calls.enqueue.push(args); return { id: 'source-job' }; },
    processQueued: () => { calls.worker++; return worker; }
  };
  let invitation;
  const clarificationService = realClarifications ? new ClarificationService({ repository, approverId: 'learner' }) : {
    next: async (selectedScope, actor, binding) => {
      calls.next.push({ selectedScope, actor, binding });
      invitation = { id: 'INV-1', actorId: actor.id, sessionId: binding.sessionId, scopeKey: selectedScope.key, messageIds: [] };
      return { invitation, question: '这处原文是“孙”还是“顺”？' };
    },
    bindDelivery: async (id, delivery, actor, binding) => {
      calls.bind.push({ id, delivery, actor, binding });
      invitation.messageIds = delivery.messageIds;
    },
    resolveReply: async (selectedScope, actor, binding) => {
      calls.resolve.push({ selectedScope, actor, binding });
      if (!invitation || !invitation.messageIds.length || actor.id !== invitation.actorId || selectedScope.key !== invitation.scopeKey || binding.sessionId !== invitation.sessionId) return null;
      return binding.invitationId === invitation.id || invitation.messageIds.includes(binding.replyToMessageId) ? invitation : null;
    },
    answer: async (id, body, actor, binding) => { calls.answer.push({ id, body, actor, binding }); return { ok: true, message: '已记下你的界定，原文保留；这不是事实核验。' }; },
    defer: async (id, actor, binding) => { calls.defer.push({ id, actor, binding }); return { ok: true, message: '已暂缓这个疑点。' }; }
  };
  const provider = { isConfigured: () => true, complete: async req => {
    calls.model.push(req);
    if (modelFailure) throw new Error('model_failed');
    return { content: modelContent };
  } };
  const channel = {
    botIdentity: { openId: 'bot', name: '复习小助手' },
    send: async (...args) => {
      if (deliveryFailure) throw new Error('delivery_failed');
      calls.sends.push(args);
      return { messageId: `sent-${calls.sends.length}` };
    },
    rawClient: { im: { v1: { messageResource: { get: async () => {
      calls.downloads++;
      if (downloadFailure) throw new Error('download_failed');
      return { getReadableStream: () => Readable.from([Buffer.from('/9j/2Q==', 'base64')]) };
    } } } } }
  };
  const handle = createGroupConversation({ repository, provider, channel, chatId: scope.chatId, appId: scope.appId, yangyangOpenId: 'learner', ownerOpenId: 'admin', knowledgeService, clarificationService, logger: { warn: (...args) => calls.logs.push(args) } });
  return { calls, handle, memory, repository, knowledgeService, clarificationService, releaseWorker };
}

test('source photos enqueue silently and their running model work does not block a later explicit request', async t => {
  const f = await fixture(t);
  await f.handle(message('photo', '', { rawContentType: 'image', resources: [{ type: 'image', fileKey: 'resource' }] }));
  assert.equal(f.calls.enqueue.length, 1);
  assert.equal(f.calls.enqueue[0][0].key, scope.key);
  assert.equal(f.calls.enqueue[0][2][0].image_url.url, 'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(f.calls.worker, 1);
  assert.equal(f.calls.model.length, 0);
  assert.deepEqual(f.calls.sends, [], 'neither receipt, draft, link nor confirmation is posted for a photo');
  await f.handle(message('question', '小助手，请解释课程标准'));
  assert.equal(f.calls.model.length, 1, 'the queued source worker is still pending');
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.calls.sends[0][2].replyTo, 'question');
  assert.ok((await f.memory.session(scope)).events.some(event => event.type === 'source_photo_input' && event.jobId === 'source-job'));
});

test('source photo download failures remain silent and produce a diagnostic only', async t => {
  const f = await fixture(t, { downloadFailure: true });
  await f.handle(message('bad-photo', '', { rawContentType: 'image', resources: [{ type: 'image', fileKey: 'resource' }] }));
  assert.equal(f.calls.enqueue.length, 0);
  assert.equal(f.calls.worker, 0);
  assert.deepEqual(f.calls.sends, []);
  assert.equal(f.calls.logs.length, 1);
});

test('new source mode observes human conversation without responding and only accepts explicit assistant requests', async t => {
  const f = await fixture(t);
  for (const [index, content] of ['你好', '答案是什么', '给我讲解这个知识点', 'AI 发展得挺快', '小助手', '复习小助手今天挺好'].entries()) await f.handle(message(`human-${index}`, content));
  await f.handle(message('other-member', '小助手，给他讲解知识点', { mentions: [{ openId: 'another-person', name: '同学' }] }));
  await f.handle(message('wrong-bot', '请讲解知识点', { mentions: [{ openId: 'other-bot', isBot: true }] }));
  assert.equal(f.calls.model.length, 0);
  assert.deepEqual(f.calls.sends, []);
  assert.equal((await f.memory.session(scope)).events.filter(event => event.type === 'inbound').length, 8);
  await f.handle(message('named', 'AI，请给出这个知识点的答案'));
  await f.handle(message('native', '@复习小助手 请解释课程标准', { mentions: [{ openId: 'bot', name: '复习小助手' }], mentionedBot: true }));
  assert.equal(f.calls.model.length, 2);
  assert.deepEqual(f.calls.sends.map(call => call[2].replyTo), ['named', 'native']);
});

for (const [index, content] of ['夸夸羊羊', '她答得不错就夸夸 记住了吗', '你好', '谢谢', '嗯', '🙂'].entries()) {
  test(`native bot mention always reaches the agent without a keyword gate: ${content}`, async t => {
    const f = await fixture(t);
    const id = `mention-${index}`;
    await f.handle(message(id, content, { senderId: 'admin', mentions: [{ openId: 'bot', isBot: true }] }));
    assert.equal(f.calls.model.length, 1);
    assert.equal(JSON.parse(f.calls.model[0].messages.at(-1).content).text, content);
    assert.match(f.calls.model[0].messages[0].content, /必须给出简短文字回复/);
    assert.equal(f.calls.sends.length, 1);
    assert.equal(f.calls.sends[0][2].replyTo, id);
  });
}

test('empty native mentions and mixed member mentions still reach the agent', async t => {
  const f = await fixture(t);
  await f.handle(message('empty-mention', '@_user_1', { mentions: [{ openId: 'bot', key: '@_user_1' }] }));
  await f.handle(message('flag-mention', '', { mentionedBot: true }));
  await f.handle(message('mixed-mention', '夸夸羊羊', { mentions: [{ openId: 'learner' }, { openId: 'bot' }] }));
  assert.equal(f.calls.model.length, 3);
  assert.match(JSON.parse(f.calls.model[0].messages.at(-1).content).text, /没有附加文字/);
  assert.match(JSON.parse(f.calls.model[1].messages.at(-1).content).text, /没有附加文字/);
  assert.deepEqual(f.calls.sends.map(call => call[2].replyTo), ['empty-mention', 'flag-mention', 'mixed-mention']);
});

test('clear assistant name calls no longer require task keywords', async t => {
  const f = await fixture(t);
  await f.handle(message('named-praise', '小助手，夸夸羊羊'));
  await f.handle(message('named-hello', '复习小助手，你好'));
  assert.equal(f.calls.model.length, 2);
  assert.deepEqual(f.calls.sends.map(call => call[2].replyTo), ['named-praise', 'named-hello']);
});

test('mentioned images enqueue in the background and receive an agent reply without downloading twice', async t => {
  const f = await fixture(t);
  await f.handle(message('mentioned-photo', '看这张图', { rawContentType: 'post', resources: [{ type: 'image', fileKey: 'resource' }], mentions: [{ openId: 'bot' }] }));
  assert.equal(f.calls.enqueue.length, 1);
  assert.equal(f.calls.worker, 1);
  assert.equal(f.calls.downloads, 1);
  assert.equal(f.calls.model.length, 1);
  assert.equal(f.calls.model[0].messages.at(-1).content[1].image_url.url, f.calls.enqueue[0][2][0].image_url.url);
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.calls.sends[0][2].replyTo, 'mentioned-photo');
});

test('mentioned image download failures send an error reply', async t => {
  const f = await fixture(t, { downloadFailure: true });
  await f.handle(message('failed-mentioned-photo', '', { rawContentType: 'image', resources: [{ type: 'image', fileKey: 'resource' }], mentions: [{ openId: 'bot' }] }));
  assert.equal(f.calls.model.length, 0);
  assert.equal(f.calls.sends.length, 1);
  assert.match(f.calls.sends[0][1].text, /失败/);
});

test('mentioned messages receive visible text when the model fails or returns only a reaction', async t => {
  for (const options of [{ modelFailure: true }, { modelContent: '{"text":"","reaction":"CLAP"}' }]) {
    const f = await fixture(t, options);
    await f.handle(message('failed-mention', '夸夸羊羊', { mentions: [{ openId: 'bot' }] }));
    assert.equal(f.calls.model.length, 1);
    assert.equal(f.calls.sends.length, 1);
    assert.match(f.calls.sends[0][1].text, /模型回复暂时不可用/);
  }
});

test('review asks one short clarification and accepts only the learner explicit reply or invitation command', async t => {
  const f = await fixture(t);
  await f.handle(message('review', '小助手，开始复习'));
  assert.equal(f.calls.next.length, 1);
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.calls.bind.length, 1);
  assert.deepEqual(f.calls.bind[0].delivery.messageIds, ['sent-1']);
  assert.equal(f.calls.model.length, 0);
  await f.handle(message('human', '这里应该是孙'));
  await f.handle(message('outsider', '孙', { senderId: 'another-person', replyToMessageId: 'sent-1' }));
  await f.handle(message('unrelated-reply', '孙', { replyToMessageId: 'other-message' }));
  await f.handle(message('redirected-reply', '孙', { replyToMessageId: 'sent-1', mentions: [{ openId: 'another-person' }] }));
  assert.equal(f.calls.answer.length, 0);
  await f.handle(message('answer', '原文是孙', { replyToMessageId: 'sent-1' }));
  assert.equal(f.calls.answer.length, 1);
  assert.deepEqual(f.calls.answer[0].body, { text: '原文是孙', idempotencyKey: 'answer' });
  assert.deepEqual(f.calls.answer[0].actor, { id: 'learner', role: 'learner' });
  assert.equal(f.calls.answer[0].binding.scopeKey, scope.key);
  await f.handle(message('explicit-answer', '回答疑点 INV-1：我指的是原文中的孙'));
  assert.equal(f.calls.answer.length, 2);
  assert.equal(f.calls.next.length, 1, 'answering never immediately asks another question');
  assert.equal(f.calls.model.length, 0);
});

test('undelivered clarification and reset sessions cannot capture later group replies', async t => {
  const failed = await fixture(t, { deliveryFailure: true });
  await failed.handle(message('review', '小助手，复习'));
  assert.equal(failed.calls.bind.length, 0);
  await failed.handle(message('answer', '回答疑点 INV-1：孙'));
  assert.equal(failed.calls.answer.length, 0);
  const f = await fixture(t);
  await f.handle(message('review', '小助手，复习'));
  await f.handle(message('reset', '/new'));
  await f.handle(message('stale-answer', '原文是孙', { replyToMessageId: 'sent-1' }));
  assert.equal(f.calls.answer.length, 0);
  assert.equal(f.calls.model.length, 0);
});

test('a learner can defer only an explicitly addressed delivered clarification', async t => {
  const f = await fixture(t);
  await f.handle(message('review', '小助手，问我一道知识点'));
  await f.handle(message('ordinary', '不知道'));
  assert.equal(f.calls.defer.length, 0);
  await f.handle(message('defer', '不知道', { replyToMessageId: 'sent-1' }));
  assert.equal(f.calls.defer.length, 1);
  assert.equal(f.calls.answer.length, 0);
  assert.equal(f.calls.next.length, 1);
});

test('group controller binds real clarification invitations and saves learner meaning without rewriting source notes', async t => {
  const f = await fixture(t, { realClarifications: true });
  await f.repository.mutate(data => {
    data.photoKnowledge = { documents: { note: { id: 'note', materialKind: 'source_note', scopeKey: scope.key, currentVersion: 1, title: '学记', revisions: [{ version: 1, title: '学记', archivedBy: 'learner', items: [{ id: 'B1', title: '原文', text: '不陵节而施之谓孙' }] }] } } };
    data.photoClarifications = { issues: { issue: { id: 'issue', documentId: 'note', scopeKey: scope.key, sourceVersion: 1, blockId: 'B1', revision: 1, status: 'open', kind: 'ocr', prompt: '此处应为孙还是顺？', createdAt: new Date().toISOString() } }, invitations: {}, events: [] };
  });
  await f.handle(message('review', '小助手，复习'));
  let data = await f.repository.read();
  const invite = Object.values(data.photoClarifications.invitations)[0];
  assert.ok(invite.deliveredAt);
  assert.deepEqual(invite.messageIds, ['sent-1']);
  await f.handle(message('other-human', '我觉得是顺', { senderId: 'another-person', replyToMessageId: 'sent-1' }));
  assert.equal((await f.repository.read()).photoClarifications.issues.issue.status, 'open');
  await f.handle(message('defer', '不知道', { replyToMessageId: 'sent-1' }));
  data = await f.repository.read();
  assert.equal(data.photoClarifications.invitations[invite.id].status, 'deferred');
  assert.equal(data.photoClarifications.issues.issue.status, 'open');
  await f.repository.mutate(next => { delete next.photoClarifications.issues.issue.deferredUntil; });
  await f.handle(message('retry-review', '小助手，复习'));
  await f.handle(message('answer', '我的笔记写的是孙', { replyToMessageId: 'sent-3' }));
  data = await f.repository.read();
  assert.equal(data.photoClarifications.issues.issue.status, 'resolved');
  assert.equal(data.photoClarifications.issues.issue.answer.provenance, 'user_defined');
  assert.equal(data.photoClarifications.issues.issue.answer.actor, 'learner');
  assert.equal(data.photoKnowledge.documents.note.revisions[0].items[0].text, '不陵节而施之谓孙');
  assert.equal(f.calls.model.length, 0);
});

async function seedScopedSources(f) {
  await f.repository.mutate(data => {
    const documents = {};
    for (let index = 0; index < 4; index++) {
      const id = `source-${index}`;
      documents[id] = { id, scopeKey: scope.key, materialKind: 'source_note', title: `笔记 ${index}`, currentVersion: 1,
        revisions: [{ version: 1, archivedBy: 'system:source-restoration', title: `笔记 ${index}`, items: [{ id: 'block', title: '课程标准',
          text: '课程标准是教学参考。'.repeat(500) + 'FULL_TRANSCRIPTION_TAIL', originalText: 'DO_NOT_INCLUDE_ORIGINAL_TEXT', factStatus: 'not_checked' }] }] };
    }
    documents.private = { id: 'private', scopeKey: 'private-other-scope', materialKind: 'source_note', currentVersion: 1,
      revisions: [{ version: 1, archivedBy: 'system:source-restoration', items: [{ id: 'block', title: '课程标准', text: 'PRIVATE_SOURCE_SECRET' }] }] };
    const drafts = {};
    for (let index = 0; index < 4; index++) drafts[`job-${index}`] = { id: `job-${index}`, mode: 'source_restoration', scopeKey: scope.key,
      createdAt: `2026-09-28T10:00:0${index}.000Z`, status: index === 3 ? 'aligning' : 'saved', stage: index === 3 ? 'aligning' : 'completed',
      sourceContent: { title: `图片 ${index}`, transcription: 'DO_NOT_INCLUDE_JOB_TRANSCRIPTION' }, reads: [{ raw: 'DO_NOT_INCLUDE_OCR' }], assets: [{ secret: 'DO_NOT_INCLUDE_ASSETS' }] };
    drafts.private = { id: 'private-job', mode: 'source_restoration', scopeKey: 'private-other-scope', createdAt: '2030-01-01T00:00:00Z', sourceContent: { title: 'PRIVATE_IMAGE_SECRET' } };
    data.photoKnowledge = { documents, drafts };
    data.photoClarifications = { issues: { answer: { id: 'answer', documentId: 'source-0', scopeKey: scope.key, sourceVersion: 1, blockId: 'block',
      status: 'resolved', kind: 'knowledge', answer: { text: '这是我后来补充的个人定义', at: '2026-09-28T11:00:00Z' } } }, invitations: {}, events: [] };
  });
}

test('source mode prompts use bounded scoped excerpts, personal answers, photo status and distinct observed speakers', async t => {
  const f = await fixture(t);
  await seedScopedSources(f);
  await f.memory.append(scope, { type: 'turn', user: JSON.stringify({ speaker: '成员甲', text: '课程标准是我刚才的问题' }), assistant: '上一轮回答' });
  await f.handle(message('human-remark', '我是在问另一位同学', { senderId: 'another-person' }));
  await f.handle(message('source-question', '小助手，请解释课程标准，并说明刚才图片处理的状态'));
  const request = f.calls.model.at(-1);
  const line = request.messages[0].content.split('\n').find(text => text.startsWith('本范围资料、图片状态和最近群消息'));
  const context = JSON.parse(line.slice(line.indexOf('：') + 1));
  assert.equal(context.saved_knowledge.length, 3);
  assert.ok(context.saved_knowledge.every(item => item.excerpt.length <= 401));
  assert.equal(context.saved_knowledge[0].materialKind, 'source_note');
  const personal = context.saved_knowledge.flatMap(item => item.userDefinedAnswers).find(answer => answer.text === '这是我后来补充的个人定义');
  assert.equal(personal.provenance, 'user_defined');
  assert.equal(context.recent_image_jobs.length, 3);
  assert.equal(context.recent_image_jobs[0].status, 'aligning');
  assert.equal(context.recent_group_messages[0].senderId, 'another-person');
  assert.equal(context.recent_group_messages[1].senderId, 'learner');
  const historical = JSON.parse(request.messages[1].content);
  assert.equal(historical.speaker, '成员甲');
  assert.equal(historical.text, '课程标准是我刚才的问题', 'history text does not double-encode the speaker wrapper');
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_SOURCE_SECRET|PRIVATE_IMAGE_SECRET|FULL_TRANSCRIPTION_TAIL|DO_NOT_INCLUDE/);
  assert.match(request.messages[0].content, /已有任务就不能说没收到/);
  assert.match(request.messages[0].content, /不是已证实知识或权威答案/);
  assert.doesNotMatch(request.messages[0].content, /图片没有自动保存进知识库|修改图片草稿可发/);
});

test('source-mode knowledge lookup returns only short scoped excerpts and labeled personal answers', async t => {
  const f = await fixture(t);
  await seedScopedSources(f);
  await f.handle(message('lookup', '小助手，知识库查询：课程标准'));
  assert.equal(f.calls.model.length, 0);
  assert.equal(f.calls.sends.length, 1);
  const text = f.calls.sends[0][1].text;
  assert.ok(text.length < 1300);
  assert.match(text, /图片原文参考，事实未经确认/);
  assert.match(text, /你后来补充的答案（个人界定）：这是我后来补充的个人定义/);
  assert.doesNotMatch(text, /PRIVATE_SOURCE_SECRET|FULL_TRANSCRIPTION_TAIL|DO_NOT_INCLUDE|https?:|\/api\/knowledge|请回查原页|请打开知识点详情/);
});

test('source-mode reset and context messages describe automatic source archiving without legacy confirmation instructions', async t => {
  const f = await fixture(t);
  await f.handle(message('context', '/上下文'));
  await f.handle(message('reset', '/new'));
  const text = f.calls.sends.map(call => call[1].text).join('\n');
  assert.match(text, /后台自动归档/);
  assert.match(text, /旧疑点邀请已失效/);
  assert.doesNotMatch(text, /草稿|确认入库|确认才能|确认知识/);
});
