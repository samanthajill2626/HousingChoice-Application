// useSystemStatus — the data hooks behind the admin-only System Status section.
// Three independent reads so each block loads/errors on its own:
//
//   useSystemFlags()   GET /api/system/flags  (always loads — config only)
//   useSystemAlarms()  GET /api/system/alarms (auto-refresh 60s WHILE VISIBLE + manual ↻)
//   useSystemErrors()  GET /api/system/errors?since= (window selector + manual ↻)
//
// Each uses an AbortController + a cancelled/abort guard (the Phase-A pattern in
// useTeam): an unmount or a superseding fetch never sets state. Alarms/errors
// resolve to { available: false, reason } on the local stack (no AWS) — the
// hooks pass that through; the components render the degraded notice.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSystemAlarms,
  getSystemErrors,
  getSystemFlags,
  type SystemAlarmsResult,
  type SystemErrorsResult,
  type SystemFlags,
} from '../../api/index.js';

export type FetchStatus = 'loading' | 'ready' | 'error';

/** Auto-refresh cadence for the alarm grid (only ticks while the tab is visible). */
export const ALARM_REFRESH_MS = 60_000;

// --- Flags ------------------------------------------------------------------

export interface SystemFlagsState {
  status: FetchStatus;
  flags: SystemFlags | null;
  retry: () => void;
}

export function useSystemFlags(): SystemFlagsState {
  const [status, setStatus] = useState<FetchStatus>('loading');
  const [flags, setFlags] = useState<SystemFlags | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const next = await getSystemFlags(controller.signal);
      if (controller.signal.aborted) return;
      setFlags(next);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const retry = useCallback(() => {
    setStatus('loading');
    void load();
  }, [load]);

  return { status, flags, retry };
}

// --- Alarms (auto-refresh while visible) ------------------------------------

export interface SystemAlarmsState {
  status: FetchStatus;
  result: SystemAlarmsResult | null;
  /** True while a background refresh is in flight (the initial load uses `status`). */
  refreshing: boolean;
  refresh: () => void;
}

export function useSystemAlarms(): SystemAlarmsState {
  const [status, setStatus] = useState<FetchStatus>('loading');
  const [result, setResult] = useState<SystemAlarmsResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // `loaded` (a ref, not state) lets the polling effect tell an initial load
  // from a background refresh without re-subscribing the interval.
  const loadedRef = useRef(false);

  const load = useCallback(async (background: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (background) setRefreshing(true);
    try {
      const next = await getSystemAlarms(controller.signal);
      if (controller.signal.aborted) return;
      setResult(next);
      setStatus('ready');
      loadedRef.current = true;
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (!background) setStatus('error');
    } finally {
      if (background) setRefreshing(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    void load(false);
    return () => abortRef.current?.abort();
  }, [load]);

  // Auto-refresh every 60s WHILE THE TAB IS VISIBLE. The interval is (re)armed
  // on visibility change: paused (cleared) when hidden, resumed when visible.
  // A manual refresh button complements it.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const arm = (): void => {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') void load(true);
      }, ALARM_REFRESH_MS);
    };
    const disarm = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        // Catch up immediately on re-show, then resume ticking.
        if (loadedRef.current) void load(true);
        arm();
      } else {
        disarm();
      }
    };
    if (document.visibilityState === 'visible') arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disarm();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  return { status, result, refreshing, refresh };
}

// --- Errors (window selector) -----------------------------------------------

export type ErrorWindow = '1h' | '24h' | '7d';

export interface SystemErrorsState {
  status: FetchStatus;
  result: SystemErrorsResult | null;
  refreshing: boolean;
  window: ErrorWindow;
  setWindow: (w: ErrorWindow) => void;
  refresh: () => void;
}

export function useSystemErrors(): SystemErrorsState {
  const [status, setStatus] = useState<FetchStatus>('loading');
  const [result, setResult] = useState<SystemErrorsResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [window, setWindowState] = useState<ErrorWindow>('24h');
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (w: ErrorWindow, background: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (background) setRefreshing(true);
    else setStatus('loading');
    try {
      const next = await getSystemErrors(w, controller.signal);
      if (controller.signal.aborted) return;
      setResult(next);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (!background) setStatus('error');
    } finally {
      if (background) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(window, false);
    return () => abortRef.current?.abort();
  }, [load, window]);

  const setWindow = useCallback((w: ErrorWindow) => {
    setWindowState(w);
  }, []);

  const refresh = useCallback(() => {
    void load(window, true);
  }, [load, window]);

  return { status, result, refreshing, window, setWindow, refresh };
}
