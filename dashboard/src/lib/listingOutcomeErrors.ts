// The send-outcome action's failure copy (last-heard-from spec 5.5): a failed
// call leaves the row unchanged with an inline error; a 503 carrying
// `saved: true` means the write landed but the server could not re-read the
// row, so the row says so instead of claiming nothing changed. Kept out of
// api/endpoints.ts on purpose: endpoints.test.ts mocks ./client.js without
// ApiError (the lib/contactTypeErrors.ts precedent).
import { ApiError } from '../api/index.js';

export const OUTCOME_SAVE_FAILED = "Couldn't save - try again.";
export const OUTCOME_SAVED_RELOAD = 'Saved - reload to see the change.';

/** True for the outcome route's 503 { error: 'outcome_unavailable', saved: true }. */
export function isOutcomeSaved(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 503) return false;
  const body = err.body;
  return body !== null && typeof body === 'object' && (body as Record<string, unknown>)['saved'] === true;
}

/**
 * True for the outcome route's 409 { error: 'tour_type_required' }: a
 * route-mode Interested click whose property lost its structured tour_type
 * since the page loaded (review B R2-5). Not an error to show - the caller
 * falls through to the form path (the Schedule tour form) instead.
 */
export function isTourTypeRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'tour_type_required';
}

/** The inline row error for a failed outcome action. */
export function outcomeErrorCopy(err: unknown): string {
  return isOutcomeSaved(err) ? OUTCOME_SAVED_RELOAD : OUTCOME_SAVE_FAILED;
}
