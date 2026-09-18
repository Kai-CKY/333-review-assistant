import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTodayPlan } from '../src/domain/plan.js';
import { scheduleReview } from '../src/domain/scheduler.js';

test('due reviews take precedence and the task cap is respected', () => {
  const plan = buildTodayPlan({
    targetDate: '2026-08-26',
    maximumTasks: 2,
    knowledgePoints: [
      { id: 'due', order: 1, title: 'Due', recallPrompt: 'x', sourceLabel: 'test' },
      { id: 'weak', order: 2, title: 'Weak', recallPrompt: 'x', sourceLabel: 'test' },
      { id: 'new', order: 3, title: 'New', recallPrompt: 'x', sourceLabel: 'test' }
    ],
    reviewStates: [
      { knowledgePointId: 'due', mastery: 0.8, nextReviewOn: '2026-08-25' },
      { knowledgePointId: 'weak', mastery: 0.3, nextReviewOn: '2026-08-30' }
    ]
  });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].knowledgePointId, 'due');
  assert.equal(plan[0].type, 'review');
  assert.equal(plan[1].knowledgePointId, 'weak');
});

test('a successful recall makes the next review later, while again records a lapse', () => {
  const initial = { intervalDays: 3, mastery: 0.5, lapseCount: 0 };
  const good = scheduleReview(initial, 'good', '2026-08-26');
  const again = scheduleReview(initial, 'again', '2026-08-26');
  assert.equal(good.nextReviewOn, '2026-09-03');
  assert.equal(again.nextReviewOn, '2026-08-27');
  assert.equal(again.lapseCount, 1);
  assert.ok(good.mastery > initial.mastery);
});

