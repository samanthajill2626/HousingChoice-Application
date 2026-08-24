// BE6/C7 — Today action-queue endpoint. A READ-ONLY aggregation over the
// placements, conversations, and contacts repos (no new table) that assembles the
// navigator's prioritized "what needs me now" queue. Mounted at /api/today
// (behind requireAuth via the /api mount in app.ts).
//
// The frontend (B1) imports the C7 wire shapes AND ships a client-side FALLBACK
// that assembles the SAME shape from /api/placements + /api/conversations — so the
// grouping/ordering rules here MUST match the spec the fallback follows
// (documentation: docs/superpowers/specs/2026-06-16-new-dashboard-design.md →
// "Today action queue", and the contract in
// docs/superpowers/plans/2026-06-16-new-dashboard-build.md → C7).
//
// "Today" date basis (tours_today only): the BACKEND IS TIMEZONE-AGNOSTIC. The
// only calendar-day input is which day's tours to fold in; every other group is
// "as of now" (deadline instants are absolute ISO, unread is current state). The
// CALLER decides the day. tours_today is derived from TOUR ENTITIES (toursRepo,
// scheduledAt instants) — the legacy placement.tour_date branch is RETIRED (the
// field + its tour_scheduled milestone live on; only this derivation moved).
// Because scheduledAt is an instant, the caller also owns the day's BOUNDARIES:
// pass ?toursFrom=&toursTo= (ISO instants for the browser's local day window) and
// the tours group folds in scheduled tours inside that window. When the
// window is absent we fall back to the UTC window of ?day=YYYY-MM-DD (or of the
// UTC date when ?day= is also absent) — evening tours near the UTC boundary may
// bucket a day off under the fallback; the dashboard always sends the window.
// Malformed ?day=/?toursFrom=/?toursTo= are 400s. This keeps the server and the
// client-side fallback agreeing by construction (both derive "today" from the
// operator's browser). A richer date-navigable queue is a separate, frontend-
// driven contract question (not built here).
//
// Every repo read is a bounded GSI Query (never a Scan): placementDeadlines
// listDue (one byDueAt query for ALL due deadlines), placements listByStage (per
// non-terminal stage — attention + derived-stuck), tours listByScheduledRange,
// listRelayOptOutAttention over the sparse byRelayOptOut index (the relay
// opt-out attention items - 2026-08-18, it used to walk the open partition),
// queryUnreadPage over the sparse byUnread index (the unread sections -
// inbox-unread-index), listByType (the unknown/needs_review triage partition),
// and listRelayGroups('open') (byRelayStatus - the D5 relay close-nags). Each
// fetch is capped and a log.warn fires if a cap is hit (no silent truncation).
//
// PII (doc §9): responses carry who/why to the authed client; LOG LINES are
// counts/IDs only.
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createPlacementsRepo,
  type PlacementDeadlineType,
  type PlacementItem,
  type PlacementsRepo,
  TERMINAL_STAGES,
} from '../repos/placementsRepo.js';
import {
  createPlacementDeadlinesRepo,
  type PlacementDeadlinesRepo,
} from '../repos/placementDeadlinesRepo.js';
import {
  PLACEMENT_STAGES,
  STAGE_LABELS,
  STAGE_STUCK_THRESHOLDS,
  type PlacementStage,
} from '../lib/statusModel.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createContactsRepo,
  isDeleted,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createToursRepo,
  type ToursRepo,
} from '../repos/toursRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../repos/extractionRepo.js';
import { GROUP_DETECTION_ORIGIN } from '../services/groupMembers.js';
import { isMemberSuppressed } from '../services/relayAnnouncements.js';
import {
  isOneToOneBucket,
  iterateUnreadConversations,
  UNREAD_WALK_LIMIT,
  type UnreadWalkState,
} from '../lib/unreadFeed.js';
import { formatPhoneForDisplay } from '../lib/phone.js';
import { createRateLimitedWarn } from '../lib/rateLimitedWarn.js';

// --- C7 wire contract (VERBATIM — the frontend imports the same shapes) ------

export type TodayGroup =
  | 'needs_you_now'
  | 'tours_today'
  | 'unreplied'
  | 'follow_ups'
  | 'ai_suggestions';

export interface TodayItem {
  group: TodayGroup;
  refType: 'placement' | 'contact' | 'conversation' | 'tour';
  refId: string;
  who: string;
  why: string;
  urgency?: string;
  tag?: string;
  attention?: boolean;
}

/**
 * A relay group left open past a terminal event whose recurring 28-day close-nag
 * is DUE (D5). Surfaced as its own top-level list (not a TodayItem - it drives a
 * dedicated Close / Keep-open card, not the four grouped queues). poolNumber +
 * member names/phones are display DATA for the card (same precedent as the relay
 * opt-out attention item); LOG LINES stay counts/IDs only.
 */
export interface RelayCloseNagItem {
  conversationId: string;
  poolNumber: string;
  tag?: string;
  /** Member display labels: name when known, else the phone (display DATA). */
  memberNames: string[];
  ownerType: 'tour' | 'placement' | null;
  ownerId?: string;
  nagDueAt: string;
}

export interface TodayResponse {
  items: TodayItem[];
  relayCloseNags: RelayCloseNagItem[];
  generatedAt: string;
}

export interface TodayRouterDeps {
  logger?: Logger;
  placementsRepo?: PlacementsRepo;
  /** First-class placement deadlines (placement-deadline-model). */
  placementDeadlinesRepo?: PlacementDeadlinesRepo;
  conversationsRepo?: ConversationsRepo;
  contactsRepo?: ContactsRepo;
  toursRepo?: ToursRepo;
  /** Pending AI suggestions (conversation-fact-extraction) -> the ai_suggestions group. */
  extractionRepo?: ExtractionRepo;
  /**
   * Test seam: the raw byUnread items ONE request may scan before the unread
   * pass reports a floor (inbox-unread-index). Production leaves it undefined
   * and takes UNREAD_WALK_LIMIT; a route test sets it small so the
   * budget-expired posture is reachable without seeding thousands of rows.
   * Forwarded from the SINGLE ApiRouterDeps.unreadWalkLimit seam - not a
   * second one.
   */
  unreadWalkLimit?: number;
}

// --- Grouping rules (match the spec + the frontend fallback) -----------------

/**
 * The "hard clock" deadline types whose due/overdue instant lands a placement in
 * needs_you_now (the spec's business-clock examples). The remaining live type
 * (follow_up) plus the DERIVED stuck signal are the follow_ups group.
 */
