import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FeedbackService, STRUCTURE_FEEDBACK_PROMPT_VERSION } from '../src/feedback-service.js';
import { LocalRepository } from '../src/repository.js';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function temporaryRepository(prefix = 'feedback-service-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  return new LocalRepository(path.join(directory, 'data.json'));
}

class FakeFeedbackRepository {
  constructor(attempts = []) {
    this.attempts = new Map(attempts.map((attempt) => [attempt.id, clone(attempt)]));
    this.jobs = new Map();
    this.feedbacks = new Map();
    this.events = [];
    this.sequence = 0;
  }

  async createFeedbackJob(input) {
    const existing = [...this.jobs.values()].find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existing) return { job: clone(existing), created: false, idempotent: true };
    const now = new Date().toISOString();
    const job = {
      id: `job-${++this.sequence}`,
      attemptId: input.attemptId,
      idempotencyKey: input.idempotencyKey,
      status: 'queued',
      provider: input.provider,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
      sourceSnapshot: clone(input.sourceSnapshot),
      taskSnapshot: clone(input.taskSnapshot),
      createdAt: now,
      queuedAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    this.events.push('create');
    return { job: clone(job), created: true, idempotent: false };
  }

  async claimFeedbackJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw codedError('job_not_found');
    const attempt = this.attempts.get(job.attemptId);
    if (job.status !== 'queued') return { claimed: false, job: clone(job), attempt: clone(attempt) };
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    this.events.push('claim');
    return { claimed: true, job: clone(job), attempt: clone(attempt) };
  }

  async completeFeedbackJob({ jobId, feedback, provider, modelVersion, promptVersion, sourceSnapshot }) {
    const job = this.jobs.get(jobId);
    if (!job) throw codedError('job_not_found');
    const existing = this.feedbacks.get(jobId);
    if (job.status === 'succeeded') return { job: clone(job), feedback: clone(existing), idempotent: true };
    if (job.status !== 'running') throw codedError('job_not_running');
    const now = new Date().toISOString();
    job.status = 'succeeded';
    job.provider = provider;
    job.modelVersion = modelVersion;
    job.promptVersion = promptVersion;
    job.sourceSnapshot = clone(sourceSnapshot);
    job.completedAt = now;
    job.updatedAt = now;
    const answerFeedback = {
      id: `feedback-${this.sequence}`,
      jobId,
      attemptId: job.attemptId,
      status: 'succeeded',
      feedback,
      provider,
      modelVersion,
      promptVersion,
      sourceSnapshot: clone(sourceSnapshot),
      createdAt: now,
      completedAt: now,
      updatedAt: now
    };
    this.feedbacks.set(jobId, answerFeedback);
    this.events.push('complete');
    return { job: clone(job), feedback: clone(answerFeedback), idempotent: false };
  }

  async failFeedbackJob({ jobId, errorCode, provider, modelVersion, promptVersion, sourceSnapshot }) {
    const job = this.jobs.get(jobId);
    if (!job) throw codedError('job_not_found');
    if (['succeeded', 'failed'].includes(job.status)) return { job: clone(job), feedback: null, idempotent: true };
    const now = new Date().toISOString();
    job.status = 'failed';
    job.errorCode = errorCode;
    job.provider = provider;
    job.modelVersion = modelVersion;
    job.promptVersion = promptVersion;
    job.sourceSnapshot = clone(sourceSnapshot);
    job.failedAt = now;
    job.updatedAt = now;
    this.events.push('fail');
    return { job: clone(job), feedback: null, idempotent: false };
  }

  async getFeedbackJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return { job: clone(job), feedback: clone(this.feedbacks.get(jobId) ?? null) };
  }
}

const attempt = {
  id: 'answer-1',
  knowledgePointId: 'kp-education-origin',
  content: '劳动起源论认为教育源于劳动。'
};

const task = {
  id: 'practice:kp-education-origin',
  knowledgePointId: 'kp-education-origin',
  type: 'practice',
  title: '教育的起源',
  prompt: '概括教育起源的主要观点。',
  source: '演示知识库'
};

