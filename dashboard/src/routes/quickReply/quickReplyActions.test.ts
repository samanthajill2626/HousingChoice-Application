// quickReplyActions tests - the action-id contract with the missed-call push.
// The property that matters most: an id is an index into the RAW settings array
// (voice.ts builds them that way), so nothing the sheet does for display may
// renumber them, and an id that no longer resolves must resolve to NOTHING
// rather than to a neighbouring reply.
import { describe, it, expect } from 'vitest';
import {
  buildQuickReplyOptions,
  optionForAction,
  parseActionHash,
  quickReplyActionId,
} from './quickReplyActions.js';

describe('buildQuickReplyOptions', () => {
  it('trims each reply and keeps the settings order', () => {
    expect(buildQuickReplyOptions(['  Please text me ', "I'll call you back"])).toEqual([
      { index: 0, body: 'Please text me' },
      { index: 1, body: "I'll call you back" },
    ]);
  });

  it('drops blank replies WITHOUT renumbering the survivors', () => {
    // The push ids by raw index, so dropping index 1 must leave the third reply
    // as index 2 - renumbering it to 1 would send the wrong text on 'qr-1'.
    const options = buildQuickReplyOptions(['first', '   ', 'third']);
    expect(options).toEqual([
      { index: 0, body: 'first' },
      { index: 2, body: 'third' },
    ]);
  });

  it('tolerates absent or empty settings', () => {
    expect(buildQuickReplyOptions(undefined)).toEqual([]);
    expect(buildQuickReplyOptions([])).toEqual([]);
    expect(buildQuickReplyOptions(['', ' '])).toEqual([]);
  });
});

describe('parseActionHash', () => {
  it('reads the id the service worker writes', () => {
    expect(parseActionHash('#action=qr-0')).toBe('qr-0');
    expect(parseActionHash('#action=qr-1')).toBe('qr-1');
  });

  it('tolerates other hash params around it', () => {
    expect(parseActionHash('#foo=1&action=qr-1')).toBe('qr-1');
  });

  it('percent-decodes the value', () => {
    expect(parseActionHash('#action=qr%2D1')).toBe('qr-1');
  });

  it('returns null when there is no action', () => {
    expect(parseActionHash('')).toBeNull();
    expect(parseActionHash('#')).toBeNull();
    expect(parseActionHash('#other=1')).toBeNull();
    // 'reaction=x' must not match as 'action=x'.
    expect(parseActionHash('#reaction=qr-0')).toBeNull();
  });

  it('returns the raw value rather than throwing on a malformed escape', () => {
    expect(parseActionHash('#action=%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('optionForAction', () => {
  const options = buildQuickReplyOptions(['first', '   ', 'third']);

  it('resolves an id to the reply at that RAW index', () => {
    expect(optionForAction(options, 'qr-0')).toEqual({ index: 0, body: 'first' });
    expect(optionForAction(options, 'qr-2')).toEqual({ index: 2, body: 'third' });
  });

  it('resolves NOTHING for an id whose reply is gone or blank', () => {
    // Settings edited between the push and the tap. Sending a neighbour would
    // text the caller something the founder never chose.
    expect(optionForAction(options, 'qr-1')).toBeUndefined();
    expect(optionForAction(options, 'qr-9')).toBeUndefined();
  });

  it('resolves nothing for an absent or unrecognised id', () => {
    expect(optionForAction(options, null)).toBeUndefined();
    expect(optionForAction(options, undefined)).toBeUndefined();
    expect(optionForAction(options, '')).toBeUndefined();
    expect(optionForAction(options, 'auto')).toBeUndefined();
    expect(optionForAction(options, '0')).toBeUndefined();
  });
});

describe('quickReplyActionId', () => {
  it('matches the shape voice.ts emits', () => {
    expect(quickReplyActionId(0)).toBe('qr-0');
    expect(quickReplyActionId(1)).toBe('qr-1');
  });
});
