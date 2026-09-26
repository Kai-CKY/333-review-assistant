import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConversationMemory, conversationScope } from '../agent/memory.js';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const fault = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const jobs = data => data.pdfImports ??= {};
export function pdfScope(env = process.env) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_TEST_GROUP_ID) throw fault('请先配置知识库所属的飞书应用和主群。', 503);
  return conversationScope({ appId: env.FEISHU_APP_ID.trim(), chatType: 'group', chatId: env.FEISHU_TEST_GROUP_ID.trim() });
}
export function validatePdf(filename, bytes) {
  if (typeof filename !== 'string' || !/\.pdf$/i.test(filename) || filename.length > 200) throw fault('仅支持 PDF 文件。');
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > MAX_PDF_BYTES) throw fault('PDF 必须小于 10 MB。', 413);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw fault('文件内容不是有效 PDF。');
}
export class MineruParser {
  constructor({ url = process.env.PDF_PARSER_URL, fetchImpl = fetch } = {}) { this.url = url?.replace(/\/$/, ''); this.fetch = fetchImpl; }
  configured() { return Boolean(this.url); }
  async health() {
    if (!this.configured()) return { configured: false, ready: false };
    try {
      const r = await this.fetch(`${this.url}/health`, { signal: AbortSignal.timeout(3000) });
      return { configured: true, ready: r.ok && (await r.json()).ready === true };
    } catch { return { configured: true, ready: false }; }
  }
  async parse(bytes) {
    if (!this.configured()) throw fault('PDF 解析服务尚未配置。', 503);
    const r = await this.fetch(`${this.url}/parse`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base64: bytes.toString('base64') }), signal: AbortSignal.timeout(21 * 60 * 1000) });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw fault(({ too_many_pages: 'PDF 超过 30 页，请拆分后上传。', encrypted_pdf: '请上传未加密的 PDF。', parser_busy: '解析器正忙，请稍后重试。', parser_timeout: '解析超时，请拆分文件后重试。', invalid_pdf: 'PDF 损坏或无法读取。' })[body.error] || 'MinerU 解析失败，请检查解析服务日志后重试。', 502);
    }
    const parsed = await r.json();
    if (parsed.parserName !== 'mineru' || !Array.isArray(parsed.pages) || !parsed.pages.length || parsed.pages.length > 30) throw fault('解析器返回了无效结果。', 502);
    let total = 0;
    parsed.pages.forEach((p, i) => {
      if (p.pageNumber !== i + 1 || !Array.isArray(p.blocks)) throw fault('解析页码不完整。', 502);
      for (const b of p.blocks) {
        if (typeof b.plainText !== 'string' || typeof b.blockId !== 'string') throw fault('解析块格式错误。', 502);
        total += b.plainText.length;
      }
    });
    if (!total || total > 500000) throw fault('未识别到正文或内容过长，请拆分文件。', 422);
    return parsed;
  }
}
export class PdfImportService {
  constructor({ repository, parser = new MineruParser() }) {
    this.repository = repository; this.parser = parser; this.memory = new ConversationMemory(repository);
    this.root = path.join(path.dirname(repository.filePath), 'knowledge-library');
    this.tail = Promise.resolve();
  }
  async reconcile() {
    await this.repository.mutate(data => { for (const j of Object.values(jobs(data))) if (['queued', 'running'].includes(j.status)) { j.status = 'failed'; j.error = '服务重启中断了解析，请重新上传。'; } });
  }
  async list(scope) { return Object.values(jobs(await this.repository.read())).filter(j => j.scopeKey === scope.key).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  async get(scope, id) {
    const job = jobs(await this.repository.read())[id];
    if (!job || job.scopeKey !== scope.key) throw fault('未找到此 PDF。', 404);
    return job;
  }
  async submit(scope, { filename, bytes, actor }) {
    if (!this.parser.configured()) throw fault('PDF 解析服务尚未配置。', 503);
    validatePdf(filename, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await this.repository.mutate(data => {
      const all = Object.values(jobs(data));
      const prior = all.find(j => j.scopeKey === scope.key && j.sha256 === sha256 && j.status !== 'failed');
      if (prior) return { job: prior, duplicate: true };
      if (all.filter(j => ['queued', 'running'].includes(j.status)).length >= 3) throw fault('已有 3 份 PDF 正在排队，请稍后上传。', 429);
      const id = `KP-${randomUUID().slice(0, 8)}`;
      if (data.photoKnowledge?.drafts?.[id] || data.photoKnowledge?.documents?.[id] || jobs(data)[id]) throw fault('请重试上传。', 409);
      const job = jobs(data)[id] = { id, filename: path.basename(filename.replaceAll('\\', '/')), sha256, scopeKey: scope.key,
        status: 'queued', actor, createdAt: new Date().toISOString(), bytes: bytes.length };
      return { job, duplicate: false };
    });
    if (result.duplicate) return result.job;
    try {
      const dir = path.join(this.root, result.job.id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'source.pdf'), bytes, { flag: 'wx', mode: 0o600 });
      this.tail = this.tail.catch(() => {}).then(() => this.run(scope, result.job.id));
      // run() persists failures; keep a handled promise for callers that do not wait.
      this.tail.catch(() => {});
    } catch { await this.fail(result.job.id, '原文件保存失败，请重新上传。'); throw fault('原文件保存失败。', 500); }
    return result.job;
  }
  async fail(id, error) { await this.repository.mutate(data => { Object.assign(jobs(data)[id], { status: 'failed', error }); }); }
  async run(scope, id) {
    try {
      await this.repository.mutate(data => { jobs(data)[id].status = 'running'; });
      const dir = path.join(this.root, id);
      const parsed = await this.parser.parse(await readFile(path.join(dir, 'source.pdf')));
      await writeFile(path.join(dir, 'parsed.json'), JSON.stringify(parsed, null, 2), { mode: 0o600 });
      await this.repository.mutate(data => { Object.assign(jobs(data)[id], { status: 'ready', parsed, completedAt: new Date().toISOString() }); });
    } catch (e) { await this.fail(id, e.statusCode ? e.message : '解析失败，请检查解析服务状态后重新上传。'); }
  }
  async confirm(scope, id, actor) {
    const session = await this.memory.session(scope);
    return this.repository.mutate(data => {
      const job = jobs(data)[id];
      if (!job || job.scopeKey !== scope.key) throw fault('未找到此 PDF。', 404);
      if (job.status === 'saved') return { id, saved: true, duplicate: true };
      if (job.status !== 'ready') throw fault('解析尚未完成，不能入库。', 409);
      const items = [];
      for (const page of job.parsed.pages) {
        for (const block of page.blocks) {
          const text = block.plainText.trim();
          if (!text) continue;
          for (let offset = 0; offset < text.length; offset += 4000) items.push({
            id: `P${page.pageNumber}B${items.length + 1}`, title: `${job.filename} · 第${page.pageNumber}页 · ${text.slice(offset, offset + 35)}`,
            text: `【用户确认的 PDF 转写资料；内容待核验，不作为标准答案。】\n${text.slice(offset, offset + 4000)}`,
            evidenceStatus: 'unresolved', citations: [], sourcePage: page.pageNumber, sourceBlockId: block.blockId, bbox: block.bbox ?? null
          });
        }
      }
      if (!items.length || items.length > 2000) throw fault('没有可入库的正文，或条目过多，请拆分文件。');
      const now = new Date().toISOString();
      const content = { title: job.filename, items, differences: ['MinerU 转写，经用户确认按原文存档；未进行事实核验。'], queries: [] };
      const store = data.photoKnowledge ??= { schemaVersion: 1, documents: {}, drafts: {}, events: [] };
      if (store.documents[id] || store.drafts[id]) throw fault('知识编号冲突，请重新上传。', 409);
      const confirmation = { channel: 'pdf_import', actor, at: now, mode: 'save_as_is_with_uncertainty' };
      const revision = { version: 1, title: job.filename, items, confirmedBy: actor, confirmation, sourceDraftId: id, contentHash: job.sha256, savedAt: now, evidenceStatus: 'unresolved' };
      store.documents[id] = { id, scopeKey: scope.key, uploadedAt: job.createdAt, createdAt: now, title: job.filename, currentVersion: 1, revisions: [revision] };
      store.drafts[id] = { id, scopeKey: scope.key, sessionId: session.id, sourceMessageId: `pdf:${job.sha256}`, sourceUploadedAt: job.createdAt, createdAt: job.createdAt,
        status: 'saved', savedVersion: 1, assets: [], actions: [], versions: [{ version: 1, content, createdAt: now, delivered: true, contentHash: job.sha256,
          verification: { checks: items.map(i => ({ id: i.id, status: 'unresolved', text: i.text, citations: [] })) } }],
        importProvenance: { archiveDir: path.join(this.root, id), confirmation, parser: job.parsed.parserName, parserVersion: job.parsed.parserVersion } };
      store.events.push({ type: 'pdf_import_confirmed', id, scopeKey: scope.key, confirmation, at: now });
      job.status = 'saved'; job.confirmedBy = actor; job.savedAt = now;
      return { id, saved: true, items: items.length };
    });
  }
}
