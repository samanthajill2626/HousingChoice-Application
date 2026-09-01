import { describe, expect, it } from 'vitest';

import { STREAM_ANCHOR_SLACK_PX, deriveStreamAnchor } from './streamAnchor';

// The anchor is defined against ONE pair of numbers: where the sentinel's bottom
// edge sits, and where the scroller's viewport bottom sits, both in the same
// (viewport) coordinate space. Positive delta = the sentinel is still BELOW the
// fold (the operator has scrolled up); negative delta = the sentinel has gone
// ABOVE the fold, which can only happen when something is rendered under it.
const at = (delta: number, hasBlock: boolean): ReturnType<typeof deriveStreamAnchor> =>
  deriveStreamAnchor({ sentinelBottom: 100 + delta, viewportBottom: 100, hasBlock });

describe('deriveStreamAnchor', () => {
  it('exposes the slack the old isAtBottom closure used', () => {
    expect(STREAM_ANCHOR_SLACK_PX).toBe(48);
  });

  describe('with an Upcoming block below the sentinel', () => {
    it('reads exactly at the viewport bottom as sentinel', () => {
      expect(at(0, true)).toBe('sentinel');
    });

    it('reads the far edge of the slack band as sentinel', () => {
      expect(at(48, true)).toBe('sentinel');
    });

    it('reads one pixel past the slack band as null', () => {
      expect(at(49, true)).toBe(null);
    });

    it('reads a sentinel far below the fold as null', () => {
      expect(at(360, true)).toBe(null);
    });

    it('reads ANY amount above the viewport bottom as below - direction, not slack', () => {
      expect(at(-1, true)).toBe('below');
      expect(at(-20, true)).toBe('below');
      expect(at(-200, true)).toBe('below');
    });

    it('stays reachable for a block SHORTER than the slack band', () => {
      // A 20px block scrolled fully into view puts the sentinel 20px above the
      // fold. A slack-based rule would call that "at bottom" and re-pin, yanking
      // the operator off the block they are reading; direction calls it below.
      expect(at(-20, true)).toBe('below');
    });
  });

  describe('with no Upcoming block (the GroupTextView / plain-thread case)', () => {
    it('never returns below', () => {
      for (const delta of [-200, -49, -48, -1, 0, 1, 48, 49, 400]) {
        expect(at(delta, false)).not.toBe('below');
      }
    });

    it('reproduces isAtBottom exactly: <= 48px of remaining scroll is at-bottom', () => {
      // isAtBottom was `scrollHeight - scrollTop - clientHeight <= 48`, which is
      // TRUE for negative values too (a fractional over-scroll). With no block
      // there is nothing under the sentinel, so those all mean "at bottom".
      expect(at(-200, false)).toBe('sentinel');
      expect(at(-1, false)).toBe('sentinel');
      expect(at(0, false)).toBe('sentinel');
      expect(at(48, false)).toBe('sentinel');
      expect(at(49, false)).toBe(null);
      expect(at(360, false)).toBe(null);
    });
  });

  it('is total over fractional deltas (Chromium holds a fractional scrollTop)', () => {
    expect(at(47.5, true)).toBe('sentinel');
    expect(at(48.5, true)).toBe(null);
    expect(at(-0.5, true)).toBe('below');
    expect(at(-0.5, false)).toBe('sentinel');
  });
});
