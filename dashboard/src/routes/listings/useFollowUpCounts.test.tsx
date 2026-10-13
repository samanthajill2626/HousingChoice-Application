// useFollowUpCounts tests (last-heard-from 5.6): the Properties list's
// "<n> waiting" counts - the follow-ups byUnit map, silent on failure, and no
// request at all on the Deleted view.
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFollowUps = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, getFollowUps: (...a: unknown[]) => getFollowUps(...a) };
});

import { useFollowUpCounts } from './useFollowUpCounts.js';

// Adjudication F9: a BLOCK body - an arrow that returns the mock hands vitest
// a teardown.
beforeEach(() => {
  getFollowUps.mockReset();
});

describe('useFollowUpCounts (last-heard-from 5.6)', () => {
  it('yields the response byUnit map', async () => {
    getFollowUps.mockResolvedValue({ items: [], byUnit: { u1: 2 }, truncated: false });
    const { result } = renderHook(() => useFollowUpCounts(true));
    expect(result.current).toEqual({});
    await waitFor(() => expect(result.current).toEqual({ u1: 2 }));
    expect(getFollowUps).toHaveBeenCalledTimes(1);
    expect(getFollowUps.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
  it('a failed fetch stays silent: an empty map, no throw', async () => {
    getFollowUps.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useFollowUpCounts(true));
    await waitFor(() => expect(getFollowUps).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual({});
  });
  it('disabled (the Deleted view) makes no request', () => {
    const { result } = renderHook(() => useFollowUpCounts(false));
    expect(getFollowUps).not.toHaveBeenCalled();
    expect(result.current).toEqual({});
  });
});
