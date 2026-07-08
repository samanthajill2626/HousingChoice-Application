// buildTodayFromSources — the CLIENT-SIDE FALLBACK assembly for the Today action
// queue (§API Contract C7). When GET /api/today 404s (backend slice not live),
// useToday assembles the SAME TodayItem[] shape from the existing /api/placements +
// /api/conversations payloads. Pure + deterministic (takes `now` so it's
// testable): no fetching, no Date.now(), no side effects.
//
// Grouping (from the build plan §B1):
//   needs_you_now — a placement with a pending business-clock deadline (any type
//     except follow_up, which is a follow-up) OR an `attention` flag,
//     PLUS untriaged inbounds (unknown_1to1 conversations). Ordered most-urgent
//     first (overdue/soonest deadline, then attention rows, then untriaged).
//   tours_today  — a placement whose tour_date is today (local).
//   unreplied    — a conversation with unread_count > 0 (excluding the untriaged
//     unknowns, which surface in needs_you_now).
//   follow_ups   — a placement whose next_deadline_type is follow_up.
//
// DERIVED-STUCK is DEFERRED to the server here. Stuck is no longer a
// next_deadline_type value (the backend derives it from time-in-stage against
// STAGE_STUCK_THRESHOLDS and folds a "Stuck — needs a check" row into
// follow_ups). Reproducing that would mean mirroring a fresh 16-entry threshold
// map — business-clock tuning with no importable source in this package and no
// natural drift-guard. This buildToday is a FALLBACK (used only when GET
// /api/today 404s); the real /api/today is authoritative and does the
// derivation. So the fallback omits client-derived stuck rather than carry a
// silent-drift hazard for a path that essentially never runs in production.
import {
  STAGE_LABELS,
  type PlacementDeadlineType,
  type PlacementItem,
  type ConversationSummary,
  type ConversationType,
  type Tour,
  type TodayItem,
} from '../../api/index.js';

// --- Group ordering ---------------------------------------------------------

const GROUP_ORDER: Record<TodayItem['group'], number> = {
  needs_you_now: 0,
  tours_today: 1,
  unreplied: 2,
  follow_ups: 3,
};

/** Deadline types that route to follow_ups rather than needs_you_now. */
const FOLLOW_UP_DEADLINES: ReadonlySet<PlacementDeadlineType> = new Set<PlacementDeadlineType>([
  'follow_up',
]);

// --- Humanizers -------------------------------------------------------------

const DEADLINE_WHY: Record<PlacementDeadlineType, string> = {
  rta_window: 'RTA window closing',
  voucher_expiration: 'Voucher expiring',
  follow_up: 'Follow-up due',
};

