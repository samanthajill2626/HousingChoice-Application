// Last heard from (spec docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1 and 14.2): the instant normalizer every last_heard_from_at
// writer shares, and the ONE attribution rule for "which contact is this
// inbound row FROM".
import { describe, expect, it } from 'vitest';
import { normalizeInstant } from '../src/lib/heardFrom.js';

describe('normalizeInstant', () => {
  it('canonicalizes a Z instant without milliseconds', () => {
    expect(normalizeInstant('2026-09-01T10:00:00Z')).toBe('2026-09-01T10:00:00.000Z');
  });

  it('canonicalizes an offset instant to UTC', () => {
    expect(normalizeInstant('2026-09-01T06:00:00-04:00')).toBe('2026-09-01T10:00:00.000Z');
  });

  it('leaves a canonical instant as it is', () => {
    expect(normalizeInstant('2026-09-01T10:00:00.000Z')).toBe('2026-09-01T10:00:00.000Z');
  });

  it('answers undefined for an unparseable, empty or absent input', () => {
    expect(normalizeInstant('yesterday')).toBeUndefined();
    expect(normalizeInstant('')).toBeUndefined();
    expect(normalizeInstant(undefined)).toBeUndefined();
  });
});
