// usePlacements — the placement board's data hook. Abort-safe fetch of the placements
// board (GET /api/placements) plus the contacts + units it needs to label cards
// (tenant NAME / property ADDRESS / porting chip). Mirrors useListings' single
// abort-safe useState/useEffect pattern (NO react-query). Exposes:
//   - applyPlacement(placement): replace/insert a placement in place after a transition returns
//     the updated PlacementItem — the board re-positions it with NO refetch.
//   - an SSE `placement.updated` subscription that live-repositions a card (it carries
//     the new stage; we patch the in-memory placement's stage/attention/tour/deadline).
//
// Name/address resolution: contacts + units back small lookup maps so a card can
// show the tenant's name (home) and the property's address. A contact/unit we
// don't have falls back to the id (honest — never fabricated).
import { useCallback, useEffect, useState } from 'react';
import {
  getPlacements,
  getContacts,
  getUnits,
  useEventStream,
  type PlacementAttention,
  type PlacementItem,
  type PlacementUpdatedEvent,
  type Contact,
  type PlacementStage,
  type UnitItem,
} from '../../api/index.js';

/** Safety cap on cursor-following so a misbehaving server (or a cursor that never
 *  nulls out) can never spin forever. The placement pipeline is small; this is
 *  far above any realistic page count. */
const MAX_PAGES = 50;

export type PlacementsStatus = 'loading' | 'ready' | 'error';

export interface PlacementsState {
  status: PlacementsStatus;
  placements: PlacementItem[];
  /** contactId → contact (tenant names + porting flag). */
  contacts: Map<string, Contact>;
  /** unitId → unit (property addresses). */
  units: Map<string, UnitItem>;
  /** Replace/insert a placement in place after a transition (no refetch). */
  applyPlacement: (next: PlacementItem) => void;
}

/** Load ALL pages of the placements board by following nextCursor. A placement board
 *  must show the WHOLE pipeline, so we page until the server stops handing back a
 *  cursor (capped by MAX_PAGES so a never-null cursor can't loop unbounded — a
 *  hit is logged with counts only, never PII). Re-throws AbortError so the
 *  effect's catch can bail cleanly. */
async function loadAllPlacements(signal: AbortSignal): Promise<PlacementItem[]> {
  const all: PlacementItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await getPlacements(signal, cursor);
    all.push(...page.placements);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages >= MAX_PAGES && cursor !== undefined) {
      // Counts only — never log placement/tenant ids or any PII.
      console.warn(`usePlacements: getPlacements hit the ${MAX_PAGES}-page cap (${all.length} placements loaded); truncating.`);
      break;
    }
  } while (cursor !== undefined);
  return all;
}

/** Best-effort fetch of ALL tenant contacts (paging through nextCursor) — never
 *  throws (except AbortError); a failure just means cards fall back to the tenant
 *  id. The Contacts API requires a `type` filter, so we ask for tenants (the only
 *  contacts a placement's tenant can be). */
async function loadContacts(signal: AbortSignal): Promise<Contact[]> {
  try {
    const all: Contact[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await getContacts({ type: 'tenant', ...(cursor !== undefined && { cursor }) }, signal);
      all.push(...page.contacts);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (pages >= MAX_PAGES && cursor !== undefined) {
        console.warn(`usePlacements: getContacts hit the ${MAX_PAGES}-page cap (${all.length} contacts loaded); truncating.`);
        break;
      }
    } while (cursor !== undefined);
    return all;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return [];
  }
}

/** Best-effort fetch of ALL units (paging through nextCursor) for card property
 *  addresses — never throws (except AbortError); a failure falls back to the unit
 *  id. */
async function loadUnits(signal: AbortSignal): Promise<UnitItem[]> {
  try {
    const all: UnitItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await getUnits({ cursor }, signal);
      all.push(...page.units);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (pages >= MAX_PAGES && cursor !== undefined) {
        console.warn(`usePlacements: getUnits hit the ${MAX_PAGES}-page cap (${all.length} units loaded); truncating.`);
        break;
      }
    } while (cursor !== undefined);
    return all;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return [];
  }
}

interface CommittedState {
  status: PlacementsStatus;
  placements: PlacementItem[];
  contacts: Map<string, Contact>;
  units: Map<string, UnitItem>;
}

const EMPTY: CommittedState = {
  status: 'loading',
  placements: [],
  contacts: new Map(),
  units: new Map(),
};

export function usePlacements(): PlacementsState {
  const [state, setState] = useState<CommittedState>(EMPTY);

  // Replace a placement by id in place (or insert if new), preserving the rest of the
  // committed state. Used by a transition success AND the SSE handler.
  const applyPlacement = useCallback((next: PlacementItem) => {
    setState((prev) => {
      const idx = prev.placements.findIndex((c) => c.placementId === next.placementId);
      const placements =
        idx === -1
          ? [...prev.placements, next]
          : prev.placements.map((c) => (c.placementId === next.placementId ? next : c));
      return { ...prev, placements };
    });
  }, []);

  // Patch only the board-relevant projection an SSE event carries onto the
  // in-memory placement (it is NOT a full PlacementItem — keep the rest of the record). A
  // placement we don't have yet is ignored (the next board load will include it).
  //
  // Field reconciliation:
  //  - attention: the EVENT carries a plain BOOLEAN, but the PlacementItem (and the
  //    card, which reads `placement.attention` for truthiness) carries a PlacementAttention
  //    OBJECT. We map true → a minimal PlacementAttention so the dot lights up, and
  //    false → undefined so it clears. We never receive the object's reason over
  //    SSE (it'd be PII-adjacent), and the next full board load refreshes detail.
  //  - tour_date / next_deadline_*: the event sends `null` to CLEAR a value. We
  //    distinguish null (clear → set the field to undefined) from a real string
  //    (set it). Skipping null (the old bug) left a cleared tour/deadline showing.
  const applyEvent = useCallback((ev: PlacementUpdatedEvent) => {
    setState((prev) => {
      const idx = prev.placements.findIndex((c) => c.placementId === ev.placementId);
      if (idx === -1) return prev;
      const attention: PlacementAttention | undefined = ev.attention
        ? { reason: 'flagged', at: ev.updated_at ?? new Date().toISOString() }
        : undefined;
      const placements = prev.placements.map((c) =>
        c.placementId === ev.placementId
          ? {
              ...c,
              stage: ev.stage as PlacementStage,
              // null → clear (undefined); string → set.
              tour_date: ev.tour_date ?? undefined,
              next_deadline_type: (ev.next_deadline_type ?? undefined) as PlacementItem['next_deadline_type'],
              next_deadline_at: ev.next_deadline_at ?? undefined,
              // boolean → PlacementAttention object | undefined (drives the card's dot).
              attention,
            }
          : c,
      );
      return { ...prev, placements };
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const [placements, contacts, units] = await Promise.all([
          loadAllPlacements(signal),
          loadContacts(signal),
          loadUnits(signal),
        ]);
        if (signal.aborted) return;
        setState({
          status: 'ready',
          placements,
          contacts: new Map(contacts.map((c) => [c.contactId, c])),
          units: new Map(units.map((u) => [u.unitId, u])),
        });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ ...EMPTY, status: 'error' });
      }
    })();

    return () => controller.abort();
  }, []);

  // Live re-positioning: a placement.updated SSE event patches the matching card's
  // stage (and tour/deadline) so it moves columns without a refetch. applyEvent
  // is a stable useCallback; useEventStream keeps the handler ref-stable itself.
  useEventStream({ onPlacementUpdated: applyEvent });

  return { ...state, applyPlacement };
}
