// parseIntroBody - the one validator behind the operator-edited group intro,
// shared by all three relay-open routes.
import { describe, expect, it } from 'vitest';

import { parseIntroBody, RELAY_INTRO_MAX_CHARS } from '../src/lib/relayIntroBody.js';

describe('parseIntroBody', () => {
  it('an ABSENT body is the ordinary case, not an error', () => {
    // The operator did not touch the preview: nothing is stored and relayFanOut
    // composes the default. undefined and null both mean "not sent".
    expect(parseIntroBody(undefined)).toEqual({ body: undefined });
    expect(parseIntroBody(null)).toEqual({ body: undefined });
  });

  it('keeps an edited body, trimmed', () => {
    expect(parseIntroBody('  Hey, it is Sam. Moving day soon!  ')).toEqual({
      body: 'Hey, it is Sam. Moving day soon!',
    });
  });

  it('treats a blank/whitespace edit as NOT edited rather than refusing it', () => {
    // Clearing the box and confirming should send the default, never a blank
    // first-contact text and never a 400 the operator has to decode.
    expect(parseIntroBody('')).toEqual({ body: undefined });
    expect(parseIntroBody('    ')).toEqual({ body: undefined });
    expect(parseIntroBody('\n\t ')).toEqual({ body: undefined });
  });

  it('refuses a non-string', () => {
    expect(parseIntroBody(42)).toEqual({ error: 'introBody must be a string' });
    expect(parseIntroBody({ body: 'x' })).toEqual({ error: 'introBody must be a string' });
    expect(parseIntroBody(['x'])).toEqual({ error: 'introBody must be a string' });
  });

  it('enforces the length cap, measured AFTER trimming', () => {
    const atCap = 'x'.repeat(RELAY_INTRO_MAX_CHARS);
    expect(parseIntroBody(atCap)).toEqual({ body: atCap });
    // Trailing whitespace must not push an otherwise-legal body over the edge.
    expect(parseIntroBody(`${atCap}   `)).toEqual({ body: atCap });
    expect(parseIntroBody(`${atCap}x`)).toEqual({
      error: `introBody must be ${RELAY_INTRO_MAX_CHARS} characters or fewer`,
    });
  });

  it('the cap leaves real room to ADD to the composed default', () => {
    // The default runs ~215 chars and the whole point of editing is to append a
    // property address and who the landlord is. A cap that barely cleared the
    // default would make the feature useless.
    expect(RELAY_INTRO_MAX_CHARS).toBeGreaterThan(400);
  });

  it('does NOT require brand or opt-out language (founder decision)', () => {
    // Deliberate: the founder directed the removal of both from the group intro
    // and engineering stated the exposure. A validator that quietly re-imposed
    // them would overrule her. See lib/relayIntroBody.ts.
    expect(parseIntroBody('Hi!')).toEqual({ body: 'Hi!' });
  });
});
