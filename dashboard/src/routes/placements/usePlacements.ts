// usePlacements - the placement board's data hook. Abort-safe fetch of the placements
// board (GET /api/placements) plus the contacts + units it needs to label cards
// (tenant NAME / property ADDRESS / porting chip). Mirrors useListings' single
// abort-safe useState/useEffect pattern (NO react-query). Exposes:
// - applyPlacement(placement): replace/insert a placement in place after a transition returns
//     the updated PlacementItem - the board re-positions it with NO refetch.
// - an SSE `placement.updated` subscription that live-repositions a card (it carries
//     the new stage; we patch the in-memory placement's stage/attention/tour/deadline).
//
// Name/address resolution: contacts + units back small lookup maps so a card can
// show the tenant's name (home) and the property's address - INCLUDING soft-deleted
// records: a closed placement routinely outlives its contact/unit (tenant moved in,
// property removed from inventory), and a live-only map rendered raw ids for those
// rows (same bug/fix as the tours list, 2026-08-03). A contact/unit we don't have
// falls back to the id (honest - never fabricated).
import { useCallback, useEffect, useState } from 'react';
import {
  getAllContacts,
  getAllPlacements,
  getAllUnits,
  useEventStream,
  type PlacementAttention,
  type PlacementItem,
  type PlacementUpdatedEvent,
  type Contact,
  type PlacementStage,
  type UnitItem,
} from '../../api/index.js';

export type PlacementsStatus = 'loading' | 'ready' | 'error';

export interface PlacementsState {
  status: PlacementsStatus;
  placements: PlacementItem[];
  /** contactId -> contact (tenant names + porting flag). */
  contacts: Map<string, Contact>;
  /** unitId -> unit (property addresses). */
  units: Map<string, UnitItem>;
  /** Replace/insert a placement in place after a transition (no refetch). */
  applyPlacement: (next: PlacementItem) => void;
}

/** Load the WHOLE placement pipeline. A board that shows a prefix is worse than
 *  one that shows nothing - it looks complete. Re-throws AbortError so the
 *  effect's catch can bail cleanly. */
async function loadAllPlacements(signal: AbortSignal): Promise<PlacementItem[]> {
  const { items } = await getAllPlacements(signal);
  return items;
}

/** Best-effort whole-list read of one tenant-contacts view (live or soft-deleted)
 *  -  never throws (except AbortError); a failure just means cards fall back to
 *  the tenant id for that view. The Contacts API requires a `type` filter, so we
 *  ask for tenants (the only contacts a placement's tenant can be). */
async function loadContactPages(deleted: boolean, signal: AbortSignal): Promise<Contact[]> {
  try {
    const { items } = await getAllContacts({ type: 'tenant', deleted }, signal);
    return items;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return [];
  }
}

/** All tenant contacts a placement can reference: soft-deleted THEN live, so the
 *  Map construction (last write wins) resolves a defensive id collision to the
 *  live record. Each view is independently best-effort. */
async function loadContacts(signal: AbortSignal): Promise<Contact[]> {
  const [deleted, live] = await Promise.all([
    loadContactPages(true, signal),
    loadContactPages(false, signal),
  ]);
  return [...deleted, ...live];
}

/** Best-effort whole-list read of one units view (live or soft-deleted) for card
 *  property addresses - never throws (except AbortError); a failure falls back
 *  to the unit id for that view. */
async function loadUnitPages(deleted: boolean, signal: AbortSignal): Promise<UnitItem[]> {
  try {
    const { items } = await getAllUnits({ deleted }, signal);
    return items;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return [];
  }
}

/** All units a placement can reference: soft-deleted THEN live (live wins a
 *  defensive id collision in the Map). Each view is independently best-effort. */
async function loadUnits(signal: AbortSignal): Promise<UnitItem[]> {
  const [deleted, live] = await Promise.all([
    loadUnitPages(true, signal),
    loadUnitPages(false, signal),
  ]);
  return [...deleted, ...live];
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
  // in-memory placement (it is NOT a full PlacementItem - keep the rest of the record). A
  // placement we don't have yet is ignored (the next board load will include it).
  //
  // Field reconciliation:
  // - attention: the EVENT carries a plain BOOLEAN, but the PlacementItem (and the
  //    card, which reads `placement.attention` for truthiness) carries a PlacementAttention
  //    OBJECT. We map true -> a minimal PlacementAttention so the dot lights up, and
  //    false -> undefined so it clears. We never receive the object's reason over
  //    SSE (it'd be PII-adjacent), and the next full board load refreshes detail.
  // - tour_date / next_deadline_*: the event sends `null` to CLEAR a value. We
  //    distinguish null (clear -> set the field to undefined) from a real string
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
              // null -> clear (undefined); string -> set.
              tour_date: ev.tour_date ?? undefined,
              next_deadline_type: (ev.next_deadline_type ?? undefined) as PlacementItem['next_deadline_type'],
              next_deadline_at: ev.next_deadline_at ?? undefined,
              // boolean -> PlacementAttention object | undefined (drives the card's dot).
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
