import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConversationMemory } from '../agent/memory.js';
import { savedItems, searchSavedItems, uploadTimestamp } from './library.js';

function state(data) { return data.photoKnowledge ??= { schemaVersion: 1, drafts: {}, documents: {}, events: [] }; }
function errorCode(error) { return ['search_not_enabled', 'search_not_configured', 'search_not_executed', 'search_incomplete', 'model_output_incomplete', 'invalid_model_json'].includes(error.message) ? error.message : 'processing_failed'; }
function normalize(value) {
  if (!value || typeof value.title !== 'string' || !Array.isArray(value.items) || !value.items.length || value.items.length > 40) throw new Error('invalid_draft');
  const ids = new Set();
  for (const item of value.items) {
    if (typeof item.id !== 'string' || !/^[\w-]{1,40}$/.test(item.id) || ids.has(item.id) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 6000 || typeof item.title !== 'string') throw new Error('invalid_draft_item');
    ids.add(item.id);
  }
  return { title: value.title.slice(0, 200), transcription: String(value.transcription ?? '').slice(0, 40000), differences: (value.differences ?? []).slice(0, 80), items: value.items, queries: (value.queries ?? []).filter(q => typeof q === 'string').slice(0, 6) };
}
export function draftText(draft) {
  const v = draft.versions.at(-1);
  if (!v) return `草稿 ${draft.id} 尚未生成（${draft.status}）。`;
  const checks = new Map((v.verification?.checks ?? []).map(c => [c.id, c]));
  const rows = v.content.items.map(item => {
    const check = checks.get(item.id), ok = ['supported', 'corrected'].includes(check?.status);
    const textbook = check?.textbookSuggestion;
    return `${item.id}. ${item.title}【${ok ? (check.status === 'corrected' ? '已校正' : '有来源支持') : '待核验'}】\n${ok ? check.text : item.text}${item.uncertain ? '\n原图字形存在疑点；核验文本不代表原图逐字认证。' : ''}\n${check?.reason ?? '联网证据暂不可用。'}${check?.citations?.length ? `\n来源：${check.citations.join('；')}` : ''}${textbook ? `\n教材校正建议（待核对）：${textbook.text}\n${textbook.reason}\n${textbook.evidence.map(e => `${e.title}：${e.text}\n${e.sourceAnchors.map(a => `PDF第${a.pdfPage}页`).join('、')}`).join('\n')}` : ''}`;
  });
  return [`知识草稿 ${draft.id} v${v.version}｜${v.content.title}`, ...rows,
    v.content.differences.length ? `识读/修订差异：\n${v.content.differences.join('\n')}` : '两次识读未报告文字分歧；这不等于事实正确。',
    v.searchError === 'search_not_enabled' ? '联网搜索服务尚未开通，本稿不能作为已核验知识保存。' : '',
    `羊羊核对后可回复：确认 ${draft.id} v${v.version}。有待核验项时，可明确回复“确认已核验部分 ${draft.id} v${v.version}”。`,
    v.verification?.checks?.some(c => c.textbookSuggestion) ? `核对教材摘录与校正建议后，可明确回复“确认教材校正 ${draft.id} v${v.version}”；没有依据的条目不会保存。` : '',
    `修改建议：修改 ${draft.id} v${v.version}：……；完整定稿并要求保存：修改并保存 ${draft.id} v${v.version}：……。修改后会重新联网核验。`,
    `重查来源：重新核验 ${draft.id} v${v.version}。${draft.savedVersion === v.version ? '此版本已经确认保存。' : '当前仅为草稿，尚未保存此版本。'}`].filter(Boolean).join('\n\n');
}

