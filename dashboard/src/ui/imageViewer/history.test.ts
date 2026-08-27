import { describe, expect, it } from 'vitest';
import {
  addImageViewerMarker,
  readImageViewerMarker,
  removeImageViewerMarker,
  type ImageViewerMarker,
} from './history.js';

const marker: ImageViewerMarker = {
  token: 'viewer-1',
  returnLocationKey: 'route-key-1',
};

describe('image viewer history state', () => {
  it('preserves ordinary router state while adding and removing its marker', () => {
    const state = { from: 'inbox', filters: { unread: true } };

    const marked = addImageViewerMarker(state, marker);

    expect(marked).toMatchObject(state);
    expect(readImageViewerMarker(marked)).toStrictEqual(marker);
    expect(removeImageViewerMarker(marked)).toStrictEqual(state);
    expect(state).toStrictEqual({ from: 'inbox', filters: { unread: true } });
  });

  it('round-trips both reserved namespace collisions without treating them as owned', () => {
    const collidingState = {
      from: 'inbox',
      __hcImageViewer: { legacy: true },
      __hcImageViewerPriorState: {
        ownerToken: 'viewer-1',
        value: 'keep this field',
      },
    };

    const marked = addImageViewerMarker(collidingState, marker);

    expect(readImageViewerMarker(marked)).toStrictEqual(marker);
    expect(removeImageViewerMarker(marked)).toStrictEqual(collidingState);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'legacy-state'],
    ['number', 42],
    ['boolean', false],
    ['array', ['inbox', 3]],
    ['Date', new Date('2026-08-27T12:00:00.000Z')],
    ['Map', new Map([['from', 'inbox']])],
    ['Set', new Set(['inbox', 'unread'])],
  ])('round-trips non-record %s state by identity', (_label, state) => {
    const marked = addImageViewerMarker(state, marker);

    expect(readImageViewerMarker(marked)).toStrictEqual(marker);
    expect(removeImageViewerMarker(marked)).toBe(state);
  });

  it('round-trips class instances without spreading away their prototype', () => {
    class RouterState {
      constructor(readonly from: string) {}
    }
    const state = new RouterState('inbox');

    const restored = removeImageViewerMarker(addImageViewerMarker(state, marker));

    expect(restored).toBe(state);
    expect(restored).toBeInstanceOf(RouterState);
  });

  it.each([
    ['non-object marker', { __hcImageViewer: 'viewer-1' }],
    ['missing metadata', { __hcImageViewer: marker }],
    [
      'wrong version',
      {
        __hcImageViewer: {
          ...marker,
          version: 2,
          priorStateKind: 'record',
          priorMarker: { present: false },
        },
      },
    ],
    [
      'empty token',
      {
        __hcImageViewer: {
          ...marker,
          token: '',
          version: 1,
          priorStateKind: 'record',
          priorMarker: { present: false },
        },
      },
    ],
    [
      'empty return key',
      {
        __hcImageViewer: {
          ...marker,
          returnLocationKey: '',
          version: 1,
          priorStateKind: 'record',
          priorMarker: { present: false },
        },
      },
    ],
    [
      'wrong state kind',
      {
        __hcImageViewer: {
          ...marker,
          version: 1,
          priorStateKind: 'array',
          priorMarker: { present: false },
        },
      },
    ],
    [
      'malformed prior marker',
      {
        __hcImageViewer: {
          ...marker,
          version: 1,
          priorStateKind: 'record',
          priorMarker: { present: 'no' },
        },
      },
    ],
    ['numeric public fields', { __hcImageViewer: { token: 1, returnLocationKey: 2 } }],
  ])('does not expose or remove a malformed marker: %s', (_label, state) => {
    expect(readImageViewerMarker(state)).toBeUndefined();
    expect(removeImageViewerMarker(state)).toBe(state);
  });
});
