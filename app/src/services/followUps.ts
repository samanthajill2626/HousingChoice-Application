// Follow-ups (last-heard-from spec 5.6 + 14.4): the waiting list behind
// Matching's "Follow up" tab and the Properties list "<n> waiting" pill.
//
// Candidate sends = every LISTED listing_sends row on every unit in status
// `available` (byStatus pages walked until 100 KEPT units or exhaustion - the
// GSI is hash-only and the soft-delete filter shortens pages, so the walk
// follows lastEvaluatedKey). Joins (all REQUIRED, D12 - any failure rejects and
// the route answers 503): listByUnit + tours.listByUnit per unit, then ONE
// requireComplete contacts batch through the RECIPIENT projection
// (getRecipientDisplaysByIds - review ADV-2: it carries every attribute read
// here, a fraction of a whole contact item). A row is kept when its outcome is
// no_reply or replied, the recipient is eligible (isEligibleRecipient - so every
// row's Text action can work), the send is inside LOOKBACK and the recipient has
// been quiet past QUIET (isWaiting). Order: longest-waiting first (oldest waitingSince), so
// a client grouping by property in first-appearance order gets groups ordered by
// their oldest row. Logs carry ids/counts only - never names or phones.
import { formatAddress } from '../lib/address.js';
import { contactDisplayName } from '../lib/contactName.js';
import type { Logger } from '../lib/logger.js';
import { deriveTourActivityAt, deriveTourSignal } from '../lib/listingSendTour.js';
import {
  deriveListingSendOutcome,
  interestedModeFor,
  isEligibleRecipient,
  isWaiting,
  waitingSince,
  type InterestedMode,
  type ListingSendOutcome,
} from '../lib/listingSendOutcome.js';
import type { ContactsRepo, RecipientDisplay } from '../repos/contactsRepo.js';
import type { ListingSendItem, ListingSendsRepo } from '../repos/listingSendsRepo.js';
import type { TourItem, ToursRepo } from '../repos/toursRepo.js';
import { isDeleted, type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';

/** Available properties read per request (spec 5.6: tens in practice). */
export const FOLLOW_UPS_UNIT_CAP = 100;
const UNIT_PAGE_LIMIT = 100;
/** Per-unit reads in flight at once (two Queries per unit). */
const PER_UNIT_CONCURRENCY = 10;

/** One waiting row (spec 5.6 as amended; mirrored in dashboard/src/api/types.ts). */
export interface FollowUpItem {
  unitId: string;
  /** formatAddress(unit.address) || unitId - the dashboard's shortAddress rule. */
  unitLabel: string;
  contactId: string;
  name: string;
  type: string;
  role?: string;
  sentAt: string;
  lastHeardFromAt?: string;
  outcome: ListingSendOutcome;
  /** Spec 5.6 lists it; never set here - a waiting row has no effective decline
   *  (plan 3.4 #7). An in-session decline lives in the dashboard's local state. */
  declined?: { at: string; by: 'staff' | 'engine' };
  interestedSupported: boolean;
  interestedMode: InterestedMode;
  /** max(sentAt, lastHeardFromAt) - the dashboard's N days counts from here. */
  waitingSince: string;
}

export interface FollowUpsResponse {
  items: FollowUpItem[];
  /** Waiting rows per unitId - the Properties list pill. */
  byUnit: Record<string, number>;
  /** True when more than FOLLOW_UPS_UNIT_CAP available properties exist. */
  truncated: boolean;
}

export interface FollowUpsDeps {
  units: Pick<UnitsRepo, 'listByStatus'>;
  listingSends: Pick<ListingSendsRepo, 'listByUnit'>;
  tours: Pick<ToursRepo, 'listByUnit'>;
  contacts: Pick<ContactsRepo, 'getRecipientDisplaysByIds'>;
  log: Logger;
  /** Epoch ms - the thresholds' clock. */
  now: number;
}

/** The row's name: the app's shared display-name rule (lib/contactName.ts
 *  contactDisplayName - first + last, part-wise trimmed; undefined when no
 *  name is known), then the phone, then the id - FollowUpItem.name is required. */
function nameOf(contact: RecipientDisplay): string {
  const display = contactDisplayName(contact);
  if (display !== undefined) return display;
  return typeof contact.phone === 'string' && contact.phone.length > 0 ? contact.phone : contact.contactId;
}

function groupByTenant(tours: TourItem[]): Map<string, TourItem[]> {
  const out = new Map<string, TourItem[]>();
  for (const t of tours) {
    const arr = out.get(t.tenantId);
    if (arr === undefined) out.set(t.tenantId, [t]);
    else arr.push(t);
  }
  return out;
}

export async function buildFollowUps(deps: FollowUpsDeps): Promise<FollowUpsResponse> {
  // 1. The available properties: KEPT (non-deleted) units, capped. The walk
  //    reads past the cap only far enough to learn whether a 101st exists.
  const kept: UnitItem[] = [];
  let truncated = false;
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await deps.units.listByStatus('available', {
      limit: UNIT_PAGE_LIMIT,
      ...(cursor !== undefined && { exclusiveStartKey: cursor }),
    });
    for (const unit of page.items) {
      if (isDeleted(unit)) continue;
      if (kept.length === FOLLOW_UPS_UNIT_CAP) {
        truncated = true;
        break;
      }
      kept.push(unit);
    }
    cursor = page.lastEvaluatedKey;
  } while (cursor !== undefined && !truncated);
  if (truncated) {
    deps.log.warn({ cap: FOLLOW_UPS_UNIT_CAP }, 'follow-ups: available-property walk hit the cap - list truncated');
  }

  // 2. Per-unit reads (each unit once per request), bounded fan-out. A unit
  //    with no listed sends costs no tours read.
  const perUnit: Array<{ unit: UnitItem; rows: ListingSendItem[]; toursByTenant: Map<string, TourItem[]> }> = [];
  for (let i = 0; i < kept.length; i += PER_UNIT_CONCURRENCY) {
    const loaded = await Promise.all(
      kept.slice(i, i + PER_UNIT_CONCURRENCY).map(async (unit) => {
        const rows = await deps.listingSends.listByUnit(unit.unitId);
        const unitTours = rows.length > 0 ? await deps.tours.listByUnit(unit.unitId) : [];
        return { unit, rows, toursByTenant: groupByTenant(unitTours) };
      }),
    );
    perUnit.push(...loaded);
  }

  // 3. ONE contacts batch; requireComplete because an absent contact would
  //    silently drop a row (an OUTCOME, not a label). The recipient
  //    projection, not whole items (review ADV-2).
  const ids = [...new Set(perUnit.flatMap((u) => u.rows.map((r) => r.contactId)))];
  const byId = ids.length > 0 ? await deps.contacts.getRecipientDisplaysByIds(ids, { requireComplete: true }) : new Map<string, RecipientDisplay>();

  // 4. Keep the waiting rows.
  const items: FollowUpItem[] = [];
  for (const { unit, rows, toursByTenant } of perUnit) {
    for (const row of rows) {
      if (typeof row.sentAt !== 'string') continue; // listByUnit returns LISTED rows only; a type guard
      const contact = byId.get(row.contactId);
      if (contact === undefined) continue; // the contact row is gone: nobody to text
      // Every contact item carries its required `type`; the projection only
      // TYPES it optional. A row without one could not be labeled - skipped.
      if (contact.type === undefined) continue;
      const lastHeardFromAt = typeof contact.last_heard_from_at === 'string' ? contact.last_heard_from_at : undefined;
      const pairTours = toursByTenant.get(row.contactId) ?? [];
      const outcome = deriveListingSendOutcome({
        row,
        recipientType: contact.type,
        lastHeardFromAt,
        tour: deriveTourSignal(pairTours),
        tourActivityAt: deriveTourActivityAt(pairTours),
      });
      const eligible = isEligibleRecipient(contact);
      if (!isWaiting({ outcome, eligible, sentAt: row.sentAt, ...(lastHeardFromAt !== undefined && { lastHeardFromAt }), now: deps.now })) continue;
      const role = typeof contact.role === 'string' && contact.role.trim().length > 0 ? contact.role.trim() : undefined;
      items.push({
        unitId: unit.unitId,
        unitLabel: formatAddress(unit.address) || unit.unitId,
        contactId: row.contactId,
        name: nameOf(contact),
        type: contact.type,
        ...(role !== undefined && { role }),
        sentAt: row.sentAt,
        ...(lastHeardFromAt !== undefined && { lastHeardFromAt }),
        outcome,
        interestedSupported: contact.type === 'tenant',
        interestedMode: interestedModeFor(unit),
        waitingSince: waitingSince(row.sentAt, lastHeardFromAt),
      });
    }
  }

  // 5. Longest-waiting first; stable ties by unit then contact.
  items.sort(
    (a, b) =>
      Date.parse(a.waitingSince) - Date.parse(b.waitingSince) ||
      a.unitId.localeCompare(b.unitId) ||
      a.contactId.localeCompare(b.contactId),
  );
  const byUnit: Record<string, number> = {};
  for (const item of items) byUnit[item.unitId] = (byUnit[item.unitId] ?? 0) + 1;
  return { items, byUnit, truncated };
}
