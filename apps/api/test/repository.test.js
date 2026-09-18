import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRepository } from '../src/repository.js';
import { FeishuSessionStore } from '../src/feishu/session-store.js';

test('review records persist and schedule the next review', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-assistant-'));
  const repository = new LocalRepository(path.join(directory, 'data.json'));
  const before = await repository.read();
  const pointId = before.knowledgePoints[0].id;
  await repository.recordReview({ knowledgePointId: pointId, rating: 'good', reviewedOn: '2026-08-26' });
  const after = await repository.read();
  const state = after.reviewStates.find((item) => item.knowledgePointId === pointId);
  assert.equal(state.lastReviewedOn, '2026-08-26');
  assert.equal(after.reviewLogs.length, 1);
});

test('channel source IDs make answer and rating writes idempotent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-assistant-'));
  const repository = new LocalRepository(path.join(directory, 'data.json'));
  const pointId = (await repository.read()).knowledgePoints[0].id;

  const firstAnswer = await repository.saveAnswer({
    knowledgePointId: pointId,
    content: '教育起源的三种主要观点。',
    sourceId: 'feishu:answer:message-1'
  });
  const replayedAnswer = await repository.saveAnswer({
    knowledgePointId: pointId,
    content: '不应重复保存。',
    sourceId: 'feishu:answer:message-1'
  });
  assert.equal(replayedAnswer.id, firstAnswer.id);
  assert.equal((await repository.read()).answerAttempts.length, 1);

  const firstRating = await repository.recordReview({
    knowledgePointId: pointId,
    rating: 'good',
    reviewedOn: '2026-08-26',
    sourceId: 'feishu:rating:session-1'
  });
  const replayedRating = await repository.recordReview({
    knowledgePointId: pointId,
    rating: 'again',
    reviewedOn: '2026-08-26',
    sourceId: 'feishu:rating:session-1'
  });
  assert.equal(replayedRating.reviewLog.id, firstRating.reviewLog.id);
  const after = await repository.read();
  assert.equal(after.reviewLogs.length, 1);
  assert.equal(after.reviewLogs[0].rating, 'good');
});

test('schema v2 completion migration preserves data and completion writes are idempotent, reversible and schedule-neutral', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-completions-'));
  const filePath = path.join(directory, 'data.json');
  const legacyState = {
    knowledgePointId: 'kp-existing',
    stage: 'review',
    intervalDays: 5,
    mastery: 0.7,
    lapseCount: 1,
    lastReviewedOn: '2026-09-10',
    nextReviewOn: '2026-09-15'
  };
  await writeFile(filePath, JSON.stringify({
    schemaVersion: 2,
    user: { id: 'li-yangyang', name: '李羊羊' },
    knowledgePoints: [{ id: 'kp-existing', title: '教育目的' }],
    reviewStates: [legacyState],
    reviewLogs: [{ id: 'review-existing', knowledgePointId: 'kp-existing', rating: 'good' }],
    answerAttempts: [{ id: 'answer-existing', knowledgePointId: 'kp-existing', content: '已有答案' }],
    answerFeedbacks: [{ id: 'feedback-existing', attemptId: 'answer-existing', status: 'completed' }]
  }), 'utf8');

  const repository = new LocalRepository(filePath);
  const migrated = await repository.read();
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.taskCompletionLogs, []);
  assert.deepEqual(migrated.feedbackJobs, []);
  assert.deepEqual(migrated.reviewStates, [legacyState]);
  assert.equal(migrated.reviewLogs[0].id, 'review-existing');
  assert.equal(migrated.answerAttempts[0].id, 'answer-existing');
  assert.equal(migrated.answerFeedbacks[0].id, 'feedback-existing');

  const scheduleBefore = structuredClone(migrated.reviewStates);
  const reviewLogsBefore = structuredClone(migrated.reviewLogs);
  const first = await repository.recordTaskCompletion({
    content: '我今天完成了教育学第一章',
    reportedOn: '2026-09-13',
    sourceId: 'feishu:completion:om_1',
    source: 'feishu_self_report'
  });
  const replayed = await repository.recordTaskCompletion({
    content: '重放消息不应覆盖原记录',
    reportedOn: '2026-09-14',
    sourceId: 'feishu:completion:om_1',
    source: 'feishu_self_report'
  });
  assert.equal(replayed.id, first.id);
  assert.equal(replayed.idempotent, true);

  let current = await repository.read();
  assert.equal(current.taskCompletionLogs.length, 1);
  assert.equal(current.taskCompletionLogs[0].content, '我今天完成了教育学第一章');
  assert.equal(current.taskCompletionLogs[0].reportedOn, '2026-09-13');
  assert.equal(current.taskCompletionLogs[0].status, 'active');
  assert.equal(current.taskCompletionLogs[0].evidenceStatus, 'self_reported');
  assert.equal(current.taskCompletionLogs[0].affectsSchedule, false);
  assert.deepEqual(current.reviewStates, scheduleBefore);
  assert.deepEqual(current.reviewLogs, reviewLogsBefore);

  const voided = await repository.voidTaskCompletion({
    completionId: first.id,
    userId: migrated.user.id,
    sourceId: 'feishu:void:card_1'
  });
  const replayedVoid = await repository.voidTaskCompletion({
    completionId: first.id,
    userId: migrated.user.id,
    sourceId: 'feishu:void:card_1'
  });
  assert.equal(voided.status, 'voided');
  assert.equal(voided.voidSourceId, 'feishu:void:card_1');
  assert.equal(replayedVoid.idempotent, true);
  assert.equal(replayedVoid.voidedAt, voided.voidedAt);

  current = await repository.read();
  assert.equal(current.taskCompletionLogs.length, 1);
  assert.equal(current.taskCompletionLogs[0].status, 'voided');
  assert.deepEqual(current.reviewStates, scheduleBefore);
  assert.deepEqual(current.reviewLogs, reviewLogsBefore);
});

