import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { todayKey } from './domain/date.js';
import { scheduleReview } from './domain/scheduler.js';
import { libraryPolicy, syncSavedKnowledge } from './knowledge/library.js';

function setDefault(object, key, value) {
  if (Object.prototype.hasOwnProperty.call(object, key)) return false;
  object[key] = value;
  return true;
}

function cloneValue(value) {
  return value === undefined ? null : structuredClone(value);
}

function optionalString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function feedbackEvidenceStatus(sourceSnapshot) {
  const status = sourceSnapshot && typeof sourceSnapshot === 'object'
    ? optionalString(sourceSnapshot.evidenceStatus)
    : null;
  return status ?? 'unverified_demo_material';
}

function applyFeedbackJobMetadata(job, {
  provider,
  modelVersion,
  promptVersion,
  sourceSnapshot
} = {}) {
  if (provider !== undefined) job.provider = optionalString(provider);
  if (modelVersion !== undefined) job.modelVersion = optionalString(modelVersion);
  if (promptVersion !== undefined) job.promptVersion = optionalString(promptVersion);
  if (sourceSnapshot !== undefined) {
    job.sourceSnapshot = cloneValue(sourceSnapshot);
    job.evidenceStatus = feedbackEvidenceStatus(job.sourceSnapshot);
  }
}