const HARD_CLOCK_DEADLINE_TYPES: ReadonlySet<PlacementDeadlineType> = new Set([
  'rta_window',
  'voucher_expiration',
]);

/** The contact triage statuses that make an untriaged inbound (needs_you_now). */
const UNTRIAGED_CONTACT_STATUSES: ReadonlySet<string> = new Set(['needs_review']);

/**
 * Per-group fetch caps. The Today queue is a human's worklist, not a report —
 * a few dozen items per group is plenty; beyond the cap we log.warn (no silent
 * truncation) so an operator drowning in work is visible in the logs.
 */
const GROUP_FETCH_LIMIT = 100;

/**
 * How many 1:1-bucket unread conversations the byUnread pass KEEPS
 * (inbox-unread-index spec 4.6). Same numeric bound Today always had, applied
 * AFTER the 1:1 filter rather than before it - so a burst of unread group/relay
 * threads can no longer starve the unreplied and untriaged-inbound sections.
 */
const TODAY_UNREAD_CAP = 100;

/**
 * Minimum gap between "the unread walk ran out of budget" WARNs. The signal is
 * the RATE (is index accrual outrunning the walk at all), not each occurrence -
 * every /api/today poll from every open dashboard would otherwise re-emit it.
 */
const TODAY_UNREAD_WARN_INTERVAL_MS = 5 * 60_000;

/**
 * How many pages the untriaged-contacts read will walk past excluded rows (fix
 * wave 2, adversarial 6). Bounded so a partition made entirely of group stubs
 * costs a fixed handful of Queries rather than an unbounded walk, and generous
 * enough to clear the ~600 stubs a full cutover import can mint.
 */
const TRIAGE_MAX_PAGES = 10;

/** A human-friendly per-deadline-type label used in `why`. */
const DEADLINE_WHY: Record<PlacementDeadlineType, string> = {
  rta_window: 'RTA window closing',
  voucher_expiration: 'Voucher expiring',
  follow_up: 'Follow-up due',
};

/** The `why` copy for a DERIVED (time-in-stage) stuck placement. */
const STUCK_WHY = 'Stuck — needs a check';

/**
 * The human label for a stage — the centralized STAGE_LABELS map (single source
 * of display copy). Falls back to a title-cased key for any non-stage value.
 */
function stageLabel(stage: string): string {
  const label = (STAGE_LABELS as Record<string, string>)[stage];
  if (label !== undefined) return label;
  return stage
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Resolved "First Last" from a contact, or undefined (never a guess). */
function nameFromContact(contact: ContactItem | undefined): string | undefined {
  if (!contact) return undefined;
  const first = typeof contact.firstName === 'string' ? contact.firstName : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName : '';
  const joined = `${first} ${last}`.trim();
  return joined.length > 0 ? joined : undefined;
}

/**
 * Relative-urgency string from a deadline instant vs now. "overdue" at/after the
 * instant; otherwise the coarsest sensible "Nh left" / "Nm left" / "Nd left".
 * Deterministic (a fixed `now`), so the ordering it feeds is testable.
 */
export function urgencyOf(deadlineAt: string, now: number): string {
  const at = Date.parse(deadlineAt);
  if (Number.isNaN(at)) return 'due';
  const ms = at - now;
  if (ms <= 0) return 'overdue';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return `${hours}h left`;
  const days = Math.ceil(ms / 86_400_000);
  return `${days}d left`;
}

/**
 * A placement's sort priority within needs_you_now: attention/overdue (the most
 * urgent) sort before soon-due. We key by the deadline instant (epoch ms) when
 * present, with attention-without-a-deadline treated as "now" (overdue-ish), so
 * the most-urgent surfaces first; ties break by refId for a stable total order.
 */
interface Ranked {
  item: TodayItem;
  /** Sort key: smaller = more urgent (epoch ms of the deadline, or now for attention-only). */
  at: number;
}

/**
 * Validate the optional ?day= param as a strict YYYY-MM-DD calendar date (the
 * browser's LOCAL date for the tours_today grouping). Returns `undefined` when
 * absent (caller falls back to the UTC date), `{ day }` when valid, or
 * `{ error }` for a malformed value (→ 400). Round-trips through UTC midnight so
 * impossible dates (2026-13-40) are rejected, not silently normalized.
 */
function parseDayParam(raw: unknown): { day: string } | { error: string } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { error: 'day must be a YYYY-MM-DD date' };
  }
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    return { error: 'day must be a valid YYYY-MM-DD date' };
  }
  return { day: raw };
}

/**
 * Validate the optional ?toursFrom=/?toursTo= pair (ISO instants — the browser's
 * LOCAL-day window for tours_today). Both-or-neither; each must be a valid ISO
 * datetime; from must precede to. Returns `undefined` when absent (caller falls
 * back to the UTC window of the day), `{ from, to }` when valid, or `{ error }`
 * for a malformed pair (→ 400).
 */
