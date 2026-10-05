import { activeStudyPoints } from '../knowledge/library.js';
import { taskForPoint } from '../knowledge/references.js';
import { todayKey } from './date.js';

// Full pending queue, independent of the daily recommendation limit.
// A group receives only counts from its own source scope.
export function reviewQueue(data, { targetDate = todayKey(), scopeKey } = {}) {
  const points = activeStudyPoints(data).filter(p => !scopeKey || p.sourceScopeKey === scopeKey);
  const states = new Map(data.reviewStates.map(s => [s.knowledgePointId, s]));
  const due = points.map(point => ({ point, state: states.get(point.id) }))
    .filter(({ state }) => state && state.nextReviewOn <= targetDate)
    .sort((a, b) => Number(Boolean(b.state.pendingForgottenReview)) - Number(Boolean(a.state.pendingForgottenReview))
      || a.state.nextReviewOn.localeCompare(b.state.nextReviewOn));
  return {
    reviewStats: {
      enrolled: points.length,
      pending: due.length,
      scheduled: points.filter(p => states.get(p.id)?.nextReviewOn > targetDate).length,
      unstarted: points.filter(p => !states.has(p.id)).length
    },
    pendingReviews: due.map(({ point, state }) => {
      const { reference, ...task } = taskForPoint(point, state, {
        type: 'review', label: state.pendingForgottenReview ? '发现遗忘，待复习' : '到期复习'
      });
      return task;
    })
  };
}
