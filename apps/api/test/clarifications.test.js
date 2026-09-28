import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRepository } from '../src/repository.js';
import { ConversationMemory, conversationScope } from '../src/agent/memory.js';
import { ClarificationService } from '../src/knowledge/clarifications.js';
import { startServer, testHash } from './helpers/http-server.js';

const scope = conversationScope({ appId: 'cq-app', chatType: 'group', chatId: 'cq-group' });
const foreign = conversationScope({ appId: 'other-app', chatType: 'group', chatId: 'cq-group' });
const topic = conversationScope({ appId: 'cq-app', chatType: 'group', chatId: 'cq-group', threadId: 'private-topic' });
const learner = { id: 'ou_learner', role: 'learner' }, admin = { id: 'admin', role: 'admin' };
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), '333-clarifications-'));
  const file = path.join(directory, 'data.json');
  const repository = new LocalRepository(file, { knowledgePolicy: { appId: 'cq-app', groupId: 'cq-group', scopeKeys: [] } });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memory = new ConversationMemory(repository), sessionId = (await memory.session(scope)).id;
  await memory.session(foreign); await memory.session(topic);
  await repository.mutate(data => {
    data.photoKnowledge = { drafts: {}, documents: {}, events: [] };
    data.photoClarifications = { issues: {}, invitations: {}, events: [] };
    for (const [suffix, sourceScope] of [['11111111', scope], ['22222222', foreign], ['33333333', topic]]) {
      const documentId = `KP-${suffix}`;
      data.photoKnowledge.documents[documentId] = { id: documentId, scopeKey: sourceScope.key, materialKind: 'source_note', title: '图片笔记', currentVersion: 1,
        revisions: [{ version: 1, title: '图片笔记', archivedBy: 'system:source-restoration', transcription: '原图写：启法性。\n第二条暂存原文。', items: [
          { id: 'K1', title: '原图疑字', text: '原图写：启法性。', region: '图1上部', uncertain: true },
          { id: 'K2', title: '概念疑点', text: '第二条暂存原文。', region: '图1下部', uncertain: false }
        ] }] };
      for (const [n, kind] of [[1, 'ocr'], [2, 'knowledge']]) {
        const id = `CQ-${suffix}-${n}`;
        data.photoClarifications.issues[id] = { id, documentId, scopeKey: sourceScope.key, sourceVersion: 1, blockId: `K${n}`, kind,
          status: 'open', prompt: n === 1 ? '上部这个字你写的是哪一个？' : '你希望怎样界定这个概念？', originalText: n === 1 ? '原图写：启法性。' : '第二条暂存原文。',
          region: n === 1 ? '图1上部' : '图1下部', candidates: [], createdAt: `2026-09-0${3 - n}T00:00:00Z`, revision: 1, answers: [] };
      }
    }
  });
  return { file, repository, memory, sessionId, context: { scopeKey: scope.key, sessionId }, service: new ClarificationService({ repository, approverId: learner.id }) };
}
async function invited(f) {
  const result = await f.service.next(scope, learner, { sessionId: f.sessionId });
  await f.service.bindDelivery(result.invitation.id, { messageIds: [`out-${result.invitation.id}`] }, learner, f.context);
  return result;
}

test('clarifications expose only current archived source notes within web library policy', async t => {
  const f = await fixture(t);
  const list = await f.service.list({}, admin);
  assert.equal(list.total, 2); assert.equal(list.openCount, 2);
  assert.ok(list.items.every(issue => issue.documentId === 'KP-11111111'));
  assert.equal((await f.service.list({ scopeKey: foreign.key }, learner)).total, 0);
  await assert.rejects(f.service.list({}, { id: 'outsider', role: 'unbound' }), { statusCode: 403 });
  await f.repository.mutate(data => { data.photoKnowledge.documents['KP-11111111'].currentVersion = 2; });
  assert.equal((await f.service.list({}, learner)).total, 0);
});

