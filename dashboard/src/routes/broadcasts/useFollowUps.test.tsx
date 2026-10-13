// useFollowUps tests (last-heard-from 5.6): the in-place rule at the hook - a
// session resolution is local; a completed load replaces it.
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpItem } from '../../api/index.js';

const getFollowUps = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, getFollowUps: (...a: unknown[]) => getFollowUps(...a) };
});

import { followUpKey, useFollowUps } from './useFollowUps.js';

const ITEM: FollowUpItem = {
  unitId: 'u1',
  unitLabel: '12 Oak St',
  contactId: 'c1',
  name: 'Dario Vance',
  type: 'tenant',
  sentAt: '2026-10-02T12:00:00.000Z',
  outcome: 'no_reply',
  interestedSupported: true,
  interestedMode: 'route',
  waitingSince: '2026-10-02T12:00:00.000Z',
};

// Adjudication F9: a BLOCK body - an arrow that returns the mock hands vitest
// a teardown.
beforeEach(() => {
  getFollowUps.mockReset().mockResolvedValue({ items: [ITEM], byUnit: { u1: 1 }, truncated: false });
});

describe('useFollowUps - the in-place rule (plan review R1 #4)', () => {
  it('resolve keeps the row in items, drops waitingCount, and does NOT refetch; unresolve restores it', async () => {
    const { result } = renderHook(() => useFollowUps());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.resolve(ITEM, { kind: 'not_interested' }));
    expect(result.current.items).toEqual([ITEM]);
    expect(result.current.resolutions.get(followUpKey(ITEM))).toEqual({ kind: 'not_interested' });
    expect(result.current.waitingCount).toBe(0);
    expect(getFollowUps).toHaveBeenCalledTimes(1);
    act(() => result.current.unresolve(ITEM));
    expect(result.current.waitingCount).toBe(1);
  });

  it('a completed load replaces the session resolutions with the server truth', async () => {
    const { result } = renderHook(() => useFollowUps());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.resolve(ITEM, { kind: 'not_interested' }));
    getFollowUps.mockResolvedValueOnce({ items: [], byUnit: {}, truncated: false });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getFollowUps).toHaveBeenCalledTimes(2);
    expect(result.current.items).toEqual([]);
    expect(result.current.resolutions.size).toBe(0);
    expect(result.current.waitingCount).toBe(0);
  });

  it('a failed load reads error with no items; the fetch carries an abort signal', async () => {
    getFollowUps.mockReset().mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useFollowUps());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.items).toEqual([]);
    expect(result.current.waitingCount).toBe(0);
    expect(getFollowUps.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
});