test('FeedbackService persists queued, running, and succeeded feedback with immutable metadata snapshots', async () => {
  const repository = new FakeFeedbackRepository([attempt]);
  const taskInput = clone(task);
  let providerInput;
  const provider = {
    modelId: 'queued-model-v1',
    isConfigured: () => true,
    reviewAnswer: async (input) => {
      providerInput = input;
      return { feedback: '亮点：有核心观点。\n可补充：补充依据。\n下一步：举一个例子。', modelId: 'served-model-v2' };
    }
  };
  const service = new FeedbackService({
    repository,
    provider,
    profileProvider: async () => ({ id: 'li-yangyang', feedbackStyle: 'encourage_then_actionable' })
  });
  const sourceSnapshot = { evidenceStatus: 'unverified_demo_material', chunkIds: ['chunk-1'] };
  const queued = await service.enqueue({ attempt, task: taskInput, idempotencyKey: 'web:answer-1:v1', sourceSnapshot });

  sourceSnapshot.chunkIds.push('mutated-after-queue');
  taskInput.title = '被调用方不应看到这个改动';
  assert.equal(queued.created, true);
  assert.equal(queued.job.status, 'queued');
  assert.equal(queued.job.provider, 'ark');
  assert.equal(queued.job.modelVersion, 'queued-model-v1');
  assert.equal(queued.job.promptVersion, STRUCTURE_FEEDBACK_PROMPT_VERSION);
  assert.deepEqual(queued.job.sourceSnapshot, { evidenceStatus: 'unverified_demo_material', chunkIds: ['chunk-1'] });
  assert.equal(queued.job.taskSnapshot.title, '教育的起源');

  const completed = await service.process(queued.job.id);
  assert.equal(completed.job.status, 'succeeded');
  assert.equal(completed.feedback.status, 'succeeded');
  assert.equal(completed.feedback.modelVersion, 'served-model-v2');
  assert.equal(providerInput.answer, attempt.content);
  assert.equal(providerInput.task.title, '教育的起源');
  assert.equal(providerInput.profile.id, 'li-yangyang');
  assert.deepEqual(repository.events, ['create', 'claim', 'complete']);

  const fetched = await service.get(queued.job.id);
  assert.equal(fetched.job.status, 'succeeded');
  assert.equal(fetched.feedback.feedback, '亮点：有核心观点。\n可补充：补充依据。\n下一步：举一个例子。');
  assert.deepEqual(fetched.feedback.sourceSnapshot, { evidenceStatus: 'unverified_demo_material', chunkIds: ['chunk-1'] });
});

test('FeedbackService persists a provider error as a failed job without leaking a rejected task', async () => {
  const repository = new FakeFeedbackRepository([attempt]);
  const provider = {
    modelId: 'failing-model',
    isConfigured: () => true,
    reviewAnswer: async () => { throw codedError('timeout'); }
  };
  const service = new FeedbackService({ repository, provider, providerName: 'ark', promptVersion: 'structure-feedback-v1' });
  const queued = await service.enqueue({
    attempt,
    task,
    idempotencyKey: 'feishu:answer-1:v1',
    sourceSnapshot: { chunkIds: ['chunk-timeout'] }
  });

  const result = await service.process(queued.job.id);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.errorCode, 'timeout');
  assert.equal(result.feedback, null);
  assert.equal(result.job.provider, 'ark');
  assert.equal(result.job.modelVersion, 'failing-model');
  assert.equal(result.job.promptVersion, 'structure-feedback-v1');
  assert.deepEqual(result.job.sourceSnapshot, { chunkIds: ['chunk-timeout'] });
  assert.deepEqual(repository.events, ['create', 'claim', 'fail']);
});

test('FeedbackService records unavailable providers as failed jobs without calling them', async () => {
  const repository = new FakeFeedbackRepository([attempt]);
  let called = false;
  const provider = {
    modelId: 'not-configured-model',
    isConfigured: () => false,
    reviewAnswer: async () => { called = true; }
  };
  const service = new FeedbackService({ repository, provider });
  const queued = await service.enqueue({ attempt, task, idempotencyKey: 'web:unconfigured:v1', channel: 'web' });

  assert.deepEqual(queued.job.sourceSnapshot, {
    channel: 'web',
    evidenceStatus: 'unverified_demo_material',
    sourceChunkIds: [],
    task: {
      id: task.id,
      knowledgePointId: task.knowledgePointId,
      title: task.title,
      prompt: task.prompt,
      source: task.source
    }
  });

  const result = await service.process(queued.job.id);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.errorCode, 'not_configured');
  assert.equal(called, false);
  assert.deepEqual(repository.events, ['create', 'claim', 'fail']);
});

