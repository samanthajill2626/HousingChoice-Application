// useUnitFlags (WP1 B2a spec D10 rev 7, charter item 16): the property page's
// read of its OPEN fair-housing flags - on mount, again whenever the page
// asks for a re-check (after a save), never leaking an answer for another
// property, and a failure as its own state (the page shows a note).
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';

const getUnitFairHousingFlags = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, getUnitFairHousingFlags: (...a: unknown[]) => getUnitFairHousingFlags(...a) };
});

import { useUnitFlags } from './useUnitFlags.js';

const FLAG = { field: 'qualifications', label: 'Qualifications', reason: 'flagged as a requirement fair housing does not allow' };

beforeEach(() => {
  getUnitFairHousingFlags.mockReset();
});

describe('useUnitFlags', () => {
  it('reads the property flags on mount: loading, then ready', async () => {
    getUnitFairHousingFlags.mockResolvedValue({ flags: [FLAG] });
    const { result } = renderHook(() => useUnitFlags('u1', 0));
    expect(result.current).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', flags: [FLAG] }));
    expect(getUnitFairHousingFlags).toHaveBeenCalledTimes(1);
    expect(getUnitFairHousingFlags).toHaveBeenCalledWith('u1', expect.any(AbortSignal));
  });

  it('re-checks when the page asks (a save): the answer replaces the old one', async () => {
    getUnitFairHousingFlags.mockResolvedValueOnce({ flags: [FLAG] }).mockResolvedValueOnce({ flags: [] });
    const { result, rerender } = renderHook(({ check }) => useUnitFlags('u1', check), { initialProps: { check: 0 } });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', flags: [FLAG] }));
    rerender({ check: 1 });
    // The old answer stays up while the re-check runs (no flicker).
    expect(result.current).toEqual({ status: 'ready', flags: [FLAG] });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', flags: [] }));
    expect(getUnitFairHousingFlags).toHaveBeenCalledTimes(2);
  });

  it('a failed read is the error state', async () => {
    getUnitFairHousingFlags.mockRejectedValue(new ApiError(503, 'flags_unavailable', 'flags_unavailable'));
    const { result } = renderHook(() => useUnitFlags('u1', 0));
    await waitFor(() => expect(result.current).toEqual({ status: 'error' }));
  });

  it('a 404 (a missing or deleted property) is no notice, not a failure', async () => {
    getUnitFairHousingFlags.mockRejectedValue(new ApiError(404, 'anchor_not_found', 'anchor_not_found'));
    const { result } = renderHook(() => useUnitFlags('u1', 0));
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', flags: [] }));
  });

  it('reads nothing while disabled (a deleted property), and reads once enabled (restored)', async () => {
    getUnitFairHousingFlags.mockResolvedValue({ flags: [FLAG] });
    const { result, rerender } = renderHook(({ enabled }) => useUnitFlags('u1', 0, enabled), {
      initialProps: { enabled: false },
    });
    expect(result.current).toEqual({ status: 'loading' });
    expect(getUnitFairHousingFlags).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', flags: [FLAG] }));
    expect(getUnitFairHousingFlags).toHaveBeenCalledTimes(1);
  });

  it('another property reads loading until its own answer lands; the old answer never shows for it', async () => {
    let releaseU2: (value: unknown) => void = () => undefined;
    getUnitFairHousingFlags.mockImplementation((unitId: string) =>
      unitId === 'u1' ? Promise.resolve({ flags: [FLAG] }) : new Promise((resolve) => (releaseU2 = resolve)),
    );
    const { result, rerender } = renderHook(({ unitId }) => useUnitFlags(unitId, 0), { initialProps: { unitId: 'u1' } });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', flags: [FLAG] }));
    rerender({ unitId: 'u2' });
    expect(result.current).toEqual({ status: 'loading' });
    releaseU2({ flags: [] });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', flags: [] }));
  });
});
