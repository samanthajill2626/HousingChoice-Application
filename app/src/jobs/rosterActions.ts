// Pending-roster-action poll - the quiet-hours deferral engine (contact-rosters
// spec 5.3 / D7, plan Task 13).
//
// A roster change an operator confirms DURING quiet hours is not performed: the
// route writes a pendingRosterActions row due at quiet-end and answers 202. This
// poll is what finally performs it, on the reminder ladder's claim-and-skip
// discipline:
//
//   listDue(now) -> per row (isolated try/catch):
//     RE-VALIDATE THE WORLD (reads only) ->
//       the action still makes sense  -> claimApply, then act
//       the world moved underneath it -> claimSkip(reason) - a VISIBLE row
//       the world is UNREADABLE       -> claim NOTHING, retry next tick
//
// ORDER MATTERS: validate first, then claim the transition we decided on. Every
// claim is a ONE-WAY door (the repo's conditional update), so claiming "applied"
// before knowing whether we can apply would strand the row when the answer is
// "skip". Both transitions are atomic, so two ticks - or a tick racing an
// operator's Cancel / Add-now - still resolve to exactly one outcome. This is
// jobs/tourReminders' resolve-then-claim shape, not a departure from it.
//
// AT APPLY TIME, NOT FROM AN 11PM SNAPSHOT (D7): a deferred open resolves the
// PLAN as it stands now (and consumes it, D1/A8); a deferred add applies against
// the participants as they stand now. The row carries only WHAT was confirmed
// (open this owner's group / add this contact), never a materialized roster.
//
// A post-claim failure keeps its claim and does NOT retry (jobs/tourReminders'
// SendRefusedError posture): re-running an open that already burned a pool
// number, or an add that already announced, is worse than a loud log.
//
// PII (doc section 9): log ids/kinds/reasons only - never a name, body or phone.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { EventBus } from '../lib/events.js';
import { isDeleted, type ContactsRepo } from '../repos/contactsRepo.js';
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ConversationItem, ConversationsRepo } from '../repos/conversationsRepo.js';
import type { PlacementDeadlinesRepo } from '../repos/placementDeadlinesRepo.js';
import type { PlacementsRepo } from '../repos/placementsRepo.js';
import type { ToursRepo } from '../repos/toursRepo.js';
import type { UnitsRepo } from '../repos/unitsRepo.js';
import type {
  PendingRosterActionItem,
  PendingRosterActionsRepo,
  RosterActionSkipReason,
} from '../repos/pendingRosterActionsRepo.js';
import { addMemberToRelay, type RelayMemberDeps } from '../services/relayMembers.js';
import type { PoolNumbersService } from '../services/poolNumbers.js';
import {
  emitPlacementUpdated,
  openPlacementGroup,
  openTourGroup,
  placementOpenGuard,
  placementRosterOwner,
  provisionMembersOf,
  tourRosterOwner,
  type OpenPlacementGroupDeps,
  type OpenTourGroupDeps,
} from '../services/rosterProvision.js';
import { resolveRoster, type RosterOwner } from '../lib/rosterResolution.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Everything an apply touches that is NOT the owner's own repo. */
export interface RosterActionDepsBase {
  actions: PendingRosterActionsRepo;
  conversations: ConversationsRepo;
  contacts: ContactsRepo;
  units: UnitsRepo;
  audit: AuditRepo;
  activityEvents: ActivityEventsRepo;
  poolNumbers: PoolNumbersService;
  events: EventBus;
  /**
   * config.relayLiveProvisioning - the RELAY_LIVE_PROVISIONING kill-switch as
   * this process sees it. REQUIRED (not defaulted): with it off, provisioning
   * refuses from INSIDE the open, i.e. after the claim, so the poller has to
   * know before it claims - see the `provisioning_unavailable` verdict.
   */
  relayLiveProvisioning: boolean;
  logger?: Logger;
}

/** A TOUR-owned action's deps (what routes/tours.ts holds for apply-now). */
export interface TourRosterActionDeps extends RosterActionDepsBase {
  tours: ToursRepo;
}

/** A PLACEMENT-owned action's deps (what routes/placements.ts holds). */
export interface PlacementRosterActionDeps extends RosterActionDepsBase {
  placements: PlacementsRepo;
  placementDeadlines: PlacementDeadlinesRepo;
}

