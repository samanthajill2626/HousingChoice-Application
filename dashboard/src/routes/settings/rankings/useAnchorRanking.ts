// useAnchorRanking - the "Rank this anchor" panel's data (WP1 B2a spec D9,
// D12, D18): the ranking read for the picked anchor, the Rank press, and the
// job status. While a job is queued or running the job read (one key read)
// is polled every 5 s, and a ranking.updated event for this anchor reads it
// at once - the event is only a hint, the worker-to-app bridge is
// best-effort. The FULL ranking (about ten DynamoDB reads per candidate) is
// read again only when the FINISHED batch count (scored or failed) grows and
// once when the job ends.
//
// State is keyed by the anchor and window it answers, so a new pick reads
// "loading" without a reset inside an effect; a response for an old key is
// dropped (its controller is aborted and the current key is checked).
//
// Order (code review R1 A2-1, A2-2; R2 FW2-1, FW2-2, FW2-3, FW2-5): reads
// answer in any order, so every request takes an issue number when it is
// sent.
// - A full read's rows are applied only if it was issued after the rows on
//   screen, so an earlier read landing last never puts back an older table,
//   and a newer one shows even while a later one is still out. A failure is
//   shown only for the LATEST full read issued; an earlier read that answers
//   after it leaves the failure (with its Retry) on screen.
// - A job view (from a job read, a read that adopts its job, or a press) of
//   the generation on screen is applied only if it is not behind the view on
//   screen - status queued, then running, then ended; then finished batches;
//   then the pool built - and, when level with it, only if issued after every
//   view applied so far: a read's job snapshot is taken late (after its
//   pool), so issue order alone could step the status back. A view of another
//   generation (or of none) is applied only if issued after every view
//   applied so far, so a read issued before a press never replaces the
//   press's job.
// - A job view of a generation the page has not shown is a change: its
//   finished batches count from zero, and its end counts even when the page
//   never saw it live - so a job first seen part-way or finished still reads
//   the ranking again.
// - Job reads never overlap: a call while one is out asks for one more read
//   after it - unless the one out was sent JOB_READ_STALL_MS ago or more; then
//   the call sends a new read, and the stalled one's answer, if it ever comes,
//   is ordered by the rules above.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getRanking,
  getRankingJob,
  startRanking,
  useEventStream,
  type RankingAnchorKind,
  type RankingAnchorRef,
  type RankingJobView,
  type RankingReadResponse,
} from '../../../api/index.js';
import { finishedBatchCount, isJobLive } from './rankingFormat.js';

/** The job read's poll interval while a job is queued or running (spec D12). */
export const JOB_POLL_MS = 5_000;

/** A job read out longer than this no longer holds back the next one (code review R2 FW2-2). */
export const JOB_READ_STALL_MS = 2 * JOB_POLL_MS;

export type RankingReadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AnchorRankingState {
  read: RankingReadResponse | undefined;
  readStatus: RankingReadStatus;
  readError: string | null;
  /** The last read's pool window (plan PR26); kept across reads so the
   *  checkbox does not vanish while a toggle re-reads. null before any read. */
  poolWindowDays: number | null;
  job: RankingJobView | null;
  /** The last press joined a job that was already live. */
  joined: boolean;
  /** A press is in flight. */
  ranking: boolean;
  rankError: string | null;
  rank: () => void;
  retryRead: () => void;
}

interface Slice {
  key: string;
  read: RankingReadResponse | undefined;
  readStatus: 'loading' | 'ready' | 'error';
  readError: string | null;
  job: RankingJobView | null;
  joined: boolean;
  ranking: boolean;
  rankError: string | null;
}

/** The job read out now (code review R2 FW2-2). */
interface JobFlight {
  /** When the read out now was sent (Date.now()). */
  since: number;
  /** Another read was asked for while it was out. */
  again: boolean;
}