test('FeedbackService deduplicates enqueue and reuses an already completed job without another model call', async () => {
  const repository = new FakeFeedbackRepository([attempt]);
  let calls = 0;
  const provider = {
    modelId: 'idempotent-model',
    isConfigured: () => true,
    reviewAnswer: async () => {
      calls += 1;
      return { feedback: '亮点：有结构。\n可补充：增加依据。\n下一步：做一次复述。', modelId: 'idempotent-model' };
    }
  };
  const service = new FeedbackService({ repository, provider });
  const first = await service.enqueue({ attempt, task, idempotencyKey: 'answer-1:feedback:v1' });
  const duplicate = await service.enqueue({ attempt, task, idempotencyKey: 'answer-1:feedback:v1' });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.job.id, first.job.id);

  await service.process(first.job.id);
  const reused = await service.process(first.job.id);
  assert.equal(reused.job.status, 'succeeded');
  assert.equal(reused.feedback.status, 'succeeded');
  assert.equal(reused.idempotent, true);
  assert.equal(calls, 1);
  assert.deepEqual(repository.events, ['create', 'claim', 'complete']);
});

test('FeedbackService uses the LocalRepository job lifecycle without exposing answer content from get', async () => {
  const repository = await temporaryRepository();
  const point = (await repository.read()).knowledgePoints[0];
  const savedAttempt = await repository.saveAnswer({
    knowledgePointId: point.id,
    content: '劳动起源论认为教育源于劳动。',
    sourceId: 'integration-answer-1'
  });
  const provider = {
    modelId: 'integration-model',
    isConfigured: () => true,
    reviewAnswer: async () => ({ feedback: '亮点：抓住劳动。\n可补充：比较其他观点。\n下一步：补充依据。', modelId: 'integration-model' })
  };
  const service = new FeedbackService({ repository, provider });
  const queued = await service.enqueue({
    attempt: savedAttempt,
    task: { id: `practice:${point.id}`, knowledgePointId: point.id, title: point.title, prompt: point.recallPrompt },
    idempotencyKey: 'integration:answer-1:v1',
    sourceSnapshot: { sourceLabel: point.sourceLabel }
  });

  const completed = await service.process(queued.job.id);
  const persisted = await service.get(queued.job.id);
  const data = await repository.read();
  assert.equal(completed.job.status, 'succeeded');
  assert.equal(persisted.job.status, 'succeeded');
  assert.equal(persisted.feedback.status, 'succeeded');
  assert.equal(Object.hasOwn(persisted, 'attempt'), false);
  assert.equal(data.feedbackJobs.length, 1);
  assert.equal(data.answerFeedbacks.length, 1);
  assert.equal(data.answerAttempts.find((item) => item.id === savedAttempt.id).feedbackStatus, 'succeeded');
});

test('FeedbackService resumes queued work and safely closes interrupted running work on startup', async () => {
  const repository = await temporaryRepository('feedback-recovery-');
  const point = (await repository.read()).knowledgePoints[0];
  const firstAttempt = await repository.saveAnswer({
    knowledgePointId: point.id,
    content: '第一份待恢复答案。',
    sourceId: 'recovery-answer-queued'
  });
  const secondAttempt = await repository.saveAnswer({
    knowledgePointId: point.id,
    content: '第二份在中断时运行的答案。',
    sourceId: 'recovery-answer-running'
  });
  let providerCalls = 0;
  const service = new FeedbackService({
    repository,
    provider: {
      modelId: 'recovery-model',
      isConfigured: () => true,
      reviewAnswer: async () => {
        providerCalls += 1;
        return { feedback: '亮点：保留了主线。\\n可补充：补齐依据。\\n下一步：再次复述。', modelId: 'recovery-model' };
      }
    }
  });
  const taskSnapshot = { id: `practice:${point.id}`, knowledgePointId: point.id, title: point.title, prompt: point.recallPrompt };
  const queued = await service.enqueue({
    attempt: firstAttempt,
    task: taskSnapshot,
    idempotencyKey: 'recovery:queued'
  });
  const running = await service.enqueue({
    attempt: secondAttempt,
    task: taskSnapshot,
    idempotencyKey: 'recovery:running'
  });
  await repository.claimFeedbackJob(running.job.id);

  const reconciliation = await service.reconcilePending();
  assert.deepEqual(reconciliation.queuedJobIds, [queued.job.id]);
  assert.deepEqual(reconciliation.interruptedJobIds, [running.job.id]);
  await service.processQueued(reconciliation.queuedJobIds);

  const completed = await service.get(queued.job.id);
  const interrupted = await service.get(running.job.id);
  assert.equal(providerCalls, 1);
  assert.equal(completed.job.status, 'succeeded');
  assert.equal(completed.feedback.status, 'succeeded');
  assert.equal(interrupted.job.status, 'failed');
  assert.equal(interrupted.job.errorCode, 'worker_interrupted');
  assert.equal(interrupted.feedback.status, 'failed');
  assert.equal(interrupted.feedback.errorCode, 'worker_interrupted');
});
