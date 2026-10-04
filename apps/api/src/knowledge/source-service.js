import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConversationMemory } from '../agent/memory.js';
import { allowedScope, libraryPolicy, uploadTimestamp } from './library.js';
import { validateSourceContent } from './source-model.js';
import { errorCode, diagnosticText } from './service.js';

const MODE = 'source_restoration';
const inProgress = new Set(['queued', 'running', 'ocr_1', 'ocr_2', 'aligning', 'verifying', 'archiving']);
const fault = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const store = data => data.photoKnowledge ??= { schemaVersion: 1, drafts: {}, documents: {}, events: [] };
const questions = data => data.photoClarifications ??= { issues: {}, invitations: {}, events: [] };
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function validOcrRead(read, count) {
  const pages = read?.data?.pages;
  return Array.isArray(pages) && pages.length === count &&
    pages.every(page => page && Number.isInteger(page.image) && page.image >= 1 && page.image <= count && typeof page.text === 'string' && page.text.trim()) &&
    new Set(pages.map(page => page.image)).size === count;
}
function codeFor(error) {
  const code = error?.code || error?.message;
  return typeof code === 'string' && /^(invalid_source_[a-z_]+|source_[a-z_]+|incomplete_source_[a-z_]+)$/.test(code) ? code : errorCode(error);
}
function actorAllowed(actor, write = false) {
  if (!actor?.id || !['learner', 'admin'].includes(actor.role) || (write && actor.role !== 'learner')) throw fault('当前身份不能执行此操作。', 403);
}
function summary(job) {
  return { id: job.id, status: job.status, stage: job.stage, createdAt: job.createdAt, updatedAt: job.updatedAt,
    title: job.sourceContent?.title || '图片资料', imageCount: job.assets.length, completedReads: job.reads.length,
    error: job.error || null, failedStage: job.failedStage || null, searchError: job.searchError || null,
    textbookStatus: job.verification?.textbookStatus || null, documentId: job.documentId || null,
    issueCount: job.issueCount || 0, canRetry: ['failed', 'saved'].includes(job.status), retryKind: job.status === 'saved' ? 'verify' : 'resume' };
}

/** Durable checkpoints; image processing never owns an outbound chat message. */
export class SourcePhotoService {
  constructor({ repository, model, verifier, approverId, logger = console, assetsDir } = {}) {
    Object.assign(this, { repository, model, verifier, approverId, logger });
    this.mode = MODE;
    this.assetsDir = assetsDir || path.join(path.dirname(repository.filePath), 'knowledge-assets');
    this.memory = new ConversationMemory(repository);
    this.worker = null;
    this.wake = false;
    this.operations = new Map();
  }