/** The poll sees BOTH owner families, so it needs both halves. */
export type RunDuePendingRosterActionsDeps = TourRosterActionDeps & PlacementRosterActionDeps;

/**
 * What one apply attempt did.
 * - `applied`  - the action happened (or was already true: an open whose group
 *                someone else opened is a no-op apply, not a false failure).
 * - `skipped`  - retired with a visible reason; nothing was sent.
 * - `waiting`  - NOTHING was claimed: the world could not be read, so the row
 *                stays pending and the next tick tries again (A21).
 * - `lost`     - another tick/operator already resolved the row (benign).
 */
export type RosterActionOutcome =
  | { result: 'applied' }
  | { result: 'skipped'; reason: RosterActionSkipReason }
  | { result: 'waiting' }
  | { result: 'lost' };

// ---------------------------------------------------------------------------
// The owner adapter - the ONLY thing that differs between tours and placements
// ---------------------------------------------------------------------------

/**
 * The validated owner of one action: its thread pointer, whether it is still
 * alive, and how to open its group. `openGroup` closes over the loaded owner so
 * the apply below is owner-agnostic.
 */
interface RosterActionOwner {
  threadId?: string;
  /** Why this owner can no longer host the action (already a skip reason). */
  dead?: RosterActionSkipReason;
  /** The resolver's view - absent only when the owner itself is gone. */
  rosterOwner?: RosterOwner;
  openGroup: () => Promise<{ ok: boolean; refusal?: { status: number; body: Record<string, unknown> } }>;
  /**
   * Poke the hubs that this owner's roster PICTURE changed. The card reads
   * pending[]/skipped[] from the roster payload and useRoster refetches on
   * tour.updated / placement.updated - but a claim-SKIP touches neither the
   * owner nor any conversation, so without this the card keeps showing "Joins
   * at 8:00 AM" for a row that is already retired until someone reloads.
   * Best-effort: an emit failure must never fail an apply.
   */
  emitUpdated: () => Promise<void>;
}

/** A tour that vanished, was canceled/closed, or converted away. */
async function loadTourOwner(
  ownerId: string,
  deps: TourRosterActionDeps,
): Promise<RosterActionOwner> {
  const tour = await deps.tours.get(ownerId);
  const log = deps.logger ?? defaultLogger;
  const openGroup = async (): Promise<{
    ok: boolean;
    refusal?: { status: number; body: Record<string, unknown> };
  }> => {
    if (!tour) return { ok: false, refusal: { status: 404, body: { error: 'tour_not_found' } } };
    const provisionDeps: OpenTourGroupDeps = { ...deps, log };
    const result = await openTourGroup(provisionDeps, tour);
    return result.ok ? { ok: true } : { ok: false, refusal: result.refusal };
  };
  const emitUpdated = async (): Promise<void> => {
    if (!tour) return;
    deps.events.emit('tour.updated', { tourId: tour.tourId, status: tour.status });
  };
  if (!tour) return { dead: 'owner_canceled', openGroup, emitUpdated };
  // CONVERTED FIRST: a converted tour is also `closed`, and 'converted' is the
  // honest notice - conversion should have MIGRATED this row (spec D4), so
  // seeing it here means that best-effort migrate failed and the row is an
  // orphan on a tour whose roster now belongs to the placement.
  if (typeof tour.convertedPlacementId === 'string' && tour.convertedPlacementId.length > 0) {
    return { dead: 'converted', openGroup, emitUpdated };
  }
  if (tour.status === 'canceled' || tour.status === 'closed') {
    return { dead: 'owner_canceled', openGroup, emitUpdated };
  }
  return {
    ...(typeof tour.groupThreadId === 'string' &&
      tour.groupThreadId.length > 0 && { threadId: tour.groupThreadId }),
    rosterOwner: tourRosterOwner(tour),
    openGroup,
    emitUpdated,
  };
}

