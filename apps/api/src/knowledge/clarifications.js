import { randomUUID } from 'node:crypto';
import { allowedScope, libraryPolicy } from './library.js';
import { conversationScope } from '../agent/memory.js';

const INVITATION_MS = 10 * 60 * 1000;
const fault = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function state(data) {
  const store = data.photoClarifications ??= {};
  store.issues ??= {}; store.invitations ??= {}; store.events ??= [];
  return store;
}
function authorize(actor, write = false, approverId) {
  if (!actor?.id || !['learner', 'admin'].includes(actor.role) || (write && actor.role !== 'learner') ||
    (write && approverId && actor.id !== approverId)) throw fault('仅学习者本人可以回答或延后疑点；管理员可查看。', 403);
}
function sourceFor(data, issue) {
  const doc = data.photoKnowledge?.documents?.[issue.documentId];
  const revision = doc?.revisions?.find(r => r.version === doc.currentVersion);
  if (!doc || doc.materialKind !== 'source_note' || doc.scopeKey !== issue.scopeKey ||
    doc.currentVersion !== issue.sourceVersion || !(revision?.confirmedBy || revision?.archivedBy) ||
    !revision.items?.some(item => item.id === issue.blockId)) return null;
  return { doc, revision };
}
function safeIssue(data, issue) {
  const source = sourceFor(data, issue);
  return { ...structuredClone(issue), sourceTitle: source?.revision.title || source?.doc.title || '图片笔记' };
}
function questionFor(issue, channel = 'group') {
  const prompt = String(issue.prompt || (issue.kind === 'ocr' ? '这里的字应当怎样读？' : '这里你希望怎样理解？')).slice(0, 400);
  const instruction = channel === 'web' ? '请在下方填写你的界定；也可以点击“暂不确定”，保留疑点稍后再看。' : '可以回复本条消息说明，也可以回复“暂不确定”，保留疑点稍后再看。';
  return `有一处${issue.kind === 'ocr' ? '识读' : '知识'}疑点想请你界定：${prompt}\n${instruction}`;
}

