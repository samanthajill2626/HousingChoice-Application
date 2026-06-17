// buildTodayFromSources — the CLIENT-SIDE FALLBACK assembly for the Today action
// queue (§API Contract C7). When GET /api/today 404s (backend slice not live),
// useToday assembles the SAME TodayItem[] shape from the existing /api/cases +
// /api/conversations payloads. Pure + deterministic (takes `now` so it's
// testable): no fetching, no Date.now(), no side effects.
//
// Grouping (from the build plan §B1):
//   needs_you_now — a case with a pending business-clock deadline (any type
//     except follow_up/stuck_case, which are follow-ups) OR an `attention` flag,
//     PLUS untriaged inbounds (unknown_1to1 conversations). Ordered most-urgent
//     first (overdue/soonest deadline, then attention rows, then untriaged).
//   tours_today  — a case whose tour_date is today (local).
//   unreplied    — a conversation with unread_count > 0 (excluding the untriaged
//     unknowns, which surface in needs_you_now).
//   follow_ups   — a case whose next_deadline_type is follow_up or stuck_case.
//
// We invent NO fields the wire doesn't carry: "stuck N days" age is not
// computable from CaseItem here, so stuck cases are detected via
// next_deadline_type === 'stuck_case' only (the design's "stuck 6 days" copy is
// a server-side enrichment for the real /api/today).
import type {
  CaseDeadlineType,
  CaseItem,
  CaseStage,
  ConversationSummary,
  ConversationType,
  TodayItem,
} from '../../api/index.js';

// --- Group ordering ---------------------------------------------------------

const GROUP_ORDER: Record<TodayItem['group'], number> = {
  needs_you_now: 0,
  tours_today: 1,
  unreplied: 2,
  follow_ups: 3,
};

/** Deadline types that route to follow_ups rather than needs_you_now. */
const FOLLOW_UP_DEADLINES: ReadonlySet<CaseDeadlineType> = new Set<CaseDeadlineType>([
  'follow_up',
  'stuck_case',
]);

// --- Humanizers -------------------------------------------------------------

const STAGE_LABELS: Record<CaseStage, string> = {
  interested: 'Interested',
  porting: 'Porting',
  touring: 'Touring',
  applied: 'Applied',
  rta_submitted: 'RTA submitted',
  inspection: 'Inspection',
  rent_determined: 'Rent determined',
  lease: 'Lease',
  moved_in: 'Moved in',
  lost: 'Lost',
};

const DEADLINE_WHY: Record<CaseDeadlineType, string> = {
  tour_reminder: 'Tour reminder',
  rta_window: 'RTA window closing',
  voucher_expiration: 'Voucher expiring',
  stuck_case: 'Stuck — needs a nudge',
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
    const mins = Math.max(1, Math.round(delta / 60_000));
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

/** YYYY-MM-DD in LOCAL time for a Date (the tour_date comparison basis). */
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// --- Assembly ---------------------------------------------------------------

interface NeedsRow {
  item: TodayItem;
  /** Sort key: deadline instant (ms). Rows without a deadline sort after. */
  sortAt: number | null;
}

export function buildTodayFromSources(
  cases: CaseItem[],
  conversations: ConversationSummary[],
  now: Date,
): TodayItem[] {
  const today = localYmd(now);

  const needs: NeedsRow[] = [];
  const tours: TodayItem[] = [];
  const followUps: TodayItem[] = [];
  const unreplied: TodayItem[] = [];

  for (const c of cases) {
    const tag = `Case · ${STAGE_LABELS[c.stage]}`;
    const deadlineType = c.next_deadline_type;
    const isFollowUp = deadlineType !== undefined && FOLLOW_UP_DEADLINES.has(deadlineType);

    // follow_ups: follow-up / stuck deadlines.
    if (isFollowUp && deadlineType !== undefined) {
      followUps.push({
        group: 'follow_ups',
        refType: 'case',
        refId: c.caseId,
        who: c.tenantId,
        why: DEADLINE_WHY[deadlineType],
        tag,
      });
    }

    // needs_you_now: a non-follow-up deadline.
    if (c.next_deadline_at !== undefined && deadlineType !== undefined && !isFollowUp) {
      needs.push({
        item: {
          group: 'needs_you_now',
          refType: 'case',
          refId: c.caseId,
          who: c.tenantId,
          why: DEADLINE_WHY[deadlineType],
          urgency: humanizeUrgency(c.next_deadline_at, now),
          tag,
        },
        sortAt: new Date(c.next_deadline_at).getTime(),
      });
    } else if (c.attention) {
      // needs_you_now: an escalation flag (only when not already added via a
      // deadline — a case shows once in the group).
      needs.push({
        item: {
          group: 'needs_you_now',
          refType: 'case',
          refId: c.caseId,
          who: c.tenantId,
          why: c.attention.reason,
          tag,
          attention: true,
        },
        sortAt: null,
      });
    }

    // tours_today: a tour scheduled for today (local).
    if (c.tour_date === today) {
      tours.push({
        group: 'tours_today',
        refType: 'case',
        refId: c.caseId,
        who: c.tenantId,
        why: 'Tour today',
        tag,
      });
    }
  }

  for (const conv of conversations) {
    if (conv.type === 'unknown_1to1') {
      // Untriaged inbound — needs triage (surfaces in needs_you_now, not unreplied).
      needs.push({
        item: {
          group: 'needs_you_now',
          refType: 'conversation',
          refId: conv.conversationId,
          who: conversationWho(conv),
          why: 'New inbound — untriaged',
          tag: 'Contact · Unknown',
          attention: true,
        },
        sortAt: null,
      });
      continue;
    }
    if (conv.unread_count > 0) {
      unreplied.push({
        group: 'unreplied',
        refType: 'conversation',
        refId: conv.conversationId,
        who: conversationWho(conv),
        why: conv.preview ?? 'Unread message',
        tag: `Contact · ${CONTACT_TYPE_LABELS[conv.type]}`,
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