function feedbackForJob(data, job) {
  if (!job) return null;
  return data.answerFeedbacks.find((item) => item.id === job.answerFeedbackId)
    ?? data.answerFeedbacks.find((item) => item.jobId === job.id)
    ?? null;
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createJobBackedAnswerFeedback(job, now) {
  const feedback = {
    id: newId('answer-feedback'),
    jobId: job.id,
    attemptId: job.attemptId,
    idempotencyKey: job.idempotencyKey,
    status: job.status,
    feedback: null,
    errorCode: job.status === 'failed' ? job.errorCode ?? 'unknown_error' : null,
    provider: job.provider,
    modelVersion: job.modelVersion,
    promptVersion: job.promptVersion,
    sourceSnapshot: cloneValue(job.sourceSnapshot),
    taskSnapshot: cloneValue(job.taskSnapshot),
    evidenceStatus: job.evidenceStatus,
    createdAt: job.createdAt ?? now,
    queuedAt: job.queuedAt ?? job.createdAt ?? now,
    updatedAt: now
  };
  if (job.claimedAt) feedback.claimedAt = job.claimedAt;
  if (job.startedAt) feedback.startedAt = job.startedAt;
  if (job.completedAt) feedback.completedAt = job.completedAt;
  if (job.failedAt) feedback.failedAt = job.failedAt;
  return feedback;
}

function ensureJobBackedAnswerFeedback(data, job, now) {
  const existing = feedbackForJob(data, job);
  if (existing) return existing;
  const feedback = createJobBackedAnswerFeedback(job, now);
  job.answerFeedbackId = feedback.id;
  data.answerFeedbacks.push(feedback);
  return feedback;
}

function synchronizeJobBackedAnswerFeedback(feedback, job, now) {
  feedback.status = job.status;
  feedback.idempotencyKey = job.idempotencyKey;
  feedback.provider = job.provider;
  feedback.modelVersion = job.modelVersion;
  feedback.promptVersion = job.promptVersion;
  feedback.sourceSnapshot = cloneValue(job.sourceSnapshot);
  feedback.taskSnapshot = cloneValue(job.taskSnapshot);
  feedback.evidenceStatus = job.evidenceStatus;
  feedback.errorCode = job.status === 'failed' ? job.errorCode ?? 'unknown_error' : null;
  feedback.updatedAt = now;
  if (job.queuedAt) feedback.queuedAt = job.queuedAt;
  if (job.claimedAt) feedback.claimedAt = job.claimedAt;
  if (job.startedAt) feedback.startedAt = job.startedAt;
  if (job.completedAt) feedback.completedAt = job.completedAt;
  if (job.failedAt) feedback.failedAt = job.failedAt;
}

export function normalizeData(data) {
  let changed = false;
  if (data.schemaVersion !== 4) {
    data.schemaVersion = 4;
    changed = true;
  }
  if (!data.user || typeof data.user !== 'object') {
    data.user = {};
    changed = true;
  }
  if (!data.user.id || data.user.id === 'demo-user') {
    data.user.id = 'li-yangyang';
    changed = true;
  }
  changed = setDefault(data.user, 'name', '李羊羊') || changed;
  changed = setDefault(data.user, 'examGoal', '2027 年考研 333 教育综合') || changed;
  changed = setDefault(data.user, 'studyStage', 'first_round_completed') || changed;
  changed = setDefault(data.user, 'painPoints', ['容易遗忘', '难以坚持']) || changed;
  changed = setDefault(data.user, 'preferredTaskRange', { min: 3, max: 5 }) || changed;
  changed = setDefault(data.user, 'feedbackStyle', 'encourage_then_actionable') || changed;
  changed = setDefault(data.user, 'reminderPreference', 'non_intrusive') || changed;
  changed = setDefault(data.user, 'examDateStatus', 'estimated') || changed;
  changed = setDefault(data.user, 'targetSchool', null) || changed;
  changed = setDefault(data.user, 'targetMajor', null) || changed;
  changed = setDefault(data.user, 'dailyAvailableMinutes', null) || changed;
  changed = setDefault(data.user, 'profileVersion', 'li-yangyang-v1') || changed;
  for (const key of ['knowledgePoints', 'reviewStates', 'reviewLogs', 'memoryEvents', 'answerAttempts', 'answerFeedbacks', 'feedbackJobs', 'taskCompletionLogs']) {
    if (!Array.isArray(data[key])) {
      data[key] = [];
      changed = true;
    }
  }
  for(const state of data.reviewStates){
    if(state.lastRating!==undefined)continue;
    const last=data.reviewLogs.filter(r=>r.knowledgePointId===state.knowledgePointId&&r.reviewedOn===state.lastReviewedOn).at(-1);
    if(last&&['again','hard','good','easy'].includes(last.rating)){state.lastRating=last.rating;changed=true;}
  }
  return changed;
}

export class LocalRepository {
  constructor(filePath, { knowledgePolicy = libraryPolicy() } = {}) {
    this.filePath = filePath;
    this.knowledgePolicy = knowledgePolicy;
    this.mutationQueue = Promise.resolve();
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'));
      const normalized = normalizeData(data);
      const synced = syncSavedKnowledge(data, this.knowledgePolicy);
      return { data, changed: normalized || synced };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const seed = createSeedData();
      return { data: seed, changed: true };
    }
  }

  async read() {
    const operation = this.mutationQueue.then(async () => {
      const { data, changed } = await this.load();
      if (changed) await this.save(data);
      return data;
    });
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  async save(data) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  async mutate(callback) {
    const operation = this.mutationQueue.then(async () => {
      const { data } = await this.load();
      const result = await callback(data);
      syncSavedKnowledge(data, this.knowledgePolicy);
      await this.save(data);
      return result;
    });
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  async recordReview({ knowledgePointId, rating, reviewedOn = todayKey(), sourceId, attemptId=null, actorId=null }) {
    return this.mutate((data) => {
      const knowledgePoint = data.knowledgePoints.find((item) => item.id === knowledgePointId);
      if (!knowledgePoint || knowledgePoint.archived || knowledgePoint.hidden || knowledgePoint.practiceEligible === false) throw Object.assign(new Error('该知识点暂不可练习，请刷新知识索引。'), { statusCode: 400 });
      const duplicate = sourceId && data.reviewLogs.find((item) => item.sourceId === sourceId);
      if (duplicate) {
        if (duplicate.knowledgePointId !== knowledgePointId) throw Object.assign(new Error('该自评请求已用于另一知识点。'), { statusCode: 409 });
        return {
          knowledgePoint,
          state: data.reviewStates.find((item) => item.knowledgePointId === knowledgePointId),
          reviewLog: duplicate,
          idempotent: true
        };
      }
      const existing = data.reviewStates.find((item) => item.knowledgePointId === knowledgePointId)
        ?? { knowledgePointId, stage: 'new', intervalDays: 0, mastery: 0.3, lapseCount: 0 };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedOn) || !Number.isFinite(Date.parse(`${reviewedOn}T00:00:00Z`)) || new Date(`${reviewedOn}T00:00:00Z`).toISOString().slice(0, 10) !== reviewedOn || (existing.forgettingAnchorOn && reviewedOn < existing.forgettingAnchorOn)) {
        throw Object.assign(new Error('复习日期无效或早于本次遗忘日期。'), { statusCode: 400 });
      }
      const linked=attemptId?data.answerAttempts.find(a=>a.id===attemptId):sourceId?.startsWith('review:')?data.answerAttempts.find(a=>a.sourceId===sourceId.slice(7)):null;
      if(attemptId&&!linked||linked&&(linked.knowledgePointId!==knowledgePointId||actorId&&linked.actorId&&linked.actorId!==actorId))throw Object.assign(new Error('作答与自评关联无效'),{statusCode:400});
      const next = {...scheduleReview(existing, rating, reviewedOn),lastRating:rating};
      data.reviewStates = data.reviewStates.filter((item) => item.knowledgePointId !== knowledgePointId);
      data.reviewStates.push(next);
      const reviewLog = {
        id: `review-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        knowledgePointId,
        rating,
        reviewedOn,
        reviewedAt:new Date().toISOString(),recordedAt:new Date().toISOString(),attemptId:linked?.id||null,actorId,
        nextReviewOn: next.nextReviewOn,
        ...(sourceId ? { sourceId } : {})
      };
      data.reviewLogs.push(reviewLog);
      return { knowledgePoint, state: next, reviewLog, idempotent: false };
    });
  }

  async saveAnswer({ knowledgePointId, content, submittedOn = todayKey(), sourceId, feedbackStatus = 'not_requested', taskSnapshot = null, practiceSessionId = null, actorId=null }) {
    return this.mutate((data) => {
      const point = data.knowledgePoints.find(item => item.id === knowledgePointId);
      if (!point || point.archived || point.hidden || point.practiceEligible === false) throw Object.assign(new Error('该知识点暂不可练习，请刷新知识索引。'), { statusCode: 400 });
      const duplicate = sourceId && data.answerAttempts.find((item) => item.sourceId === sourceId);
      if (duplicate) {
        if (duplicate.knowledgePointId !== knowledgePointId) throw Object.assign(new Error('答案标识已用于另一知识点。'), { statusCode: 409 });
        return { ...duplicate, idempotent: true };
      }
      const attempt = {
        id: `answer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        knowledgePointId,
        content: content.trim(),
        submittedOn,
        submittedAt:new Date().toISOString(),recordedAt:new Date().toISOString(),actorId,
        feedbackStatus,
        taskSnapshot: cloneValue(taskSnapshot), practiceSessionId,
        ...(sourceId ? { sourceId } : {})
      };
      data.answerAttempts.push(attempt);
      return { ...attempt, idempotent: false };
    });
  }

  /**
   * Enqueues a channel-neutral feedback request. Jobs own their execution
   * lifecycle and create a linked answer-feedback status record immediately.
   */
  async createFeedbackJob({
    attemptId,
    idempotencyKey,
    provider,
    modelVersion,
    promptVersion,
    sourceSnapshot,
    taskSnapshot
  }) {
    return this.mutate((data) => {
      const normalizedKey = optionalString(idempotencyKey);
      if (!normalizedKey) throw new Error('idempotencyKey is required');
      const existing = data.feedbackJobs.find((item) => item.idempotencyKey === normalizedKey);
      if (existing) {
        return { job: cloneValue(existing), created: false, idempotent: true };
      }

      const attempt = data.answerAttempts.find((item) => item.id === attemptId);
      if (!attempt) throw new Error('answer attempt not found');
      const now = new Date().toISOString();
      const savedSourceSnapshot = cloneValue(sourceSnapshot);
      const job = {
        id: newId('feedback-job'),
        attemptId,
        idempotencyKey: normalizedKey,
        status: 'queued',
        provider: optionalString(provider),
        modelVersion: optionalString(modelVersion),
        promptVersion: optionalString(promptVersion),
        sourceSnapshot: savedSourceSnapshot,
        taskSnapshot: cloneValue(taskSnapshot),
        evidenceStatus: feedbackEvidenceStatus(savedSourceSnapshot),
        createdAt: now,
        queuedAt: now,
        updatedAt: now
      };
      const answerFeedback = createJobBackedAnswerFeedback(job, now);
      job.answerFeedbackId = answerFeedback.id;
      data.feedbackJobs.push(job);
      data.answerFeedbacks.push(answerFeedback);
      attempt.feedbackStatus = 'queued';
      return { job: cloneValue(job), created: true, idempotent: false };
    });
  }

  /**
   * Atomically takes a queued job. A worker that loses the race receives the
   * persisted state and must not issue a second model request.
   */
  async claimFeedbackJob(jobId) {
    return this.mutate((data) => {
      const job = data.feedbackJobs.find((item) => item.id === jobId);
      if (!job) throw new Error('feedback job not found');
      const attempt = data.answerAttempts.find((item) => item.id === job.attemptId);
      if (!attempt) throw new Error('answer attempt not found');
      if (job.status !== 'queued') {
        if (!feedbackForJob(data, job)) ensureJobBackedAnswerFeedback(data, job, new Date().toISOString());
        return { claimed: false, job: cloneValue(job), attempt: cloneValue(attempt) };
      }

      const now = new Date().toISOString();
      job.status = 'running';
      job.claimedAt = now;
      job.startedAt = now;
      job.updatedAt = now;
      const answerFeedback = ensureJobBackedAnswerFeedback(data, job, now);
      synchronizeJobBackedAnswerFeedback(answerFeedback, job, now);
      attempt.feedbackStatus = 'running';
      return { claimed: true, job: cloneValue(job), attempt: cloneValue(attempt) };
    });
  }

  /**
   * Persists a successful feedback result. Replays return the original result
   * rather than writing a second answer-feedback record.
   */
  async completeFeedbackJob({
    jobId,
    feedback,
    details = null,
    provider,
    modelVersion,
    promptVersion,
    sourceSnapshot
  }) {
    return this.mutate((data) => {
      const job = data.feedbackJobs.find((item) => item.id === jobId);
      if (!job) throw new Error('feedback job not found');
      if (job.status === 'succeeded') {
        const persistedFeedback = feedbackForJob(data, job)
          ?? ensureJobBackedAnswerFeedback(data, job, new Date().toISOString());
        return {
          job: cloneValue(job),
          feedback: persistedFeedback ? cloneValue(persistedFeedback) : null,
          idempotent: true
        };
      }
      if (job.status !== 'running') throw new Error('feedback job is not running');

      const attempt = data.answerAttempts.find((item) => item.id === job.attemptId);
      if (!attempt) throw new Error('answer attempt not found');
      applyFeedbackJobMetadata(job, { provider, modelVersion, promptVersion, sourceSnapshot });
      const now = new Date().toISOString();
      job.status = 'succeeded';
      job.completedAt = now;
      job.updatedAt = now;
      const answerFeedback = ensureJobBackedAnswerFeedback(data, job, now);
      synchronizeJobBackedAnswerFeedback(answerFeedback, job, now);
      answerFeedback.feedback = cloneValue(feedback);
      answerFeedback.details = cloneValue(details);
      attempt.feedbackStatus = 'succeeded';
      return {
        job: cloneValue(job),
        feedback: cloneValue(answerFeedback),
        idempotent: false
      };
    });
  }

  /**
   * Records a terminal model failure without exposing or retaining provider
   * error bodies. A completed job is never overwritten by a later failure.
   */
  async failFeedbackJob({
    jobId,
    errorCode,
    provider,
    modelVersion,
    promptVersion,
    sourceSnapshot
  }) {
    return this.mutate((data) => {
      const job = data.feedbackJobs.find((item) => item.id === jobId);
      if (!job) throw new Error('feedback job not found');
      if (job.status === 'failed' || job.status === 'succeeded') {
        if (!feedbackForJob(data, job)) ensureJobBackedAnswerFeedback(data, job, new Date().toISOString());
        return { job: cloneValue(job), feedback: null, idempotent: true };
      }
      if (job.status !== 'queued' && job.status !== 'running') {
        throw new Error('feedback job cannot be failed from its current state');
      }

      const attempt = data.answerAttempts.find((item) => item.id === job.attemptId);
      if (!attempt) throw new Error('answer attempt not found');
      applyFeedbackJobMetadata(job, { provider, modelVersion, promptVersion, sourceSnapshot });
      const now = new Date().toISOString();
      job.status = 'failed';
      job.errorCode = optionalString(errorCode) ?? 'unknown_error';
      job.failedAt = now;
      job.updatedAt = now;
      const answerFeedback = ensureJobBackedAnswerFeedback(data, job, now);
      synchronizeJobBackedAnswerFeedback(answerFeedback, job, now);
      attempt.feedbackStatus = 'failed';
      return { job: cloneValue(job), feedback: null, idempotent: false };
    });
  }

  /**
   * Retrieves the job and its feedback result without returning answer text.
   */
  async getFeedbackJob(jobId) {
    const data = await this.read();
    const job = data.feedbackJobs.find((item) => item.id === jobId);
    if (!job) return null;
    const feedback = feedbackForJob(data, job);
    return {
      job: cloneValue(job),
      feedback: feedback ? cloneValue(feedback) : null
    };
  }

  /**
   * Reconciles jobs left behind by a previous local server process. This
   * repository is intentionally single-process; callers must invoke this
   * before accepting new work so an in-flight job from the current process is
   * never mistaken for an interrupted one.
   *
   * Queued work remains eligible for a later worker. A running job is marked
   * failed rather than automatically replayed, because the previous process
   * may already have sent the model request and replaying could charge twice.
   */
  async reconcileFeedbackJobs() {
    return this.mutate((data) => {
      const queuedJobIds = [];
      const interruptedJobIds = [];
      const now = new Date().toISOString();
      for (const job of data.feedbackJobs) {
        if (job.status === 'queued') {
          queuedJobIds.push(job.id);
          continue;
        }
        if (job.status !== 'running') continue;

        job.status = 'failed';
        job.errorCode = 'worker_interrupted';
        job.failedAt = now;
        job.updatedAt = now;
        const answerFeedback = ensureJobBackedAnswerFeedback(data, job, now);
        synchronizeJobBackedAnswerFeedback(answerFeedback, job, now);
        const attempt = data.answerAttempts.find((item) => item.id === job.attemptId);
        if (attempt) attempt.feedbackStatus = 'failed';
        interruptedJobIds.push(job.id);
      }
      return { queuedJobIds, interruptedJobIds };
    });
  }

  async recordTaskCompletion({ content, reportedOn = todayKey(), sourceId, source = 'self_report', sourceMetadata }) {
    return this.mutate((data) => {
      const duplicate = sourceId && data.taskCompletionLogs.find((item) => item.sourceId === sourceId);
      if (duplicate) return { ...duplicate, idempotent: true };
      const recordedAt = new Date().toISOString();
      const entry = {
        id: `completion-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        userId: data.user.id,
        content: String(content).trim(),
        reportedOn,
        recordedAt,
        source,
        status: 'active',
        evidenceStatus: 'self_reported',
        ...(sourceMetadata ? { sourceMetadata: structuredClone(sourceMetadata) } : {}),
        affectsSchedule: false,
        ...(sourceId ? { sourceId } : {})
      };
      data.taskCompletionLogs.push(entry);
      if (data.taskCompletionLogs.length > 500) data.taskCompletionLogs.splice(0, data.taskCompletionLogs.length - 500);
      return { ...entry, idempotent: false };
    });
  }

  async voidTaskCompletion({ completionId, userId, sourceId }) {
    return this.mutate((data) => {
      const entry = data.taskCompletionLogs.find((item) => item.id === completionId && item.userId === userId);
      if (!entry) throw new Error('task completion not found');
      if (entry.status === 'voided') return { ...entry, idempotent: true };
      entry.status = 'voided';
      entry.voidedAt = new Date().toISOString();
      if (sourceId) entry.voidSourceId = sourceId;
      return { ...entry, idempotent: false };
    });
  }

  async claimAnswerFeedback({ attemptId, sourceId, promptVersion }) {
    return this.mutate((data) => {
      const attempt = data.answerAttempts.find((item) => item.id === attemptId);
      if (!attempt) throw new Error('answer attempt not found');
      const existing = data.answerFeedbacks.find((item) => item.sourceId === sourceId);
      if (existing) return { claimed: false, feedback: { ...existing } };
      const now = new Date().toISOString();
      const feedback = {
        id: `feedback-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        attemptId,
        sourceId,
        promptVersion,
        status: 'generating',
        evidenceStatus: 'unverified_demo_material',
        createdAt: now,
        updatedAt: now
      };
      data.answerFeedbacks.push(feedback);
      attempt.feedbackStatus = 'generating';
      return { claimed: true, feedback: { ...feedback } };
    });
  }

  async completeAnswerFeedback({ sourceId, feedback, modelId }) {
    return this.mutate((data) => {
      const record = data.answerFeedbacks.find((item) => item.sourceId === sourceId);
      if (!record) throw new Error('answer feedback not found');
      if (record.status === 'completed') return { ...record, idempotent: true };
      record.status = 'completed';
      record.feedback = feedback;
      record.modelId = modelId;
      record.updatedAt = new Date().toISOString();
      const attempt = data.answerAttempts.find((item) => item.id === record.attemptId);
      if (attempt) attempt.feedbackStatus = 'completed';
      return { ...record, idempotent: false };
    });
  }

  async failAnswerFeedback({ sourceId, errorCode }) {
    return this.mutate((data) => {
      const record = data.answerFeedbacks.find((item) => item.sourceId === sourceId);
      if (!record || record.status === 'completed') return record ? { ...record } : null;
      record.status = 'failed';
      record.errorCode = errorCode;
      record.updatedAt = new Date().toISOString();
      const attempt = data.answerAttempts.find((item) => item.id === record.attemptId);
      if (attempt) attempt.feedbackStatus = 'failed';
      return { ...record };
    });
  }
}

