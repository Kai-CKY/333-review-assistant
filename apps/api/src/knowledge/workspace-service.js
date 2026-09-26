import { randomInt, randomUUID } from 'node:crypto';
import { visiblePoint, usableAnswer, sourceTextHash } from './references.js';
import { searchSavedItems } from './library.js';
import { todayKey } from '../domain/date.js';
import { rankItems } from './text-search.js';

const fault = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const state = data => data.knowledgeV2 ??= { answers: {}, enrollments: {}, relations: [], audit: [] };
const visible = data => data.knowledgePoints.filter(p => !p.hidden && !p.archived);
const summary = p => ({ id: p.id, title: p.title, materialKind: p.materialKind, sourceTitle: p.sourceTitle,
  sourceVersion: p.sourceVersion, sourceDocumentId: p.sourceDocumentId, practiceEligible: p.practiceEligible,
  evidenceStatus: p.evidenceStatus, hasReviewedAnswer: Boolean(p.reviewedAnswer) });
function authorized(actor, learnerOnly = false) {
  if (!actor?.id || !['admin', 'learner'].includes(actor.role) || (learnerOnly && actor.role !== 'learner')) throw fault('当前身份不能执行此操作。', 403);
}

export class KnowledgeWorkspace {
  constructor(repository) { this.repository = repository; }
  async list({ query = '', cursor = 0, limit = 30, kind, documentId, learning } = {}) {
    const data = await this.repository.read();
    let points = visible(data).filter(p => (!kind || p.materialKind === kind) && (!documentId || p.sourceDocumentId === documentId)
      && (learning !== 'enrolled' || p.practiceEligible !== false));
    if (query) {
      points = rankItems(points, String(query).slice(0, 500)).map(r => r.item);
    }
    const start = Math.max(0, Number(cursor) || 0), size = Math.max(1, Math.min(50, Number(limit) || 30));
    return { total: points.length, items: points.slice(start, start + size).map(summary), nextCursor: start + size < points.length ? start + size : null };
  }
  async get(pointId) {
    const data = await this.repository.read(), point = visiblePoint(data, pointId);
    const answer = usableAnswer(data, point);
    const latest = data.knowledgeV2?.answers?.[pointId]?.at(-1);
    return { ...point, reviewedAnswer: answer, answerVersion: latest?.version || 0, answerStatus: answer ? 'reviewed' : latest ? 'stale' : 'unreviewed',
      state: data.reviewStates.find(s => s.knowledgePointId === pointId) || null,
      timeline: [...data.memoryEvents.filter(e => e.knowledgePointId === pointId),
        ...data.reviewLogs.filter(r => r.knowledgePointId === pointId).map(r => ({ type: 'review', on: r.reviewedOn, rating: r.rating, nextReviewOn: r.nextReviewOn }))]
        .sort((a, b) => String(b.on).localeCompare(String(a.on))).slice(0, 100) };
  }
  async sources() {
    const data = await this.repository.read(), sources = new Map();
    for (const p of visible(data)) {
      if (!p.sourceDocumentId) continue;
      if (!sources.has(p.sourceDocumentId)) sources.set(p.sourceDocumentId, { id: p.sourceDocumentId, title: p.sourceTitle, materialKind: p.materialKind, pointCount: 0 });
      sources.get(p.sourceDocumentId).pointCount++;
    }
    return [...sources.values()];
  }
  async search(query, { scopeKey, textbookOnly = false, limit = 5 } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw fault('请输入 1–500 字的检索内容。');
    if (this.repository.searchPoints) {
      const hits = await this.repository.searchPoints(query, { scopeKey, textbookOnly, limit });
      return { retrievalId: randomUUID(), outcome: hits.length ? 'matched' : 'no_match', hits };
    }
    const data = await this.repository.read();
    const points = visible(data).filter(p => (!scopeKey || p.sourceScopeKey === scopeKey) && (!textbookOnly || p.materialKind === 'textbook'));
    const hits = searchSavedItems(points, query, limit);
    return { retrievalId: randomUUID(), outcome: hits.length ? 'matched' : 'no_match', hits };
  }
  async excerpt(pointId, version) {
    const p = await this.get(pointId);
    if (version !== undefined && p.sourceVersion !== Number(version)) throw fault('资料已修订，请重新检索。', 409);
    return { id: p.id, title: p.title, text: p.text, version: p.sourceVersion, sourceAnchors: p.sourceAnchors || [], evidenceStatus: p.evidenceStatus };
  }
  async reviewAnswer(pointId, input, actor) {
    authorized(actor);
    return this.repository.mutate(data => {
      const point = visiblePoint(data, pointId), store = state(data);
      const history = store.answers[pointId] ??= [], version = (history.at(-1)?.version || 0);
      if (input.expectedVersion !== version || input.pointVersion !== point.sourceVersion) throw fault('资料或答案已变化，请刷新后核对。', 409);
      if (input.reviewed !== true || !Array.isArray(input.items) || !input.items.length || input.items.length > 30) throw fault('请核对原文后确认 1–30 个答案要点。');
      const evidence = new Map();
      const items = input.items.map((item, i) => {
        if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 1500 || !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 3) throw fault('每个要点需有正文和 1–3 条原文依据。');
        const ids = item.evidence.map(ref => {
          const source = visiblePoint(data, ref.pointId);
          if (source.sourceKind !== 'saved_knowledge' || source.sourceVersion !== ref.version) throw fault('引用资料已变化或不可用。', 409);
          if (typeof ref.quote !== 'string' || !ref.quote.trim() || ref.quote.length > 3000 || !source.text.includes(ref.quote)) throw fault('引用必须是所选资料中的完整原文片段，最长 3000 字。');
          const key = `${source.id}:v${source.sourceVersion}:${ref.quote}`;
          if (!evidence.has(key)) evidence.set(key, { id: `E${evidence.size + 1}`, pointId: source.id, version: source.sourceVersion,
            title: source.title, textHash: sourceTextHash(source.text), quote: ref.quote, sourceAnchors: source.sourceAnchors || [] });
          return evidence.get(key).id;
        });
        return { id: `A${i + 1}`, text: item.text.trim(), evidenceIds: [...new Set(ids)] };
      });
      const answer = { version: version + 1, pointVersion: point.sourceVersion, status: 'reviewed', items,
        evidence: [...evidence.values()], reviewedBy: actor.id, reviewedAt: new Date().toISOString() };
      history.push(answer); store.audit.push({ type: 'answer_reviewed', pointId, version: answer.version, actor: actor.id, at: answer.reviewedAt });
      return structuredClone(answer);
    });
  }
  async enroll(pointId, actor) {
    authorized(actor, true);
    return this.repository.mutate(data => {
      visiblePoint(data, pointId); const store = state(data);
      if (!store.enrollments[pointId]) {
        const at = new Date().toISOString();
        store.enrollments[pointId] = { at, actor: actor.id };
        data.memoryEvents.push({ id: `enroll:${pointId}`, type: 'enrollment', knowledgePointId: pointId, on: todayKey(), recordedAt: at });
      }
      return { pointId, enrolled: true };
    });
  }
  async addRelation(from, input, actor) {
    authorized(actor);
    return this.repository.mutate(data => {
      visiblePoint(data, from);
      const store = state(data);
      if (input.deleteId) {
        const relation = store.relations.find(r => r.id === input.deleteId && (r.from === from || r.to === from));
        if (!relation) throw fault('知识关联不存在。', 404);
        relation.deletedAt ??= new Date().toISOString(); relation.deletedBy = actor.id; return relation;
      }
      visiblePoint(data, input.to);
      if (from === input.to || !['contains', 'contrast', 'confusable', 'prerequisite'].includes(input.type) || input.confirmed !== true) throw fault('请选择不同知识点，核对关系后确认。');
      const symmetric = ['contrast', 'confusable'].includes(input.type);
      const old = store.relations.find(r => !r.deletedAt && r.type === input.type && ((r.from === from && r.to === input.to) || (symmetric && r.to === from && r.from === input.to)));
      if (old) return old;
      if (!symmetric) {
        const pending = [input.to], visited = new Set();
        while (pending.length) {
          const current = pending.pop(); if (current === from) throw fault('该关系会形成循环，请核对方向。');
          if (visited.has(current)) continue; visited.add(current);
          pending.push(...store.relations.filter(r => !r.deletedAt && r.type === input.type && r.from === current).map(r => r.to));
        }
      }
      const relation = { id: randomUUID(), from, to: input.to, type: input.type, confirmedBy: actor.id, createdAt: new Date().toISOString() };
      store.relations.push(relation); return relation;
    });
  }
  async graph(pointId) {
    const data = await this.repository.read(), root = visiblePoint(data, pointId);
    const allowed = new Map(visible(data).map(p => [p.id, p]));
    const allEdges = (data.knowledgeV2?.relations || []).filter(r => !r.deletedAt && (r.from === pointId || r.to === pointId) && allowed.has(r.from) && allowed.has(r.to));
    const ids = new Set([root.id]); const edges = [];
    for (const e of allEdges) { if (ids.size >= 50 || edges.length >= 100) break; ids.add(e.from); ids.add(e.to); edges.push(e); }
    return { rootId: pointId, nodes: [...ids].map(id => ({ ...summary(allowed.get(id)), state: data.reviewStates.find(s => s.knowledgePointId === id) || null })),
      edges, truncated: edges.length < allEdges.length };
  }
  async spotCheck(actor) {
    authorized(actor, true);
    return this.repository.mutate(data => {
      const points = visible(data).filter(p => p.practiceEligible !== false && usableAnswer(data, p) &&
        !data.reviewLogs.some(r => r.knowledgePointId === p.id && r.reviewedOn === todayKey()));
      if (!points.length) throw fault('暂无可抽查知识点：请先加入学习范围并核对参考答案，今天已复习的会跳过。', 409);
      const store = state(data), used = new Set(store.spotChecks?.filter(x => x.on === todayKey()).map(x => x.pointId));
      const candidates = points.filter(p => !used.has(p.id));
      if (!candidates.length) throw fault('今天可抽查的知识点已全部抽过。', 409);
      const point = candidates[randomInt(candidates.length)];
      (store.spotChecks ??= []).push({ id: randomUUID(), pointId: point.id, on: todayKey(), actor: actor.id });
      return summary(point);
    });
  }
}