interface Current {
  key: string;
  kind: RankingAnchorKind;
  id: string;
  includeOlder: boolean;
  controller: AbortController;
  /** The issue number of the latest full read: only its failure is shown. */
  latestRead: number;
  /** The issue numbers of the full read whose rows are held and of the failure on screen (0 = none). */
  rowsIssued: number;
  failedIssued: number;
  /** The job view on screen (null = none, or no job) - for the order rules,
   *  "the finished batches grew" and "a new generation" - and the highest
   *  issue number of a view applied (0 = none yet). */
  jobView: RankingJobView | null;
  jobIssued: number;
  /** The job on screen is live, or a 409 just said a live job exists: its
   *  end, whenever a view shows it, is "the job ended". */
  wasLive: boolean;
  /** The job read out now (null = none). */
  jobFlight: JobFlight | null;
}

/** What applying a job view changed; null when it was not applied. */
type JobChange = { grew: boolean; ended: boolean } | null;

/** How far one generation's job has got (code review R2 FW2-5): status
 *  (queued, running, then any end), finished batches, the pool built. */
function jobProgress(view: RankingJobView): [number, number, number] {
  const stage = view.status === 'queued' ? 0 : view.status === 'running' ? 1 : 2;
  return [stage, finishedBatchCount(view), view.batchCount];
}

/** Negative when `a` is behind `b`, 0 when level, positive when ahead. */
function compareProgress(a: RankingJobView, b: RankingJobView): number {
  const left = jobProgress(a);
  const right = jobProgress(b);
  for (let i = 0; i < left.length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function blank(key: string): Slice {
  return {
    key,
    read: undefined,
    readStatus: 'loading',
    readError: null,
    job: null,
    joined: false,
    ranking: false,
    rankError: null,
  };
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function serverMessage(err: ApiError): string | undefined {
  const body = err.body;
  if (body === null || typeof body !== 'object') return undefined;
  const message = (body as Record<string, unknown>)['message'];
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
}

function readErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'This record was not found.';
    // S6 answers 503 ranking_unavailable with a message (plan IR32, PR17).
    if (err.status === 503) return serverMessage(err) ?? 'This record could not be read. Try again.';
  }
  return 'We could not load this ranking.';
}

function rankErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'ranking_running') return 'A ranking is running for this record. Try again when it finishes.';
    if (err.status === 429) return 'Too many rankings. Wait a minute and try again.';
    if (err.status === 404) return 'This record was not found.';
  }
  return 'The ranking could not be started. Try again.';
}

