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
  // Job progress as last seen, for "the finished batches grew" and "the job ended".
  const seenBatchesRef = useRef(0);
  const wasLiveRef = useRef(false);

  const update = useCallback((forKey: string, change: (s: Slice) => Slice): void => {
    setSlice((prev) => change(prev !== null && prev.key === forKey ? prev : blank(forKey)));
  }, []);

  const loadRead = useCallback(
    async (cur: Current, adoptJob: boolean): Promise<void> => {
      try {
        const next = await getRanking(cur.kind, cur.id, { includeOlder: cur.includeOlder }, cur.controller.signal);
        if (cur.controller.signal.aborted || currentRef.current !== cur) return;
        if (adoptJob) {
          seenBatchesRef.current = next.job === null ? 0 : finishedBatchCount(next.job);
          wasLiveRef.current = next.job !== null && isJobLive(next.job.status);
        }
        setPoolWindowDays(next.poolWindowDays);
        update(cur.key, (s) => ({
          ...s,
          read: next,
          readStatus: 'ready',
          readError: null,
          ...(adoptJob && { job: next.job }),
        }));
      } catch (err) {
        if (cur.controller.signal.aborted || isAbort(err) || currentRef.current !== cur) return;
        update(cur.key, (s) => ({ ...s, readStatus: 'error', readError: readErrorText(err) }));
      }
    },
    [update],
  );

  useEffect(() => {
    if (key === undefined || kind === undefined || id === undefined) {
      currentRef.current = null;
      return undefined;
    }
    const cur: Current = { key, kind, id, includeOlder, controller: new AbortController() };
    currentRef.current = cur;
    seenBatchesRef.current = 0;
    wasLiveRef.current = false;
    void loadRead(cur, true);
    return () => {
      cur.controller.abort();
      if (currentRef.current === cur) currentRef.current = null;
    };
  }, [id, includeOlder, key, kind, loadRead]);

  const refreshJob = useCallback(async (): Promise<void> => {
    const cur = currentRef.current;
    if (cur === null) return;
    try {
      const res = await getRankingJob(cur.kind, cur.id, cur.controller.signal);
      if (cur.controller.signal.aborted || currentRef.current !== cur) return;
      const next = res.job;
      // FINISHED batches, scored or failed (spec D12; plan review BB5).
      const finished = next === null ? 0 : finishedBatchCount(next);
      const grew = finished > seenBatchesRef.current;
      const ended = wasLiveRef.current && (next === null || !isJobLive(next.status));
      seenBatchesRef.current = finished;
      wasLiveRef.current = next !== null && isJobLive(next.status);
      update(cur.key, (s) => ({ ...s, job: next }));
      if (grew || ended) await loadRead(cur, false);
    } catch {
      // A failed job read is not shown: the next poll or event reads it again.
    }
  }, [loadRead, update]);

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
        seenBatchesRef.current = finishedBatchCount(res.job);
        wasLiveRef.current = isJobLive(res.job.status);
        update(cur.key, (s) => ({ ...s, ranking: false, job: res.job, joined: res.joined }));
      } catch (err) {
        if (currentRef.current !== cur) return;
        update(cur.key, (s) => ({ ...s, ranking: false, rankError: rankErrorText(err) }));
        // Refused for a live job: follow it, so the page shows it finishing.
        if (err instanceof ApiError && err.code === 'ranking_running') void refreshJob();
      }
    })();
  }, [refreshJob, update]);

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