function parseToursWindow(
  rawFrom: unknown,
  rawTo: unknown,
): { from: string; to: string } | { error: string } | undefined {
  if (rawFrom === undefined && rawTo === undefined) return undefined;
  if (typeof rawFrom !== 'string' || typeof rawTo !== 'string') {
    return { error: 'toursFrom and toursTo must be provided together as ISO datetimes' };
  }
  const from = new Date(rawFrom);
  const to = new Date(rawTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: 'toursFrom/toursTo must be valid ISO datetimes' };
  }
  if (from.getTime() >= to.getTime()) {
    return { error: 'toursFrom must be before toursTo' };
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export function createTodayRouter(deps: TodayRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const placementDeadlines =
    deps.placementDeadlinesRepo ?? createPlacementDeadlinesRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
  /** Raw byUnread rows ONE /api/today request may scan (spec 4.3's budget). */
  const unreadWalkBudget = deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT;
  /**
   * ROUTER-FACTORY scoped, matching this repo's only other createRateLimitedWarn
   * call sites (routes/webhooks/twilio.ts): one router per process in
   * production, so one throttle window - and one per harness in tests, so a
   * suite's second budget case is not swallowed by its first one's window.
   */
  const warnUnreadWalkTruncated = createRateLimitedWarn({
    logger: log,
    intervalMs: TODAY_UNREAD_WARN_INTERVAL_MS,
  });

  const router = Router();

  // GET /api/today?day=YYYY-MM-DD → TodayResponse
  router.get('/', async (req, res) => {
    const nowIso = new Date().toISOString();
    const now = Date.parse(nowIso);
    // tours_today scopes to the caller's day (browser's LOCAL date) when given —
    // the backend stays timezone-agnostic — else the UTC date as a fallback.
    const parsedDay = parseDayParam(req.query['day']);
    if (parsedDay !== undefined && 'error' in parsedDay) {
      res.status(400).json({ error: parsedDay.error });
      return;
    }
    const todayYmd = parsedDay?.day ?? nowIso.slice(0, 10);
    // tours_today window: the caller's local-day boundaries as instants (the
    // browser knows its offset; the server stays timezone-agnostic). Fallback:
    // the UTC window of todayYmd (see the header note on the boundary caveat).
    const parsedWindow = parseToursWindow(req.query['toursFrom'], req.query['toursTo']);
    if (parsedWindow !== undefined && 'error' in parsedWindow) {
      res.status(400).json({ error: parsedWindow.error });
      return;
    }
    const toursWindow =
      parsedWindow ?? { from: `${todayYmd}T00:00:00.000Z`, to: `${todayYmd}T23:59:59.999Z` };

    // A best-effort contact cache so we resolve each contact at most once (the
    // same tenant may anchor several placements). A missing contact must never 500 the
    // endpoint - fall back to the contactId for `who`. Drives BOTH display-label
    // hydration and the soft-delete check (one getById per contact).
    const contactCache = new Map<string, ContactItem | undefined>();
    const getContact = async (contactId: string): Promise<ContactItem | undefined> => {
      if (contactCache.has(contactId)) return contactCache.get(contactId);
      let contact: ContactItem | undefined;
      try {
        contact = await contacts.getById(contactId);
      } catch (err) {
        // Best-effort hydration: a lookup failure degrades gracefully, never a 500.
        log.warn({ err, contactId }, 'today: contact hydration failed (best-effort)');
        contact = undefined;
      }
      contactCache.set(contactId, contact);
      return contact;
    };
    const resolveContactLabel = async (contactId: string): Promise<string | undefined> => {
      const contact = await getContact(contactId);
      return nameFromContact(contact) ?? formatPhoneForDisplay(contact?.phone);
    };
    // Soft-deleted contacts are off the boards: an item anchored to a deleted
    // contact (its own row, or a placement whose tenant was deleted) is skipped. A
    // lookup failure is NOT treated as deleted (best-effort → keep the item).
    const isDeletedContact = async (contactId: string): Promise<boolean> => {
      const contact = await getContact(contactId);
      return contact ? isDeleted(contact) : false;
    };

    // A bounded placement cache: a due deadline joins to its placement to read
    // stage/tenant (the placementDeadlines item deliberately does NOT denormalize
    // them, so a stage change never rewrites deadline rows). Cache so each
    // placement is point-read at most once. A lookup failure degrades to skip
    // (never a 500).
    const placementCache = new Map<string, PlacementItem | undefined>();
    const getPlacement = async (placementId: string): Promise<PlacementItem | undefined> => {
      if (placementCache.has(placementId)) return placementCache.get(placementId);
      let placement: PlacementItem | undefined;
      try {
        placement = await placements.getById(placementId);
      } catch (err) {
        log.warn({ err, placementId }, 'today: placement hydration failed (best-effort)');
        placement = undefined;
      }
      placementCache.set(placementId, placement);
      return placement;
    };

    /**
     * Warn (never silently truncate) when a group's bounded fetch hit its cap.
     *
     * The threshold is a PARAMETER rather than a hardcoded GROUP_FETCH_LIMIT:
     * not every bounded read on this route is bounded by that constant any more
     * (the byUnread pass carries its own TODAY_UNREAD_CAP), and a hardcoded
     * threshold would both mis-compare and mis-report the logged count. Every
     * pre-existing call site passes GROUP_FETCH_LIMIT, so their behavior is
     * unchanged.
     */
    const warnIfCapped = (group: string, count: number, threshold: number): void => {
      if (count >= threshold) {
        log.warn({ group, count: threshold }, 'today: group fetch hit the cap - results truncated');
      }
    };

    // De-dupe is PER-GROUP now (placement-deadline-model): a placement MAY appear
    // in BOTH needs_you_now (a due hard clock) AND follow_ups (derived stuck) —
    // the two are independent signals and must not suppress each other. Within a
    // group a placement appears once.
    const needsYouNowIds = new Set<string>();
    const followUpsIds = new Set<string>();

    const needsYouNow: Ranked[] = [];
    const toursToday: Ranked[] = [];
    const unreplied: Ranked[] = [];
    const followUps: Ranked[] = [];
    const aiSuggestions: Ranked[] = [];

    // --- due deadlines: ONE byDueAt Query, bucket by type --------------------
    // listDue returns every deadline due AT/BEFORE now across all placements in
    // ONE query, soonest-first. Join each to its placement (skip TERMINAL_STAGES
    // — the read-time guard that also neutralizes any straggler row — and deleted
    // tenants), then bucket: rta_window/voucher_expiration → needs_you_now;
    // follow_up → follow_ups. Soonest-first ⇒ the first row per (placement,group)
    // is the most urgent, so per-group dedup keeps the right one.
    const dueDeadlines = await placementDeadlines.listDue(nowIso, { limit: GROUP_FETCH_LIMIT });
    warnIfCapped('deadlines', dueDeadlines.length, GROUP_FETCH_LIMIT);
    for (const d of dueDeadlines) {
      const placement = await getPlacement(d.placementId);
      if (!placement) continue; // orphan deadline (placement gone) → skip
      if (TERMINAL_STAGES.has(placement.stage)) continue; // closed deal → off the boards
      const isHardClock = HARD_CLOCK_DEADLINE_TYPES.has(d.type);
      const groupIds = isHardClock ? needsYouNowIds : followUpsIds;
      if (groupIds.has(d.placementId)) continue; // per-group dedup (soonest already won)
      if (await isDeletedContact(placement.tenantId)) continue; // deleted tenant → off the boards
      groupIds.add(d.placementId);
      const who = (await resolveContactLabel(placement.tenantId)) ?? placement.tenantId;
      const at = Date.parse(d.at);
      const item: TodayItem = {
        group: isHardClock ? 'needs_you_now' : 'follow_ups',
        refType: 'placement',
        refId: d.placementId,
        who,
        why: DEADLINE_WHY[d.type],
        urgency: urgencyOf(d.at, now),
        tag: `Placement - ${stageLabel(placement.stage)}`,
      };
      (isHardClock ? needsYouNow : followUps).push({ item, at: Number.isNaN(at) ? now : at });
    }

    // --- byStage scan: attention (needs_you_now) + DERIVED stuck (follow_ups) --
    // One bounded Query per non-terminal stage (never a Scan) does double duty:
    //   (a) attention flag → needs_you_now (an escalated placement; PROMOTE to
    //       attention:true if it's already there via a due deadline).
    //   (b) DERIVED stuck → follow_ups: a placement whose time-in-stage exceeds
    //       STAGE_STUCK_THRESHOLDS[stage] is "stuck" — a pure function of state,
    //       no stored artifact, firing REGARDLESS of any pending hard clock (so a
    //       placement can be in needs_you_now AND follow_ups). This replaces the
    //       old stored `stuck_placement` deadline (scheduleStuckNudge is gone).
    // Derive the non-terminal stages from the central model (never a hardcoded
    // copy of the ladder — it must track PLACEMENT_STAGES automatically).
    const ATTENTION_STAGES: readonly PlacementStage[] = PLACEMENT_STAGES.filter(
      (s) => !TERMINAL_STAGES.has(s),
    );
    const isStuck = (c: PlacementItem): boolean => {
      const threshold = STAGE_STUCK_THRESHOLDS[c.stage];
      if (threshold === undefined || typeof c.stage_entered_at !== 'string') return false;
      const entered = Date.parse(c.stage_entered_at);
      return !Number.isNaN(entered) && now - entered >= threshold;
    };
    for (const stage of ATTENTION_STAGES) {
      const page = await placements.listByStage(stage, { limit: GROUP_FETCH_LIMIT });
      warnIfCapped(`attention:${stage}`, page.items.length, GROUP_FETCH_LIMIT);
      for (const c of page.items) {
        // Cache the placement we just loaded so any deadline join reuses it.
        if (!placementCache.has(c.placementId)) placementCache.set(c.placementId, c);

        // (a) attention flag → needs_you_now.
        if (c.attention && typeof c.attention === 'object') {
          if (needsYouNowIds.has(c.placementId)) {
            // Already in needs_you_now via a deadline — just flag attention.
            const existing = needsYouNow.find((r) => r.item.refId === c.placementId);
            if (existing) existing.item.attention = true;
          } else if (!(await isDeletedContact(c.tenantId))) {
            needsYouNowIds.add(c.placementId);
            const who = (await resolveContactLabel(c.tenantId)) ?? c.tenantId;
            const reason =
              typeof (c.attention as { reason?: unknown }).reason === 'string'
                ? (c.attention as { reason: string }).reason
                : 'Escalated';
            needsYouNow.push({
              item: {
                group: 'needs_you_now',
                refType: 'placement',
                refId: c.placementId,
                who,
                why: reason,
                urgency: 'Escalated',
                tag: `Placement - ${stageLabel(c.stage)}`,
                attention: true,
              },
              // Attention-only (no deadline) sorts among the overdue/most-urgent.
              at: now,
            });
          }
        }

        // (b) DERIVED stuck → follow_ups (independent of any hard clock).
        if (isStuck(c) && !followUpsIds.has(c.placementId) && !(await isDeletedContact(c.tenantId))) {
          followUpsIds.add(c.placementId);
          const who = (await resolveContactLabel(c.tenantId)) ?? c.tenantId;
          followUps.push({
            item: {
              group: 'follow_ups',
              refType: 'placement',
              refId: c.placementId,
              who,
              why: STUCK_WHY,
              tag: `Placement - ${stageLabel(c.stage)}`,
            },
            // Stuck rows share "now" ordering (no deadline instant of their own).
            at: now,
          });
        }
      }
    }

    // --- tours_today: Tour entities whose scheduledAt falls in the caller's day window ---
    // status = scheduled ONLY (the 'confirmed' status was removed 2026-07-08 -
    // scheduled covers it); 'requested' tours have no scheduledAt and are
    // naturally excluded by the sparse byScheduledAt GSI. The window comes
    // from ?toursFrom/?toursTo (the browser's local-day boundaries) with a UTC-day
    // fallback (see toursWindow above). Deleted-tenant check is best-effort (same
    // as other groups). The placement.tour_date branch is RETIRED: only Tour
    // entities appear here.
    {
      const TOURS_TODAY_STATUSES: ReadonlySet<string> = new Set(['scheduled']);
      const todayTours = await tours.listByScheduledRange(toursWindow.from, toursWindow.to);
      warnIfCapped('tours_today', todayTours.length, GROUP_FETCH_LIMIT);
      for (const t of todayTours) {
        if (!TOURS_TODAY_STATUSES.has(t.status)) continue; // skip non-active statuses
        if (await isDeletedContact(t.tenantId)) continue; // deleted tenant → off the boards
        const who = (await resolveContactLabel(t.tenantId)) ?? t.tenantId;
        const item: TodayItem = {
          group: 'tours_today',
          refType: 'tour',
          refId: t.tourId,
          who,
          why: 'Tour today',
          tag: 'Tour',
        };
        // Tours all share "today" — order them by tenant name then refId (stable).
        toursToday.push({ item, at: now });
      }
    }

    // (follow_ups is assembled above: due `follow_up` deadlines from the byDueAt
    // query + DERIVED stuck rows from the byStage scan.)

    // --- relay opt-out attention: ONE Query on the sparse byRelayOptOut index --
    // (2026-08-18) This pass used to ride the byLastActivity `open` read,
    // hard-capped at 100 rows, from the days it ALSO fed the unread items. When
    // inbox-unread-index moved unread onto the sparse byUnread GSI, this scan
    // was left behind on the wide read - and once prod held 649 open threads it
    // truncated (and WARNed) on every Today load to find the ~1 relay group
    // that mattered. The truth it needs is written at the moment of STOP /
    // START / removal (relay_opted_out_members, and now the relay_optout_flag
    // that rides those same writes), so this reads exactly the attention set:
    // the relay groups whose map is non-empty, newest activity first. The cap
    // check stays as a tripwire - a full page here means 100 relay groups with
    // an opted-out member, which IS worth a WARN.
    //
    // `emittedUnknownPhones` is written by the unread pass and read by the
    // contacts-triage pass after it, so it stays declared out here, ahead of
    // both: auto-capture usually creates BOTH an unknown_1to1 conversation AND a
    // needs_review contact, and the triage pass de-dupes the SAME person to one
    // item, preferring the conversation (the actionable target).
    const emittedUnknownPhones = new Set<string>();
    {
      const page = await conversations.listRelayOptOutAttention({ limit: GROUP_FETCH_LIMIT });
      warnIfCapped('relay_optout', page.items.length, GROUP_FETCH_LIMIT);
      for (const conv of page.items) {
        // The index is the truth; the type check is defense in depth (the flag
        // is written by relay-only primitives), and a closed group's flag is
        // dropped by the close write, so an `open` check here is a tripwire too.
        if (conv.status !== 'open') continue;
        // A2P — relay opt-out attention: a relay_group carrying opted-out members
        // surfaces ONE needs_you_now item PER still-opted-out member, linking to
        // that member's contact page (where staff investigate/remove them). This
        // is independent of unread (a relay thread's unread is pool-number noise),
        // so it runs BEFORE the unread gate. Each entry is LIVE-CONFIRMED against
        // the contact (sms_opt_out still true, not deleted) so an opt-back-in /
        // removal auto-resolves the item without extra wiring.
        if (conv.type === 'relay_group' && conv.relay_opted_out_members !== undefined) {
          for (const entry of Object.values(conv.relay_opted_out_members)) {
            const memberContactId = entry.contactId;
            // No contactId → we can't link OR live-confirm; skip (honesty rule).
            if (typeof memberContactId !== 'string' || memberContactId.length === 0) continue;
            const memberContact = await getContact(memberContactId);
            // Contact gone -> nothing to link or confirm; the annotation is stale,
            // auto-resolve silently (also narrows memberContact for the checks below).
            if (!memberContact) continue;
            // Live-confirm against the ONE shared suppression predicate: the member
            // is still silenced when the contact flag is set OR (BE1 per-phone scope)
            // their roster phone's own 1:1 conversation carries sms_opt_out - the
            // secondary-number STOP corner this feature closed for sends, where the
            // contact flag is never set. Reading isMemberSuppressed here keeps Today
            // and the leg gates on one suppression truth. Old annotations with no
            // phone can't run the per-phone check, so they fall back to the
            // contact-flag-only confirm.
            const stillSuppressed =
              typeof entry.phone === 'string' && entry.phone.length > 0
                ? await isMemberSuppressed(contacts, conversations, {
                    contactId: memberContactId,
                    phone: entry.phone,
                  })
                : memberContact.sms_opt_out === true;
            if (!stillSuppressed) continue;
            if (isDeleted(memberContact)) continue;
            const memberWho =
              nameFromContact(memberContact) ??
              entry.name ??
              formatPhoneForDisplay(entry.phone) ??
              formatPhoneForDisplay(memberContact.phone) ??
              memberContactId;
            needsYouNow.push({
              item: {
                group: 'needs_you_now',
                refType: 'contact',
                refId: memberContactId,
                who: memberWho,
                why: 'Opted out of a relay group - not receiving messages',
                tag: 'Relay group',
                attention: true,
              },
              at: now,
            });
          }
        }
      }
    }

    // --- unread: ONE bounded byUnread index walk (newest-activity-first) ------
    // The sparse byUnread GSI holds exactly the conversations with unread, so
    // this pass sees the newest 100 unread 1:1 threads rather than whichever
    // unread threads happened to fall inside the first 100 OPEN rows. Same
    // numeric bound, larger realized payload on unread-heavy data - that growth
    // IS the fix. Today gains one index Query and loses nothing; this is a
    // CORRECTNESS fix, not a cost fix.
    //
    // FILTER-THEN-CAP, explicitly: keep only 1:1-bucket rows and stop after
    // TODAY_UNREAD_CAP KEPT ones. Capping the raw stream first would let a burst
    // of unread group_text / relay_group threads - which Today never shows -
    // consume every slot and starve the sections this pass exists to fill.
    //
    // The iterator is LAZY, so breaking at the cap stops the paging too. It also
    // applies the shared visibility rule (unread_count > 0 plus the per-type
    // status gate), which for a 1:1 is exactly the `status: 'open'` + `unread >
    // 0` gate this pass used to apply itself.
    //
    // ORDER MATTERS: this runs BEFORE the contacts-triage pass below, which
    // consumes the `emittedUnknownPhones` written here.
    {
      const walkState: UnreadWalkState = { scanExhausted: false, scanned: 0 };
      const unreadOneToOne: ConversationItem[] = [];
      // DEDUPE BY EMITTED IDENTITY, AND BEFORE THE CAP (adversarial NEW-3).
      // One contact can own SEVERAL unread threads - contactThreads.ts models
      // exactly one conversation PER PARTICIPANT KEY, so a person with a phone
      // thread and an email thread arrives here TWICE. Both emitted a row with
      // the same refType/refId, which cost three things: duplicate React keys
      // inside one group's <ul> (Today.tsx renders key=`${refType}:${refId}`),
      // TWO consumed TODAY_UNREAD_CAP slots for one person - pushing real work
      // off the queue the cap exists to protect - and a warnIfCapped tripwire
      // counting the duplicate. Every other Today group carries a dedupe set
      // (needsYouNowIds, followUpsIds); this one carried none.
      //
      // It sits in the COLLECT loop, ahead of the cap check, precisely so a
      // duplicate cannot spend one of the 100 slots. Newest-activity-first
      // order means the FIRST thread seen wins, which is the row the operator
      // would want. Keyed PER DESTINATION GROUP, matching the per-group dedupe
      // ruling above: an unknown thread emits into needs_you_now and a known
      // 1:1 into unreplied, and Today renders those as separate <ul>s with
      // independent keyspaces, so one contact legitimately appearing in both is
      // not a duplicate.
      const unreadRowKeys = new Set<string>();
      /**
       * DISTINCT deleted contacts this pass has skipped - one `contacts.getById`
       * each, because `getContact` memoizes per contact ID (adversarial r2
       * finding 6). It is both the read counter and the bound below.
       */
      const skippedDeletedContacts = new Set<string>();
      for await (const conv of iterateUnreadConversations(
        { conversations, logger: log },
        { budget: unreadWalkBudget },
        walkState,
      )) {
        if (!isOneToOneBucket(conv)) continue;
        // DELETED CONTACTS, ALSO BEFORE THE CAP (adversarial A9). This test used
        // to run in the emit loop below, after the cap had been spent - the very
        // ordering the comment above rejects for group threads - and the index
        // source makes it worse: the newest 100 UNREAD rows is where resurfaced
        // deleted contacts live BY CONSTRUCTION (the product rule keeps them
        // unread until someone reads them), where the newest 100 OPEN rows held
        // only a small fraction of them. A hundred at the head of the index
        // rendered Unreplied and the untriaged block EMPTY, with warnIfCapped
        // announcing "capped" rather than "filtered to nothing".
        //
        // IT IS NOT FREE (adversarial r2 finding 6 - the earlier claim that the
        // request cache made it so was wrong): `getContact` memoizes per contact
        // ID, so every DISTINCT contact costs a real `contacts.getById`, and
        // ahead of the cap this runs over every 1:1 item walked rather than the
        // 100 kept ones. Unbounded, an index head thick with deleted residue
        // could issue up to UNREAD_WALK_LIMIT (2000) sequential contact Gets on
        // a route every connected dashboard SSE-refetches. So the skip work
        // carries its own bound, at the same TODAY_UNREAD_CAP the kept rows use.
        // Batching the lookups is the real remedy
        // (docs/issues/contacts-batchget-amplified-reads.md).
        //
        // NO LOOKUP BOUND (planner fix, adversarial r4 finding 1). Every bound
        // tried here was wrong at some threshold: fix wave 2 stopped the WALK
        // (hid live work - the walk-stop that was BLOCKING for the inbox), and
        // fix wave 3 stopped the LOOKUPS and treated the rest as non-deleted -
        // which at 250 deleted ahead of 5 live rendered a FULL Unreplied block
        // of deleted contacts and ZERO live work: the board inverted. There is
        // no partial-knowledge state that is honest, so the rule is applied to
        // every walked 1:1 item. COST: one memoized `getById` per DISTINCT
        // contact, bounded by the raw walk budget - the same O(scanned index
        // items) the nav badge pays, watched by the scanned-items WARN, and
        // remedied by the BatchGet follow-up
        // (docs/issues/contacts-batchget-amplified-reads.md).
        const ownerId = oneToOneContactId(conv);
        if (ownerId !== undefined && (await isDeletedContact(ownerId))) {
          skippedDeletedContacts.add(ownerId);
          continue;
        }
        const rowKey = unreadRowKeyOf(conv);
        if (unreadRowKeys.has(rowKey)) continue;
        unreadRowKeys.add(rowKey);
        unreadOneToOne.push(conv);
        if (unreadOneToOne.length >= TODAY_UNREAD_CAP) break;
      }
      warnIfCapped('unread', unreadOneToOne.length, TODAY_UNREAD_CAP);
      // ITS OWN LABEL, deliberately not folded into the line above: it says
      // "this many distinct deleted contacts were skipped on the way to the
      // block" (residue accruing - the delete-time reset and backfill rule 3
      // are the fixes), where the block-level line says "the block is full".
      // Two different operational problems. The threshold reuses
      // TODAY_UNREAD_CAP as a magnitude, not as any lookup bound.
      warnIfCapped('unread:deleted_skips', skippedDeletedContacts.size, TODAY_UNREAD_CAP);
      // UNDERFILLED FOR A REASON NOBODY CAN OTHERWISE SEE. Neither capped nor
      // exhausted means the raw-scan budget ran out first, so the block is short
      // while real unread work sits behind it - the same loud-problem-turned-
      // silent shape the contacts-triage page-budget WARN below covers. Rate
      // limited because the signal is the RATE, not each poll.
      if (unreadOneToOne.length < TODAY_UNREAD_CAP && !walkState.scanExhausted) {
        warnUnreadWalkTruncated(
          {
            event: 'today_unread_walk_truncated',
            scanned: walkState.scanned,
            kept: unreadOneToOne.length,
            budget: unreadWalkBudget,
          },
          'today: the unread index walk hit its scan budget before filling the block - some unread threads are NOT shown',
        );
      }
      for (const conv of unreadOneToOne) {
        const who = whoOfConversation(conv);
        if (conv.type === 'unknown_1to1') {
          // Untriaged inbound → link to the unknown CONTACT's page (the
          // auto-captured needs_review contact), NOT /conversations/:id — the
          // dashboard has no conversation route, so that was a DEAD link. When the
          // roster isn't linked yet (auto-capture race), DEFER to the contacts
          // triage pass below (it emits the proper contact row) rather than
          // emitting a dead conversation ref — so we never produce a nowhere-link.
          // The deleted-contact test has already run, ahead of the cap.
          const contactId = oneToOneContactId(conv);
          if (contactId !== undefined) {
            if (typeof conv.participant_phone === 'string') {
              emittedUnknownPhones.add(conv.participant_phone);
            }
            needsYouNow.push({
              item: {
                group: 'needs_you_now',
                refType: 'contact',
                refId: contactId,
                who,
                why: 'New unknown contact',
                attention: true,
              },
              at: now,
            });
          }
        } else if (
          // A POSITIVE allowlist: every multi-party type falls out deliberately.
          // relay_group and group_text are already gone (isOneToOneBucket drops
          // both above); this list is the second, type-level guard, and it is
          // also what makes a legacy row with NO `type` emit nothing - the same
          // thing it emitted before this pass was index-fed.
          conv.type === 'tenant_1to1' ||
          conv.type === 'landlord_1to1' ||
          conv.type === 'partner_1to1'
        ) {
          // Unreplied is anchored to a 1:1 tenant/landlord/partner thread only. A
          // relay_group's participant_phone is the synthetic POOL number (no
          // display name) — surfacing it as an Unreplied row whose `who` is an
          // internal pool number violates "anchored to a placement/contact". Skip it
          // (and anything that isn't a known 1:1 type). Link to the contact page;
          // fall back to the conversation ref only if the roster isn't linked yet.
          // A deleted contact's thread is off the boards (an unlinked thread -
          // contactId undefined - has no contact to be deleted, so it stays);
          // both rules are applied in the collect loop above, ahead of the cap.
          const contactId = oneToOneContactId(conv);
          unreplied.push({
            item: {
              group: 'unreplied',
              refType: contactId !== undefined ? 'contact' : 'conversation',
              refId: contactId ?? conv.conversationId,
              who,
              why: 'Unreplied',
            },
            // Sort unreplied by most-recent activity first (soonest = most recent
            // → use the negated activity time so newer sorts earlier).
            at: -Date.parse(conv.last_activity_at),
          });
        }
      }
    }

    // --- contacts: untriaged (unknown / needs_review) → needs_you_now ---------
    // The (type=unknown, status=needs_review) byTypeStatus partition IS the human
    // triage queue — one bounded Query, never a Scan.
    {
      // FILL THE PAGE PAST THE STUBS (fix wave 2, adversarial 6). DynamoDB
      // applies `Limit` at the index BEFORE any filter, and every row in the
      // `unknown#needs_review` partition carries the identical sort key - so
      // intra-partition order is stable and the same 100 rows come back every
      // time. Once enough group-detection stubs sort ahead of the real unknown
      // contacts, filtering them at display rendered an EMPTY block, forever,
      // which reads as "nothing needs triage": a loud problem turned silent.
      // The exclusion is pushed into the Query (saves work, not page slots) AND
      // the read pages until it has a real page or runs out, bounded so a
      // partition made entirely of stubs cannot spin.
      //
      // WHAT THIS COSTS (fix wave 4, item 7): up to TRIAGE_MAX_PAGES (10)
      // SEQUENTIAL Queries of GROUP_FETCH_LIMIT (100) rows each on one Today
      // request - a bounded but real read amplification, paid only while the
      // partition ahead of the real unknowns is thick with excluded rows. It
      // stops the moment a page fills the block.
      const collected: ContactItem[] = [];
      let cursor: Record<string, unknown> | undefined;
      let pagesWalked = 0;
      for (let page = 0; page < TRIAGE_MAX_PAGES; page += 1) {
        pagesWalked = page + 1;
        const read = await contacts.listByType('unknown', {
          status: 'needs_review',
          limit: GROUP_FETCH_LIMIT,
          // Their triage surface is the GROUP THREAD, which is where a human can
          // actually tell who these people are.
          excludeOrigin: GROUP_DETECTION_ORIGIN,
          ...(cursor !== undefined && { exclusiveStartKey: cursor }),
        });
        collected.push(...read.items);
        cursor = read.lastEvaluatedKey;
        if (cursor === undefined || collected.length >= GROUP_FETCH_LIMIT) break;
      }
      // THE PAGE BUDGET RAN OUT WITH ROWS STILL BEHIND IT (fix wave 4, item 7).
      // Every other truncation on this route is announced by `warnIfCapped`, and
      // this one was not: a partition holding more than ~1000 excluded rows
      // ahead of the real unknowns exhausts the walk with a short block, and the
      // block reads as "nothing needs triage" - which is exactly the loud
      // problem turned silent that the fill loop was added to prevent, one layer
      // further out.
      if (cursor !== undefined && collected.length < GROUP_FETCH_LIMIT) {
        log.warn(
          { group: 'contacts:triage', pages: pagesWalked, found: collected.length },
          'today: the untriaged-contacts walk ran out of pages before filling the block - some untriaged contacts are NOT shown',
        );
      }
      // HARD CAP THE RESULT, NOT JUST THE READ. The loop breaks on `>=`, so a
      // last page could take the total to 199 - twice the bound every other
      // group on this route respects, and a block a human is meant to work
      // through.
      const triaged = collected.slice(0, GROUP_FETCH_LIMIT);
      warnIfCapped('contacts:triage', triaged.length, GROUP_FETCH_LIMIT);
      for (const contact of triaged) {
        if (!UNTRIAGED_CONTACT_STATUSES.has(contact.status ?? '')) continue;
        // GROUP-DETECTION STUBS ARE NOT A TODAY ROW (fix wave 5, adversarial 30;
        // moved to the QUERY + a fill loop above in fix wave 2, adversarial 6 -
        // this line is now the belt to that braces, and covers a stub written
        // before the `origin` marker existed).
        // Detection mints a contact for EVERY unseen roster member as
        // (unknown, needs_review) - the exact partition this block reads - so
        // one inbound from a six-person carrier group put five "New unknown
        // contact" rows into `needs_you_now` in a single shot, none of them
        // de-duped (group members deliberately get no 1:1 thread minted, so the
        // conversation-row de-dupe above cannot see them). Worse, this Query is
        // hard-capped and the byTypeStatus GSI's range key is `status`, not a
        // timestamp, so there is NO recency ordering: past the page limit,
        // genuinely new unknown contacts became permanently invisible here.
        //
        // Their triage surface is the GROUP THREAD, which is where a human can
        // actually tell who these people are - and Today already states that
        // group conversations are structurally absent from it. This makes the
        // contacts they create absent too, rather than only the conversations.
        // A stub that a human later triages loses `needs_review` and leaves this
        // partition anyway; a real unknown caller who TEXTED still surfaces
        // through the conversation-row source above.
        if (contact.origin === GROUP_DETECTION_ORIGIN) continue;
        // De-dupe by phone: if this person already emitted an unknown_1to1
        // conversation row above, skip the contact (prefer the conversation —
        // it carries the unread and is the actionable triage target). A
        // needs_review contact with NO matching emitted conversation still
        // emits its own row.
        if (typeof contact.phone === 'string' && emittedUnknownPhones.has(contact.phone)) continue;
        const who =
          nameFromContact(contact) ?? formatPhoneForDisplay(contact.phone) ?? contact.contactId;
        needsYouNow.push({
          item: {
            group: 'needs_you_now',
            refType: 'contact',
            refId: contact.contactId,
            who,
            why: 'New unknown contact',
            attention: true,
          },
          at: now,
        });
      }
    }

    // --- ai_suggestions: pending AI extractions grouped by contact -----------
    // conversation-fact-extraction: one bounded byPending Query returns the newest
    // pending suggestions across all contacts; group by ownerContactId into ONE
    // review row per contact (why = "<n> suggestion(s)"), skip deleted contacts,
    // cap at 20 contact rows. count (the group size the dashboard shows) = distinct
    // contacts, not raw suggestions.
    {
      const AI_SUGGESTIONS_ITEM_CAP = 20;
      const pending = await extraction.listPending({ limit: GROUP_FETCH_LIMIT });
      warnIfCapped('ai_suggestions', pending.length, GROUP_FETCH_LIMIT);
      // Preserve first-seen order (listPending is newest-first) so the most recent
      // suggestion's contact leads.
      const byContact = new Map<string, number>();
      for (const s of pending) {
        byContact.set(s.ownerContactId, (byContact.get(s.ownerContactId) ?? 0) + 1);
      }
      for (const [contactId, count] of byContact) {
        if (aiSuggestions.length >= AI_SUGGESTIONS_ITEM_CAP) break;
        if (await isDeletedContact(contactId)) continue; // deleted -> off the boards
        const who = (await resolveContactLabel(contactId)) ?? contactId;
        aiSuggestions.push({
          item: {
            group: 'ai_suggestions',
            refType: 'contact',
            refId: contactId,
            who,
            why: `${count} suggestion(s)`,
          },
          at: now,
        });
      }
    }

    // --- relay close-nags: open relay groups whose 28-day close-nag is DUE ----
    // D5: a group left open past a terminal event recurs on Today every 28 days
    // until closed. Source = listRelayGroups('open') (byRelayStatus GSI), filtered
    // to close_nag_next_at <= now. This is a SEPARATE list (its own Close /
    // Keep-open card), not folded into the four grouped queues. poolNumber +
    // member names/phones are display DATA on the card (same precedent as the
    // relay opt-out attention item above); LOGS stay counts/IDs only.
    const relayCloseNags: RelayCloseNagItem[] = [];
    {
      // listRelayGroups reads the SPARSE byRelayStatus GSI. A native group text
      // never writes `relay_status` (spec 4.2 forbids it outright), so it cannot
      // appear here and no group thread is ever close-nagged - it has no close.
      const { items: openGroups, truncated } = await conversations.listRelayGroups('open');
      if (truncated) {
        log.warn(
          { group: 'relay_close_nags' },
          'today: relay-group list truncated - some due nags may be missing',
        );
      }
      for (const conv of openGroups) {
        const nagDueAt = conv.close_nag_next_at;
        // Only groups with a DUE nag (<= now). No nag, or a future nag -> skip.
        if (typeof nagDueAt !== 'string' || nagDueAt > nowIso) continue;
        const poolNumber = conv.pool_number;
        if (typeof poolNumber !== 'string' || poolNumber.length === 0) continue; // defensive
        const memberNames = (conv.participants ?? []).map(
          (p) => p.name ?? formatPhoneForDisplay(p.phone) ?? p.contactId,
        );
        relayCloseNags.push({
          conversationId: conv.conversationId,
          poolNumber,
          ...(typeof conv.placement_tag === 'string' &&
            conv.placement_tag.length > 0 && { tag: conv.placement_tag }),
          memberNames,
          ownerType: conv.owner?.type ?? null,
          ...(typeof conv.owner?.id === 'string' &&
            conv.owner.id.length > 0 && { ownerId: conv.owner.id }),
          nagDueAt,
        });
      }
    }

    // --- Deterministic total order, most-urgent first ------------------------
    // needs_you_now: by `at` ascending (overdue/attention=now sort first, then
    // soon-due), tie-break by refId. Same comparator family for the others
    // (each group's `at` encodes its own urgency), tie-break by refId.
    const byUrgency = (a: Ranked, b: Ranked): number => {
      if (a.at !== b.at) return a.at - b.at;
      return a.item.refId < b.item.refId ? -1 : a.item.refId > b.item.refId ? 1 : 0;
    };
    needsYouNow.sort(byUrgency);
    toursToday.sort((a, b) =>
      a.item.who !== b.item.who
        ? a.item.who < b.item.who
          ? -1
          : 1
        : a.item.refId < b.item.refId
          ? -1
          : a.item.refId > b.item.refId
            ? 1
            : 0,
    );
    unreplied.sort(byUrgency);
    followUps.sort(byUrgency);
    // AI-suggestion rows share "now" ordering - tie-break by refId for a stable order.
    aiSuggestions.sort((a, b) =>
      a.item.refId < b.item.refId ? -1 : a.item.refId > b.item.refId ? 1 : 0,
    );

    // Group order matches the spec's reading order: Needs-you-now, Tours-today,
    // Unreplied, Follow-ups, AI-suggestions.
    const items: TodayItem[] = [
      ...needsYouNow.map((r) => r.item),
      ...toursToday.map((r) => r.item),
      ...unreplied.map((r) => r.item),
      ...followUps.map((r) => r.item),
      ...aiSuggestions.map((r) => r.item),
    ];

    log.info(
      {
        needs_you_now: needsYouNow.length,
        tours_today: toursToday.length,
        unreplied: unreplied.length,
        follow_ups: followUps.length,
        ai_suggestions: aiSuggestions.length,
        relay_close_nags: relayCloseNags.length,
      },
      'today queue assembled',
    );

    const body: TodayResponse = { items, relayCloseNags, generatedAt: nowIso };
    res.json(body);
  });

  return router;
}

/** Conversation `who`: the resolved display name, else the participant phone in
 *  staff-facing display form (email-only threads carry neither -> ''). */
function whoOfConversation(conv: ConversationItem): string {
  if (typeof conv.participant_display_name === 'string' && conv.participant_display_name.length > 0) {
    return conv.participant_display_name;
  }
  return formatPhoneForDisplay(conv.participant_phone) ?? '';
}

/** A 1:1 thread's external contact id (its single participant), or undefined when
 *  the roster isn't linked yet (the M1.2 auto-capture race, before
 *  setParticipantsIfAbsent runs). Used to deep-link Today rows to the CONTACT
 *  page (/contacts/:id) — the dashboard has no /conversations route. */
function oneToOneContactId(conv: ConversationItem): string | undefined {
  const p = conv.participants?.[0];
  return typeof p?.contactId === 'string' && p.contactId.length > 0 ? p.contactId : undefined;
}

/**
 * The Today row IDENTITY a 1:1 unread thread would emit: the destination group
 * plus the `${refType}:${refId}` pair Today.tsx uses as its React key.
 *
 * Deliberately mirrors the two emit branches of the unread pass - an
 * `unknown_1to1` goes to needs_you_now, every other 1:1-bucket type to
 * unreplied, and both prefer the contact ref over the conversation ref. Two
 * threads of the SAME person therefore collide here, which is the point.
 *
 * An unlinked thread (no contactId yet - the auto-capture race) falls back to
 * its own conversationId, which is unique, so it never suppresses anything; the
 * unknown branch drops it at emit time anyway.
 */
function unreadRowKeyOf(conv: ConversationItem): string {
  const group = conv.type === 'unknown_1to1' ? 'needs_you_now' : 'unreplied';
  const contactId = oneToOneContactId(conv);
  return contactId !== undefined
    ? `${group}:contact:${contactId}`
    : `${group}:conversation:${conv.conversationId}`;
}