/** A placement that vanished or reached a terminal stage. */
async function loadPlacementOwner(
  ownerId: string,
  deps: PlacementRosterActionDeps,
): Promise<RosterActionOwner> {
  const placement = await deps.placements.getById(ownerId);
  const log = deps.logger ?? defaultLogger;
  const openGroup = async (): Promise<{
    ok: boolean;
    refusal?: { status: number; body: Record<string, unknown> };
  }> => {
    if (!placement) {
      return { ok: false, refusal: { status: 404, body: { error: 'placement_not_found' } } };
    }
    const provisionDeps: OpenPlacementGroupDeps = { ...deps, log };
    const result = await openPlacementGroup(provisionDeps, placement);
    return result.ok ? { ok: true } : { ok: false, refusal: result.refusal };
  };
  const emitUpdated = async (): Promise<void> => {
    if (!placement) return;
    await emitPlacementUpdated({ ...deps, log }, placement);
  };
  if (!placement) return { dead: 'owner_canceled', openGroup, emitUpdated };
  const terminal = placementOpenGuard(placement);
  if (terminal !== undefined) return { dead: 'owner_canceled', openGroup, emitUpdated };
  return {
    ...(typeof placement.group_thread === 'string' &&
      placement.group_thread.length > 0 && { threadId: placement.group_thread }),
    rosterOwner: placementRosterOwner(placement),
    openGroup,
    emitUpdated,
  };
}

// ---------------------------------------------------------------------------
// Validation - "does this action still make sense?"
// ---------------------------------------------------------------------------

/** What validation decided, before any claim is taken. */
type ActionVerdict =
  | { act: 'open' }
  | { act: 'add'; conversationId: string; contactId: string; phone: string }
  /** Already true - claim it applied and DO nothing (never a false failure). */
  | { act: 'noop' }
  | { skip: RosterActionSkipReason }
  /** Unreadable world: claim nothing at all. */
  | { wait: true };

/** One page of the removal scan, and how many pages it may read. The window a
 *  deferral spans is up to ~11 hours, and a contact active across several
 *  tours/placements can log a lot in that time - so the scan is bounded by the
 *  ROW'S OWN AGE (it stops at the first event older than createdAt), not by a
 *  fixed event count. The page cap is only a runaway guard. */
const REMOVAL_SCAN_PAGE_SIZE = 25;
const REMOVAL_SCAN_MAX_PAGES = 10;

/**
 * Was this member REMOVED from the thread while the add was pending (spec 5.3
 * `member_no_longer_on_roster`)? The evidence is their own timeline: the live
 * remove path pins `removed_from_group_text` against the conversation, so a pin
 * for THIS thread dated after the row was born means an operator took them off
 * after confirming the add - re-adding them at 8 AM would resurrect someone
 * deliberately removed, and TEXT the group about it.
 *
 * A removal from BEFORE the row was born is the opposite case (a deliberate
 * re-add of a previously-removed member) and must apply normally, which is why
 * this compares against `createdAt` instead of just checking membership history.
 *
 * So the scan pages back (newest-first) until it reaches events OLDER than
 * `createdAt` - the point past which nothing can be evidence - rather than
 * reading a fixed first page a busy contact would overflow. If the cap is hit
 * before that boundary, the answer is "we do not know", and the conservative
 * failure is to REFUSE: not texting someone is recoverable (the notice says so),
 * announcing a deliberately-removed person is not.
 *
 * Best-effort on a read FAILURE only: an unreadable timeline answers "no
 * evidence" and the add applies, as before.
 */
async function removedWhilePending(
  row: PendingRosterActionItem,
  contactId: string,
  conversationId: string,
  deps: RosterActionDepsBase,
  log: Logger,
): Promise<boolean> {
  try {
    let before: string | undefined;
    for (let page = 0; page < REMOVAL_SCAN_MAX_PAGES; page += 1) {
      const { items } = await deps.activityEvents.listByContact(contactId, {
        limit: REMOVAL_SCAN_PAGE_SIZE,
        ...(before !== undefined && { before }),
      });
      for (const e of items) {
        // Newest-first: the first event at or before the row's birth ends the
        // window - nothing older can be a removal "while pending".
        if (e.at <= row.createdAt) return false;
        if (e.type === 'removed_from_group_text' && e.refId === conversationId) return true;
      }
      // A short page means the feed is exhausted: the boundary IS reached.
      if (items.length < REMOVAL_SCAN_PAGE_SIZE) return false;
      const oldest = items[items.length - 1];
      if (oldest === undefined) return false;
      before = oldest.tsEventId;
    }
    log.warn(
      { actionId: row.actionId, pages: REMOVAL_SCAN_MAX_PAGES },
      'roster action: removal-history scan hit the page cap without reaching the row - refusing the add',
    );
    return true;
  } catch (err) {
    log.warn(
      { err, actionId: row.actionId },
      'roster action: removal-history read failed - treating as no removal',
    );
    return false;
  }
}

