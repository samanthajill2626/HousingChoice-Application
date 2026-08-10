import { describe, expect, it } from 'vitest';
import { sendNowErrorMessage, suggestionResolutionErrorMessage } from './types.js';

// The complete accept/dismiss error vocabulary the suggestion-resolution routes
// can return today (app/src/services/suggestionResolution.ts +
// app/src/routes/suggestions.ts). Listed here rather than imported from the map
// so that DELETING an entry from the map is a test failure, not a silent
// downgrade to the generic sentence.
const SERVER_CODES = [
  'invalid_suggestion_identity',
  'accept_type_via_triage',
  'invalid_suggestion_value',
  'phone is not a valid phone number',
  'unknown_target',
  'no_pending_suggestion',
  'contact_not_found',
  'phone_in_use',
  'suggestion_resolution_in_progress',
  'suggestion_already_resolved',
  'suggestion_replaced',
  'suggestion_field_edited',
  'suggestion_resolution_lost',
  'suggestion_resolution_retry_exhausted',
];

const GENERIC = suggestionResolutionErrorMessage('a_code_no_server_has_ever_sent');

describe('suggestionResolutionErrorMessage', () => {
  it('covers every code the resolution routes can return with its own sentence', () => {
    for (const code of SERVER_CODES) {
      const copy = suggestionResolutionErrorMessage(code);
      expect(copy.length, code).toBeGreaterThan(0);
      expect(copy, code).not.toBe(GENERIC);
    }
  });

  it('never puts a machine token in front of staff', () => {
    for (const code of [...SERVER_CODES, 'some_future_code']) {
      const copy = suggestionResolutionErrorMessage(code);
      expect(copy, code).not.toContain('_');
      expect(copy, code).not.toContain(code);
    }
  });

  it('falls back to a generic retry sentence for an unknown or missing code', () => {
    expect(suggestionResolutionErrorMessage('some_future_code')).toBe(GENERIC);
    expect(suggestionResolutionErrorMessage('')).toBe(GENERIC);
    expect(GENERIC.length).toBeGreaterThan(0);
  });

  it('keeps the established phone-conflict sentence', () => {
    expect(suggestionResolutionErrorMessage('phone_in_use')).toBe(
      'That number already belongs to another contact.',
    );
  });

  it('reads the three retryable codes as transient', () => {
    for (const code of [
      'suggestion_resolution_in_progress',
      'suggestion_resolution_lost',
      'suggestion_resolution_retry_exhausted',
    ]) {
      expect(suggestionResolutionErrorMessage(code), code).toContain('try again in a moment');
    }
  });

  it('leaves the send-now resolver alone', () => {
    expect(sendNowErrorMessage('breaker_open')).toBe('Sending is paused right now - try again shortly.');
  });
});
