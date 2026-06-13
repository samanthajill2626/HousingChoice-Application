// useApi — a tiny dependency-free query hook (no react-query). Runs an async
// fetcher on mount (and whenever the deps change), exposing {data, error,
// loading} plus a refetch(). Aborts the in-flight request on unmount / dep
// change so a late response never sets state on an unmounted component.
//
// Use for GETs that should load when a screen opens. For mutations (POST/PATCH/
// PUT/DELETE) call the endpoint function directly and manage your own pending
// state — a one-shot hook would only get in the way.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './client.js';

export interface UseApiResult<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** Re-run the fetcher (e.g. after a mutation). */
  refetch: () => void;
}

/**
 * @param fetcher receives an AbortSignal — pass it through to the endpoint
 *   function so the request is cancelled on unmount / refetch / dep change.
 * @param deps  re-runs the fetcher when these change (like useEffect deps).
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): UseApiResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // A monotonically bumped token forces refetch() to re-run the effect.
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(undefined);

    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(
          err instanceof ApiError ? err : new ApiError(0, 'unknown_error', String(err)),
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
    // Deps are caller-supplied; the fetcher itself is read from a ref so it is
    // intentionally not a dependency (avoids re-running on every render).
  }, [nonce, ...deps]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, refetch };
}