  async enqueue(scope, message, images) {
    if (!scope?.key || !message?.messageId || !message.senderId) throw fault('图片来源不完整。');
    if (!Array.isArray(images) || images.length < 1 || images.length > 3) throw new Error('invalid_image');
    const duplicate = Object.values(store(await this.repository.read()).drafts).find(d => d.mode === MODE && d.scopeKey === scope.key && d.sourceMessageId === message.messageId);
    if (duplicate) return { ...clone(duplicate), duplicate: true };
    const session = await this.memory.session(scope), assets = [];
    await mkdir(this.assetsDir, { recursive: true });
    for (const image of images) {
      const match = image?.image_url?.url?.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) throw new Error('invalid_image');
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('invalid_image');
      const sha256 = hash(bytes);
      await writeFile(path.join(this.assetsDir, sha256), bytes, { mode: 0o600 });
      assets.push({ sha256, mime: match[1], bytes: bytes.length });
    }
    return this.repository.mutate(data => {
      const storage = store(data), prior = Object.values(storage.drafts).find(d => d.mode === MODE && d.scopeKey === scope.key && d.sourceMessageId === message.messageId);
      if (prior) return { ...clone(prior), duplicate: true };
      if (Object.values(storage.drafts).filter(d => d.mode === MODE && inProgress.has(d.status)).length >= 100) throw fault('后台图片任务过多，请稍后重试。', 429);
      const id = `KP-${randomUUID().slice(0, 8)}`, now = new Date().toISOString();
      const job = { id, mode: MODE, scopeKey: scope.key, scope: clone(scope), sessionId: session.id, senderId: message.senderId,
        learningKind: /遗忘|忘了|忘记|没记住/.test(message.text||'')?'forgotten':/新学|今天(?:学了|学习|刚学)/.test(message.text||'')?'learn':'record',
        sourceMessageId: message.messageId, sourceUploadedAt: uploadTimestamp(message.createTime) || now,
        createdAt: now, updatedAt: now, status: 'queued', stage: 'queued', assets, reads: [], versions: [], actions: [], attempts: 0 };
      storage.drafts[id] = job;
      storage.events.push({ type: 'source_queued', id, scopeKey: scope.key, at: now });
      return clone(job);
    });
  }

  async get(scope, id) {
    const job = store(await this.repository.read()).drafts[id];
    return job?.mode === MODE && job.scopeKey === scope.key ? clone(job) : null;
  }

  async list(actor, { limit = 30 } = {}) {
    actorAllowed(actor);
    const data = await this.repository.read(), policy = this.repository.knowledgePolicy || libraryPolicy();
    const jobs = Object.values(store(data).drafts).filter(d => d.mode === MODE && allowedScope(data, d.scopeKey, policy))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: jobs.slice(0, Math.max(1, Math.min(100, Number(limit) || 30))).map(job => ({ ...summary(job), issueCount: Object.values(data.photoClarifications?.issues || {}).filter(issue => issue.documentId === job.id && issue.status === 'open').length })), total: jobs.length };
  }

  visible(data, id, actor) {
    actorAllowed(actor);
    const job = store(data).drafts[id];
    if (job?.mode !== MODE || !allowedScope(data, job.scopeKey, this.repository.knowledgePolicy || libraryPolicy())) throw fault('图片任务不存在或当前不可访问。', 404);
    return job;
  }

  async getVisible(id, actor) {
    const data = await this.repository.read(), job = this.visible(data, id, actor);
    const issues = Object.values(data.photoClarifications?.issues || {}).filter(issue => issue.documentId === id);
    return { ...summary(job), issueCount: issues.filter(issue => issue.status === 'open').length,
      content: clone(job.sourceContent || null), verification: clone(job.verification || null), issues: issues.map(clone) };
  }

  async retry(id, actor) {
    actorAllowed(actor, true);
    const job = await this.repository.mutate(data => {
      const current = this.visible(data, id, actor);
      if (!['failed', 'saved'].includes(current.status)) throw fault('任务仍在处理，请稍后重试。', 409);
      if (current.status === 'saved') { delete current.verification; delete current.searchError; }
      current.status = 'queued'; current.stage = 'queued'; current.updatedAt = new Date().toISOString();
      delete current.error; delete current.failedStage;
      return summary(current);
    });
    void this.processQueued().catch(error => this.report(id, 'worker', error));
    return job;
  }

  async reconcile() {
    // Startup only: no active process may have a lease when this method is called.
    return this.repository.mutate(data => {
      const ids = [];
      for (const job of Object.values(store(data).drafts)) {
        if (job.mode !== MODE || !inProgress.has(job.status)) continue;
        if (job.status !== 'queued') job.recoveries = (job.recoveries || 0) + 1;
        if ((job.recoveries || 0) > 3) { job.status = 'failed'; job.error = 'source_recovery_exhausted'; job.failedStage = job.stage; }
        else { job.status = 'queued'; ids.push(job.id); }
        delete job.runId;
      }
      return ids;
    });
  }

  processQueued() {
    this.wake = true;
    if (this.worker) return this.worker;
    this.worker = (async () => {
      while (this.wake) {
        this.wake = false;
        while (true) {
          const job = Object.values(store(await this.repository.read()).drafts).find(d => d.mode === MODE && d.status === 'queued');
          if (!job) break;
          await this.process(job.id);
        }
      }
    })().finally(() => { this.worker = null; });
    return this.worker;
  }

  process(id) {
    if (this.operations.has(id)) return this.operations.get(id);
    const operation = this.run(id).finally(() => this.operations.delete(id));
    this.operations.set(id, operation);
    return operation;
  }

  async update(id, runId, callback) {
    return this.repository.mutate(data => {
      const job = store(data).drafts[id];
      if (!job || job.runId !== runId) throw new Error('source_lease_lost');
      callback(job, data);
      job.updatedAt = new Date().toISOString();
      return clone(job);
    });
  }

  report(id, stage, error) {
    const code = codeFor(error);
    // Keep bounded diagnostics without credentials, image bytes or provider response bodies.
    try { this.logger?.error?.('[SourcePhotoService]', { id, stage, code, message: diagnosticText(error?.message, 500), stack: diagnosticText(error?.stack, 2000) }); } catch {}
    return code;
  }

  async run(id) {
    const runId = randomUUID();
    let job = await this.repository.mutate(data => {
      const current = store(data).drafts[id];
      if (current?.mode !== MODE || current.status !== 'queued') return null;
      current.runId = runId; current.status = 'running'; current.attempts++;
      return clone(current);
    });
    if (!job) return null;
    let stage = 'assets';
    try {
      const images = [];
      for (const asset of job.assets) {
        if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('invalid_image');
        const bytes = await readFile(path.join(this.assetsDir, asset.sha256));
        if (hash(bytes) !== asset.sha256) throw new Error('invalid_image');
        images.push({ type: 'image_url', image_url: { url: `data:${asset.mime};base64,${bytes.toString('base64')}` } });
      }
      if (!job.sourceContent) {
        const invalidPass = job.reads.findIndex(read => !validOcrRead(read, images.length));
        if (invalidPass >= 0 || job.reads.length > 2) {
          // Older malformed checkpoints must not make every retry skip the broken OCR pass.
          job = await this.update(id, runId, d => { d.reads = d.reads.slice(0, invalidPass >= 0 ? invalidPass : 0); delete d.verification; });
        }
      }
      for (let pass = job.reads.length + 1; pass <= 2; pass++) {
        stage = `ocr_${pass}`;
        job = await this.update(id, runId, d => { d.stage = stage; d.status = stage; });
        const read = await this.model.recognize(images, pass);
        if (!validOcrRead(read, images.length)) throw new Error('incomplete_ocr_pages');
        job = await this.update(id, runId, d => { d.reads.push(read); });
      }
      if (!job.sourceContent) {
        stage = 'aligning';
        job = await this.update(id, runId, d => { d.stage = stage; d.status = stage; });
        const result = await this.model.align(job.reads[0].data, job.reads[1].data);
        const content = validateSourceContent(result.data, job.reads.map(read => read.data));
        job = await this.update(id, runId, d => { d.sourceContent = content; d.alignment = { model: result.model, usage: result.usage }; });
      }
      if (!job.verification) {
        stage = 'verifying';
        job = await this.update(id, runId, d => { d.stage = stage; d.status = stage; });
        let verification, searchError;
        try { verification = await this.verifier.verify(job.sourceContent, { scope: job.scope }); }
        catch (error) {
          searchError = this.report(id, stage, error);
          verification = { checks: [], errors: [{ code: searchError }], textbookStatus: error.textbookStatus || 'unavailable' };
        }
        job = await this.update(id, runId, d => { d.verification = verification; d.searchError = searchError || (verification.errors?.length ? 'search_partial_failed' : null); });
      }
      stage = 'archiving';
      job = await this.update(id, runId, (d, data) => this.archive(d, data));
      return job;
    } catch (error) {
      const code = this.report(id, stage, error);
      return this.update(id, runId, d => { d.status = 'failed'; d.error = code; d.failedStage = stage; delete d.runId; });
    }
  }

  archive(job, data) {
    const storage = store(data), existing = storage.documents[job.id];
    if (existing && (existing.materialKind !== 'source_note' || existing.scopeKey !== job.scopeKey)) throw new Error('invalid_source_content');
    const content = job.sourceContent, now = new Date().toISOString(), clarificationStore = questions(data);
    const checks = Array.isArray(job.verification?.checks) ? job.verification.checks : [];
    const items = content.items.map(item => {
      const matches = checks.filter(check => check.id === item.id), check = matches.length === 1 ? matches[0] : null;
      const kinds = [];
      if (item.uncertain || /【(?:不清|裁切|待辨认|待核对)】/.test(item.text)) kinds.push('ocr');
      // A service outage is operational state, not a question for the learner to solve.
      const failedBatch = job.verification?.errors?.some(failure => !failure.itemIds || failure.itemIds.includes(item.id));
      if (!failedBatch && check && ['corrected', 'unresolved'].includes(check.status) && !kinds.length) kinds.push('knowledge');
      for (const kind of kinds) {
        const issueId = `CQ-${hash(`${job.id}:1:${item.id}:${kind}`).slice(0, 20)}`;
        const location = item.region || '这条笔记';
        clarificationStore.issues[issueId] ??= { id: issueId, documentId: job.id, scopeKey: job.scopeKey, sourceVersion: 1,
          blockId: item.id, kind, status: 'open', revision: 1, originalText: item.text, region: location,
          prompt: kind === 'ocr' ? `“${item.title.slice(0, 80)}”在${location.slice(0, 60)}有识读疑点。这里原本是什么字或哪条知识？不确定可以跳过。`
            : `“${item.title.slice(0, 80)}”的含义还没确定。你希望这条笔记记住的知识或答案是什么？不确定可以跳过。`,
          candidates: [], answer: null, answers: [], createdAt: now };
      }
      return { ...clone(item), evidenceStatus: 'unresolved', factStatus: check?.status || 'not_checked',
        verificationSuggestion: check ? clone(check) : null, citations: [],
        textbookMatches: clone(check?.textbookMatches || []), transcriptionStatus: kinds.includes('ocr') ? 'needs_clarification' : 'machine_transcribed' };
    });
    const revision = { version: 1, title: content.title, transcription: content.transcription, differences: clone(content.differences || []),
      sourceAnnotations: clone(content.sourceAnnotations || []), items, contentHash: hash(JSON.stringify(content)),
      archivedBy: 'system:source-restoration', savedAt: now, sourceDraftId: job.id, sourceMessageId: job.sourceMessageId };
    if (existing) {
      const current = existing.revisions.find(value => value.version === existing.currentVersion);
      if (current.contentHash !== revision.contentHash) throw new Error('invalid_source_content');
      // Rechecking only updates sidecar evidence. Source text and learner definitions remain unchanged.
      existing.verification = clone(job.verification);
      existing.verificationUpdatedAt = now;
      for (const item of current.items) {
        const checked = items.find(value => value.id === item.id);
        item.verificationSuggestion = checked.verificationSuggestion;
        item.factStatus = checked.factStatus;
        item.textbookMatches = checked.textbookMatches;
      }
    } else {
      storage.documents[job.id] = { id: job.id, scopeKey: job.scopeKey, materialKind: 'source_note', title: content.title,
        learningKind: job.learningKind || 'record',
        uploadedAt: job.sourceUploadedAt, createdAt: now, currentVersion: 1, revisions: [revision], verification: clone(job.verification) };
    }
    job.versions = [{ version: 1, content: clone(content), verification: clone(job.verification), createdAt: now, delivered: false,
      deliveryPolicy: 'silent', contentHash: revision.contentHash }];
    job.documentId = job.id; job.savedVersion = 1; job.status = 'saved'; job.stage = 'completed';
    job.issueCount = Object.values(clarificationStore.issues).filter(issue => issue.documentId === job.id && issue.status === 'open').length;
    delete job.runId; delete job.error; delete job.failedStage;
    storage.events.push({ type: existing ? 'source_rechecked' : 'source_archived', id: job.id, scopeKey: job.scopeKey, at: now });
  }
}
