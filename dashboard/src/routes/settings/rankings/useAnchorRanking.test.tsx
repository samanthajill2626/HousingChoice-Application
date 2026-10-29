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

import { JOB_POLL_MS, JOB_READ_STALL_MS, useAnchorRanking, type AnchorRankingState } from './useAnchorRanking.js';

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

/** A response the test answers when it chooses (reads that land out of order). */
function held<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A read whose one row names which read it is. */
function readWithRow(display: string, jobView: RankingJobView | null = null): RankingReadResponse {
  return { ...readOf(jobView), rows: [{ candidateId: 'contact-1', display, notScored: false, match: null }] };
}

function rankingEvent(over: Partial<{ status: 'queued' | 'running' | 'done' | 'failed'; batchesDone: number; batchCount: number }> = {}) {
  return { anchorKind: 'unit' as const, anchorId: 'unit-1', generation: 'gen-1', status: 'running' as const, batchesDone: 1, batchCount: 2, ...over };
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

// Code review R1 (FW1-4, FW1-5, FW1-6): reads answer in any order, so the hook
// applies a full read only if it is the latest one issued, a job view only if
// it was issued after the one on screen, never runs two job reads at once,
// and clears a press error and the joined mark when the followed job ends.
describe('useAnchorRanking - ordering', () => {
  it('an EARLIER full read that answers after a later one is dropped: the final rows stay under Done (A2-1)', async () => {
    const afterBatch0 = held<RankingReadResponse>();
    const finalRead = held<RankingReadResponse>();
    getRanking
      .mockResolvedValueOnce(readOf(job({ status: 'running', batchCount: 2, batchesDone: [] })))
      .mockReturnValueOnce(afterBatch0.promise)
      .mockReturnValueOnce(finalRead.promise);
    getRankingJob
      .mockResolvedValueOnce({ job: job({ status: 'running', batchCount: 2, batchesDone: [0] }) })
      .mockResolvedValueOnce({ job: job({ status: 'done', batchCount: 2, batchesDone: [0, 1] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    // Parallel batches: the last batch's event and the done event arrive back to back.
    act(() => {
      handlers.onRankingUpdated?.(rankingEvent({ batchesDone: 1 }));
      handlers.onRankingUpdated?.(rankingEvent({ status: 'done', batchesDone: 2 }));
    });
    await flush();
    await flush();
    expect(getRanking).toHaveBeenCalledTimes(3);
    await act(async () => {
      finalRead.resolve(readWithRow('final'));
    });
    await flush();
    expect(current().read?.rows[0]?.display).toBe('final');
    await act(async () => {
      afterBatch0.resolve(readWithRow('stale after batch 0'));
    });
    await flush();
    expect(current().job?.status).toBe('done');
    expect(current().read?.rows[0]?.display).toBe('final');
  });

  it('a job read issued before a press that answers after it is dropped: the new job stays queued and polled', async () => {
    const stale = held<{ job: RankingJobView | null }>();
    const finished = job({ status: 'done', batchCount: 1, batchesDone: [0] });
    getRanking.mockResolvedValue(readOf(finished));
    getRankingJob.mockReturnValueOnce(stale.promise).mockResolvedValue({ job: job({ generation: 'gen-2' }) });
    startRanking.mockResolvedValue({ job: job({ generation: 'gen-2' }), joined: false });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    // A late event for the finished job reads the job (held); the admin presses Rank.
    act(() => {
      handlers.onRankingUpdated?.(rankingEvent({ status: 'done', batchesDone: 1, batchCount: 1 }));
    });
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().job).toMatchObject({ status: 'queued', generation: 'gen-2' });
    await act(async () => {
      stale.resolve({ job: finished });
    });
    await flush();
    expect(current().job).toMatchObject({ status: 'queued', generation: 'gen-2' });
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(2);
  });

  it('job reads never overlap: a burst of events reads the job once, then once more after it answers', async () => {
    const first = held<{ job: RankingJobView | null }>();
    const running = job({ status: 'running', batchCount: 3, batchesDone: [] });
    getRanking.mockResolvedValue(readOf(running));
    getRankingJob.mockReturnValueOnce(first.promise).mockResolvedValue({ job: running });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      handlers.onRankingUpdated?.(rankingEvent());
      handlers.onRankingUpdated?.(rankingEvent());
      handlers.onRankingUpdated?.(rankingEvent());
    });
    await flush();
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve({ job: running });
    });
    await flush();
    await flush();
    // One more read covers every event that arrived while the first was out.
    expect(getRankingJob).toHaveBeenCalledTimes(2);
  });

  it('a Rank press answered before the first read keeps its job: the read does not replace it, and the poll runs (A2-2)', async () => {
    const first = held<RankingReadResponse>();
    getRanking.mockReturnValueOnce(first.promise);
    startRanking.mockResolvedValue({ job: job(), joined: false });
    getRankingJob.mockResolvedValue({ job: job() });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().job?.status).toBe('queued');
    // The read was served before the press wrote the job.
    await act(async () => {
      first.resolve(readOf(null));
    });
    await flush();
    expect(current().readStatus).toBe('ready');
    expect(current().job?.status).toBe('queued');
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(1);
  });

  it('clears the joined mark when the followed job ends (A2-8)', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockResolvedValue({ job: job({ status: 'running', batchCount: 1 }), joined: true });
    getRankingJob.mockResolvedValue({ job: job({ status: 'done', batchCount: 1, batchesDone: [0] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().joined).toBe(true);
    await flush(JOB_POLL_MS);
    expect(current().job?.status).toBe('done');
    expect(current().joined).toBe(false);
  });

  it('clears a refused press error when the job it followed ends (A2-8)', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockRejectedValue(new ApiError(409, 'ranking_running', 'ranking_running', { error: 'ranking_running' }));
    getRankingJob
      .mockResolvedValueOnce({ job: job({ status: 'running', includeOlder: true, batchCount: 1 }) })
      .mockResolvedValue({ job: job({ status: 'done', includeOlder: true, batchCount: 1, batchesDone: [0] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().rankError).toBe('A ranking is running for this record. Try again when it finishes.');
    await flush(JOB_POLL_MS);
    expect(current().job?.status).toBe('done');
    expect(current().rankError).toBeNull();
  });

  it('a refused press whose job finished before the follow-up read clears the error and reads the ranking again (A2-8)', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockRejectedValue(new ApiError(409, 'ranking_running', 'ranking_running', { error: 'ranking_running' }));
    getRankingJob.mockResolvedValue({ job: job({ status: 'done', includeOlder: true, batchCount: 1, batchesDone: [0] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    await flush();
    expect(current().job?.status).toBe('done');
    expect(current().rankError).toBeNull();
    expect(getRanking).toHaveBeenCalledTimes(2);
  });
});

// Code review R2 (FW2-1, FW2-2, FW2-3, FW2-5): a job view of a generation the
// page has not shown counts its progress from zero; one generation's views
// never step back; a job read that never answers stops blocking after
// JOB_READ_STALL_MS; and a full read newer than the rows on screen is shown
// even while a later one is still out.
describe('useAnchorRanking - ordering, round 2', () => {
  const genEvent = (generation: string, over: Parameters<typeof rankingEvent>[0] = {}) => ({ ...rankingEvent(over), generation });

  it('a NEW generation first seen finished, with no more finished batches than the last one, reads the ranking again (FW2-1)', async () => {
    getRanking.mockResolvedValue(readOf(job({ status: 'done', batchCount: 1, batchesDone: [0] })));
    getRankingJob.mockResolvedValue({ job: job({ status: 'done', generation: 'gen-2', batchCount: 1, batchesDone: [0] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    expect(getRanking).toHaveBeenCalledTimes(1);
    // Another admin ranked it again; the page's first look at gen-2 finds it done.
    act(() => {
      handlers.onRankingUpdated?.(genEvent('gen-2', { status: 'done', batchesDone: 1, batchCount: 1 }));
    });
    await flush();
    await flush(JOB_POLL_MS * 3);
    expect(current().job).toMatchObject({ status: 'done', generation: 'gen-2' });
    expect(getRanking).toHaveBeenCalledTimes(2);
  });

  it('a press that joins a generation the page never showed, with batches already finished, reads the ranking again (FW2-1)', async () => {
    // gen-2's 2 finished batches are fewer than gen-1's 4: they count from zero.
    const joinedJob = job({ status: 'running', generation: 'gen-2', batchCount: 4, batchesDone: [0, 1] });
    getRanking.mockResolvedValue(readOf(job({ status: 'done', batchCount: 4, batchesDone: [0, 1, 2, 3] })));
    startRanking.mockResolvedValue({ job: joinedJob, joined: true });
    getRankingJob.mockResolvedValue({ job: joinedJob });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().joined).toBe(true);
    expect(current().job).toMatchObject({ status: 'running', generation: 'gen-2' });
    expect(getRanking).toHaveBeenCalledTimes(2);
  });

  it('within one generation a job view behind the one on screen is dropped, even when issued later: the status never steps back (FW2-5)', async () => {
    const firstRead = held<RankingReadResponse>();
    const early = held<{ job: RankingJobView | null }>();
    getRanking.mockReturnValueOnce(firstRead.promise).mockResolvedValue(readOf(null));
    getRankingJob
      .mockReturnValueOnce(early.promise)
      .mockResolvedValue({ job: job({ status: 'running', batchCount: 3, batchesDone: [0, 1] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    // An event reads the job - issued after the first read, served at once: 1 of 3.
    act(() => {
      handlers.onRankingUpdated?.(rankingEvent({ batchesDone: 1, batchCount: 3 }));
    });
    await flush();
    // The first read took its job snapshot later, after building the pool (2 of 3), and lands first.
    await act(async () => {
      firstRead.resolve(readOf(job({ status: 'running', batchCount: 3, batchesDone: [0, 1] })));
    });
    await flush();
    expect(current().job?.batchesDone).toEqual([0, 1]);
    await act(async () => {
      early.resolve({ job: job({ status: 'running', batchCount: 3, batchesDone: [0] }) });
    });
    await flush();
    expect(current().job?.batchesDone).toEqual([0, 1]);
    // The next poll's 2 of 3 has not grown: no extra full read.
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(2);
    expect(getRanking).toHaveBeenCalledTimes(1);
  });

  it('a job read that never answers stops blocking after JOB_READ_STALL_MS: the next poll reads the job again (FW2-2)', async () => {
    getRanking.mockResolvedValue(readOf(job({ status: 'running', batchCount: 1 })));
    getRankingJob
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue({ job: job({ status: 'done', batchCount: 1, batchesDone: [0] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    // Polls inside the deadline wait for the read that is out...
    await flush(JOB_READ_STALL_MS - JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    // ...the first one past it reads again, and that answer is applied.
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(2);
    expect(current().job?.status).toBe('done');
    expect(getRanking).toHaveBeenCalledTimes(2);
  });

  it('a stalled job read that answers after its successor is ordered like any other: its older view is dropped (FW2-2)', async () => {
    const stalled = held<{ job: RankingJobView | null }>();
    getRanking.mockResolvedValue(readOf(job({ status: 'running', batchCount: 2 })));
    getRankingJob
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue({ job: job({ status: 'running', batchCount: 2, batchesDone: [0] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    await flush(JOB_POLL_MS);
    await flush(JOB_READ_STALL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(2);
    expect(current().job?.batchesDone).toEqual([0]);
    expect(getRanking).toHaveBeenCalledTimes(2);
    await act(async () => {
      stalled.resolve({ job: job({ status: 'running', batchCount: 2 }) });
    });
    await flush();
    expect(current().job?.batchesDone).toEqual([0]);
    expect(getRanking).toHaveBeenCalledTimes(2);
  });

  it('three overlapping full reads answering 2, 1, 3 show the rows of 2, then 3 - never 1 (FW2-3)', async () => {
    const one = held<RankingReadResponse>();
    const two = held<RankingReadResponse>();
    const three = held<RankingReadResponse>();
    getRanking
      .mockResolvedValueOnce(readWithRow('initial', job({ status: 'running', batchCount: 4 })))
      .mockReturnValueOnce(one.promise)
      .mockReturnValueOnce(two.promise)
      .mockReturnValueOnce(three.promise);
    getRankingJob
      .mockResolvedValueOnce({ job: job({ status: 'running', batchCount: 4, batchesDone: [0] }) })
      .mockResolvedValueOnce({ job: job({ status: 'running', batchCount: 4, batchesDone: [0, 1] }) })
      .mockResolvedValueOnce({ job: job({ status: 'running', batchCount: 4, batchesDone: [0, 1, 2] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    // Three batches finish one after another; each grown job view issues a full read.
    for (const finished of [1, 2, 3]) {
      act(() => {
        handlers.onRankingUpdated?.(rankingEvent({ batchesDone: finished, batchCount: 4 }));
      });
      await flush();
    }
    expect(getRanking).toHaveBeenCalledTimes(4);
    await act(async () => {
      two.resolve(readWithRow('two'));
    });
    await flush();
    expect(current().read?.rows[0]?.display).toBe('two');
    await act(async () => {
      one.resolve(readWithRow('one'));
    });
    await flush();
    expect(current().read?.rows[0]?.display).toBe('two');
    await act(async () => {
      three.resolve(readWithRow('three'));
    });
    await flush();
    expect(current().read?.rows[0]?.display).toBe('three');
    expect(current().readStatus).toBe('ready');
  });

  // A guard on FW2-3, not its regression test: an earlier read that answers
  // after the LATEST read failed must not hide that failure (and its Retry)
  // behind its own, older table.
  it('a failure of the latest full read stays, with its Retry, when an earlier read answers after it (FW2-3)', async () => {
    const earlier = held<RankingReadResponse>();
    const latest = held<RankingReadResponse>();
    getRanking
      .mockResolvedValueOnce(readWithRow('initial', job({ status: 'running', batchCount: 2 })))
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(latest.promise)
      .mockResolvedValueOnce(readWithRow('retried'));
    getRankingJob
      .mockResolvedValueOnce({ job: job({ status: 'running', batchCount: 2, batchesDone: [0] }) })
      .mockResolvedValueOnce({ job: job({ status: 'done', batchCount: 2, batchesDone: [0, 1] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    for (const event of [rankingEvent({ batchesDone: 1 }), rankingEvent({ status: 'done', batchesDone: 2 })]) {
      act(() => {
        handlers.onRankingUpdated?.(event);
      });
      await flush();
    }
    expect(getRanking).toHaveBeenCalledTimes(3);
    await act(async () => {
      latest.reject(new ApiError(503, 'ranking_unavailable', 'ranking_unavailable', { error: 'ranking_unavailable' }));
    });
    await flush();
    expect(current().readStatus).toBe('error');
    await act(async () => {
      earlier.resolve(readWithRow('after batch 0'));
    });
    await flush();
    expect(current().readStatus).toBe('error');
    expect(current().readError).toBe('This record could not be read. Try again.');
    act(() => {
      current().retryRead();
    });
    await flush();
    expect(current().readStatus).toBe('ready');
    expect(current().read?.rows[0]?.display).toBe('retried');
  });
});

// Code review R3 (FW3-1, FW3-2, FW3-4): a press's message and joined mark
// clear only when a view that is not live replaces a job the page FOLLOWED,
// not while it follows none (a job that ended unseen, first shown then, still
// reads the ranking again); a job read as expired - a queued record read past
// its expiry - is level with queued, so when a poll tick that started before
// the expiry claims it, the same generation's running views apply and the
// poll resumes; and two FW2 details are pinned: the pool-built tier of one
// generation's order, and a job read out when the clock goes back.
describe('useAnchorRanking - ordering, round 3', () => {
  it.each<[string, unknown, string]>([
    ['refused 429', new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }), 'Too many rankings. Wait a minute and try again.'],
    ['lost on the network', new TypeError('Failed to fetch'), 'The ranking could not be started. Try again.'],
  ])('a press %s before the first read keeps its message when that read lands with the last finished job (FW3-1)', async (_how, refusal, message) => {
    const first = held<RankingReadResponse>();
    getRanking.mockReturnValueOnce(first.promise).mockResolvedValue(readOf(null));
    startRanking.mockRejectedValue(refusal);
    render(<Probe anchor={ANCHOR} />);
    await flush();
    // Rank is enabled while the first read loads; the press is refused.
    act(() => {
      current().rank();
    });
    await flush();
    expect(current().rankError).toBe(message);
    // The first read answers with the anchor's previous ranking, finished long ago.
    await act(async () => {
      first.resolve(readOf(job({ status: 'done', batchCount: 1, batchesDone: [0] })));
    });
    await flush();
    expect(current().job?.status).toBe('done');
    expect(current().rankError).toBe(message);
  });

  it('a first job view of a ranking that ended unseen, with no batch finished, reads the ranking again and leaves a refused press its message (FW3-1)', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockRejectedValue(new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }));
    // Another admin's press ran and ended after the first read: an empty pool, no batch.
    getRankingJob.mockResolvedValue({ job: job({ status: 'done', startedAt: '2026-07-01T12:00:01.000Z', poolSize: 0 }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    act(() => {
      handlers.onRankingUpdated?.(rankingEvent({ status: 'done', batchesDone: 0, batchCount: 0 }));
    });
    await flush();
    await flush();
    expect(current().job?.status).toBe('done');
    // FW2-1's wider end, kept for the full read: a generation first seen ended reads the table.
    expect(getRanking).toHaveBeenCalledTimes(2);
    // The page followed no job, so no followed job ended: the press's message stays.
    expect(current().rankError).toBe('Too many rankings. Wait a minute and try again.');
  });

  it('a queued job read as expired and then claimed in the same generation is followed: its running views apply and the poll resumes (FW3-2)', async () => {
    getRanking.mockResolvedValue(readOf(null));
    startRanking.mockResolvedValue({ job: job(), joined: false });
    getRankingJob
      .mockResolvedValueOnce({ job: job({ status: 'expired' }) })
      .mockResolvedValueOnce({ job: job({ status: 'running', startedAt: '2026-07-01T12:10:00.000Z', batchCount: 2 }) })
      .mockResolvedValue({ job: job({ status: 'running', startedAt: '2026-07-01T12:10:00.000Z', batchCount: 2, batchesDone: [0] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    act(() => {
      current().rank();
    });
    await flush();
    // The poll reads the queued record just past its expiry: the server derives 'expired'.
    await flush(JOB_POLL_MS);
    expect(current().job?.status).toBe('expired');
    expect(getRanking).toHaveBeenCalledTimes(2);
    // A poll tick that started before the expiry claims it: the same generation runs.
    act(() => {
      handlers.onRankingUpdated?.(rankingEvent({ batchesDone: 0, batchCount: 2 }));
    });
    await flush();
    expect(current().job).toMatchObject({ status: 'running', generation: 'gen-1', batchCount: 2 });
    // Live again: the poll reads it, and its first finished batch reads the ranking.
    await flush(JOB_POLL_MS);
    expect(getRankingJob).toHaveBeenCalledTimes(3);
    expect(current().job?.batchesDone).toEqual([0]);
    expect(getRanking).toHaveBeenCalledTimes(3);
  });

  // FW3-4: two FW2 details that no test pinned.
  it('within one generation a view whose pool is not built is behind one whose pool is, even when issued later: "Ranking..." never replaces "0 of 3" (FW3-4, FW2-5)', async () => {
    const firstRead = held<RankingReadResponse>();
    const early = held<{ job: RankingJobView | null }>();
    getRanking.mockReturnValueOnce(firstRead.promise).mockResolvedValue(readOf(null));
    getRankingJob.mockReturnValueOnce(early.promise);
    render(<Probe anchor={ANCHOR} />);
    await flush();
    // The job's start event reads the job - issued after the first read, served before the pool was built.
    act(() => {
      handlers.onRankingUpdated?.(rankingEvent({ batchesDone: 0, batchCount: 0 }));
    });
    await flush();
    // The first read took its job snapshot after the pool (3 batches) and lands first.
    await act(async () => {
      firstRead.resolve(readOf(job({ status: 'running', startedAt: '2026-07-01T12:00:01.000Z', batchCount: 3 })));
    });
    await flush();
    expect(current().job).toMatchObject({ status: 'running', batchCount: 3 });
    // The job read lands last, from before the pool: level in status and finished batches, behind in the pool.
    await act(async () => {
      early.resolve({ job: job({ status: 'running', startedAt: '2026-07-01T12:00:01.000Z' }) });
    });
    await flush();
    expect(current().job).toMatchObject({ status: 'running', batchCount: 3 });
  });

  it('a job read out when the clock goes back no longer holds the next one: a negative age counts as stalled (FW3-4, FW2-2)', async () => {
    getRanking.mockResolvedValue(readOf(job({ status: 'running', batchCount: 1 })));
    getRankingJob
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue({ job: job({ status: 'done', batchCount: 1, batchesDone: [0] }) });
    render(<Probe anchor={ANCHOR} />);
    await flush();
    // An event reads the job; that read never answers.
    act(() => {
      handlers.onRankingUpdated?.(rankingEvent({ batchesDone: 0, batchCount: 1 }));
    });
    await flush();
    expect(getRankingJob).toHaveBeenCalledTimes(1);
    // The system clock is set back an hour, no time passes: the read out seems sent in the future.
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    act(() => {
      handlers.onRankingUpdated?.(rankingEvent({ status: 'done', batchesDone: 1, batchCount: 1 }));
    });
    await flush();
    expect(getRankingJob).toHaveBeenCalledTimes(2);
    expect(current().job?.status).toBe('done');
  });
});
