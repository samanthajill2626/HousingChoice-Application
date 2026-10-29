// useRankCandidates - the lists the Rank panel's search fields filter (WP1
// B2a spec D18 "the existing contact and unit search"). ContactSearchField
// and UnitSearchField filter a candidate array client side, so the panel
// loads EVERY page of both, as PlacementCreateForm does. Any record can be
// the anchor (spec D1), so neither list is narrowed by status.
import { useEffect, useState } from 'react';
import { getAllContacts, getAllUnits, type Contact, type UnitItem } from '../../../api/index.js';

export interface RankCandidates {
  units: UnitItem[];
  tenants: Contact[];
  status: 'loading' | 'ready' | 'error';
}

export function useRankCandidates(): RankCandidates {
  const [state, setState] = useState<RankCandidates>({ units: [], tenants: [], status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [units, tenants] = await Promise.all([
          getAllUnits({}, controller.signal),
          getAllContacts({ type: 'tenant' }, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setState({ units, tenants, status: 'ready' });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ units: [], tenants: [], status: 'error' });
      }
    })();
    return () => controller.abort();
  }, []);

  return state;
}
