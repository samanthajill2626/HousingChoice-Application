import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAiRun,
  listAiRuns,
  type AiRunDetailResponse,
  type AiRunListRow,
  type AiRunScope,
} from '../../../api/index.js';

export type AiRunFetchStatus = 'loading' | 'ready' | 'error';

export interface AiRunListState {
  rows: AiRunListRow[];
  status: AiRunFetchStatus;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

export interface AiRunState {
  detail: AiRunDetailResponse | undefined;
  status: 'idle' | AiRunFetchStatus;
  retry: () => void;
}

export function useAiRunList(params: { scope: AiRunScope; from?: string; to?: string }): AiRunListState {
  const { scope, from, to } = params;
  const [state, setState] = useState<Omit<AiRunListState, 'loadMore' | 'retry'>>({
    rows: [], status: 'loading', hasMore: false, loadingMore: false,
  });
  const abortRef = useRef<AbortController | null>(null);
  const nextBeforeRef = useRef<string | undefined>(undefined);

  const loadFirst = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const page = await listAiRuns({ scope, from, to }, controller.signal);
      if (controller.signal.aborted) return;
      nextBeforeRef.current = page.nextBefore;
      setState({ rows: page.runs, status: 'ready', hasMore: page.nextBefore !== undefined, loadingMore: false });
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      nextBeforeRef.current = undefined;
      setState({ rows: [], status: 'error', hasMore: false, loadingMore: false });
    }
  }, [from, scope, to]);

  useEffect(() => {
    nextBeforeRef.current = undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ rows: [], status: 'loading', hasMore: false, loadingMore: false });
    void loadFirst();
    return () => abortRef.current?.abort();
  }, [loadFirst]);

  const loadMore = useCallback(() => {
    const before = nextBeforeRef.current;
    if (before === undefined || state.loadingMore || state.status !== 'ready') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState((previous) => ({ ...previous, loadingMore: true }));
    void (async () => {
      try {
        const page = await listAiRuns({ scope, from, to, before }, controller.signal);
        if (controller.signal.aborted) return;
        nextBeforeRef.current = page.nextBefore;
        setState((previous) => ({
          ...previous, rows: [...previous.rows, ...page.runs], hasMore: page.nextBefore !== undefined, loadingMore: false,
        }));
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState((previous) => ({ ...previous, loadingMore: false, hasMore: false }));
      }
    })();
  }, [from, scope, state.loadingMore, state.status, to]);

  const retry = useCallback(() => {
    setState({ rows: [], status: 'loading', hasMore: false, loadingMore: false });
    void loadFirst();
  }, [loadFirst]);

  return { ...state, loadMore, retry };
}

export function useAiRun(runId: string | undefined): AiRunState {
  const [detail, setDetail] = useState<AiRunDetailResponse | undefined>(undefined);
  const [status, setStatus] = useState<AiRunState['status']>(runId === undefined ? 'idle' : 'loading');
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (runId === undefined) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const next = await getAiRun(runId, controller.signal);
      if (controller.signal.aborted) return;
      setDetail(next);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setDetail(undefined);
      setStatus('error');
    }
  }, [runId]);

  useEffect(() => {
    if (runId === undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDetail(undefined);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('idle');
      return () => abortRef.current?.abort();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(undefined);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    void load();
    return () => abortRef.current?.abort();
  }, [load, runId]);

  const retry = useCallback(() => {
    if (runId === undefined) return;
    setStatus('loading');
    void load();
  }, [load, runId]);

  return { detail, status, retry };
}