test('feedback jobs are idempotent, track execution state, and persist one successful result', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-feedback-jobs-'));
  const repository = new LocalRepository(path.join(directory, 'data.json'));
  const point = (await repository.read()).knowledgePoints[0];
  const attempt = await repository.saveAnswer({
    knowledgePointId: point.id,
    content: '私密答案内容，只应在模型执行时读取。',
    sourceId: 'web:answer:feedback-job-success'
  });
  const sourceSnapshot = {
    evidenceStatus: 'reviewed_source',
    sourceIds: ['source-education-origin'],
    sourceVersion: '2026-09-14'
  };
  const taskSnapshot = { id: `review:${point.id}`, title: point.title, prompt: point.recallPrompt };
  const input = {
    attemptId: attempt.id,
    idempotencyKey: `feedback:${attempt.id}:prompt-v1`,
    provider: 'ark',
    modelVersion: 'model-v1',
    promptVersion: 'prompt-v1',
    sourceSnapshot,
    taskSnapshot
  };

  const first = await repository.createFeedbackJob(input);
  const replayedCreate = await repository.createFeedbackJob(input);
  assert.equal(first.created, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.job.status, 'queued');
  assert.equal(replayedCreate.created, false);
  assert.equal(replayedCreate.idempotent, true);
  assert.equal(replayedCreate.job.id, first.job.id);
  let data = await repository.read();
  assert.equal(data.feedbackJobs.length, 1);
  assert.equal(data.answerFeedbacks.length, 1);
  assert.equal(data.answerFeedbacks[0].id, first.job.answerFeedbackId);
  assert.equal(data.answerFeedbacks[0].idempotencyKey, input.idempotencyKey);
  assert.equal(data.answerFeedbacks[0].status, 'queued');
  assert.equal(data.answerFeedbacks[0].modelVersion, 'model-v1');
  assert.equal(data.answerAttempts.find((item) => item.id === attempt.id).feedbackStatus, 'queued');
  const queued = await repository.getFeedbackJob(first.job.id);
  assert.equal(queued.feedback.status, 'queued');

  const claimed = await repository.claimFeedbackJob(first.job.id);
  const replayedClaim = await repository.claimFeedbackJob(first.job.id);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.job.status, 'running');
  assert.equal(claimed.attempt.id, attempt.id);
  assert.ok(claimed.job.claimedAt);
  assert.equal(replayedClaim.claimed, false);
  assert.equal(replayedClaim.job.status, 'running');
  const running = await repository.getFeedbackJob(first.job.id);
  assert.equal(running.feedback.id, first.job.answerFeedbackId);
  assert.equal(running.feedback.status, 'running');
  assert.ok(running.feedback.startedAt);

  const completed = await repository.completeFeedbackJob({
    jobId: first.job.id,
    feedback: { strength: '答出了核心观点。', nextStep: '补充理论依据。' },
    provider: 'ark',
    modelVersion: 'model-v2',
    promptVersion: 'prompt-v2',
    sourceSnapshot: { evidenceStatus: 'verified_source', sourceIds: ['source-education-origin'], sourceVersion: '2026-09-15' }
  });
  const replayedComplete = await repository.completeFeedbackJob({
    jobId: first.job.id,
    feedback: { strength: '不应覆盖已保存结果。' }
  });
  assert.equal(completed.idempotent, false);
  assert.equal(completed.job.status, 'succeeded');
  assert.equal(completed.feedback.status, 'succeeded');
  assert.equal(completed.job.answerFeedbackId, completed.feedback.id);
  assert.equal(completed.feedback.jobId, completed.job.id);
  assert.equal(completed.feedback.modelVersion, 'model-v2');
  assert.equal(completed.feedback.promptVersion, 'prompt-v2');
  assert.equal(completed.feedback.evidenceStatus, 'verified_source');
  assert.equal(replayedComplete.idempotent, true);
  assert.equal(replayedComplete.feedback.id, completed.feedback.id);

  const loaded = await repository.getFeedbackJob(first.job.id);
  assert.equal('attempt' in loaded, false);
  assert.equal(loaded.job.status, 'succeeded');
  assert.equal(loaded.feedback.id, completed.feedback.id);
  assert.doesNotMatch(JSON.stringify(loaded), /私密答案内容/);
  data = await repository.read();
  assert.equal(data.answerFeedbacks.length, 1);
  assert.equal(data.answerFeedbacks[0].id, first.job.answerFeedbackId);
  assert.equal(data.answerAttempts.find((item) => item.id === attempt.id).feedbackStatus, 'succeeded');
});