/** Re-validate one due row against the world as it stands NOW. Reads only. */
async function validateAction(
  row: PendingRosterActionItem,
  owner: RosterActionOwner,
  deps: RosterActionDepsBase,
  log: Logger,
): Promise<ActionVerdict> {
  if (owner.dead !== undefined) return { skip: owner.dead };

  // --- open_group ---------------------------------------------------------
  if (row.action === 'open_group') {
    if (owner.rosterOwner === undefined) return { skip: 'owner_canceled' };
    // Resolve the roster AS IT STANDS NOW (D7) through the ONE resolver, so the
    // cardinal rule applies here too: an unreadable thread is 'unavailable' and
    // NEVER falls through to the plan/default.
    const roster = await resolveRoster(
      { conversations: deps.conversations, units: deps.units, contacts: deps.contacts, log },
      owner.rosterOwner,
    );
    if (roster.source === 'unavailable') return { wait: true };

    if (owner.threadId !== undefined) {
      // A thread already fronts this owner - somebody opened the group while the
      // action waited (a force-send, the raw relay route, the other hub).
      const conversation = await readConversation(owner.threadId, deps);
      if (conversation === 'unreadable' || conversation === undefined) return { wait: true };
      // Opened AND closed inside the window: re-opening is not this action's
      // business (reopen is a separate decision) - retire it visibly.
      if (conversation.status === 'closed') return { skip: 'group_closed' };
      // The group IS open. The operator's intent is satisfied; claim the row
      // APPLIED (a skip notice here would be a false alarm about a group that
      // exists) and provision nothing.
      return { act: 'noop' };
    }

    // PRE-CLAIM too-thin check: the roster can lose its second reachable member
    // between confirm and quiet-end, and 'roster_too_thin' is a VISIBLE notice -
    // it must never become a post-claim refusal nobody sees.
    if (provisionMembersOf(roster).length < 2) return { skip: 'roster_too_thin' };
    // PRE-CLAIM kill-switch check, for the same reason. With
    // RELAY_LIVE_PROVISIONING off (the pre-A2P posture) the open refuses from
    // inside provisioning - AFTER claimApply - and an 'applied' row is in
    // neither pending[] nor skipped[], so the operator's deferred open would
    // simply evaporate at quiet-end with nothing to show for it. The immediate
    // path answers 503 with a message; this is the deferred path's equivalent.
    if (!deps.relayLiveProvisioning) return { skip: 'provisioning_unavailable' };
    return { act: 'open' };
  }

  // --- add_member ---------------------------------------------------------
  const contactId = typeof row.contactId === 'string' ? row.contactId : '';
  if (contactId.length === 0) {
    log.error({ actionId: row.actionId }, 'roster action: add row carries no contactId');
    return { skip: 'contact_deleted' };
  }
  if (owner.threadId === undefined) {
    // The group this add belonged to is gone (a pointer cleared, or the add was
    // deferred against a thread that never survived): there is nothing to join.
    return { skip: 'group_closed' };
  }
  const conversation = await readConversation(owner.threadId, deps);
  // A POINTER THAT WILL NOT LOAD is the resolver's 'unavailable' (missing or a
  // read failure alike): claim nothing, retry next tick. Never a skip - a blip
  // must not retire a real add.
  if (conversation === 'unreadable' || conversation === undefined) return { wait: true };
  // Spec section 7: a closed group is never announced into.
  if (conversation.status === 'closed') return { skip: 'group_closed' };
  // A CONNECTING group has no pool number yet, so services/relayMembers refuses
  // every member mutation on it (409 group_connecting) - and that refusal is
  // raised AFTER the claim, where it would silently lose the add. Connecting is
  // TRANSIENT (the number is on its way), so this is the 'unavailable' idiom:
  // claim nothing, retry next tick. Never a skip - the add is still wanted.
  if (conversation.status === 'connecting') return { wait: true };

  let contact;
  try {
    contact = await deps.contacts.getById(contactId);
  } catch (err) {
    log.warn({ err, actionId: row.actionId }, 'roster action: contact read failed - retrying next tick');
    return { wait: true };
  }
  // 'contact_deleted' covers the person being UNUSABLE, not only absent: a
  // contact with no phone cannot be put on a relay at all (the add path would
  // refuse), and the card's notice reads the same either way.
  if (!contact || isDeleted(contact)) return { skip: 'contact_deleted' };
  const phone = typeof contact.phone === 'string' ? contact.phone : '';
  if (phone.length === 0) return { skip: 'contact_deleted' };

  const participants = conversation.participants ?? [];
  if (participants.some((p) => p.contactId === contactId || p.phone === phone)) {
    return { skip: 'already_member' };
  }
  if (await removedWhilePending(row, contactId, owner.threadId, deps, log)) {
    return { skip: 'member_no_longer_on_roster' };
  }
  return { act: 'add', conversationId: owner.threadId, contactId, phone };
}

