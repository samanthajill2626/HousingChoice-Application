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
// Order (code review R1 A2-1, A2-2): reads answer in any order, so every
// request takes an issue number when it is sent. A full read's rows are
// applied only if it is the LATEST full read issued for the key; a job view
// (from a job read, a read that adopts its job, or a press) only if it was
// issued after the view on screen - so an earlier read landing last never
// puts back an older table or job, and a read issued before a press never
// replaces the press's job. Job reads never overlap: a call while one is out
// asks for one more read after it.
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

interface Current {
  key: string;
  kind: RankingAnchorKind;
  id: string;
  includeOlder: boolean;
  controller: AbortController;
  /** The issue number of the latest full read: only its answer is applied. */
  latestRead: number;
  /** The issue number of the job view on screen (0 = none yet) and its generation. */
  jobIssued: number;
  jobGeneration: string | null;
  /** The job view on screen as last seen, for "the finished batches grew" and "the job ended". */
  seenBatches: number;
  wasLive: boolean;
  /** The job read out now, and whether another was asked for meanwhile. */
  jobRead: Promise<void> | null;
  jobReadAgain: boolean;
}

/** What applying a job view changed; null when a newer view was on screen. */
type JobChange = { grew: boolean; ended: boolean } | null;

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

  // A job view issued as `issued`, applied only when no later one is on screen.
  const applyJob = useCallback(
    (cur: Current, next: RankingJobView | null, issued: number): JobChange => {
      if (issued <= cur.jobIssued) return null;
      // FINISHED batches, scored or failed (spec D12; plan review BB5).
      const finished = next === null ? 0 : finishedBatchCount(next);
      const grew = finished > cur.seenBatches;
      const ended = cur.wasLive && (next === null || !isJobLive(next.status));
      cur.jobIssued = issued;
      cur.jobGeneration = next === null ? null : next.generation;
      cur.seenBatches = finished;
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
        // Its job by the job views' own rule: never over a press or a job
        // read issued after this read (A2-2).
        if (adoptJob) applyJob(cur, next.job, issued);
        // Its rows only if no later full read was issued (A2-1).
        if (issued !== cur.latestRead) return;
        setPoolWindowDays(next.poolWindowDays);
        update(cur.key, (s) => ({ ...s, read: next, readStatus: 'ready', readError: null }));
      } catch (err) {
        if (cur.controller.signal.aborted || isAbort(err) || currentRef.current !== cur) return;
        if (issued !== cur.latestRead) return;
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
      jobIssued: 0,
      jobGeneration: null,
      seenBatches: 0,
      wasLive: false,
      jobRead: null,
      jobReadAgain: false,
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

  const refreshJob = useCallback((): Promise<void> => {
    const cur = currentRef.current;
    if (cur === null) return Promise.resolve();
    // One job read at a time (A2-1): events, the poll and a refused press
    // arriving while one is out ask for ONE more read after it.
    if (cur.jobRead !== null) {
      cur.jobReadAgain = true;
      return cur.jobRead;
    }
    const run = async (): Promise<void> => {
      try {
        do {
          cur.jobReadAgain = false;
          await readJobOnce(cur);
        } while (cur.jobReadAgain && currentRef.current === cur && !cur.controller.signal.aborted);
      } finally {
        // In the same step as the last check, so no call can slip between them.
        cur.jobRead = null;
      }
    };
    cur.jobRead = run();
    return cur.jobRead;
  }, [readJobOnce]);

  const live = slice !== null && key !== undefined && slice.key === key ? slice : null;
  const jobLive = live !== null && live.job !== null && isJobLive(live.job.status);

  useEffect(() => {
    if (!jobLive) return undefined;
    const timer = setInterval(() => {
      void refreshJob();
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [jobLive, key, refreshJob]);

  useEventStream({
    onRankingUpdated: (event) => {
      if (event.anchorKind === kind && event.anchorId === id) void refreshJob();
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
        // as new or newer. Every read issued before this answer is older: its
        // job view is dropped when it lands.
        if (cur.jobGeneration !== res.job.generation) {
          cur.jobIssued = issue();
          cur.jobGeneration = res.job.generation;
          cur.seenBatches = finishedBatchCount(res.job);
          cur.wasLive = isJobLive(res.job.status);
          update(cur.key, (s) => ({ ...s, ranking: false, job: res.job, joined: res.joined }));
        } else {
          update(cur.key, (s) => ({ ...s, ranking: false, joined: res.joined }));
        }
      } catch (err) {
        if (currentRef.current !== cur) return;
        update(cur.key, (s) => ({ ...s, ranking: false, rankError: rankErrorText(err) }));
        // Refused for a live job: follow it, so the page shows it finishing.
        // The server just said that job is live, so its end - whenever the
        // page reads it - clears this error (A2-8) and reads the ranking again.
        if (err instanceof ApiError && err.code === 'ranking_running') {
          cur.wasLive = true;
          void refreshJob();
        }
      }
    })();
  }, [issue, refreshJob, update]);

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
