// useCases — the placement board's data hook. Abort-safe fetch of the cases
// board (GET /api/cases) plus the contacts + units it needs to label cards
// (tenant NAME / listing ADDRESS / porting chip). Mirrors useListings' single
// abort-safe useState/useEffect pattern (NO react-query). Exposes:
//   - applyCase(case): replace/insert a case in place after a transition returns
//     the updated CaseItem — the board re-positions it with NO refetch.
//   - an SSE `case.updated` subscription that live-repositions a card (it carries
//     the new stage; we patch the in-memory case's stage/attention/tour/deadline).
//
// Name/address resolution: contacts + units back small lookup maps so a card can
// show the tenant's name (home) and the listing's address. A contact/unit we
// don't have falls back to the id (honest — never fabricated).
import { useCallback, useEffect, useState } from 'react';
import {
  getCases,
  getContacts,
  getUnits,
  useEventStream,
  type CaseAttention,
  type CaseItem,
  type CaseUpdatedEvent,
  type Contact,
  type PlacementStage,
  type UnitItem,
} from '../../api/index.js';

/** Safety cap on cursor-following so a misbehaving server (or a cursor that never
 *  nulls out) can never spin forever. The placement pipeline is small; this is
 *  far above any realistic page count. */
const MAX_PAGES = 50;

export type CasesStatus = 'loading' | 'ready' | 'error';

export interface CasesState {
  status: CasesStatus;
  cases: CaseItem[];
  /** contactId → contact (tenant names + porting flag). */
  contacts: Map<string, Contact>;
  /** unitId → unit (listing addresses). */
  units: Map<string, UnitItem>;
  /** Replace/insert a case in place after a transition (no refetch). */
  applyCase: (next: CaseItem) => void;
}

/** Load ALL pages of the cases board by following nextCursor. A placement board
 *  must show the WHOLE pipeline, so we page until the server stops handing back a
 *  cursor (capped by MAX_PAGES so a never-null cursor can't loop unbounded — a
 *  hit is logged with counts only, never PII). Re-throws AbortError so the
 *  effect's catch can bail cleanly. */
async function loadAllCases(signal: AbortSignal): Promise<CaseItem[]> {
  const all: CaseItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await getCases(signal, cursor);
    all.push(...page.cases);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages >= MAX_PAGES && cursor !== undefined) {
      // Counts only — never log case/tenant ids or any PII.
      console.warn(`useCases: getCases hit the ${MAX_PAGES}-page cap (${all.length} cases loaded); truncating.`);
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
        console.warn(`useCases: getContacts hit the ${MAX_PAGES}-page cap (${all.length} contacts loaded); truncating.`);
        break;
      }
    } while (cursor !== undefined);
    return all;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return [];
  }
}

/** Best-effort fetch of ALL units (paging through nextCursor) for card listing
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
        console.warn(`useCases: getUnits hit the ${MAX_PAGES}-page cap (${all.length} units loaded); truncating.`);
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
  status: CasesStatus;
  cases: CaseItem[];
  contacts: Map<string, Contact>;
  units: Map<string, UnitItem>;
}

const EMPTY: CommittedState = {
  status: 'loading',
  cases: [],
  contacts: new Map(),
  units: new Map(),
};

export function useCases(): CasesState {
  const [state, setState] = useState<CommittedState>(EMPTY);

  // Replace a case by id in place (or insert if new), preserving the rest of the
  // committed state. Used by a transition success AND the SSE handler.
  const applyCase = useCallback((next: CaseItem) => {
    setState((prev) => {
      const idx = prev.cases.findIndex((c) => c.caseId === next.caseId);
      const cases =
        idx === -1
          ? [...prev.cases, next]
          : prev.cases.map((c) => (c.caseId === next.caseId ? next : c));
      return { ...prev, cases };
    });
  }, []);

  // Patch only the board-relevant projection an SSE event carries onto the
  // in-memory case (it is NOT a full CaseItem — keep the rest of the record). A
  // case we don't have yet is ignored (the next board load will include it).
  //
  // Field reconciliation:
  //  - attention: the EVENT carries a plain BOOLEAN, but the CaseItem (and the
  //    card, which reads `case_.attention` for truthiness) carries a CaseAttention
  //    OBJECT. We map true → a minimal CaseAttention so the dot lights up, and
  //    false → undefined so it clears. We never receive the object's reason over
  //    SSE (it'd be PII-adjacent), and the next full board load refreshes detail.
  //  - tour_date / next_deadline_*: the event sends `null` to CLEAR a value. We
  //    distinguish null (clear → set the field to undefined) from a real string
  //    (set it). Skipping null (the old bug) left a cleared tour/deadline showing.
  const applyEvent = useCallback((ev: CaseUpdatedEvent) => {
    setState((prev) => {
      const idx = prev.cases.findIndex((c) => c.caseId === ev.caseId);
      if (idx === -1) return prev;
      const attention: CaseAttention | undefined = ev.attention
        ? { reason: 'flagged', at: ev.updated_at ?? new Date().toISOString() }
        : undefined;
      const cases = prev.cases.map((c) =>
        c.caseId === ev.caseId
          ? {
              ...c,
              stage: ev.stage as PlacementStage,
              // null → clear (undefined); string → set.
              tour_date: ev.tour_date ?? undefined,
              next_deadline_type: (ev.next_deadline_type ?? undefined) as CaseItem['next_deadline_type'],
              next_deadline_at: ev.next_deadline_at ?? undefined,
              // boolean → CaseAttention object | undefined (drives the card's dot).
              attention,
            }
          : c,
      );
      return { ...prev, cases };
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const [cases, contacts, units] = await Promise.all([
          loadAllCases(signal),
          loadContacts(signal),
          loadUnits(signal),
        ]);
        if (signal.aborted) return;
        setState({
          status: 'ready',
          cases,
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

  // Live re-positioning: a case.updated SSE event patches the matching card's
  // stage (and tour/deadline) so it moves columns without a refetch. applyEvent
  // is a stable useCallback; useEventStream keeps the handler ref-stable itself.
  useEventStream({ onCaseUpdated: applyEvent });

  return { ...state, applyCase };
}
