import { ArkFeedbackProvider } from './ark/feedback.js';

export const STRUCTURE_FEEDBACK_PROMPT_VERSION = 'structure-feedback-v1';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value) {
  const normalized = text(value);
  return normalized || null;
}

function snapshot(value) {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function errorCode(error) {
  const code = text(error?.code);
  return /^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(code) ? code : 'unknown_error';
}

function invalidFeedbackError() {
  const error = new Error('feedback provider returned no feedback');
  error.code = 'invalid_feedback';
  return error;
}

function defaultSourceSnapshot(channel, task) {
  return {
    channel: optionalText(channel) ?? 'unknown',
    evidenceStatus: 'unverified_demo_material',
    sourceChunkIds: [],
    task: {
      id: task?.id ?? null,
      knowledgePointId: task?.knowledgePointId ?? null,
      title: task?.title ?? null,
      prompt: task?.prompt ?? null,
      source: task?.source ?? task?.sourceLabel ?? null
    }
  };
}

/**
 * Channel-neutral orchestration for an answer-feedback request.
 *
 * Channels enqueue a durable job, trigger process when appropriate, and read
 * its result through get.  This class deliberately knows nothing about HTTP,
 * Feishu, review scheduling, or card rendering.
 */
export class FeedbackService {
  constructor({
    repository,
    provider = new ArkFeedbackProvider(),
    profileProvider = async () => ({}),
    providerName = 'ark',
    promptVersion = STRUCTURE_FEEDBACK_PROMPT_VERSION
  } = {}) {
    if (!repository) throw new Error('repository is required');
    this.repository = repository;
    this.provider = provider;
    this.profileProvider = typeof profileProvider === 'function' ? profileProvider : async () => ({});
    this.providerName = optionalText(providerName) ?? 'ark';
    this.promptVersion = optionalText(promptVersion) ?? STRUCTURE_FEEDBACK_PROMPT_VERSION;
  }

  isConfigured() {
    if (!this.provider || typeof this.provider.reviewAnswer !== 'function') return false;
    try {
      return typeof this.provider.isConfigured === 'function' ? Boolean(this.provider.isConfigured()) : true;
    } catch {
      return false;
    }
  }

  async enqueue({ attempt, task, idempotencyKey, sourceSnapshot, channel } = {}) {
    if (!attempt?.id) throw new Error('attempt.id is required');
    if (!task || typeof task !== 'object') throw new Error('task is required');
    if (!text(idempotencyKey)) throw new Error('idempotencyKey is required');

    return this.repository.createFeedbackJob({
      attemptId: attempt.id,
      idempotencyKey: text(idempotencyKey),
      provider: this.providerName,
      modelVersion: this.modelVersion(),
      promptVersion: this.promptVersion,
      // A caller with retrieved, reviewed evidence can provide its own
      // snapshot. Until then every channel gets the same explicit demo-mode
      // snapshot, rather than maintaining duplicate helpers at each adapter.
      sourceSnapshot: snapshot(sourceSnapshot === undefined ? defaultSourceSnapshot(channel, task) : sourceSnapshot),
      taskSnapshot: snapshot(task)
    });
  }

  async process(jobId) {
    let claim;
    try {
      claim = await this.repository.claimFeedbackJob(jobId);
    } catch (error) {
      return this.unavailableResult(null, errorCode(error));
    }

    if (!claim?.claimed) return this.readExisting(jobId, claim?.job ?? null);
    if (!claim.job?.id) return this.unavailableResult(null, 'invalid_job');

    const metadata = this.metadataFor(claim.job);
    if (!this.isConfigured()) return this.persistFailure(claim.job, 'not_configured', metadata);

    try {
      const answer = text(claim.attempt?.content);
      if (!answer) throw Object.assign(new Error('answer content is required'), { code: 'invalid_answer' });

      const profile = await this.profileProvider({
        job: claim.job,
        attempt: claim.attempt,
        sourceSnapshot: claim.job.sourceSnapshot
      });
      const result = await this.provider.reviewAnswer({
        task: claim.job.taskSnapshot ?? {},
        answer,
        profile: profile && typeof profile === 'object' ? profile : {}
      });
      if (!text(result?.feedback)) throw invalidFeedbackError();

      return await this.repository.completeFeedbackJob({
        jobId: claim.job.id,
        feedback: result.feedback,
        ...this.metadataFor(claim.job, result.modelId)
      });
    } catch (error) {
      return this.persistFailure(claim.job, errorCode(error), metadata);
    }
  }

  async get(jobId) {
    return this.repository.getFeedbackJob(jobId);
  }

  /**
   * Reconciles durable work before the local HTTP/Feishu adapters accept new
   * requests. The repository leaves queued jobs intact, while running jobs
   * from a terminated process become a terminal, auditable failure instead of
   * being replayed and potentially issuing a second paid model request.
   */
  async reconcilePending() {
    if (typeof this.repository.reconcileFeedbackJobs !== 'function') {
      return { queuedJobIds: [], interruptedJobIds: [] };
    }
    const result = await this.repository.reconcileFeedbackJobs();
    return {
      queuedJobIds: Array.isArray(result?.queuedJobIds) ? result.queuedJobIds : [],
      interruptedJobIds: Array.isArray(result?.interruptedJobIds) ? result.interruptedJobIds : []
    };
  }

  /** Processes a recovered list serially to keep startup cost bounded. */
  async processQueued(jobIds = []) {
    const results = [];
    for (const jobId of new Set(jobIds.filter((id) => typeof id === 'string' && id))) {
      const result = await this.process(jobId);
      results.push({ jobId, status: result?.job?.status ?? 'unavailable' });
    }
    return results;
  }

  modelVersion() {
    return optionalText(this.provider?.modelVersion) ?? optionalText(this.provider?.modelId);
  }

  metadataFor(job, resultModelVersion) {
    return {
      provider: optionalText(job?.provider) ?? this.providerName,
      modelVersion: optionalText(resultModelVersion) ?? optionalText(job?.modelVersion) ?? this.modelVersion(),
      promptVersion: optionalText(job?.promptVersion) ?? this.promptVersion,
      sourceSnapshot: snapshot(job?.sourceSnapshot)
    };
  }

  async readExisting(jobId, fallbackJob) {
    try {
      const existing = await this.get(jobId);
      if (existing) return { ...existing, idempotent: true };
    } catch {
      // The job was already claimed or completed, but reading it failed.  The
      // caller still receives a controlled result instead of a rejected task.
    }
    return { ...this.unavailableResult(fallbackJob, 'persistence_error'), idempotent: true };
  }

  async persistFailure(job, failureCode, metadata) {
    try {
      return await this.repository.failFeedbackJob({
        jobId: job.id,
        errorCode: failureCode,
        ...metadata
      });
    } catch {
      return this.unavailableResult({ ...job, status: 'failed', errorCode: failureCode }, 'persistence_error');
    }
  }

  unavailableResult(job, code) {
    return { job, feedback: null, errorCode: code };
  }
}