export function useAnchorRanking(anchor: RankingAnchorRef | undefined, includeOlder: boolean): AnchorRankingState {
  const kind = anchor?.kind;
  const id = anchor?.id;
  const key = kind === undefined || id === undefined ? undefined : `${kind}:${id}:${includeOlder ? 'older' : 'window'}`;
  const [slice, setSlice] = useState<Slice | null>(null);
  const [poolWindowDays, setPoolWindowDays] = useState<number | null>(null);
  const currentRef = useRef<Current | null>(null);
  // One issue counter for every request - full reads, job reads, presses.
  const issuedRef = useRef(0);
  const issue = useCallback((): number => {
    issuedRef.current += 1;
    return issuedRef.current;
  }, []);

  const update = useCallback((forKey: string, change: (s: Slice) => Slice): void => {
    setSlice((prev) => change(prev !== null && prev.key === forKey ? prev : blank(forKey)));
  }, []);

  // A job view issued as `issued`, applied by the order rules in the header.
  const applyJob = useCallback(
    (cur: Current, next: RankingJobView | null, issued: number): JobChange => {
      const shown = cur.jobView;
      const sameGeneration = next !== null && shown !== null && next.generation === shown.generation;
      if (sameGeneration) {
        // One generation (code review R2 FW2-5): never a view behind the one
        // on screen; a level one only if issued after every view applied.
        const order = compareProgress(next, shown);
        if (order < 0 || (order === 0 && issued <= cur.jobIssued)) return null;
      } else if (issued <= cur.jobIssued) {
        return null;
      }
      // FINISHED batches, scored or failed (spec D12; plan review BB5). A
      // generation the page has not shown counts from zero, and its end
      // counts even when the page never saw it live (R2 FW2-1).
      const newGeneration = next !== null && !sameGeneration;
      const finished = next === null ? 0 : finishedBatchCount(next);
      const seen = newGeneration || shown === null ? 0 : finishedBatchCount(shown);
      const grew = finished > seen;
      const ended = (cur.wasLive || newGeneration) && (next === null || !isJobLive(next.status));
      cur.jobView = next;
      cur.jobIssued = Math.max(cur.jobIssued, issued);
      cur.wasLive = next !== null && isJobLive(next.status);
      // Code review R1 A2-8: a press's error and the joined mark speak of the
      // job the press followed; once that job ends they no longer apply.
      update(cur.key, (s) => ({ ...s, job: next, ...(ended && { rankError: null, joined: false }) }));
      return { grew, ended };
    },
    [update],
  );

  const loadRead = useCallback(
    async (cur: Current, adoptJob: boolean): Promise<void> => {
      const issued = issue();
      cur.latestRead = issued;
      try {
        const next = await getRanking(cur.kind, cur.id, { includeOlder: cur.includeOlder }, cur.controller.signal);
        if (cur.controller.signal.aborted || currentRef.current !== cur) return;
        // Its job by the job views' own rules: never over a press or a job
        // read issued after this read (A2-2), never behind the view on screen
        // (R2 FW2-5).
        if (adoptJob) applyJob(cur, next.job, issued);
        // Its rows only if issued after the rows held (A2-1; R2 FW2-3).
        if (issued <= cur.rowsIssued) return;
        cur.rowsIssued = issued;
        setPoolWindowDays(next.poolWindowDays);
        // A failure of a read issued after this one stays on screen, with its Retry.
        const afterFailure = issued > cur.failedIssued;
        update(cur.key, (s) =>
          afterFailure ? { ...s, read: next, readStatus: 'ready', readError: null } : { ...s, read: next },
        );
      } catch (err) {
        if (cur.controller.signal.aborted || isAbort(err) || currentRef.current !== cur) return;
        // Only the latest full read's failure is shown: a later read is still out.
        if (issued !== cur.latestRead) return;
        cur.failedIssued = issued;
        update(cur.key, (s) => ({ ...s, readStatus: 'error', readError: readErrorText(err) }));
      }
    },
    [applyJob, issue, update],
  );

  useEffect(() => {
    if (key === undefined || kind === undefined || id === undefined) {
      currentRef.current = null;
      return undefined;
    }
    const cur: Current = {
      key,
      kind,
      id,
      includeOlder,
      controller: new AbortController(),
      latestRead: 0,
      rowsIssued: 0,
      failedIssued: 0,
      jobView: null,
      jobIssued: 0,
      wasLive: false,
      jobFlight: null,
    };
    currentRef.current = cur;
    void loadRead(cur, true);
    return () => {
      cur.controller.abort();
      if (currentRef.current === cur) currentRef.current = null;
    };
  }, [id, includeOlder, key, kind, loadRead]);

  const readJobOnce = useCallback(
    async (cur: Current): Promise<void> => {
      const issued = issue();
      try {
        const res = await getRankingJob(cur.kind, cur.id, cur.controller.signal);
        if (cur.controller.signal.aborted || currentRef.current !== cur) return;
        const change = applyJob(cur, res.job, issued);
        // The full ranking: again when the finished batches grew, and once when the job ended.
        if (change !== null && (change.grew || change.ended)) void loadRead(cur, false);
      } catch {
        // A failed job read is not shown: the next poll or event reads it again.
      }
    },
    [applyJob, issue, loadRead],
  );

  const refreshJob = useCallback((): void => {
    const cur = currentRef.current;
    if (cur === null) return;
    const out = cur.jobFlight;
    if (out !== null) {
      // One job read at a time (A2-1): events, the poll and a refused press
      // arriving while one is out ask for ONE more read after it - unless it
      // was sent JOB_READ_STALL_MS ago or more (or the clock went back): then
      // it no longer holds the flight (R2 FW2-2).
      const age = Date.now() - out.since;
      if (age >= 0 && age < JOB_READ_STALL_MS) {
        out.again = true;
        return;
      }
    }
    const flight: JobFlight = { since: Date.now(), again: false };
    cur.jobFlight = flight;
    void (async () => {
      try {
        do {
          flight.again = false;
          flight.since = Date.now();
          await readJobOnce(cur);
        } while (flight.again && cur.jobFlight === flight && currentRef.current === cur && !cur.controller.signal.aborted);
      } finally {
        // In the same step as the last check, so no call can slip between
        // them; a stalled flight that a newer one replaced leaves it alone.
        if (cur.jobFlight === flight) cur.jobFlight = null;
      }
    })();
  }, [readJobOnce]);

  const live = slice !== null && key !== undefined && slice.key === key ? slice : null;
  const jobLive = live !== null && live.job !== null && isJobLive(live.job.status);

  useEffect(() => {
    if (!jobLive) return undefined;
    const timer = setInterval(() => {
      refreshJob();
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [jobLive, key, refreshJob]);

  useEventStream({
    onRankingUpdated: (event) => {
      if (event.anchorKind === kind && event.anchorId === id) refreshJob();
    },
  });

  const rank = useCallback((): void => {
    const cur = currentRef.current;
    if (cur === null) return;
    update(cur.key, (s) => ({ ...s, ranking: true, rankError: null, joined: false }));
    void (async () => {
      try {
        const res = await startRanking(cur.kind, cur.id, { includeOlder: cur.includeOlder });
        if (currentRef.current !== cur) return;
        // The press's job is newer than every view on screen (A2-2), unless a
        // job read already shows this generation - read after the claim, so
        // as new or newer. It takes a fresh issue number, so every read issued
        // before this answer is older: a view of another generation from one
        // is dropped when it lands. A generation the page had not shown, joined
        // part-way, reads the ranking again (R2 FW2-1).
        const change = cur.jobView?.generation !== res.job.generation ? applyJob(cur, res.job, issue()) : null;
        update(cur.key, (s) => ({ ...s, ranking: false, joined: res.joined }));
        if (change !== null && (change.grew || change.ended)) void loadRead(cur, false);
      } catch (err) {
        if (currentRef.current !== cur) return;
        update(cur.key, (s) => ({ ...s, ranking: false, rankError: rankErrorText(err) }));
        // Refused for a live job: follow it, so the page shows it finishing.
        // The server just said that job is live, so its end - whenever the
        // page reads it - clears this error (A2-8) and reads the ranking again.
        if (err instanceof ApiError && err.code === 'ranking_running') {
          cur.wasLive = true;
          refreshJob();
        }
      }
    })();
  }, [applyJob, issue, loadRead, refreshJob, update]);

  const retryRead = useCallback((): void => {
    const cur = currentRef.current;
    if (cur === null) return;
    update(cur.key, (s) => ({ ...s, readStatus: 'loading', readError: null }));
    void loadRead(cur, true);
  }, [loadRead, update]);

  if (key === undefined) {
    return {
      read: undefined,
      readStatus: 'idle',
      readError: null,
      poolWindowDays,
      job: null,
      joined: false,
      ranking: false,
      rankError: null,
      rank,
      retryRead,
    };
  }
  const s = live ?? blank(key);
  return {
    read: s.read,
    readStatus: s.readStatus,
    readError: s.readError,
    poolWindowDays,
    job: s.job,
    joined: s.joined,
    ranking: s.ranking,
    rankError: s.rankError,
    rank,
    retryRead,
  };
}