test('group invitations prefer OCR, require delivery, exact learner, scope and explicit reply', async t => {
  const f = await fixture(t);
  const first = await f.service.next(scope, learner, { sessionId: f.sessionId });
  assert.equal(first.issue.kind, 'ocr'); assert.doesNotMatch(first.question, /原图写：启法性/);
  assert.equal((await f.service.next(scope, learner, { sessionId: f.sessionId })).invitation.id, first.invitation.id);
  const submit = (actor = learner, context = f.context) => f.service.answer(first.invitation.id, { text: '是启发性', idempotencyKey: 'answer-1' }, actor, context);
  await assert.rejects(submit(), /尚未送达/);
  await f.service.bindDelivery(first.invitation.id, { messageIds: ['om-question'] }, learner, f.context);
  assert.equal(await f.service.resolveReply(scope, learner, { sessionId: f.sessionId }), null);
  assert.equal((await f.service.resolveReply(scope, learner, { replyToMessageId: 'om-question', sessionId: f.sessionId })).id, first.invitation.id);
  assert.equal(await f.service.resolveReply(scope, learner, { replyToMessageId: 'other-message', sessionId: f.sessionId }), null);
  await assert.rejects(submit(admin), { statusCode: 403 });
  await assert.rejects(submit({ id: 'other', role: 'learner' }), { statusCode: 403 });
  await assert.rejects(submit(learner, { ...f.context, scopeKey: foreign.key }), { statusCode: 409 });
  await assert.rejects(new ClarificationService({ repository: f.repository }).next(scope, learner), { statusCode: 403 });
});

test('answers are idempotent user-defined annotations and preserve original text and fact states', async t => {
  const f = await fixture(t), next = await invited(f);
  const before = await f.repository.read(), original = structuredClone(before.photoKnowledge.documents), v2 = structuredClone(before.knowledgeV2);
  const args = { text: '我写的是启发性。', idempotencyKey: 'same-request' };
  const answer = await f.service.answer(next.invitation.id, args, learner, f.context);
  assert.equal(answer.answer.provenance, 'user_defined'); assert.equal(answer.issue.status, 'resolved');
  assert.equal((await f.service.answer(next.invitation.id, args, learner, f.context)).duplicate, true);
  await assert.rejects(f.service.answer(next.invitation.id, { ...args, text: '改写另一种回答' }, learner, f.context), { statusCode: 409 });
  await assert.rejects(f.service.answer(next.invitation.id, { ...args, idempotencyKey: 'different-request' }, learner, f.context), { statusCode: 409 });
  const after = await f.repository.read();
  assert.deepEqual(after.photoKnowledge.documents, original); assert.deepEqual(after.knowledgeV2, v2);
  assert.equal(after.photoClarifications.issues[next.issue.id].answers.length, 1);
  assert.equal((await f.service.list({}, learner)).items.find(issue => issue.id === next.issue.id).answer.text, args.text);
});

for (const reason of ['expired', 'reset', 'source-version', 'issue-revision']) test(`stale clarification invitations reject ${reason}`, async t => {
  const f = await fixture(t), next = await invited(f);
  if (reason === 'reset') await f.memory.reset(scope);
  else await f.repository.mutate(data => {
    if (reason === 'expired') data.photoClarifications.invitations[next.invitation.id].expiresAt = '2000-01-01T00:00:00Z';
    if (reason === 'source-version') data.photoKnowledge.documents[next.issue.documentId].currentVersion = 2;
    if (reason === 'issue-revision') data.photoClarifications.issues[next.issue.id].revision++;
  });
  await assert.rejects(f.service.answer(next.invitation.id, { text: '旧问题的答案', idempotencyKey: 'stale' }, learner, f.context), { statusCode: 409 });
  assert.equal((await f.repository.read()).photoClarifications.issues[next.issue.id].answers.length, 0);
});

