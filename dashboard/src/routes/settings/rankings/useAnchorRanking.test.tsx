// The Rank panel's data hook (WP1 B2a spec D9, D12, D18). Full fake timers
// drive the 5 s poll; setup.ts pins only Date, so release it first.
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type EventStreamHandlers,
  type RankingAnchorRef,
  type RankingJobView,
  type RankingReadResponse,
} from '../../../api/index.js';

const getRanking = vi.fn();
const getRankingJob = vi.fn();
const startRanking = vi.fn();
let handlers: EventStreamHandlers = {};

vi.mock('../../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../api/index.js')>('../../../api/index.js');
  return {
    ...actual,
    getRanking: (...args: unknown[]) => getRanking(...args),
    getRankingJob: (...args: unknown[]) => getRankingJob(...args),
    startRanking: (...args: unknown[]) => startRanking(...args),
    useEventStream: (next: EventStreamHandlers) => {
      handlers = next;
    },
  };
});

import { JOB_POLL_MS, useAnchorRanking, type AnchorRankingState } from './useAnchorRanking.js';

const ANCHOR: RankingAnchorRef = { kind: 'unit', id: 'unit-1' };

let latest: AnchorRankingState | undefined;
function Probe({ anchor, includeOlder = false }: { anchor?: RankingAnchorRef; includeOlder?: boolean }): null {
  latest = useAnchorRanking(anchor, includeOlder);
  return null;
}
function current(): AnchorRankingState {
  if (latest === undefined) throw new Error('the probe has not rendered');
  return latest;
}

function job(over: Partial<RankingJobView> = {}): RankingJobView {
  return {
    status: 'queued',
    generation: 'gen-1',
    includeOlder: false,
    requestedAt: '2026-07-01T12:00:00.000Z',
    batchCount: 0,
    batchesDone: [],
    failedBatches: [],
    notScored: [],
    ...over,
  };
}

function readOf(jobView: RankingJobView | null, poolWindowDays = 90): RankingReadResponse {
  return {
    anchor: {
      kind: 'unit',
      id: 'unit-1',
      display: '12 Oak St, Atlanta',
      anchorNotes: [],
      missing: [],
      cardChanged: false,
    },
    job: jobView,
    poolWindowDays,
    rows: [],
    flags: [],
  };
}

