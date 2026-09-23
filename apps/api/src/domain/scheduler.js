import { addDays } from './date.js';

export const ratings = ['again', 'hard', 'good', 'easy'];

const multipliers = {
  again: 0.4,
  hard: 1.2,
  good: 2.5,
  easy: 3.8
};

const firstIntervals = {
  again: 1,
  hard: 1,
  good: 3,
  easy: 5
};

/**
 * A deliberately small scheduler adapter. Its input/output mirrors the future
 * FSRS adapter, so storage and API contracts remain stable when ts-fsrs lands.
 */
export function scheduleReview(state, rating, reviewedOn) {
  if (!ratings.includes(rating)) {
    throw new Error('rating must be again, hard, good, or easy');
  }

  const previousInterval = Number(state.intervalDays ?? 0);
  const intervalDays = rating === 'again' ? 1 : previousInterval === 0
    ? firstIntervals[rating]
    : Math.max(1, Math.round(previousInterval * multipliers[rating]));
  const lapseCount = Number(state.lapseCount ?? 0) + (rating === 'again' ? 1 : 0);
  const masteryDelta = { again: -0.16, hard: -0.03, good: 0.08, easy: 0.13 }[rating];
  const mastery = Math.max(0.05, Math.min(0.98, Number(state.mastery ?? 0.3) + masteryDelta));

  return {
    ...state,
    stage: rating === 'again' ? 'learning' : 'review',
    intervalDays,
    lapseCount,
    mastery: Math.round(mastery * 100) / 100,
    lastReviewedOn: reviewedOn,
    pendingForgottenReview: false,
    nextReviewOn: addDays(reviewedOn, intervalDays)
  };
}
