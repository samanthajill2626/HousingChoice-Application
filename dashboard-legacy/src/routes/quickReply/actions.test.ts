// Unit tests for the action-id scheme — the contract M1.9's push payload must
// honour (action ids 'auto' | 'qr-<index>' map to settings templates).
import { describe, expect, it } from 'vitest';
import type { OrgSettings } from '../../api/index.js';
import {
  AUTO_TEXT_ACTION_ID,
  buildOptions,
  optionForAction,
  quickReplyActionId,
} from './actions.js';
import { parseActionHash } from './useNotificationAction.js';

const settings = (over: Partial<OrgSettings> = {}): OrgSettings => ({
  missedCallAutoText: 'auto text',
  missedCallAutoTextEnabled: true,
  quickReplies: ['first', 'second'],
  preRingPauseSeconds: 2,
  ...over,
});

describe('buildOptions', () => {
  it('leads with the auto-text, then the quick replies in order', () => {
    const options = buildOptions(settings());
    expect(options.map((o) => o.id)).toEqual([AUTO_TEXT_ACTION_ID, 'qr-0', 'qr-1']);
    expect(options[0]).toMatchObject({ isAuto: true, body: 'auto text' });
    expect(options[1]).toMatchObject({ isAuto: false, body: 'first' });
  });

  it('drops a blank auto-text and blank quick replies', () => {
    const options = buildOptions(settings({ missedCallAutoText: '   ', quickReplies: ['ok', ''] }));
    // No auto option, and the blank quick reply at index 1 is skipped, but the
    // surviving reply keeps its original positional id.
    expect(options.map((o) => o.id)).toEqual(['qr-0']);
    expect(options[0]).toMatchObject({ body: 'ok', isAuto: false });
  });
});

describe('optionForAction', () => {
  it('matches by id and returns undefined for misses / empties', () => {
    const options = buildOptions(settings());
    expect(optionForAction(options, 'qr-1')?.body).toBe('second');
    expect(optionForAction(options, AUTO_TEXT_ACTION_ID)?.isAuto).toBe(true);
    expect(optionForAction(options, 'qr-9')).toBeUndefined();
    expect(optionForAction(options, null)).toBeUndefined();
    expect(optionForAction(options, '')).toBeUndefined();
  });
});

describe('quickReplyActionId', () => {
  it('forms qr-<index>', () => {
    expect(quickReplyActionId(0)).toBe('qr-0');
    expect(quickReplyActionId(3)).toBe('qr-3');
  });
});

describe('parseActionHash', () => {
  it('reads #action=<id>', () => {
    expect(parseActionHash('#action=qr-1')).toBe('qr-1');
  });
  it('decodes percent-encoding', () => {
    expect(parseActionHash('#action=qr%2D0')).toBe('qr-0');
  });
  it('returns null when absent', () => {
    expect(parseActionHash('')).toBeNull();
    expect(parseActionHash('#')).toBeNull();
    expect(parseActionHash('#other=1')).toBeNull();
  });
});
