export function buildTodayPlan({ knowledgePoints, reviewStates, targetDate, maximumTasks = 5 }) {
  const states = new Map(reviewStates.map((state) => [state.knowledgePointId, state]));
  const points = knowledgePoints.map((point) => ({ ...point, state: states.get(point.id) }));

  const due = points
    .filter((point) => point.state && point.state.nextReviewOn <= targetDate)
    .sort((a, b) => Number(Boolean(b.state.pendingForgottenReview)) - Number(Boolean(a.state.pendingForgottenReview)) || a.state.nextReviewOn.localeCompare(b.state.nextReviewOn));

  const weak = points
    .filter((point) => point.state && !due.includes(point) && point.state.lastReviewedOn !== targetDate && point.state.mastery < 0.62 && point.sourceKind !== 'saved_knowledge')
    .sort((a, b) => a.state.mastery - b.state.mastery);

  const newPoints = points.filter((point) => !point.state).sort((a, b) => a.order - b.order);
  const candidates = [
    ...due.map((point) => toTask(point, 'review', point.state.pendingForgottenReview ? '发现遗忘，待复习' : '到期复习')),
    ...weak.map((point) => toTask(point, 'reinforce', '薄弱巩固')),
    ...newPoints.map((point) => toTask(point, 'learn', '新内容'))
  ];

  return candidates.slice(0, Math.max(maximumTasks, due.filter(p => p.state.pendingForgottenReview).length));
}

function toTask(point, type, label) {
  return {
    id: `${type}:${point.id}`,
    knowledgePointId: point.id,
    type,
    label,
    title: point.title,
    prompt: point.recallPrompt,
    estimatedMinutes: type === 'learn' ? 12 : 7,
    mastery: point.state?.mastery ?? 0.2,
    source: point.sourceLabel,
    ...(point.sourceKind === 'saved_knowledge' ? { reference: {
      text: point.text, evidenceStatus: point.evidenceStatus, citations: point.citations,
      documentId: point.sourceDocumentId, itemId: point.sourceItemId, version: point.sourceVersion
    } } : {})
  };
}