const CONTACT_TYPE_LABELS: Record<ConversationType, string> = {
  tenant_1to1: 'Tenant',
  landlord_1to1: 'Landlord',
  unknown_1to1: 'Unknown',
  relay_group: 'Group',
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** "2h left" / "3 days" / "overdue" — humanized time from `now` to a deadline. */
function humanizeUrgency(deadlineAt: string, now: Date): string {
  const delta = new Date(deadlineAt).getTime() - now.getTime();
  if (Number.isNaN(delta)) return '';
  if (delta <= 0) return 'overdue';
  if (delta < HOUR_MS) {
    // Clamp to 59 so a 59m59s delta never renders "60m left" (→ would read as 1h).
    const mins = Math.min(59, Math.max(1, Math.round(delta / 60_000)));
    return `${mins}m left`;
  }
  if (delta < DAY_MS) {
    return `${Math.round(delta / HOUR_MS)}h left`;
  }
  const days = Math.round(delta / DAY_MS);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** "(404) 010-0007" — a light NANP-ish format; non-conforming input is returned
 *  as-is so we never mangle short codes or already-formatted strings. */
function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length !== 10) return phone;
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

/** A conversation's display name, falling back to the formatted phone. */
function conversationWho(conv: ConversationSummary): string {
  return conv.participant_display_name ?? formatPhone(conv.participant_phone);
}

/** The external participant's contact id (match by phone, else the first
 *  participant). Undefined when the summary carries no participant contact id. */
function participantContactId(conv: ConversationSummary): string | undefined {
  const p = conv.participants.find((x) => x.phone === conv.participant_phone) ?? conv.participants[0];
  return p?.contactId;
}

/** A `refType:'contact'` refId for a 1:1 conversation row: the contact's id when
 *  resolvable (→ /contacts/:id, the detail page), else the Unknown list filtered
 *  by phone (→ /contacts/unknown?phone=…, mirroring the Inbox). NEVER a
 *  `refType:'conversation'` ref — /conversations/:id is an unrouted placeholder
 *  ("Not found"), which is the dead-link this fixes. */
function contactRefId(conv: ConversationSummary): string {
  return (
    participantContactId(conv) ?? `unknown?phone=${encodeURIComponent(conv.participant_phone)}`
  );
}

/** 1:1 conversation types (one external contact) — these route to the contact
 *  page. relay_group has no single contact, so it keeps a conversation ref. */
const ONE_TO_ONE: ReadonlySet<ConversationType> = new Set<ConversationType>([
  'tenant_1to1',
  'landlord_1to1',
  'unknown_1to1',
]);

/** YYYY-MM-DD in LOCAL time for a Date — the browser's definition of "today".
 *  Used BOTH as the tour_date comparison basis here AND as the `?day=` the hook
 *  sends to /api/today, so the server and this fallback agree on which day. Built
 *  from local fields (getFullYear/Month/Date), never toISOString() (that's UTC). */
export function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The browser's LOCAL-day boundaries for `now`, as ISO instants. Sent to
 *  /api/today (?toursFrom/?toursTo) and to /api/tours (?from/?to) so both the
 *  server queue and this fallback fold in exactly the tours on the operator's
 *  calendar day — Tour scheduledAt is an instant, so only the browser can say
 *  where its day starts and ends. */
export function localDayWindow(now: Date): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

// --- Assembly ---------------------------------------------------------------

interface NeedsRow {
  item: TodayItem;
  /** Sort key: deadline instant (ms). Rows without a deadline sort after. */
  sortAt: number | null;
}

/** Tour statuses that appear in tours_today (time-scheduled, active tours).
 *  scheduled ONLY - the 'confirmed' status was removed 2026-07-08 (mirrors
 *  app/src/routes/today.ts TOURS_TODAY_STATUSES). */
const TOURS_TODAY_STATUSES: ReadonlySet<string> = new Set(['scheduled']);

export function buildTodayFromSources(
  placements: PlacementItem[],
  conversations: ConversationSummary[],
  now: Date,
  tourEntities: Tour[] = [],
): TodayItem[] {
  const today = localYmd(now);

  const needs: NeedsRow[] = [];
  const tours: TodayItem[] = [];
  const followUps: TodayItem[] = [];
  const unreplied: TodayItem[] = [];

  for (const c of placements) {
    // `?? c.stage` guards an unknown stage (PlacementItem is a flexible server doc) so
    // the tag never renders "Placement - undefined".
    const tag = `Placement - ${STAGE_LABELS[c.stage] ?? c.stage}`;
    const deadlineType = c.next_deadline_type;
    const isFollowUp = deadlineType !== undefined && FOLLOW_UP_DEADLINES.has(deadlineType);

    // follow_ups: follow-up / stuck deadlines — UNLESS the placement also carries an
    // `attention` escalation, which takes precedence and routes it to
    // needs_you_now instead (a placement appears in exactly one of the two groups).
    if (isFollowUp && deadlineType !== undefined && !c.attention) {
      followUps.push({
        group: 'follow_ups',
        refType: 'placement',
        refId: c.placementId,
        // who = tenantId: a KNOWN fallback-only cosmetic gap. PlacementItem carries no
        // tenant name on the wire; the real /api/today resolves it server-side.
        who: c.tenantId,
        why: DEADLINE_WHY[deadlineType] ?? 'Deadline',
        tag,
      });
    }

    // needs_you_now: a non-follow-up deadline.
    if (c.next_deadline_at !== undefined && deadlineType !== undefined && !isFollowUp) {
      const t = new Date(c.next_deadline_at).getTime();
      needs.push({
        item: {
          group: 'needs_you_now',
          refType: 'placement',
          refId: c.placementId,
          who: c.tenantId,
          why: DEADLINE_WHY[deadlineType] ?? 'Deadline',
          urgency: humanizeUrgency(c.next_deadline_at, now),
          tag,
        },
        // Coerce a malformed deadline (NaN) to null so it sorts after valid ones.
        sortAt: Number.isNaN(t) ? null : t,
      });
    } else if (c.attention) {
      // needs_you_now: an escalation flag (only when not already added via a
      // deadline — a placement shows once in the group).
      needs.push({
        item: {
          group: 'needs_you_now',
          refType: 'placement',
          refId: c.placementId,
          who: c.tenantId,
          why: c.attention.reason,
          tag,
          attention: true,
        },
        sortAt: null,
      });
    }

    // NOTE: tours_today is now derived from Tour entities (see the loop below),
    // NOT from placement.tour_date. The tour_date branch is RETIRED.
  }

  // tours_today: Tour entities scheduled on the operator's LOCAL day. The fetch
  // window (localDayWindow) already bounds these, but re-check the local day here
  // (defense in depth — a window drift must not surface a wrong-day tour) and the
  // status set ('requested' tours have no scheduledAt and never qualify).
  for (const t of tourEntities) {
    if (t.scheduledAt === undefined || !TOURS_TODAY_STATUSES.has(t.status)) continue;
    if (localYmd(new Date(t.scheduledAt)) !== today) continue;
    tours.push({
      group: 'tours_today',
      refType: 'tour',
      refId: t.tourId,
      who: t.tenantId,
      why: 'Tour today',
      tag: 'Tour',
    });
  }

  for (const conv of conversations) {
    if (conv.type === 'unknown_1to1') {
      // Untriaged inbound — needs triage (surfaces in needs_you_now, not
      // unreplied). Links to the unknown CONTACT's page (the inbound created an
      // unknown contact record), NOT /conversations/:id (an unrouted placeholder).
      needs.push({
        item: {
          group: 'needs_you_now',
          refType: 'contact',
          refId: contactRefId(conv),
          who: conversationWho(conv),
          why: 'New inbound — untriaged',
          tag: 'Contact - Unknown',
          attention: true,
        },
        sortAt: null,
      });
      continue;
    }
    if (conv.unread_count > 0) {
      // A 1:1 thread opens its contact page; a relay group has no single contact,
      // so it keeps a conversation ref (a separate, future concern).
      const is1to1 = ONE_TO_ONE.has(conv.type);
      unreplied.push({
        group: 'unreplied',
        refType: is1to1 ? 'contact' : 'conversation',
        refId: is1to1 ? contactRefId(conv) : conv.conversationId,
        who: conversationWho(conv),
        why: conv.preview ?? 'Unread message',
        tag: `Contact - ${CONTACT_TYPE_LABELS[conv.type] ?? conv.type}`,
      });
    }
  }

  // Order within needs_you_now: most-urgent first — overdue/soonest deadline by
  // instant, then the deadline-less rows (attention flags, untriaged inbounds).
  needs.sort((a, b) => {
    if (a.sortAt === null && b.sortAt === null) return 0;
    if (a.sortAt === null) return 1;
    if (b.sortAt === null) return -1;
    return a.sortAt - b.sortAt;
  });

  const all: TodayItem[] = [
    ...needs.map((n) => n.item),
    ...tours,
    ...unreplied,
    ...followUps,
  ];
  // Stable group ordering (canonical), preserving within-group order.
  return all
    .map((item, index) => ({ item, index }))
    .sort((a, b) => GROUP_ORDER[a.item.group] - GROUP_ORDER[b.item.group] || a.index - b.index)
    .map(({ item }) => item);
}
