import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRepository } from '../src/repository.js';
import { StudyService } from '../src/study-service.js';
import { PhotoKnowledgeService } from '../src/knowledge/service.js';
import { conversationScope } from '../src/agent/memory.js';
import { ArkStudyAgent } from '../src/ark/agent.js';
import { startServer } from './helpers/http-server.js';
import { scheduleReview } from '../src/domain/scheduler.js';

const scope = conversationScope({ appId: 'test-app', chatType: 'group', chatId: 'study-group' });
const foreign = conversationScope({ appId: 'test-app', chatType: 'group', chatId: 'other-group' });
function document(scopeKey = scope.key, id = 'KP-1234abcd') {
  return { id, scopeKey, currentVersion: 1, revisions: [{
    version: 1, title: '高频资料', confirmedBy: 'learner', savedAt: '2026-09-18T00:00:00Z',
    items: [
      { id: 'K1', title: '教学原则', text: '循序渐进，联系实际。', evidenceStatus: 'supported', citations: ['https://example.org/reference'] },
      { id: 'K2', title: '课程分类', text: '保留疑点的存档', evidenceStatus: 'unresolved', citations: [] }
    ]
  }] };
}
async function fixture(t) {
  const folder = await mkdtemp(path.join(tmpdir(), '333-library-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'data.json');
  const repository = new LocalRepository(file, { knowledgePolicy: { appId: 'test-app', groupId: 'study-group', scopeKeys: [] } });
  await repository.mutate(data => {
    data.photoKnowledge = { documents: { main: document(), foreign: document(foreign.key, 'KP-9876abcd') }, drafts: { draft: { status: 'awaiting_confirmation', versions: [{ content: { title: 'SECRET-DRAFT' } }] } }, events: [] };
  });
  return { repository, file };
}

test('saved knowledge populates study library, retires removed items, preserves history and scope isolation', async t => {
  const { repository, file } = await fixture(t);
  const service = new StudyService(repository);
  let data = await repository.read();
  const points = data.knowledgePoints.filter(p => p.sourceKind === 'saved_knowledge');
  assert.equal(points.length, 2);
  assert.ok(points.every(p => p.sourceScopeKey === scope.key));
  assert.ok(data.knowledgePoints.filter(p => p.sourceLabel === '演示知识库').every(p => p.hidden));
  const dashboard = await service.getDashboard();
  assert.equal(dashboard.tasks.length, 2);
  assert.equal(dashboard.tasks[0].title, '教学原则');
  assert.equal(dashboard.tasks[0].reference.version, 1);
  const id = dashboard.tasks[0].knowledgePointId;
  await service.recordReview({ knowledgePointId: id, rating: 'good', reviewedOn: '2026-09-18' });
  const before = await repository.read();
  await repository.mutate(d => {
    const doc = d.photoKnowledge.documents.main;
    doc.revisions.push({ ...doc.revisions[0], version: 2, items: [{ ...doc.revisions[0].items[0], text: '修订后的教学原则' }] });
    doc.currentVersion = 2;
  });
  data = await new LocalRepository(file, { knowledgePolicy: repository.knowledgePolicy }).read();
  assert.deepEqual(data.reviewStates, before.reviewStates);
  assert.deepEqual(data.reviewLogs, before.reviewLogs);
  assert.equal(data.knowledgePoints.find(p => p.id === id).sourceVersion, 2);
  assert.equal(data.knowledgePoints.find(p => p.id === id).text, '修订后的教学原则');
  assert.equal(data.knowledgePoints.find(p => p.id === points[1].id).archived, true);
  await assert.rejects(service.getPracticeTask(points[1].id));
  const snapshot = JSON.stringify(data.knowledgePoints);
  await Promise.all([repository.read(), repository.mutate(d => { d.taskCompletionLogs.push({ id: 'concurrent-write' }); }), repository.read()]);
  assert.equal(JSON.stringify((await repository.read()).knowledgePoints), snapshot);
  assert.ok((await repository.read()).taskCompletionLogs.some(x => x.id === 'concurrent-write'));
});

test('Web API and private agent read latest saved knowledge; unresolved data remains labelled for self-recall', async t => {
  const { repository, file } = await fixture(t);
  const server = await startServer(file, { FEISHU_APP_ID: 'test-app', FEISHU_TEST_GROUP_ID: 'study-group' });
  t.after(() => server.stop());
  const cookie = (await server.login()).headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'Content-Type': 'application/json' };
  const response = await fetch(server.url + '/api/knowledge-points', { headers });
  assert.equal(response.status, 200);
  const points = await response.json();
  assert.equal(points.length, 2);
  const pending = points.find(p => p.evidenceStatus === 'unresolved');
  assert.equal(pending.practiceEligible, true);
  assert.equal(pending.forgottenOn, '2026-09-18');
  assert.equal((await fetch(server.url + '/api/reviews', { method: 'POST', headers, body: JSON.stringify({ knowledgePointId: pending.id, rating: 'good' }) })).status, 201);
  const calls = [];
  const agent = new ArkStudyAgent({ repository, provider: { isConfigured: () => true, complete: async input => { calls.push(input); return { content: '依据资料回答', modelId: 'fake' }; } } });
  await agent.chat({ message: '讲讲教学原则', profile: {}, runtimeSummary: {} });
  assert.match(JSON.stringify(calls[0]), /循序渐进/);
  assert.doesNotMatch(JSON.stringify(calls[0]), /SECRET-DRAFT|9876abcd/);
  await repository.mutate(d => { d.photoKnowledge.documents.main.revisions[0].items[0].text = '即时新内容'; });
  await agent.chat({ message: '讲讲教学原则', profile: {}, runtimeSummary: {} });
  assert.match(JSON.stringify(calls[1]), /即时新内容/);
  await agent.chat({ message: '课程分类', profile: {}, runtimeSummary: {} });
  assert.match(JSON.stringify(calls[2]), /unresolved/);
});

test('group natural knowledge lookup uses only current scope and current saved version', async t => {
  const { repository } = await fixture(t);
  let received;
  const service = new PhotoKnowledgeService({ repository, model: { answerSavedKnowledge: async (_question, items) => { received = items; return '资料回答'; } } });
  const answer = await service.handleText(scope, { content: '说说教学原则', senderId: 'learner' });
  assert.match(answer.text, /教学原则【有来源支持】/);
  assert.doesNotMatch(answer.text, /v1/);
  assert.equal(received.length, 1);
  assert.equal(received[0].sourceDocumentId, 'KP-1234abcd');
  const thread = conversationScope({ appId: 'test-app', chatType: 'group', chatId: 'study-group', threadId: 'other-topic' });
  assert.equal(await service.handleText(thread, { content: '教学原则', senderId: 'learner' }), null);
  const pending = await service.handleText(scope, { content: '课程分类', senderId: 'learner' });
  assert.match(pending.text, /待核验/);
});

test('queued feedback retains original knowledge reference after source revision', async t => {
  const { repository } = await fixture(t);
  const service = new StudyService(repository);
  const point = (await service.getDashboard()).tasks[0];
  const task = await service.getPracticeTask(point.knowledgePointId);
  const attempt = await service.saveAnswer({ knowledgePointId: point.knowledgePointId, content: '回忆答案', sourceId: 'reference-test' });
  const { job } = await service.feedbackService.enqueue({ attempt, task, idempotencyKey: 'reference-test', channel: 'web' });
  await repository.mutate(data => {
    const doc = data.photoKnowledge.documents.main;
    doc.currentVersion = 2;
    doc.revisions.push({ ...doc.revisions[0], version: 2, items: [{ ...doc.revisions[0].items[0], text: '新版本正文' }] });
  });
  const saved = (await repository.read()).feedbackJobs.find(item => item.id === job.id);
  assert.equal(saved.sourceSnapshot.reference.version, 1);
  assert.equal(saved.taskSnapshot.reference.text, '循序渐进，联系实际。');
  assert.equal((await service.getPracticeTask(point.knowledgePointId)).reference.version, 2);
});

test('upload date anchors all forgotten items, revision/restart preserve schedule, recall generates the next date', async t => {
  const { repository, file } = await fixture(t);
  await repository.mutate(data => {
    const doc = document(scope.key, 'KP-aaaabbbb');
    doc.uploadedAt = '2026-09-22T16:30:00Z'; // Shanghai September 23
    doc.revisions[0].savedAt = '2026-09-24T00:00:00Z'; // approval must not move the upload anchor
    doc.revisions[0].items = Array.from({ length: 8 }, (_, n) => ({ id: `K${n}`, title: `高频知识${n}`, text: '曾经学过', evidenceStatus: 'unresolved' }));
    data.photoKnowledge.documents = { main: doc };
  });
  const service = new StudyService(repository);
  const tasks = (await service.getDashboard('2026-09-23')).tasks;
  assert.equal(tasks.length, 8, 'all upload-day items are due even above the ordinary cap');
  const id = tasks[0].knowledgePointId;
  const initial = await repository.read();
  const point = initial.knowledgePoints.find(p => p.id === id);
  assert.equal(point.forgottenOn, '2026-09-23');
  assert.equal(point.firstLearnedOn, null);
  assert.equal(point.previouslyLearned, true);
  assert.equal(initial.reviewStates.find(s => s.knowledgePointId === id).nextReviewOn, '2026-09-23');
  assert.doesNotMatch(point.sourceLabel, /v\d/);
  await assert.rejects(service.recordReview({ knowledgePointId: id, rating: 'good', reviewedOn: '2026-09-22' }));
  const review = await service.recordReview({ knowledgePointId: id, rating: 'good', reviewedOn: '2026-09-23', sourceId: 'one-recall' });
  assert.equal(review.state.nextReviewOn, '2026-09-26');
  assert.equal((await service.getDashboard('2026-09-23')).tasks.some(t => t.knowledgePointId === id), false);
  assert.equal((await service.getDashboard('2026-09-24')).tasks.some(t => t.knowledgePointId === id), false);
  await repository.mutate(data => {
    const doc = data.photoKnowledge.documents.main;
    doc.currentVersion = 2;
    doc.revisions.push({ ...doc.revisions[0], version: 2, savedAt: '2026-09-25T00:00:00Z', items: doc.revisions[0].items.map(i => ({ ...i, text: '自动显示修正版' })) });
  });
  const restarted = await new LocalRepository(file, { knowledgePolicy: repository.knowledgePolicy }).read();
  assert.equal(restarted.knowledgePoints.find(p => p.id === id).text, '自动显示修正版');
  assert.equal(restarted.knowledgePoints.find(p => p.id === id).forgottenOn, '2026-09-23');
  assert.deepEqual(restarted.reviewStates.find(s => s.knowledgePointId === id), review.state);
  assert.equal(restarted.memoryEvents.filter(e => e.knowledgePointId === id).length, 1);
  assert.equal(scheduleReview({ intervalDays: 100, mastery: 0.9 }, 'again', '2026-09-23').nextReviewOn, '2026-09-24');
});

test('Web answer and rating persist one review timeline across process restart without a model', async t => {
  const { repository, file } = await fixture(t);
  const overrides = { FEISHU_APP_ID: 'test-app', FEISHU_TEST_GROUP_ID: 'study-group' };
  let server = await startServer(file, overrides);
  t.after(() => server.stop());
  let cookie = (await server.login()).headers.get('set-cookie').split(';')[0];
  let headers = { cookie, 'Content-Type': 'application/json' };
  const points = await (await fetch(server.url + '/api/knowledge-points', { headers })).json();
  const id = points[0].id;
  const answer = await fetch(server.url + '/api/answer-attempts', { method: 'POST', headers, body: JSON.stringify({ knowledgePointId: id, content: '循序渐进，联系实际', sourceId: 'web-answer-e2e' }) });
  assert.equal(answer.status, 202);
  for (let n = 0; n < 2; n++) {
    const review = await fetch(server.url + '/api/reviews', { method: 'POST', headers, body: JSON.stringify({ knowledgePointId: id, rating: 'good', reviewedOn: '2026-09-23', sourceId: 'web-rating-e2e' }) });
    assert.equal(review.status, 201);
    assert.equal((await review.json()).state.nextReviewOn, '2026-09-26');
  }
  await server.stop();
  server = await startServer(file, overrides);
  assert.equal((await fetch(server.url + '/api/dashboard', { headers })).status, 401);
  cookie = (await server.login()).headers.get('set-cookie').split(';')[0];
  headers = { cookie };
  const reloaded = await (await fetch(server.url + '/api/knowledge-points', { headers })).json();
  const saved = reloaded.find(p => p.id === id);
  assert.equal(saved.state.nextReviewOn, '2026-09-26');
  assert.deepEqual(saved.timeline.map(e => [e.type, e.on]), [['forgotten_upload', '2026-09-18'], ['review', '2026-09-23']]);
  const data = await repository.read();
  assert.equal(data.answerAttempts.length, 1);
  assert.equal(data.reviewLogs.length, 1);
});