export function createSeedData() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const pastDate = todayKey(yesterday);
  return {
    schemaVersion: 4,
    user: {
      id: 'li-yangyang',
      name: '李羊羊',
      examGoal: '2027 年考研 333 教育综合',
      studyStage: 'first_round_completed',
      painPoints: ['容易遗忘', '难以坚持'],
      preferredTaskRange: { min: 3, max: 5 },
      feedbackStyle: 'encourage_then_actionable',
      reminderPreference: 'non_intrusive',
      targetExamDate: '2026-12-20',
      examDateStatus: 'estimated',
      targetSchool: null,
      targetMajor: null,
      dailyAvailableMinutes: null,
      dailyTaskLimit: 5,
      profileVersion: 'li-yangyang-v1'
    },
    knowledgePoints: [
      { id: 'kp-education-origin', order: 10, title: '教育的起源', sourceLabel: '演示知识库', recallPrompt: '不用看资料，概括教育起源的主要观点，并说出各自的核心依据。' },
      { id: 'kp-education-function', order: 20, title: '教育的社会功能', sourceLabel: '演示知识库', recallPrompt: '从个体发展与社会发展两个维度，列出教育的主要功能。' },
      { id: 'kp-education-purpose', order: 30, title: '教育目的的价值取向', sourceLabel: '演示知识库', recallPrompt: '比较个人本位论与社会本位论：各自观点、代表人物与评价。' },
      { id: 'kp-teaching-process', order: 40, title: '教学过程的基本规律', sourceLabel: '演示知识库', recallPrompt: '写出教学过程的主要规律，并任选一条说明它对课堂设计的启示。' },
      { id: 'kp-teaching-principles', order: 50, title: '教学原则', sourceLabel: '演示知识库', recallPrompt: '围绕“理论联系实际”解释含义、依据、贯彻要求。' },
      { id: 'kp-moral-education', order: 60, title: '德育过程的规律', sourceLabel: '演示知识库', recallPrompt: '用“知、情、意、行”的关系解释德育过程的一个规律。' },
      { id: 'kp-curriculum', order: 70, title: '课程类型', sourceLabel: '演示知识库', recallPrompt: '比较学科课程、活动课程、综合课程的基本特征。' },
      { id: 'kp-student-view', order: 80, title: '学生观', sourceLabel: '演示知识库', recallPrompt: '概括现代学生观，并说明它如何影响教师的教学行为。' }
    ],
    reviewStates: [
      { knowledgePointId: 'kp-education-origin', stage: 'review', intervalDays: 3, mastery: 0.56, lapseCount: 1, lastReviewedOn: pastDate, nextReviewOn: pastDate },
      { knowledgePointId: 'kp-education-function', stage: 'review', intervalDays: 5, mastery: 0.72, lapseCount: 0, lastReviewedOn: pastDate, nextReviewOn: pastDate },
      { knowledgePointId: 'kp-education-purpose', stage: 'learning', intervalDays: 1, mastery: 0.44, lapseCount: 2, lastReviewedOn: pastDate, nextReviewOn: pastDate },
      { knowledgePointId: 'kp-teaching-process', stage: 'review', intervalDays: 7, mastery: 0.61, lapseCount: 1, lastReviewedOn: pastDate, nextReviewOn: pastDate }
    ],
    reviewLogs: [],
    answerAttempts: [],
    answerFeedbacks: [],
    feedbackJobs: [],
    taskCompletionLogs: []
  };
}
