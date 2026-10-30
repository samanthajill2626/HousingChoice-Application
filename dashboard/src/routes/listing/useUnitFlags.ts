// useUnitFlags - the property page's read of its OPEN fair-housing flags
// (WP1 B2a spec D10 rev 7, charter item 16; GET /api/rankings/unit/:id/flags,
// admin and va). The page shows them as a read-only notice.
//
// - Reads on mount, in parallel with the page's own reads.
// - `check`: the page bumps it after a save, and the hook reads again, so an
//   edited field's notice goes without a reload (open is derived on read on
//   the server: an edit to the flagged text closes the flag). The previous
//   answer stays up while the re-check runs (no flicker).
// - `enabled`: false while the property is deleted (the page shows no notice
//   then); it reads again when the property is restored.
// - A 404 (a missing or deleted property) is no notice, not a failure; any
//   other failure is the `error` state, which the page shows as a short note.
//
// The committed state records which unitId it describes; a different id
// DERIVES loading during render until its own answer lands (useListing's
// pattern), so an answer for one property never shows on another.
import { useEffect, useState } from 'react';
import { ApiError, getUnitFairHousingFlags, type UnitFairHousingFlag } from '../../api/index.js';

export type UnitFlagsState =
  | { status: 'loading' }
  | { status: 'ready'; flags: UnitFairHousingFlag[] }
  | { status: 'error' };

const LOADING: UnitFlagsState = { status: 'loading' };

export function useUnitFlags(unitId: string, check: number, enabled = true): UnitFlagsState {
  const [state, setState] = useState<{ forId: string; value: UnitFlagsState }>({ forId: unitId, value: LOADING });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getUnitFairHousingFlags(unitId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ forId: unitId, value: { status: 'ready', flags: response.flags } });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        const value: UnitFlagsState =
          err instanceof ApiError && err.status === 404 ? { status: 'ready', flags: [] } : { status: 'error' };
        setState({ forId: unitId, value });
      });
    return () => controller.abort();
    // `check` is the re-check trigger: a new value reads again.
  }, [unitId, check, enabled]);

  return state.forId === unitId ? state.value : LOADING;
}