export class PhotoKnowledgeService {
  constructor({ repository, model, search, approverId, assetsDir }) {
    Object.assign(this, { repository, model, search, approverId });
    this.assetsDir = assetsDir || path.join(path.dirname(repository.filePath), 'knowledge-assets');
    this.memory = new ConversationMemory(repository);
  }
  async reconcile() {
    return this.repository.mutate(data => {
      let count = 0;
      for (const draft of Object.values(state(data).drafts)) if (['recognizing', 'aligning', 'verifying', 'revising'].includes(draft.status)) { draft.status = 'interrupted'; draft.error = 'worker_interrupted'; count++; }
      return count;
    });
  }
  async get(scope, id) {
    const draft = state(await this.repository.read()).drafts[id];
    return draft?.scopeKey === scope.key ? structuredClone(draft) : null;
  }
  async patch(id, callback) { return this.repository.mutate(data => callback(state(data).drafts[id])); }
  async process(scope, message, images) {
    const session = await this.memory.session(scope);
    const draft = await this.repository.mutate(data => {
      const store = state(data), prior = Object.values(store.drafts).find(d => d.scopeKey === scope.key && d.sourceMessageId === message.messageId);
      if (prior) return { ...structuredClone(prior), duplicate: true };
      const id = `KP-${randomUUID().slice(0, 8)}`;
      return structuredClone(store.drafts[id] = { id, scopeKey: scope.key, sessionId: session.id, sourceMessageId: message.messageId, sourceUploadedAt: uploadTimestamp(message.createTime) || new Date().toISOString(), senderId: message.senderId, status: 'recognizing', createdAt: new Date().toISOString(), versions: [], reads: [], assets: [], actions: [] });
    });
    if (draft.duplicate) return draft;
    try {
      const assets = [];
      await mkdir(this.assetsDir, { recursive: true });
      for (const image of images) {
        const match = image.image_url?.url?.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
        if (!match) throw new Error('invalid_image');
        const bytes = Buffer.from(match[2], 'base64'), sha256 = createHash('sha256').update(bytes).digest('hex');
        const file = path.join(this.assetsDir, sha256);
        await writeFile(file, bytes, { mode: 0o600 });
        assets.push({ sha256, mime: match[1], bytes: bytes.length });
      }
      await this.patch(draft.id, d => { d.assets = assets; });
      for (const pass of [1, 2]) {
        const result = await this.model.recognize(images, pass);
        if (!Array.isArray(result.data?.pages) || result.data.pages.length !== images.length || result.data.pages.some(p => typeof p.text !== 'string' || !p.text.trim())) throw new Error('incomplete_ocr_pages');
        draft.reads.push(result);
        await this.patch(draft.id, d => { d.reads = draft.reads; d.status = pass === 2 ? 'aligning' : 'recognizing'; });
      }
      const aligned = await this.model.align(draft.reads[0].data, draft.reads[1].data);
      await this.makeVersion(draft.id, normalize(aligned.data), { kind: 'image', model: aligned.model });
    } catch (error) { await this.patch(draft.id, d => { d.status = 'failed'; d.error = errorCode(error); }); }
    return this.get(scope, draft.id);
  }
  async makeVersion(id, content, change) {
    await this.patch(id, d => { d.status = 'verifying'; d.pendingContent = content; d.pendingChange = change; });
    const data = await this.repository.read(), draft = state(data).drafts[id];
    const textbooks = savedItems(data, key => key === draft.scopeKey).filter(p => p.materialKind === 'textbook');
    const suggestions = new Map();
    if (textbooks.length && this.model?.compareTextbook) for (const item of content.items) {
      let evidence = searchSavedItems(textbooks, item.title, 3);
      if (!evidence.length) evidence = searchSavedItems(textbooks, item.text.slice(0, 120), 3);
      if (!evidence.length) continue;
      try {
        const result = await this.model.compareTextbook(item, evidence);
        if (!['supported', 'corrected'].includes(result.status) || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 6000 || !Array.isArray(result.evidenceIds) || !result.evidenceIds.length || result.evidenceIds.some(eid => !evidence.some(e => e.id === eid))) continue;
        suggestions.set(item.id, { status: result.status, text: result.text, reason: String(result.reason || '').slice(0, 1000), evidence: evidence.filter(e => result.evidenceIds.includes(e.id)) });
      } catch { /* A failed comparison must remain a visible unresolved item. */ }
    }
    let verification, searchError;
    const remaining = content.items.filter(item => !suggestions.has(item.id));
    if (remaining.length) try { verification = await this.search.verify({ ...content, items: remaining }); } catch (error) { searchError = errorCode(error); }
    // Even injected providers must supply evidence; never let model text authorize a write.
    const checks = content.items.map(item => {
      const c = verification?.checks?.find(c => c.id === item.id);
      const links = (c?.citations ?? []).filter(url => typeof url === 'string' && /^https?:\/\//.test(url));
      return { id: item.id, text: c?.text || item.text, reason: c?.reason || '未找到已核对证据', citations: links, status: ['supported', 'corrected'].includes(c?.status) && links.length ? c.status : 'unresolved',
        ...(suggestions.has(item.id) ? { textbookSuggestion: suggestions.get(item.id) } : {}) };
    });
    return this.patch(id, d => {
      const version = d.versions.length + 1;
      d.versions.push({ version, content, verification: { ...verification, checks }, searchError, change, createdAt: new Date().toISOString(), contentHash: createHash('sha256').update(JSON.stringify({ content, checks })).digest('hex'), delivered: false });
      d.status = 'awaiting_confirmation'; delete d.error;
      delete d.pendingContent; delete d.pendingChange;
      return structuredClone(d);
    });
  }
  async delivered(scope, id, version, messageIds = []) {
    return this.patch(id, d => {
      if (d.scopeKey !== scope.key || d.versions.at(-1)?.version !== version) return false;
      Object.assign(d.versions.at(-1), { delivered: true, messageIds, deliveredAt: new Date().toISOString() }); return true;
    });
  }
  async confirm(scope, { id, version, senderId, messageId, partial = false, explicitReplacement = false, textbook = false }) {
    if (!this.approverId || senderId !== this.approverId) return { ok: false, message: '仅已配置身份的羊羊可以确认或修改知识库。群昵称和自我介绍不能授权。' };
    const session = await this.memory.session(scope);
    return this.repository.mutate(data => {
      const store = state(data), d = store.drafts[id], v = d?.versions.at(-1);
      if (!d || d.scopeKey !== scope.key || d.sessionId !== session.id) return { ok: false, message: '当前会话没有这份草稿；重置前的草稿不能在新会话直接确认。' };
      if (d.actions.includes(messageId)) return { ok: true, message: '这次确认已处理，无需重复保存。' };
      if (!v || v.version !== version || !['awaiting_confirmation', 'saved'].includes(d.status)) return { ok: false, message: '草稿版本已变化或仍在处理，请核对最新版本后确认。' };
      if (!v.delivered && !explicitReplacement) return { ok: false, message: '草稿尚未完整送达，请先查看最新文字版本。' };
      if (d.savedVersion === version) return { ok: true, message: '这一版本已保存，没有重复建库。' };
      const currentSources = new Map(savedItems(data, key => key === scope.key).map(p => [p.id, p]));
      const checks = v.verification.checks.map(c => {
        if (!textbook || !c.textbookSuggestion) return c;
        const s = c.textbookSuggestion;
        if (s.evidence.some(e => currentSources.get(e.id)?.sourceVersion !== e.sourceVersion)) throw Object.assign(new Error('教材已修订，请重新核验后确认。'), { statusCode: 409 });
        return { ...c, text: s.text, status: s.status, textbookEvidence: s.evidence };
      });
      const accepted = checks.filter(c => ['supported', 'corrected'].includes(c.status));
      const pending = checks.filter(c => c.status === 'unresolved');
      if (!accepted.length || (pending.length && !partial)) return { ok: false, message: pending.length && accepted.length ? `还有 ${pending.length} 项待核验。请修改，或明确回复“确认已核验部分 ${id} v${version}”。` : '尚无完成核验的条目，暂不能保存为知识库。可开通搜索后重新核验。' };
      const doc = store.documents[id] ??= { id, scopeKey: scope.key, uploadedAt: d.sourceUploadedAt || d.createdAt, createdAt: new Date().toISOString(), revisions: [] };
      const items = accepted.map(c => ({ ...v.content.items.find(i => i.id === c.id), text: c.text, citations: c.citations, evidenceStatus: c.status,
        ...(c.textbookEvidence ? { textbookEvidence: c.textbookEvidence, originalText: v.content.items.find(i => i.id === c.id).text } : {}) }));
      const revision = { version, title: v.content.title, items, contentHash: v.contentHash, confirmedBy: senderId, confirmationMessageId: messageId, sourceDraftId: id, sourceMessageId: d.sourceMessageId, savedAt: new Date().toISOString(), excludedIds: pending.map(c => c.id) };
      doc.revisions.push(revision); doc.currentVersion = version; doc.title = v.content.title;
      d.savedVersion = version; d.status = 'saved'; d.actions.push(messageId);
      store.events.push({ type: 'knowledge_saved', id, version, scopeKey: scope.key, senderId, messageId, at: revision.savedAt });
      return { ok: true, message: `已保存 ${id} v${version}，共 ${items.length} 条知识点${pending.length ? `；${pending.length} 项待核验内容未入库` : ''}。旧版本保留，可用“知识库 ${id}”查看。` };
    });
  }
  async handleText(scope, message) {
    let text = String(message.content ?? '').trim();
    // Natural correction advice can create a reviewable draft, never authorize a save.
    if (!/^(确认|修改|建议|重新核验|查看草稿|知识库)/.test(text) && /应该|改成|改为|写错|漏了|补充|修正|这里不对/.test(text) && message.senderId === this.approverId) {
      const session = await this.memory.session(scope);
      const pending = Object.values(state(await this.repository.read()).drafts).filter(d => d.scopeKey === scope.key && d.sessionId === session.id && ['awaiting_confirmation', 'saved'].includes(d.status));
      if (pending.length === 1) text = `修改 ${pending[0].id} v${pending[0].versions.at(-1).version}：${text}`;
      else if (pending.length > 1) return { text: '有多份草稿，请在修改建议前指定草稿编号和版本。' };
    }
    if (/^(没问题[，, ]*)?(确认保存|可以保存|保存吧)[。！!]*$/.test(text)) text = '确认保存';
    const command = text.match(/^(确认教材校正|确认已核验部分|确认保存|确认|修改并保存|修改|建议|重新核验|查看草稿|知识库)(?:\s+(KP-[a-f0-9]{8}))?(?:\s+v(\d+))?\s*(?:[：:]\s*([\s\S]+))?$/i);
    if (!command) {
      // Existing group controller already routes here; no changes to its deployment patches.
      if (/^(知识库查询|修改|建议|确认|重新核验|查看草稿)/.test(text)) return null;
      const items = searchSavedItems(savedItems(await this.repository.read(), key => key === scope.key), text);
      if (!items.length) return null;
      const sources = items.map(item => `${item.title}【${['supported', 'corrected'].includes(item.evidenceStatus) ? '有来源支持' : '待核验，仅供参考'}】`).join('\n');
      let answer;
      try { answer = await this.model?.answerSavedKnowledge?.(text, items); } catch { /* Stored references remain available during a model outage. */ }
      return { text: `${answer || items.map(item => `${item.title}\n${item.text}`).join('\n\n')}\n\n入库资料：\n${sources}` };
    }
    const [, verb, explicitId, versionText, body] = command;
    if (verb === '知识库') {
      const docs = Object.values(state(await this.repository.read()).documents).filter(d => d.scopeKey === scope.key && (!explicitId || d.id === explicitId));
      return { text: docs.length ? docs.map(d => { const v = d.revisions.find(v => v.version === d.currentVersion); return `${v.title}\n${v.items.map(i => `${i.title}\n${i.text}\n${i.citations.join('\n')}`).join('\n\n')}`; }).join('\n\n') : '当前会话范围内还没有已确认的知识库内容。' };
    }
    const session = await this.memory.session(scope);
    const candidates = Object.values(state(await this.repository.read()).drafts).filter(d => d.scopeKey === scope.key && d.sessionId === session.id && ['awaiting_confirmation', 'saved'].includes(d.status));
    const d = explicitId ? candidates.find(d => d.id === explicitId) : candidates.length === 1 ? candidates[0] : null;
    if (!d) return { text: '请指定当前会话的草稿编号及版本，例如：确认 KP-xxxxxxxx v1。多份草稿时不会猜测要修改哪一份。' };
    const latest = d.versions.at(-1), version = Number(versionText || latest.version);
    if (verb === '查看草稿') return { draft: d };
    if (message.senderId !== this.approverId || !this.approverId) return { text: '仅已配置身份的羊羊可以确认、修改或重新核验这份草稿。' };
    if (version !== latest.version) return { text: `这是旧版本。请使用 ${d.id} v${latest.version}。` };
    if (explicitId && !versionText) return { text: `请带上版本，避免误改旧稿，例如：${verb} ${d.id} v${latest.version}${body ? `：${body}` : ''}` };
    if (verb.startsWith('确认') && !versionText && message.createTime && message.createTime < Date.parse(latest.deliveredAt || latest.createdAt)) return { text: `这条确认早于最新草稿送达，请查看后回复“确认 ${d.id} v${latest.version}”。` };
    if (verb.startsWith('确认')) return { text: (await this.confirm(scope, { id: d.id, version, senderId: message.senderId, messageId: message.messageId, partial: ['确认已核验部分', '确认教材校正'].includes(verb), textbook: verb === '确认教材校正' })).message };
    if (d.actions.includes(message.messageId)) return { draft: d, saveAfterDelivery: latest.change?.kind === '修改并保存' && latest.change?.messageId === message.messageId };
    if (verb !== '重新核验' && !body?.trim()) return { text: `请在“修改 ${d.id} v${version}：”后写出修改建议或完整修改版本。` };
    const claimed = await this.patch(d.id, draft => {
      if (!['saved', 'awaiting_confirmation'].includes(draft.status) || draft.versions.at(-1).version !== version) return false;
      draft.status = 'revising'; draft.pendingChange = { kind: verb, request: body, senderId: message.senderId, messageId: message.messageId, parentVersion: version }; return true;
    });
    if (!claimed) return { text: '已有修订在处理，请等待新版本。' };
    try {
      const revised = verb === '重新核验' ? latest.content : normalize((await this.model.revise(latest.content, body)).data);
      const next = await this.makeVersion(d.id, revised, { kind: verb, request: body || null, senderId: message.senderId, messageId: message.messageId, parentVersion: version });
      await this.patch(d.id, draft => { draft.actions.push(message.messageId); });
      // Even explicit "modify and save" first delivers the generated revision. Its
      // confirmation is performed by the controller after delivery, not by the LLM.
      return { draft: next, saveAfterDelivery: verb === '修改并保存' };
    } catch (error) {
      await this.patch(d.id, draft => { draft.status = 'awaiting_confirmation'; draft.error = errorCode(error); });
      return { text: '修改处理失败，原草稿和已保存版本均保留；请稍后重试。' };
    }
  }
}
