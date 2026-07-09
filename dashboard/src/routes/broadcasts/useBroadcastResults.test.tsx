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
