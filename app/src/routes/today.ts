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
// the tours group folds in scheduled/confirmed tours inside that window. When the
// window is absent we fall back to the UTC window of ?day=YYYY-MM-DD (or of the
// UTC date when ?day= is also absent) — evening tours near the UTC boundary may
// bucket a day off under the fallback; the dashboard always sends the window.
// Malformed ?day=/?toursFrom=/?toursTo= are 400s. This keeps the server and the
// client-side fallback agreeing by construction (both derive "today" from the
// operator's browser). A richer date-navigable queue is a separate, frontend-
// driven contract question (not built here).
//
// Every repo read is a bounded GSI Query (never a Scan): listByNextDeadline (per
// deadline type), tours listByScheduledRange, listByLastActivity({status:'open'}), and
// listByType (the unknown/needs_review triage partition). Each fetch is capped and
// a log.warn fires if a cap is hit (no silent truncation).
//
// PII (doc §9): responses carry who/why to the authed client; LOG LINES are
// counts/IDs only.
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createPlacementsRepo,
  type PlacementDeadlineType,
  type PlacementsRepo,
  TERMINAL_STAGES,
} from '../repos/placementsRepo.js';
import { PLACEMENT_STAGES, STAGE_LABELS, type PlacementStage } from '../lib/statusModel.js';
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

// --- C7 wire contract (VERBATIM — the frontend imports the same shapes) ------

export type TodayGroup = 'needs_you_now' | 'tours_today' | 'unreplied' | 'follow_ups';

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

export interface TodayResponse {
  items: TodayItem[];
  generatedAt: string;
}

export interface TodayRouterDeps {
  logger?: Logger;
  placementsRepo?: PlacementsRepo;
  conversationsRepo?: ConversationsRepo;
  contactsRepo?: ContactsRepo;
  toursRepo?: ToursRepo;
}

// --- Grouping rules (match the spec + the frontend fallback) -----------------

/**
 * The "hard clock" deadline types whose due/overdue instant lands a placement in
 * needs_you_now (the spec's business-clock examples). The remaining deadline
 * types (stuck_placement, follow_up) are the follow_ups group.
 */
const HARD_CLOCK_DEADLINE_TYPES: readonly PlacementDeadlineType[] = [
  'tour_reminder',
  'rta_window',
  'voucher_expiration',
];

/** The stuck-placement / due-follow-up deadline types → the follow_ups group. */
const FOLLOW_UP_DEADLINE_TYPES: readonly PlacementDeadlineType[] = ['stuck_placement', 'follow_up'];

/** The contact triage statuses that make an untriaged inbound (needs_you_now). */
const UNTRIAGED_CONTACT_STATUSES: ReadonlySet<string> = new Set(['needs_review']);

/**
 * Per-group fetch caps. The Today queue is a human's worklist, not a report —
 * a few dozen items per group is plenty; beyond the cap we log.warn (no silent
 * truncation) so an operator drowning in work is visible in the logs.
 */
const GROUP_FETCH_LIMIT = 100;