/** Read a conversation, distinguishing "gone" from "could not be read" (A21). */
async function readConversation(
  conversationId: string,
  deps: RosterActionDepsBase,
): Promise<ConversationItem | undefined | 'unreadable'> {
  try {
    return await deps.conversations.getById(conversationId);
  } catch {
    return 'unreadable';
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** Tell the hubs this owner's roster payload changed. Best-effort by design:
 *  a live-update poke must never turn a completed apply into a failure. */
async function pokeOwner(
  owner: RosterActionOwner,
  row: PendingRosterActionItem,
  log: Logger,
): Promise<void> {
  try {
    await owner.emitUpdated();
  } catch (err) {
    log.warn(
      { err, actionId: row.actionId },
      'roster action: live-update poke failed - the card refreshes on its next read',
    );
  }
}

async function applyAction(
  row: PendingRosterActionItem,
  nowIso: string,
  owner: RosterActionOwner,
  deps: RosterActionDepsBase,
): Promise<RosterActionOutcome> {
  const log = deps.logger ?? defaultLogger;
  const verdict = await validateAction(row, owner, deps, log);

  if ('wait' in verdict) {
    log.warn(
      { actionId: row.actionId, action: row.action },
      'roster action: world unreadable - leaving the row unclaimed for the next tick',
    );
    return { result: 'waiting' };
  }

  if ('skip' in verdict) {
    const claimed = await deps.actions.claimSkip(row.actionId, nowIso, verdict.skip);
    if (!claimed) return { result: 'lost' };
    log.info(
      { actionId: row.actionId, action: row.action, reason: verdict.skip },
      'roster action retired without applying (visible skip)',
    );
    // The card is showing "Joins at 8:00 AM" for a row that just became a skip
    // NOTICE, and a skip touches neither the owner nor a conversation - so this
    // is the only thing that can tell an open hub to re-read (PL5).
    await pokeOwner(owner, row, log);
    return { result: 'skipped', reason: verdict.skip };
  }

  // CLAIM BEFORE ACTING: the stamp is what makes an open/announce happen once.
  const claimed = await deps.actions.claimApply(row.actionId, nowIso);
  if (!claimed) return { result: 'lost' };

  // Past the claim the row is TERMINAL and nothing retries it, so an UNEXPECTED
  // throw from here is a change that is gone: the pending banner disappears and
  // nothing happened. Say so at error level (the logger stamps correlationId) -
  // the claim itself stays one-way, exactly as designed. The poll's per-row
  // catch also logs, but apply-now (routes) has no such net.
  try {
    const outcome = await performClaimedAction(row, verdict, owner, deps, log);
    // Same reason as the skip above: the pending banner has to go away even when
    // the apply itself emitted nothing (a noop, or a refusal). A duplicate poke
    // is harmless - the hub's refetch is debounced.
    await pokeOwner(owner, row, log);
    return outcome;
  } catch (err) {
    log.error(
      { err, actionId: row.actionId, ownerType: row.ownerType, action: row.action },
      'roster action: UNEXPECTED failure AFTER the claim - the action did not happen and will not retry',
    );
    throw err;
  }
}

/** The claimed half of an apply. Split out so EVERY throw past the one-way claim
 *  is logged in one place (see applyAction's try/catch). */
async function performClaimedAction(
  row: PendingRosterActionItem,
  verdict: { act: 'open' } | { act: 'noop' } | { act: 'add'; conversationId: string; contactId: string; phone: string },
  owner: RosterActionOwner,
  deps: RosterActionDepsBase,
  log: Logger,
): Promise<RosterActionOutcome> {
  if (verdict.act === 'noop') {
    log.info(
      { actionId: row.actionId },
      'roster action: the group was already open - retired with nothing to do',
    );
    return { result: 'applied' };
  }

  if (verdict.act === 'open') {
    const opened = await owner.openGroup();
    if (!opened.ok) {
      // Post-claim refusal. The two PREDICTABLE ones are pre-empted above
      // (roster_too_thin, provisioning_unavailable), so what is left is a race
      // (someone else opened/closed it between validate and act) or a
      // provisioning failure. The claim stands - this NEVER retries - so log
      // loudly: the operator sees no group and no pending banner, and opens it
      // again by hand.
      log.error(
        { actionId: row.actionId, refusal: opened.refusal?.body },
        'roster action: deferred open REFUSED after the claim - nothing was provisioned',
      );
    }
    return { result: 'applied' };
  }

  // add_member - WITH the announcement (the whole point of deferring it).
  const memberDeps: RelayMemberDeps = {
    conversations: deps.conversations,
    contacts: deps.contacts,
    audit: deps.audit,
    activityEvents: deps.activityEvents,
    poolNumbers: deps.poolNumbers,
    events: deps.events,
    log,
  };
  const added = await addMemberToRelay(
    memberDeps,
    verdict.conversationId,
    { contactId: verdict.contactId, phone: verdict.phone },
    { announce: true },
  );
  if (!added.ok) {
    log.error(
      { actionId: row.actionId, error: added.refusal.error },
      'roster action: deferred add REFUSED after the claim - the member was not added',
    );
  }
  return { result: 'applied' };
}

/** Apply ONE tour-owned action (the poll's per-row body, and apply-now). */
export async function applyTourRosterAction(
  row: PendingRosterActionItem,
  nowIso: string,
  deps: TourRosterActionDeps,
): Promise<RosterActionOutcome> {
  return applyAction(row, nowIso, await loadTourOwner(row.ownerId, deps), deps);
}

/** Apply ONE placement-owned action. */
export async function applyPlacementRosterAction(
  row: PendingRosterActionItem,
  nowIso: string,
  deps: PlacementRosterActionDeps,
): Promise<RosterActionOutcome> {
  return applyAction(row, nowIso, await loadPlacementOwner(row.ownerId, deps), deps);
}

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

/**
 * The stateless poll handler (state is the DynamoDB rows). Queries every pending
 * action due at or before `now` and applies it, isolating per-row errors so one
 * bad row never blocks the batch. Designed to be called by a setInterval in
 * worker.ts - and by POST /__dev/roster-actions/tick for deterministic e2e.
 */
export async function runDuePendingRosterActions(
  nowIso: string,
  deps: RunDuePendingRosterActionsDeps,
): Promise<void> {
  const log = deps.logger ?? defaultLogger;

  const dueRows = await deps.actions.listDue(nowIso);
  if (dueRows.length === 0) return;

  log.info({ count: dueRows.length, now: nowIso }, 'roster action poll: processing due rows');

  for (const row of dueRows) {
    try {
      const outcome =
        row.ownerType === 'tour'
          ? await applyTourRosterAction(row, nowIso, deps)
          : await applyPlacementRosterAction(row, nowIso, deps);
      log.debug(
        { actionId: row.actionId, action: row.action, outcome: outcome.result },
        'roster action processed',
      );
    } catch (err) {
      // Per-row isolation: log + continue. The row stays pending unless a claim
      // already landed, so a transient failure retries on the next tick.
      log.error(
        { err, actionId: row.actionId, ownerType: row.ownerType, action: row.action },
        'roster action poll: unexpected error processing row',
      );
    }
  }
}
