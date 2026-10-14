// useFollowUpCounts - the Properties list's "<n> waiting" counts
// (last-heard-from spec 5.6 option C, 14.4 B14): the follow-ups response's
// byUnit map, one request per list load. Its OWN hook - never useListings,
// which ToursPage also calls. Silent on failure: no count, no error over the
// list. `enabled` is false on the Deleted view (no available rows there).
import { useEffect, useState } from 'react';
import { getFollowUps } from '../../api/index.js';

const EMPTY: Readonly<Record<string, number>> = {};

export function useFollowUpCounts(enabled: boolean): Readonly<Record<string, number>> {
  const [byUnit, setByUnit] = useState<Readonly<Record<string, number>>>(EMPTY);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getFollowUps(controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setByUnit(res.byUnit);
      })
      .catch(() => {
        // Silent by design (spec 14.4 B14): the pill is a hint, not a gate.
      });
    return () => controller.abort();
  }, [enabled]);
  return enabled ? byUnit : EMPTY;
}
