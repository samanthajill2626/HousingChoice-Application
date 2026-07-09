// useBroadcastResults polling tests (S3/S8) - while a broadcast is still
// 'sending' the hook polls the results endpoint on a ~2s interval so the detail
// page ticks live even when no SSE reaches this process (the deployed-worker
// seam). The interval must START only while sending, STOP the moment status goes
// terminal (sent/failed), and clear on unmount. Fake timers throughout.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BroadcastResults as BroadcastResultsType,
  BroadcastStatus,
  EventStreamHandlers,
} from '../../api/index.js';

const getBroadcastResults = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getBroadcastResults: (...a: unknown[]) => getBroadcastResults(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { useBroadcastResults } from './useBroadcastResults.js';

function results(status: BroadcastStatus): BroadcastResultsType {
  return {
    broadcastId: 'bcast_1',
    status,
    unitId: 'unit-0001',
    audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
    stats: {
      audience: 3,
      sent: 1,
      delivered: 1,
      failed: 0,
      skipped_opted_out: 0,
      skipped_no_consent: 0,
      queued: 1,
    },
    recipients: { c1: { status: 'delivered' }, c2: { status: 'queued' } },
    created_at: '2026-06-30T14:00:00.000Z',
  };
}

/** Flush the awaited fetch microtasks + advance any interval timers by `ms`,
 *  wrapped in act so the resulting state updates are applied. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  getBroadcastResults.mockReset();
  sse = {};
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useBroadcastResults - live polling while sending', () => {
  it('polls every ~2s while the broadcast is sending', async () => {
    getBroadcastResults.mockResolvedValue(results('sending'));
    renderHook(() => useBroadcastResults('bcast_1'));

    // Initial load.
    await tick(0);
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);

    // Two interval ticks -> two more fetches (steady ~2s cadence).
    await tick(2000);
    expect(getBroadcastResults).toHaveBeenCalledTimes(2);
    await tick(2000);
    expect(getBroadcastResults).toHaveBeenCalledTimes(3);
  });

  it('stops polling the moment status goes terminal (sent)', async () => {
    getBroadcastResults.mockResolvedValueOnce(results('sending'));
    renderHook(() => useBroadcastResults('bcast_1'));
    await tick(0);
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);

    // The next poll returns the terminal (sent) rollup.
    getBroadcastResults.mockResolvedValue(results('sent'));
    await tick(2000);
    expect(getBroadcastResults).toHaveBeenCalledTimes(2);

    // No further polling once terminal.
    await tick(6000);
    expect(getBroadcastResults).toHaveBeenCalledTimes(2);
  });

  it('does not poll when the broadcast loads already terminal (sent)', async () => {
    getBroadcastResults.mockResolvedValue(results('sent'));
    renderHook(() => useBroadcastResults('bcast_1'));
    await tick(0);
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);

    await tick(6000);
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);
  });

  it('a stale in-flight poll cannot regress a terminal SSE status back to sending', async () => {
    // Regression (review S2): the gen/abort guard protects fetches against each
    // other, but the SSE overlay owns no generation. A poll that was already in
    // flight when finalize's event landed used to resolve LATER with its stale
    // pre-finalize 'sending' snapshot and flap the pill sent -> sending -> sent.
    // The terminal latch discards that snapshot (the lifecycle is forward-only).
    getBroadcastResults.mockResolvedValueOnce(results('sending'));
    let resolveStalePoll: (v: BroadcastResultsType) => void = () => {};
    getBroadcastResults.mockImplementationOnce(
      () => new Promise<BroadcastResultsType>((resolve) => (resolveStalePoll = resolve)),
    );
    getBroadcastResults.mockResolvedValue(results('sent'));

    const { result } = renderHook(() => useBroadcastResults('bcast_1'));
    await tick(0);
    expect(result.current.results?.status).toBe('sending');

    // The 2s poll starts and HANGS (in flight, holding a pre-finalize snapshot).
    await tick(2000);
    expect(getBroadcastResults).toHaveBeenCalledTimes(2);

    // finalize's SSE event lands while that poll is still in flight.
    act(() => {
      sse.onBroadcastUpdated?.({
        broadcastId: 'bcast_1',
        status: 'sent',
        stats: results('sent').stats,
      });
    });
    expect(result.current.results?.status).toBe('sent');

    // The stale poll NOW resolves with its 'sending' snapshot - it must be
    // discarded, never applied (no sent -> sending regression, no re-armed poll).
    await act(async () => {
      resolveStalePoll(results('sending'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.results?.status).toBe('sent');

    // The SSE debounced refetch (+400ms) re-reads the terminal rows; after that
    // the page is quiet - the poll never re-armed off the stale snapshot.
    await tick(400);
    expect(getBroadcastResults).toHaveBeenCalledTimes(3);
    expect(result.current.results?.status).toBe('sent');
    await tick(6000);
    expect(getBroadcastResults).toHaveBeenCalledTimes(3);
  });

  it('clears the polling interval on unmount', async () => {
    getBroadcastResults.mockResolvedValue(results('sending'));
    const { unmount } = renderHook(() => useBroadcastResults('bcast_1'));
    await tick(0);
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);
    await tick(2000);
    expect(getBroadcastResults).toHaveBeenCalledTimes(2);

    unmount();
    await tick(6000);
    // Frozen at the last count - no post-unmount polls.
    expect(getBroadcastResults).toHaveBeenCalledTimes(2);
  });
});
