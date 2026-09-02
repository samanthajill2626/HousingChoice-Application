import { describe, expect, it } from 'vitest';
import {
  MESSAGE_TRANSPORTS,
  REMINDER_SKIP_REASON_LABELS,
  REMINDER_SUPPRESSION_LABELS,
  sendNowErrorMessage,
  suggestionResolutionErrorMessage,
  suppressionLead,
  suppressionNote,
} from './types.js';

describe('MESSAGE_TRANSPORTS', () => {
  it('mirrors the complete authenticated message transport contract', () => {
    expect(MESSAGE_TRANSPORTS).toEqual(['sms', 'mms', 'rcs']);
  });
});

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

  it('never claims nothing changed for the one code whose effect may have committed', () => {
    // The `suggestion_resolution_lost` throw in `applyJournal`
    // (app/src/services/suggestionResolution.ts): a `stale` token also covers a
    // committed-then-lost acknowledgement, not just pre-commit contention, so
    // this copy may NOT assert the effect did not land. It has to say the
    // outcome is unconfirmed and point at the current value instead.
    const copy = suggestionResolutionErrorMessage('suggestion_resolution_lost');
    expect(copy).not.toContain('nothing changed');
    expect(copy).toMatch(/could not confirm/i);
  });

  it('leaves the send-now resolver alone', () => {
    expect(sendNowErrorMessage('breaker_open')).toBe('Sending is paused right now - try again shortly.');
  });
});

// The complete skip-reason vocabulary the app can stamp on a retired rung
// (app/src/repos/tourRemindersRepo.ts, ReminderSkipReason). Listed here as
// plain strings rather than imported or typed against the wire union so that
// the two hand-duplicated unions are checked against each other: the Record
// type already catches "member added to the dashboard union, label missing",
// but nothing catches "the app added a reason and the dashboard union was
// never touched" - which fails no build and degrades the chip to a
// reason-less "Skipped".
const SKIP_REASONS = [
  'no_conversation',
  'contact_missing',
  'contact_no_phone',
  'tour_missing',
  'quiet_hours_superseded',
  'past_event',
  'tenant_not_on_roster',
  'roster_unavailable',
  'invalid_schedule',
  'booked_too_late',
  'tour_already_passed',
  'kind_retired',
  'names_unavailable',
];

describe('REMINDER_SKIP_REASON_LABELS', () => {
  it('carries a staff-facing label for every reason the app can send', () => {
    const labels: Readonly<Record<string, string | undefined>> = REMINDER_SKIP_REASON_LABELS;
    for (const reason of SKIP_REASONS) {
      const label = labels[reason];
      expect(label, reason).toBeDefined();
      expect(label?.length ?? 0, reason).toBeGreaterThan(0);
    }
  });

  it('carries no label for a reason the app cannot send', () => {
    expect(Object.keys(REMINDER_SKIP_REASON_LABELS).sort()).toEqual([...SKIP_REASONS].sort());
  });

  it('never puts a machine token in front of staff', () => {
    for (const [reason, label] of Object.entries(REMINDER_SKIP_REASON_LABELS)) {
      expect(label, reason).not.toContain('_');
    }
  });
});

describe('SEND_NOW_ERROR_COPY', () => {
  // Refusal codes whose generic "try again" fallback would be a LIE - the
  // condition is permanent, so retrying can never work. Every such code MUST
  // carry explicit copy. names_unavailable is deliberately NOT listed: it keeps
  // its existing cause-agnostic copy, because there retrying IS the right
  // advice (spec 7.2). SEND_NOW_ERROR_COPY is module-private, so this asserts
  // through the exported resolver.
  const PERMANENT_REFUSALS = ['tour_already_passed', 'kind_retired'];
  it('carries explicit copy for every permanent refusal', () => {
    for (const code of PERMANENT_REFUSALS) {
      expect(sendNowErrorMessage(code), code).not.toBe(
        "Couldn't send that just now - please try again.",
      );
    }
  });
});

// The suppression vocabulary the app can send on an UPCOMING rung/card. Listed
// as plain strings, like SKIP_REASONS above and for the same reason: the
// exhaustive Record type catches "dashboard union grew, label missing", but
// nothing catches "the app added a reason and the dashboard union was never
// touched" - which fails no build and degrades the note to a raw token.
const SUPPRESSION_REASONS = [
  'sms_sending_disabled',
  'contact_opted_out',
  'manual_mode',
  'stale_stage',
  'quiet_hours',
  'paused',
  'discontinued',
];

describe('suppression copy', () => {
  it('carries a staff-facing label for every reason the app can send', () => {
    const labels: Readonly<Record<string, string | undefined>> = REMINDER_SUPPRESSION_LABELS;
    for (const reason of SUPPRESSION_REASONS) {
      const label = labels[reason];
      expect(label, reason).toBeDefined();
      expect(label?.length ?? 0, reason).toBeGreaterThan(0);
    }
    expect(Object.keys(REMINDER_SUPPRESSION_LABELS).sort()).toEqual(
      [...SUPPRESSION_REASONS].sort(),
    );
  });

  it('never puts a machine token in front of staff', () => {
    for (const [reason, label] of Object.entries(REMINDER_SUPPRESSION_LABELS)) {
      expect(label, reason).not.toContain('_');
    }
  });

  // `discontinued` is TERMINAL: neither a timed deferral nor a human hold, so
  // it must borrow neither "Will wait" (which promises a release) nor "Paused"
  // (which promises a person could release it) - and not "Will be skipped"
  // either, which describes THIS send being dropped rather than the kind being
  // retired.
  it('leads a discontinued rung with "No longer sent"', () => {
    expect(suppressionLead('discontinued')).toBe('No longer sent');
    expect(suppressionLead('discontinued')).not.toBe(suppressionLead('paused'));
    expect(suppressionLead('discontinued')).not.toBe(suppressionLead('quiet_hours'));
  });

  it('labels it "turned off", so the note does not stutter', () => {
    // The lead already says "No longer sent"; a label repeating that phrase
    // would render "No longer sent - no longer sent".
    expect(REMINDER_SUPPRESSION_LABELS['discontinued']).toBe('turned off');
    const note = suppressionNote('discontinued', REMINDER_SUPPRESSION_LABELS['discontinued']);
    expect(note).toContain('No longer sent');
    expect(note).toContain('turned off');
    expect(note.toLowerCase().split('no longer sent').length - 1).toBe(1);
  });
});