/** A human-friendly per-deadline-type label used in `why`. */
const DEADLINE_WHY: Record<PlacementDeadlineType, string> = {
  tour_reminder: 'Tour reminder',
  rta_window: 'RTA window closing',
  voucher_expiration: 'Voucher expiring',
  stuck_placement: 'Stuck placement',
  follow_up: 'Follow-up due',
};

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
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });

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
    // endpoint — fall back to the contactId for `who`. Drives BOTH name hydration
    // and the soft-delete check (one getById per contact).
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
    const resolveName = async (contactId: string): Promise<string | undefined> =>
      nameFromContact(await getContact(contactId));
    // Soft-deleted contacts are off the boards: an item anchored to a deleted
    // contact (its own row, or a placement whose tenant was deleted) is skipped. A
    // lookup failure is NOT treated as deleted (best-effort → keep the item).
    const isDeletedContact = async (contactId: string): Promise<boolean> => {
      const contact = await getContact(contactId);
      return contact ? isDeleted(contact) : false;
    };

    /** Warn (never silently truncate) when a group's bounded fetch hit the cap. */
    const warnIfCapped = (group: string, count: number): void => {
      if (count >= GROUP_FETCH_LIMIT) {
        log.warn({ group, count: GROUP_FETCH_LIMIT }, 'today: group fetch hit the cap — results truncated');
      }
    };

    // Track which placements are already placed (de-dupe across groups by the most
    // relevant group: needs_you_now > tours_today > follow_ups).
    const placedPlacementIds = new Set<string>();

    const needsYouNow: Ranked[] = [];
    const toursToday: Ranked[] = [];
    const unreplied: Ranked[] = [];
    const followUps: Ranked[] = [];

    // --- needs_you_now: due/overdue HARD-CLOCK deadlines ---------------------
    // One bounded GSI Query per hard-clock type, bounded to those due AT/BEFORE
    // now (beforeAt) — soonest-first by the index range key.
    for (const type of HARD_CLOCK_DEADLINE_TYPES) {
      const page = await placements.listByNextDeadline(type, { beforeAt: nowIso, limit: GROUP_FETCH_LIMIT });
      warnIfCapped(`needs_you_now:${type}`, page.items.length);
      for (const c of page.items) {
        // Terminal placements (moved_in/lost) are off the boards — a lingering
        // deadline that was never cleared on the transition must not surface.
        if (TERMINAL_STAGES.has(c.stage)) continue;
        if (placedPlacementIds.has(c.placementId)) continue;
        placedPlacementIds.add(c.placementId);
        if (await isDeletedContact(c.tenantId)) continue; // deleted tenant → off the boards
        const who = (await resolveName(c.tenantId)) ?? c.tenantId;
        const at = typeof c.next_deadline_at === 'string' ? Date.parse(c.next_deadline_at) : now;
        const item: TodayItem = {
          group: 'needs_you_now',
          refType: 'placement',
          refId: c.placementId,
          who,
          why: DEADLINE_WHY[type],
          urgency: typeof c.next_deadline_at === 'string' ? urgencyOf(c.next_deadline_at, now) : 'due',
          tag: `Placement · ${stageLabel(c.stage)}`,
        };
        needsYouNow.push({ item, at: Number.isNaN(at) ? now : at });
      }
    }

    // --- needs_you_now: attention (escalation) placements --------------------
    // The attention flag has no GSI of its own; the spec's escalation set is
    // "active placements" flagged for a human. We surface them via the byStage GSI
    // over the non-terminal stages (a bounded Query per stage, never a Scan) and
    // filter to those carrying `attention`. A placement already placed by a deadline
    // above is left there (de-dupe) but PROMOTED to attention:true.
    // Derive the non-terminal stages from the central model (never a hardcoded
    // copy of the ladder — it must track PLACEMENT_STAGES automatically).
    const ATTENTION_STAGES: readonly PlacementStage[] = PLACEMENT_STAGES.filter(
      (s) => !TERMINAL_STAGES.has(s),
    );
    for (const stage of ATTENTION_STAGES) {
      const page = await placements.listByStage(stage, { limit: GROUP_FETCH_LIMIT });
      warnIfCapped(`attention:${stage}`, page.items.length);
      for (const c of page.items) {
        if (!c.attention || typeof c.attention !== 'object') continue;
        if (placedPlacementIds.has(c.placementId)) {
          // Already in needs_you_now via a deadline — just flag attention.
          const existing = needsYouNow.find((r) => r.item.refId === c.placementId);
          if (existing) existing.item.attention = true;
          continue;
        }
        placedPlacementIds.add(c.placementId);
        if (await isDeletedContact(c.tenantId)) continue; // deleted tenant → off the boards
        const who = (await resolveName(c.tenantId)) ?? c.tenantId;
        const reason =
          typeof (c.attention as { reason?: unknown }).reason === 'string'
            ? ((c.attention as { reason: string }).reason)
            : 'Escalated';
        const item: TodayItem = {
          group: 'needs_you_now',
          refType: 'placement',
          refId: c.placementId,
          who,
          why: reason,
          urgency: 'Escalated',
          tag: `Placement · ${stageLabel(c.stage)}`,
          attention: true,
        };
        // Attention-only (no deadline) is treated as "now" so it sorts among the
        // overdue/most-urgent items.
        needsYouNow.push({ item, at: now });
      }
    }

    // --- tours_today: Tour entities whose scheduledAt falls in the caller's day window ---
    // status ∈ {scheduled, confirmed}; 'requested' tours have no scheduledAt and
    // are naturally excluded by the sparse byScheduledAt GSI. The window comes
    // from ?toursFrom/?toursTo (the browser's local-day boundaries) with a UTC-day
    // fallback (see toursWindow above). Deleted-tenant check is best-effort (same
    // as other groups). The placement.tour_date branch is RETIRED: only Tour
    // entities appear here.
    {
      const TOURS_TODAY_STATUSES: ReadonlySet<string> = new Set(['scheduled', 'confirmed']);
      const todayTours = await tours.listByScheduledRange(toursWindow.from, toursWindow.to);
      warnIfCapped('tours_today', todayTours.length);
      for (const t of todayTours) {
        if (!TOURS_TODAY_STATUSES.has(t.status)) continue; // skip non-active statuses
        if (await isDeletedContact(t.tenantId)) continue; // deleted tenant → off the boards
        const who = (await resolveName(t.tenantId)) ?? t.tenantId;
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

    // --- follow_ups: stuck / due follow-up deadlines (the soft-clock types) ---
    for (const type of FOLLOW_UP_DEADLINE_TYPES) {
      const page = await placements.listByNextDeadline(type, { beforeAt: nowIso, limit: GROUP_FETCH_LIMIT });
      warnIfCapped(`follow_ups:${type}`, page.items.length);
      for (const c of page.items) {
        // Terminal placements (moved_in/lost) are off the boards — a lingering
        // deadline that was never cleared on the transition must not surface.
        if (TERMINAL_STAGES.has(c.stage)) continue;
        if (placedPlacementIds.has(c.placementId)) continue; // already needs_you_now / tours_today
        placedPlacementIds.add(c.placementId);
        if (await isDeletedContact(c.tenantId)) continue; // deleted tenant → off the boards
        const who = (await resolveName(c.tenantId)) ?? c.tenantId;
        const at = typeof c.next_deadline_at === 'string' ? Date.parse(c.next_deadline_at) : now;
        const item: TodayItem = {
          group: 'follow_ups',
          refType: 'placement',
          refId: c.placementId,
          who,
          why: 'Follow-up due',
          urgency: typeof c.next_deadline_at === 'string' ? urgencyOf(c.next_deadline_at, now) : 'due',
          tag: `Placement · ${stageLabel(c.stage)}`,
        };
        followUps.push({ item, at: Number.isNaN(at) ? now : at });
      }
    }

    // --- conversations: ONE bounded inbox Query (byLastActivity, open) --------
    // Untriaged inbounds (unknown_1to1 + unread) → needs_you_now (refType
    // 'conversation'); every other open conversation with unread → unreplied.
    // Phones already emitted as an untriaged unknown_1to1 conversation row — so
    // the contacts triage pass below can de-dupe the SAME person (auto-capture
    // usually creates BOTH an unknown_1to1 conversation AND a needs_review
    // contact) to one item, preferring the conversation (the actionable target).
    const emittedUnknownPhones = new Set<string>();
    {
      const page = await conversations.listByLastActivity({ status: 'open', limit: GROUP_FETCH_LIMIT });
      warnIfCapped('conversations', page.items.length);
      for (const conv of page.items) {
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
            // Skip if the member opted back in, or their contact is gone/deleted —
            // the flag on the conversation is stale; auto-resolve silently.
            if (!memberContact || memberContact.sms_opt_out !== true) continue;
            if (isDeleted(memberContact)) continue;
            const memberWho =
              nameFromContact(memberContact) ?? entry.name ?? entry.phone ?? memberContactId;
            needsYouNow.push({
              item: {
                group: 'needs_you_now',
                refType: 'contact',
                refId: memberContactId,
                who: memberWho,
                why: 'Opted out of a group text — not receiving messages',
                tag: 'Group text',
                attention: true,
              },
              at: now,
            });
          }
        }
        const unread = typeof conv.unread_count === 'number' ? conv.unread_count : 0;
        if (unread <= 0) continue; // only inbound-last (unread) threads are actionable
        const who = whoOfConversation(conv);
        if (conv.type === 'unknown_1to1') {
          // Untriaged inbound → link to the unknown CONTACT's page (the
          // auto-captured needs_review contact), NOT /conversations/:id — the
          // dashboard has no conversation route, so that was a DEAD link. When the
          // roster isn't linked yet (auto-capture race), DEFER to the contacts
          // triage pass below (it emits the proper contact row) rather than
          // emitting a dead conversation ref — so we never produce a nowhere-link.
          const contactId = oneToOneContactId(conv);
          if (contactId !== undefined && !(await isDeletedContact(contactId))) {
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
        } else if (conv.type === 'tenant_1to1' || conv.type === 'landlord_1to1') {
          // Unreplied is anchored to a 1:1 tenant/landlord thread only. A
          // relay_group's participant_phone is the synthetic POOL number (no
          // display name) — surfacing it as an Unreplied row whose `who` is an
          // internal pool number violates "anchored to a placement/contact". Skip it
          // (and anything that isn't a known 1:1 type). Link to the contact page;
          // fall back to the conversation ref only if the roster isn't linked yet.
          const contactId = oneToOneContactId(conv);
          // A deleted contact's thread is off the boards (an unlinked thread —
          // contactId undefined — has no contact to be deleted, so it stays).
          if (contactId !== undefined && (await isDeletedContact(contactId))) continue;
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
      const page = await contacts.listByType('unknown', {
        status: 'needs_review',
        limit: GROUP_FETCH_LIMIT,
      });
      warnIfCapped('contacts:triage', page.items.length);
      for (const contact of page.items) {
        if (!UNTRIAGED_CONTACT_STATUSES.has(contact.status ?? '')) continue;
        // De-dupe by phone: if this person already emitted an unknown_1to1
        // conversation row above, skip the contact (prefer the conversation —
        // it carries the unread and is the actionable triage target). A
        // needs_review contact with NO matching emitted conversation still
        // emits its own row.
        if (typeof contact.phone === 'string' && emittedUnknownPhones.has(contact.phone)) continue;
        const who = nameFromContact(contact) ?? contact.phone ?? contact.contactId;
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

    // Group order matches the spec's reading order: Needs-you-now, Tours-today,
    // Unreplied, Follow-ups.
    const items: TodayItem[] = [
      ...needsYouNow.map((r) => r.item),
      ...toursToday.map((r) => r.item),
      ...unreplied.map((r) => r.item),
      ...followUps.map((r) => r.item),
    ];

    log.info(
      {
        needs_you_now: needsYouNow.length,
        tours_today: toursToday.length,
        unreplied: unreplied.length,
        follow_ups: followUps.length,
      },
      'today queue assembled',
    );

    const body: TodayResponse = { items, generatedAt: nowIso };
    res.json(body);
  });

  return router;
}

/** Conversation `who`: the resolved display name, else the participant phone. */
function whoOfConversation(conv: ConversationItem): string {
  if (typeof conv.participant_display_name === 'string' && conv.participant_display_name.length > 0) {
    return conv.participant_display_name;
  }
  return conv.participant_phone;
}

/** A 1:1 thread's external contact id (its single participant), or undefined when
 *  the roster isn't linked yet (the M1.2 auto-capture race, before
 *  setParticipantsIfAbsent runs). Used to deep-link Today rows to the CONTACT
 *  page (/contacts/:id) — the dashboard has no /conversations route. */
function oneToOneContactId(conv: ConversationItem): string | undefined {
  const p = conv.participants?.[0];
  return typeof p?.contactId === 'string' && p.contactId.length > 0 ? p.contactId : undefined;
}
