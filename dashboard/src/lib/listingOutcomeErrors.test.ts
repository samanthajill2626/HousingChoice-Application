// The send-outcome action's failure copy (last-heard-from spec 5.5; plan 3.8):
// a 503 carrying `saved: true` is a saved write, anything else a failed save.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/index.js';
import { isOutcomeSaved, isTourTypeRequired, outcomeErrorCopy, OUTCOME_SAVE_FAILED, OUTCOME_SAVED_RELOAD } from './listingOutcomeErrors.js';

describe('listingOutcomeErrors', () => {
  it('a 503 whose body says saved: true is a saved write', () => {
    const err = new ApiError(503, 'outcome_unavailable', 'x', { error: 'outcome_unavailable', saved: true });
    expect(isOutcomeSaved(err)).toBe(true);
    expect(outcomeErrorCopy(err)).toBe('Saved - reload to see the change.');
    expect(OUTCOME_SAVED_RELOAD).toBe('Saved - reload to see the change.');
  });
  it('anything else is a failed save', () => {
    expect(isOutcomeSaved(new ApiError(503, 'outcome_unavailable', 'x', { error: 'outcome_unavailable' }))).toBe(false);
    expect(isOutcomeSaved(new ApiError(500, 'boom', 'x', { saved: true }))).toBe(false);
    expect(isOutcomeSaved(new Error('network'))).toBe(false);
    expect(outcomeErrorCopy(new Error('network'))).toBe("Couldn't save - try again.");
    expect(OUTCOME_SAVE_FAILED).toBe("Couldn't save - try again.");
  });
  // Review B R2-5: a route-mode Interested whose property lost its tour_type
  // since the page loaded falls through to the form path instead of an error.
  it('isTourTypeRequired: only the 409 tour_type_required answer', () => {
    expect(isTourTypeRequired(new ApiError(409, 'tour_type_required', 'tour_type_required', { error: 'tour_type_required' }))).toBe(true);
    expect(isTourTypeRequired(new ApiError(409, 'contact_not_tenant', 'x', { error: 'contact_not_tenant' }))).toBe(false);
    expect(isTourTypeRequired(new ApiError(400, 'tour_type_required', 'x', { error: 'tour_type_required' }))).toBe(false);
    expect(isTourTypeRequired(new Error('tour_type_required'))).toBe(false);
    expect(isTourTypeRequired(undefined)).toBe(false);
  });
});