// Advance the fake clock, then drain the promise chains the mocked endpoints
// start (job read -> ranking read is several microtask hops deep).
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.useFakeTimers();
  getRanking.mockReset();
  getRankingJob.mockReset();
  startRanking.mockReset();
  handlers = {};
  latest = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAnchorRanking', () => {
  it('polls the job read every 5 seconds (spec D12)', () => {
    expect(JOB_POLL_MS).toBe(5_000);
  });

  it('is idle and reads nothing without an anchor', async () => {
    render(<Probe />);
    await flush();
    expect(current().readStatus).toBe('idle');
    expect(current().job).toBeNull();
    expect(getRanking).not.toHaveBeenCalled();
  });

  it('reads the ranking for the anchor with its window choice', async () => {
    getRanking.mockResolvedValue(readOf(null));
    render(<Probe anchor={ANCHOR} includeOlder />);
    expect(current().readStatus).toBe('loading');
    await flush();
    expect(getRanking).toHaveBeenCalledWith('unit', 'unit-1', { includeOlder: true }, expect.any(AbortSignal));
    expect(current().readStatus).toBe('ready');
    expect(current().read?.anchor.display).toBe('12 Oak St, Atlanta');
  });

  it('a different anchor drops the old state and reads again', async () => {
    getRanking.mockResolvedValue(readOf(null));
    const { rerender } = render(<Probe anchor={ANCHOR} />);
    await flush();
    rerender(<Probe anchor={{ kind: 'tenant', id: 'contact-1' }} />);
    expect(current().readStatus).toBe('loading');
    expect(current().read).toBeUndefined();
    await flush();
    expect(getRanking).toHaveBeenLastCalledWith('tenant', 'contact-1', { includeOlder: false }, expect.any(AbortSignal));
  });

  it('Rank posts the press, then polls the job read every 5 seconds while it is queued', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockResolvedValue({ job: job(), joined: false });
    getRankingJob.mockResolvedValue({ job: job() });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    expect(current().ranking).toBe(true);
    await flush();
    expect(startRanking).toHaveBeenCalledWith('unit', 'unit-1', { includeOlder: false });
    expect(current().ranking).toBe(false);
    expect(current().job?.status).toBe('queued');
    expect(getRankingJob).not.toHaveBeenCalled();
    await flush(JOB_POLL_MS - 1);
    expect(getRankingJob).not.toHaveBeenCalled();
    await flush(1);
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    expect(getRankingJob).toHaveBeenCalledWith('unit', 'unit-1', expect.any(AbortSignal));
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(2);
    // The full read is never polled on its own (spec D9).
    expect(getRanking).toHaveBeenCalledTimes(1);
  });

  it('stops polling and reads the ranking once more when the job ends', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockResolvedValue({ job: job(), joined: false });
    getRankingJob.mockResolvedValue({
      job: job({ status: 'done', startedAt: '2026-07-01T12:00:01.000Z', batchCount: 1, batchesDone: [0] }),
    });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    await flush(JOB_POLL_MS);
    expect(current().job?.status).toBe('done');
    expect(getRanking).toHaveBeenCalledTimes(2);
    await flush(JOB_POLL_MS * 3);
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    expect(getRanking).toHaveBeenCalledTimes(2);
  });

  it('a page opened mid-job polls without a press, and reads again when batchesDone grows', async () => {
    const before = job({ status: 'running', batchCount: 3, batchesDone: [] });
    const after = job({ status: 'running', batchCount: 3, batchesDone: [1] });
    getRanking.mockResolvedValue(readOf(before));
    getRankingJob.mockResolvedValue({ job: after });
    getRankingJob.mockResolvedValueOnce({ job: before });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    expect(current().job?.status).toBe('running');
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    expect(getRanking).toHaveBeenCalledTimes(1);
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(2);
    expect(getRanking).toHaveBeenCalledTimes(2);
    expect(current().job?.batchesDone).toEqual([1]);
  });

  it('reads the ranking again when a batch FAILS mid-job (finished, not only scored; plan review BB5)', async () => {
    const before = job({ status: 'running', batchCount: 3, batchesDone: [0] });
    const after = job({
      status: 'running',
      batchCount: 3,
      batchesDone: [0],
      failedBatches: [{ index: 1, candidateIds: ['c2'], failure: 'timeout' }],
    });
    getRanking.mockResolvedValue(readOf(before));
    getRankingJob.mockResolvedValue({ job: after });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    expect(getRanking).toHaveBeenCalledTimes(2);
  });

  it('a ranking.updated event for this anchor reads the job at once; another anchor is ignored', async () => {
    getRanking.mockResolvedValue(readOf(null));
    getRankingJob.mockResolvedValue({ job: job({ status: 'running', batchCount: 2, batchesDone: [0] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      handlers.onRankingUpdated?.({
        anchorKind: 'unit', anchorId: 'unit-other', generation: 'g', status: 'running', batchesDone: 1, batchCount: 2,
      });
    });
    await flush();
    expect(getRankingJob).not.toHaveBeenCalled();
    act(() => {
      handlers.onRankingUpdated?.({
        anchorKind: 'unit', anchorId: 'unit-1', generation: 'gen-1', status: 'running', batchesDone: 1, batchCount: 2,
      });
    });
    await flush();
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    expect(current().job?.status).toBe('running');
    // batchesDone grew from nothing to one batch: the ranking is read again.
    expect(getRanking).toHaveBeenCalledTimes(2);
  });

  it('a press refused 409 ranking_running says so and follows the running job', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockRejectedValue(new ApiError(409, 'ranking_running', 'ranking_running', { error: 'ranking_running' }));
    getRankingJob.mockResolvedValue({ job: job({ status: 'running', includeOlder: true }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().rankError).toBe('A ranking is running for this record. Try again when it finishes.');
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    expect(current().job?.status).toBe('running');
  });

  it('a rate-limited press says to wait, and a 404 says the record is gone', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }));
    startRanking.mockRejectedValueOnce(new ApiError(404, 'not_found', 'not_found', { error: 'not_found' }));
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().rankError).toBe('Too many rankings. Wait a minute and try again.');
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().rankError).toBe('This record was not found.');
  });

  it('reports a press that joined a live job', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockResolvedValue({ job: job({ status: 'running' }), joined: true });
    getRankingJob.mockResolvedValue({ job: job({ status: 'running' }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().joined).toBe(true);
    expect(current().rankError).toBeNull();
  });

  it('a read failure shows its message, and Retry reads again', async () => {
    // S6's 503 code (plan IR32); with no message the page's own copy shows.
    getRanking.mockRejectedValueOnce(new ApiError(503, 'ranking_unavailable', 'ranking_unavailable', { error: 'ranking_unavailable' }));
    getRanking.mockResolvedValue(readOf(null));
    render(<Probe anchor={ANCHOR} />);
    await flush();
    expect(current().readStatus).toBe('error');
    expect(current().readError).toBe('This record could not be read. Try again.');
    act(() => {
      current().retryRead();
    });
    expect(current().readStatus).toBe('loading');
    await flush();
    expect(current().readStatus).toBe('ready');
  });

  it('a 503 that carries the server message shows that message', async () => {
    getRanking.mockRejectedValue(
      new ApiError(503, 'ranking_unavailable', 'ranking_unavailable', {
        error: 'ranking_unavailable',
        message: 'The organization list could not be read. Try again.',
      }),
    );
    render(<Probe anchor={ANCHOR} />);
    await flush();
    expect(current().readError).toBe('The organization list could not be read. Try again.');
  });

  it('returns the read window, and keeps the last one while a new read loads (plan PR26)', async () => {
    getRanking.mockResolvedValue(readOf(null, 60));
    const { rerender } = render(<Probe anchor={ANCHOR} />);
    expect(current().poolWindowDays).toBeNull();
    await flush();
    expect(current().poolWindowDays).toBe(60);
    rerender(<Probe anchor={ANCHOR} includeOlder />);
    expect(current().readStatus).toBe('loading');
    expect(current().poolWindowDays).toBe(60);
  });
});