test('feedback job failures retain metadata and error codes on the linked feedback record', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-feedback-jobs-'));
  const repository = new LocalRepository(path.join(directory, 'data.json'));
  const point = (await repository.read()).knowledgePoints[0];
  const attempt = await repository.saveAnswer({
    knowledgePointId: point.id,
    content: '待反馈的简短答案。',
    sourceId: 'web:answer:feedback-job-failure'
  });
  const created = await repository.createFeedbackJob({
    attemptId: attempt.id,
    idempotencyKey: `feedback:${attempt.id}:prompt-v1`,
    provider: 'ark',
    modelVersion: 'model-v1',
    promptVersion: 'prompt-v1',
    sourceSnapshot: { evidenceStatus: 'reviewed_source', sourceIds: ['source-1'] },
    taskSnapshot: { id: `practice:${point.id}`, title: point.title }
  });
  await repository.claimFeedbackJob(created.job.id);

  const failed = await repository.failFeedbackJob({
    jobId: created.job.id,
    errorCode: 'timeout',
    provider: 'ark',
    modelVersion: 'model-v1',
    promptVersion: 'prompt-v2',
    sourceSnapshot: { evidenceStatus: 'verified_source', sourceIds: ['source-1'], sourceVersion: 'v2' }
  });
  const replayedFailure = await repository.failFeedbackJob({ jobId: created.job.id, errorCode: 'network_error' });
  assert.equal(failed.idempotent, false);
  assert.equal(failed.feedback, null);
  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.errorCode, 'timeout');
  assert.ok(failed.job.failedAt);
  assert.equal(failed.job.promptVersion, 'prompt-v2');
  assert.equal(failed.job.evidenceStatus, 'verified_source');
  assert.equal(replayedFailure.idempotent, true);
  assert.equal(replayedFailure.job.errorCode, 'timeout');

  const loaded = await repository.getFeedbackJob(created.job.id);
  assert.equal(loaded.job.status, 'failed');
  assert.equal(loaded.feedback.id, created.job.answerFeedbackId);
  assert.equal(loaded.feedback.status, 'failed');
  assert.equal(loaded.feedback.errorCode, 'timeout');
  assert.equal(loaded.feedback.promptVersion, 'prompt-v2');
  assert.equal(loaded.feedback.evidenceStatus, 'verified_source');
  assert.ok(loaded.feedback.failedAt);
  const data = await repository.read();
  assert.equal(data.answerFeedbacks.length, 1);
  assert.equal(data.answerFeedbacks[0].status, 'failed');
  assert.equal(data.answerAttempts.find((item) => item.id === attempt.id).feedbackStatus, 'failed');
});

test('stale Feishu claims reconcile against persisted answer and review writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-assistant-'));
  const repository = new LocalRepository(path.join(directory, 'data.json'));
  const store = new FeishuSessionStore(repository);
  const point = (await repository.read()).knowledgePoints[0];
  const created = await store.createAwaitingAnswer({
    actionKey: 'card-start:test',
    openId: 'ou_test',
    chatId: 'oc_test',
    task: { id: `review:${point.id}`, knowledgePointId: point.id, title: point.title, prompt: point.recallPrompt }
  });
  const answerClaim = await store.claimAnswer({ sessionId: created.session.id, openId: 'ou_test', messageId: 'om_answer' });
  await repository.saveAnswer({
    knowledgePointId: point.id,
    content: '已保存的答案。',
    sourceId: answerClaim.session.answerSourceId
  });
  await repository.mutate((data) => {
    data.feishu.sessions[0].updatedAt = '2020-01-01T00:00:00.000Z';
  });
  const answerRecovered = await store.getActive('ou_test');
  assert.equal(answerRecovered.status, 'awaiting_rating');

  const ratingClaim = await store.claimRating({ sessionId: created.session.id, openId: 'ou_test', rating: 'good' });
  await repository.recordReview({
    knowledgePointId: point.id,
    rating: 'good',
    reviewedOn: '2026-08-26',
    sourceId: ratingClaim.session.ratingSourceId
  });
  await repository.mutate((data) => {
    data.feishu.sessions[0].updatedAt = '2020-01-01T00:00:00.000Z';
  });
  assert.equal(await store.getActive('ou_test'), null);
  assert.equal((await repository.read()).feishu.sessions[0].status, 'completed');
});