test('defer keeps uncertainty open and lets another question proceed', async t => {
  const f = await fixture(t), first = await invited(f);
  const result = await f.service.defer(first.invitation.id, learner, f.context);
  assert.equal(result.issue.status, 'open'); assert.equal(result.issue.answer, undefined);
  assert.equal((await f.service.next(scope, learner, { sessionId: f.sessionId })).issue.kind, 'knowledge');
  await assert.rejects(f.service.answer(first.invitation.id, { text: 'late answer', idempotencyKey: 'late' }, learner, f.context), { statusCode: 409 });
});

test('web HTTP offers clarifications before random practice and protects learner answer actions', async t => {
  const f = await fixture(t);
  const server = await startServer(f.file, { FEISHU_APP_ID: 'cq-app', FEISHU_TEST_GROUP_ID: 'cq-group', WEB_USERS: `tester:${testHash},admin:${testHash}`, WEB_ADMIN_USERS: 'admin' });
  t.after(() => server.stop());
  assert.equal((await fetch(server.url + '/api/knowledge-v2/clarifications')).status, 401);
  const cookie = (await server.login()).headers.get('set-cookie').split(';')[0];
  const adminCookie = (await server.login('admin')).headers.get('set-cookie').split(';')[0];
  const post = (route, body, c = cookie) => fetch(server.url + '/api/knowledge-v2' + route, { method: 'POST', headers: { cookie: c, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const list = await (await fetch(server.url + '/api/knowledge-v2/clarifications', { headers: { cookie: adminCookie } })).json();
  assert.equal(list.total, 2);
  for (const route of ['/clarifications/next', '/clarifications/answers', '/clarifications/defer', '/photo-jobs/KP-11111111/retry']) assert.equal((await post(route, {}, adminCookie)).status, 403);
  const first = await (await post('/spot-checks', {})).json();
  assert.equal(first.type, 'clarification'); assert.equal(first.issue.kind, 'ocr');
  const response = await post('/clarifications/answers', { invitationId: first.invitation.id, text: '我定义为启发性', idempotencyKey: 'web-1' });
  assert.equal(response.status, 200); assert.equal((await response.json()).answer.provenance, 'user_defined');
  assert.equal((await post('/clarifications/answers', { invitationId: first.invitation.id, text: 'x', idempotencyKey: 'web-2' })).status, 409);
  const next = await (await post('/clarifications/next', {})).json();
  assert.equal(next.issue.kind, 'knowledge');
  assert.equal((await post('/clarifications/defer', { invitationId: next.invitation.id })).status, 200);
  const fallback = await post('/spot-checks', {});
  assert.equal(fallback.status, 409); assert.match((await fallback.json()).error, /抽查/);
  const foreignAnswer = await post('/clarifications/answers', { invitationId: 'CI-invented', text: 'wrong', idempotencyKey: 'wrong' });
  assert.equal(foreignAnswer.status, 403);
  const crossOrigin = await fetch(server.url + '/api/knowledge-v2/clarifications/next', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://untrusted.example' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  // Seed after startup recovery; these synthetic queued jobs must not execute a model.
  await f.repository.mutate(data => {
    for (const [id, sourceScope] of [['KP-11111111', scope], ['KP-22222222', foreign]]) data.photoKnowledge.drafts[id] = {
      id, mode: 'source_restoration', scopeKey: sourceScope.key, status: 'queued', stage: 'queued', assets: [], reads: [],
      createdAt: '2026-09-01T00:00:00Z', sourceContent: { title: '测试原文', transcription: '原文必须保留。', items: [] }
    };
  });
  const jobs = await (await fetch(server.url + '/api/knowledge-v2/photo-jobs', { headers: { cookie } })).json();
  assert.equal(jobs.total, 1); assert.equal(jobs.items[0].id, 'KP-11111111');
  const visibleJob = await (await fetch(server.url + '/api/knowledge-v2/photo-jobs/KP-11111111', { headers: { cookie: adminCookie } })).json();
  assert.equal(visibleJob.content.transcription, '原文必须保留。');
  assert.equal((await post('/photo-jobs/KP-11111111/retry', {})).status, 409);
  assert.equal((await fetch(server.url + '/api/knowledge-v2/photo-jobs/KP-22222222', { headers: { cookie } })).status, 404);
});
