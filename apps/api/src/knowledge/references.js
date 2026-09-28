import { createHash } from 'node:crypto';
export const sourceTextHash = text => createHash('sha256').update(String(text || '')).digest('hex');
// A task is bound to an ID and an immutable reference snapshot, never a title search.
export function referenceForPoint(point) {
  if (point.sourceKind !== 'saved_knowledge') return null;
  return structuredClone({
    knowledgePointId: point.id, text: point.text, evidenceStatus: point.evidenceStatus,
    citations: point.citations || [], documentId: point.sourceDocumentId, itemId: point.sourceItemId,
    version: point.sourceVersion, sourceTitle: point.sourceTitle, sourceAnchors: point.sourceAnchors || [],
    qualityIssues: point.qualityIssues || [], structureStatus: point.structureStatus,
    ...(point.materialKind === 'source_note' ? { materialKind: point.materialKind, userDefinedAnswers: point.userDefinedAnswers || [],
      transcriptionStatus: point.transcriptionStatus, factStatus: point.factStatus } : {}),
    answer: point.reviewedAnswer || null
  });
}

export function taskForPoint(point, state, { type = 'practice', label = '自主练习' } = {}) {
  const reference = referenceForPoint(point);
  return {
    id: `${type}:${point.id}`, knowledgePointId: point.id, type, label, title: point.title,
    prompt: point.recallPrompt, estimatedMinutes: type === 'learn' ? 12 : 7,
    mastery: state?.mastery ?? 0.2, source: point.sourceLabel,
    ...(reference ? { reference } : {})
  };
}

export function visiblePoint(data, id) {
  const point = data.knowledgePoints.find(p => p.id === id && !p.archived && !p.hidden);
  if (!point) throw Object.assign(new Error('知识点不存在或当前不可访问。'), { statusCode: 404 });
  return point;
}

export function usableAnswer(data, point, pointIndex, hashes = new Map()) {
  const answer = data.knowledgeV2?.answers?.[point.id]?.at(-1);
  if (!answer || answer.status !== 'reviewed' || answer.pointVersion !== point.sourceVersion) return null;
  const index = pointIndex || new Map(data.knowledgePoints.map(p => [p.id, p]));
  const valid = answer.evidence.every(e => {
    const p = index.get(e.pointId);
    if (!p || p.archived || p.hidden || p.sourceVersion !== e.version) return false;
    if (!e.textHash) return p.text === e.text; // Preserve references written by the initial implementation.
    if (!hashes.has(p.id)) hashes.set(p.id, sourceTextHash(p.text));
    return hashes.get(p.id) === e.textHash && p.text.includes(e.quote);
  });
  return valid ? answer : null;
}
