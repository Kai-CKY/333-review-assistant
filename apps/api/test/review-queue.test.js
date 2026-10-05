import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewQueue } from '../src/domain/review-queue.js';
import { StudyService } from '../src/study-service.js';
import { compactRuntime } from '../src/agent/context-builder.js';
import { createGroupConversation } from '../src/feishu/group-conversation.js';
import { LocalRepository } from '../src/repository.js';
import { conversationScope } from '../src/agent/memory.js';
import { todayKey, addDays } from '../src/domain/date.js';

function point(id, extra = {}) {
  return { id, title: id, text: 'original text', recallPrompt: 'recall', sourceKind: 'manual_upload',
    sourceScopeKey: 'group', practiceEligible: true, ...extra };
}
function due(id, on = '2026-10-05') {
  return { knowledgePointId: id, nextReviewOn: on, stage: 'new', mastery: 0.3, pendingForgottenReview: false };
}

test('full pending queue exceeds recommendation cap and excludes fragments, hidden points and future reviews', async () => {
  const points = Array.from({ length: 69 }, (_, i) => point(`complete-${i}`));
  const data = { user: { dailyTaskLimit: 5 }, knowledgePoints: [...points,
    point('future'), point('unstarted'), point('fragment', { practiceEligible: false }),
    point('archived', { archived: true }), point('hidden', { hidden: true })],
    reviewStates: [...points.map(p => due(p.id)), due('future', '2026-10-06'), due('fragment'), due('archived'), due('hidden')],
    reviewLogs: [], taskCompletionLogs: [] };
  const service = new StudyService({ read: async () => data });
  const dashboard = await service.getDashboard('2026-10-05');
  assert.equal(dashboard.tasks.length, 5);
  assert.equal(dashboard.pendingReviews.length, 69);
  assert.deepEqual(dashboard.reviewStats, { enrolled: 71, pending: 69, scheduled: 1, unstarted: 1 });
  assert.deepEqual(new Set(dashboard.pendingReviews.map(t => t.knowledgePointId)), new Set(points.map(p => p.id)));
  assert.ok(dashboard.pendingReviews.every(t => !('reference' in t)));
  const context = compactRuntime({ dashboard });
  assert.equal(context.taskCount, 5);
  assert.equal(context.reviewStats.pending, 69);
  assert.equal(context.todayTasks.length, 5);
  assert.ok(!JSON.stringify(context).includes('complete-68'));
  data.reviewStates[0].nextReviewOn = '2026-10-07';
  assert.equal((await service.getDashboard('2026-10-05')).reviewStats.pending, 68);
});

test('scoped review counts do not include private or another group records', () => {
  const data = { knowledgePoints: [point('main'), point('private', { sourceScopeKey: 'p2p' }), point('other', { sourceScopeKey: 'other-group' })],
    reviewStates: ['main', 'private', 'other'].map(id => due(id)) };
  assert.equal(reviewQueue(data, { targetDate: '2026-10-05' }).reviewStats.pending, 3);
  assert.deepEqual(reviewQueue(data, { targetDate: '2026-10-05', scopeKey: 'group' }).reviewStats,
    { enrolled: 1, pending: 1, scheduled: 0, unstarted: 0 });
});

test('Feishu group prompt receives fresh scoped totals after a review changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-queue-group-'));
  const repository = new LocalRepository(path.join(directory, 'data.json'));
  const scope = conversationScope({ appId: 'app', chatType: 'group', chatId: 'oc_main' });
  await repository.mutate(data => {
    data.knowledgePoints = [point('one', { sourceScopeKey: scope.key }), point('two', { sourceScopeKey: scope.key }),
      point('private-secret', { sourceScopeKey: 'private-scope' })];
    data.reviewStates = ['one', 'two', 'private-secret'].map(id => due(id, todayKey()));
  });
  const requests = [], sends = [];
  const handle = createGroupConversation({ repository, appId: 'app', chatId: 'oc_main',
    yangyangOpenId: 'learner', ownerOpenId: 'owner', knowledgeService: { mode: 'source_restoration' },
    provider: { isConfigured: () => true, complete: async request => { requests.push(request); return { content: 'count' }; } },
    channel: { send: async (...args) => sends.push(args) }, logger: { warn() {} } });
  await handle({ senderId: 'owner', chatId: 'oc_main', messageId: 'q1', rawContentType: 'text', content: '小助手，现在有多少待复习知识点？' });
  const first = requests[0].messages[0].content;
  assert.match(first, /"review_stats":\{"enrolled":2,"pending":2,"scheduled":0,"unstarted":0\}/);
  assert.doesNotMatch(first, /private-secret/);
  await repository.mutate(data => { data.reviewStates.find(s => s.knowledgePointId === 'one').nextReviewOn = addDays(todayKey(), 1); });
  await handle({ senderId: 'owner', chatId: 'oc_main', messageId: 'q2', rawContentType: 'text', content: '小助手，待复习知识点现在有多少？' });
  assert.match(requests[1].messages[0].content, /"review_stats":\{"enrolled":2,"pending":1,"scheduled":1,"unstarted":0\}/);
  assert.equal(sends.length, 2);
});