/** Clarifications annotate a source; answering never rewrites it or creates a reviewed answer. */
export class ClarificationService {
  constructor({ repository, approverId } = {}) { this.repository = repository; this.approverId = approverId; }
  webVisible(data, issue) {
    return Boolean(sourceFor(data, issue) && allowedScope(data, issue.scopeKey, this.repository.knowledgePolicy || libraryPolicy()));
  }
  groupScope(data, scope, sessionId) {
    if (!scope?.key || conversationScope(scope).key !== scope.key) throw fault('疑点会话范围无效。', 403);
    const stream = data.agentMemory?.streams?.[scope.key];
    if (!stream || (sessionId && stream.sessionId !== sessionId)) throw fault('会话已重置，请重新获取疑点。', 409);
  }
  async list({ scopeKey, status, limit = 30 } = {}, actor) {
    authorize(actor);
    if (status && !['open', 'resolved'].includes(status)) throw fault('疑点状态无效。');
    const data = await this.repository.read();
    const rows = Object.values(data.photoClarifications?.issues || {}).filter(issue => this.webVisible(data, issue) &&
      (!scopeKey || issue.scopeKey === scopeKey) && (!status || issue.status === status))
      .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || String(a.createdAt).localeCompare(String(b.createdAt)));
    return { total: rows.length, openCount: rows.filter(issue => issue.status === 'open').length,
      items: rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 30))).map(issue => safeIssue(data, issue)) };
  }
  async next(scope, actor, { sessionId } = {}) {
    if (scope && !this.approverId) throw fault('学习者身份尚未绑定，不能发起疑点问答。', 403);
    authorize(actor, true, scope ? this.approverId : undefined);
    return this.repository.mutate(data => {
      if (scope) this.groupScope(data, scope, sessionId);
      const store = state(data), now = Date.now();
      const boundSessionId = scope ? sessionId || data.agentMemory.streams[scope.key].sessionId : null;
      const rows = Object.values(store.issues).filter(issue => issue.status === 'open' && sourceFor(data, issue) &&
        (scope ? issue.scopeKey === scope.key : this.webVisible(data, issue)) && (!issue.deferredUntil || Date.parse(issue.deferredUntil) <= now))
        .sort((a, b) => Number(a.kind !== 'ocr') - Number(b.kind !== 'ocr') || String(a.lastAskedAt || a.createdAt).localeCompare(String(b.lastAskedAt || b.createdAt)));
      if (!rows.length) return null;
      // Repeated button clicks reuse the active question; they do not consume more questions.
      const active = Object.values(store.invitations).find(inv => inv.actorId === actor.id && inv.channel === (scope ? 'group' : 'web') &&
        inv.sessionId === boundSessionId && (!scope || inv.scopeKey === scope.key) && inv.status === 'pending' && Date.parse(inv.expiresAt) > now &&
        rows.some(issue => issue.id === inv.issueId && issue.revision === inv.issueRevision && issue.sourceVersion === inv.sourceVersion));
      if (active) { const issue = store.issues[active.issueId]; return { invitation: structuredClone(active), issue: safeIssue(data, issue), question: questionFor(issue, active.channel) }; }
      const issue = rows[0], at = new Date(now).toISOString();
      const invitation = { id: `CI-${randomUUID()}`, issueId: issue.id, issueRevision: issue.revision, sourceVersion: issue.sourceVersion,
        actorId: actor.id, scopeKey: issue.scopeKey, sessionId: boundSessionId, channel: scope ? 'group' : 'web', status: 'pending',
        createdAt: at, expiresAt: new Date(now + INVITATION_MS).toISOString(), deliveredAt: scope ? null : at, messageIds: [] };
      store.invitations[invitation.id] = invitation; issue.lastAskedAt = at;
      store.events.push({ type: 'clarification_invited', invitationId: invitation.id, issueId: issue.id, actor: actor.id, at });
      return { invitation: structuredClone(invitation), issue: safeIssue(data, issue), question: questionFor(issue, invitation.channel) };
    });
  }
  validate(data, id, actor, { scopeKey, sessionId } = {}, { delivered = true, replay = false } = {}) {
    const invitation = data.photoClarifications?.invitations?.[id];
    if (!invitation || invitation.actorId !== actor.id) throw fault('没有当前账号可回答的疑点邀请。', 403);
    if (invitation.channel === 'group' && !this.approverId) throw fault('学习者身份尚未绑定，不能回答疑点。', 403);
    authorize(actor, true, invitation.channel === 'group' ? this.approverId : undefined);
    if ((scopeKey && invitation.scopeKey !== scopeKey) || (invitation.channel === 'group' && (!scopeKey || sessionId !== invitation.sessionId))) throw fault('这条邀请不属于当前会话。', 409);
    if (invitation.channel === 'group' && data.agentMemory?.streams?.[invitation.scopeKey]?.sessionId !== invitation.sessionId) throw fault('会话已重置，请重新获取疑点。', 409);
    const issue = data.photoClarifications?.issues?.[invitation.issueId];
    if (!issue || !sourceFor(data, issue) || issue.sourceVersion !== invitation.sourceVersion || (invitation.channel === 'web' && !this.webVisible(data, issue))) throw fault('原资料已变化或不可访问，请重新获取疑点。', 409);
    if (replay) return { invitation, issue };
    if (invitation.status !== 'pending' || issue.status !== 'open' || issue.revision !== invitation.issueRevision) throw fault('这条疑点已处理或已更新，请重新获取。', 409);
    if (!Number.isFinite(Date.parse(invitation.expiresAt)) || Date.parse(invitation.expiresAt) <= Date.now()) throw fault('疑点邀请已过期，请重新获取。', 409);
    if (delivered && !invitation.deliveredAt) throw fault('疑点尚未送达，请重新获取。', 409);
    return { invitation, issue };
  }
  async bindDelivery(id, { messageIds = [] } = {}, actor, context = {}) {
    return this.repository.mutate(data => {
      const { invitation } = this.validate(data, id, actor, context, { delivered: false });
      if (!Array.isArray(messageIds) || !messageIds.length || messageIds.some(value => typeof value !== 'string' || !value)) throw fault('疑点消息尚未完整送达。');
      invitation.messageIds = [...new Set(messageIds)]; invitation.deliveredAt = new Date().toISOString();
      return structuredClone(invitation);
    });
  }
  async resolveReply(scope, actor, { replyToMessageId, invitationId, sessionId } = {}) {
    authorize(actor, true, this.approverId);
    if (!replyToMessageId && !invitationId) return null;
    const data = await this.repository.read(); this.groupScope(data, scope, sessionId);
    const invitation = invitationId ? data.photoClarifications?.invitations?.[invitationId] :
      Object.values(data.photoClarifications?.invitations || {}).find(inv => inv.actorId === actor.id && inv.scopeKey === scope.key && inv.messageIds?.includes(replyToMessageId));
    if (!invitation) return null;
    this.validate(data, invitation.id, actor, { scopeKey: scope.key, sessionId });
    return structuredClone(invitation);
  }
  async answer(id, { text, idempotencyKey } = {}, actor, context = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200) throw fault('请填写 1–4000 字的界定内容，并使用有效提交标识。');
    return this.repository.mutate(data => {
      const { invitation, issue } = this.validate(data, id, actor, context, { replay: true });
      if (invitation.status === 'answered' && invitation.idempotencyKey === idempotencyKey) {
        if (invitation.answerText !== text.trim()) throw fault('同一次提交的内容已变化，请重新获取疑点。', 409);
        return { ok: true, duplicate: true, issue: safeIssue(data, issue), answer: structuredClone(invitation.answer), message: '这次回答已保存。' };
      }
      this.validate(data, id, actor, context);
      const at = new Date().toISOString();
      const answer = { text: text.trim(), provenance: 'user_defined', actor: actor.id, at, invitationId: id, idempotencyKey, sourceVersion: issue.sourceVersion };
      issue.answer = answer; (issue.answers ??= []).push(structuredClone(answer)); issue.status = 'resolved'; issue.revision += 1; issue.resolvedAt = at;
      invitation.status = 'answered'; invitation.answeredAt = at; invitation.idempotencyKey = idempotencyKey; invitation.answerText = text.trim(); invitation.answer = structuredClone(answer);
      state(data).events.push({ type: 'clarification_answered', issueId: issue.id, invitationId: id, actor: actor.id, at });
      return { ok: true, issue: safeIssue(data, issue), answer: structuredClone(answer), message: '已记下你的界定，原文保留；这不是事实核验。' };
    });
  }
  async defer(id, actor, context = {}) {
    return this.repository.mutate(data => {
      const { invitation, issue } = this.validate(data, id, actor, context);
      const at = new Date().toISOString(); invitation.status = 'deferred'; invitation.deferredAt = at;
      issue.deferredUntil = new Date(Date.now() + INVITATION_MS).toISOString(); issue.lastDeferredAt = at;
      state(data).events.push({ type: 'clarification_deferred', issueId: issue.id, invitationId: id, actor: actor.id, at });
      return { ok: true, deferred: true, issue: safeIssue(data, issue), message: '这处继续保留为未决疑点，稍后再问。' };
    });
  }
}
