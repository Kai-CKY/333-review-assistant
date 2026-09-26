import { KnowledgeWorkspace } from '../knowledge/workspace-service.js';
import { relevantExcerpt } from '../knowledge/text-search.js';

// Controlled backend adapters. Context is provided by authenticated channel code,
// never by a model-supplied role/scope. No write operation is exposed here.
export class KnowledgeTools {
  constructor(repository, { scopeKey } = {}) { this.workspace = new KnowledgeWorkspace(repository); this.scopeKey = scopeKey; }
  async searchKnowledge(query, { limit = 3, textbookOnly = false } = {}) {
    return this.workspace.search(String(query).slice(0, 500), { limit, textbookOnly, scopeKey: this.scopeKey });
  }
  async point(pointId) {
    const p = await this.workspace.get(pointId);
    if (this.scopeKey && p.sourceScopeKey !== this.scopeKey) throw Object.assign(new Error('知识点不可访问。'), { statusCode: 404 });
    return p;
  }
  async getKnowledgePoint(pointId) {
    const p = await this.point(pointId);
    return { id: p.id, title: p.title, version: p.sourceVersion, answerStatus: p.answerStatus,
      answerItems: (p.reviewedAnswer?.items || []).slice(0, 3), truncated: (p.reviewedAnswer?.items.length || 0) > 3,
      sourceAnchors: (p.sourceAnchors || []).slice(0, 20), evidenceStatus: p.evidenceStatus };
  }
  async getSourceExcerpt(pointId, { version, query = '' } = {}) {
    const p = await this.point(pointId);
    if (version !== undefined && Number(version) !== p.sourceVersion) throw Object.assign(new Error('资料已修订，请重新读取。'), { statusCode: 409 });
    return { id: p.id, version: p.sourceVersion, ...relevantExcerpt(p.text, query), sourceAnchors: p.sourceAnchors || [], evidenceStatus: p.evidenceStatus };
  }
  async getKnowledgeRelations(pointId) {
    await this.point(pointId);
    const graph = await this.workspace.graph(pointId);
    const data = this.scopeKey ? await this.workspace.repository.read() : null;
    const scopedIds = data ? new Set(data.knowledgePoints.filter(p => !p.hidden && !p.archived && p.sourceScopeKey === this.scopeKey).map(p => p.id)) : null;
    const nodes = graph.nodes.filter(n => !scopedIds || scopedIds.has(n.id)).map(n => ({ id: n.id, title: n.title }));
    const allowed = new Set(nodes.map(n => n.id));
    return { rootId: pointId, nodes, edges: graph.edges.filter(e => allowed.has(e.from) && allowed.has(e.to)).map(e => ({ from: e.from, to: e.to, type: e.type })), truncated: graph.truncated };
  }
}
