// Opening a tour's / placement's relay group - the ONE implementation of
// "provision the relay group for this owner" (contact-rosters Task 13).
//
// Extracted VERBATIM from the two route bodies (routes/tours.ts POST
// /:tourId/relay, routes/placements.ts POST /:placementId/relay) so the routes
// AND the quiet-hours poller (jobs/rosterActions.ts) run the SAME flow:
//
//   resolve the roster (the ONE resolver) -> reachable, phone-de-duplicated
//   members -> too-thin refusal -> claim -> provisionRelayGroup -> write the
//   thread pointer -> CONSUME the plan (only after a successful pointer write)
//   -> audit + roster milestone + owner event.
//
// A second copy of that sequence is how a deferred open and an immediate open
// start disagreeing about who is on the thread, whether the plan was consumed,
// or which milestone was pinned. Deferral is the whole reason this exists: the
// poller applies an open HOURS after the operator confirmed it, and D7 says the
// plan resolves AT APPLY TIME - so the poller cannot pre-compute members and
// hand them to a thin "provision" helper; it has to run this.
//
// The functions REFUSE rather than respond: they return { status, body } and
// the route renders it verbatim, so the wire contract of both routes is
// unchanged (the same tokens, the same detail strings, the same order of
// checks). The poller maps the same refusals onto skip reasons.
//
// PII (doc section 9): logs carry ids/counts only - never a phone or a name.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { EventBus } from '../lib/events.js';
import { toPlacementUpdatedEvent } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';
import { zipFive } from '../lib/address.js';
import { normalizeToE164 } from '../lib/phone.js';
import { recordRosterMilestone } from '../lib/personEvents.js';
import {
  resolveRoster,
  type ResolvedRoster,
  type RosterOwner,
} from '../lib/rosterResolution.js';
import { VoiceCapabilityError } from '../adapters/messaging.js';
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
import {
  type ConversationItem,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import type { PlacementDeadlinesRepo } from '../repos/placementDeadlinesRepo.js';
import { soonestDeadline } from '../repos/placementDeadlinesRepo.js';
import type { PlacementItem, PlacementsRepo } from '../repos/placementsRepo.js';
import type { TourItem, ToursRepo } from '../repos/toursRepo.js';
import { unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';
import { TERMINAL_STAGES } from '../lib/statusModel.js';
import {
  RelayProvisioningDisabledError,
  RELAY_PROVISIONING_DISABLED_MESSAGE,
  type PoolNumbersService,
} from './poolNumbers.js';
import { provisionRelayGroup } from './relayProvisioning.js';

/** A refusal the caller renders verbatim (each route's exact wire contract). */
export interface RosterOpenRefusal {
  status: number;
  body: Record<string, unknown>;
}

/** Everything an open touches, minus the owner repo. Both routers hold all of it. */
export interface RosterProvisionDeps {
  conversations: ConversationsRepo;
  contacts: ContactsRepo;
  units: UnitsRepo;
  audit: AuditRepo;
  activityEvents: ActivityEventsRepo;
  poolNumbers: PoolNumbersService;
  events: EventBus;
  log: Logger;
}

export interface OpenTourGroupDeps extends RosterProvisionDeps {
  tours: ToursRepo;
}

export interface OpenPlacementGroupDeps extends RosterProvisionDeps {
  placements: PlacementsRepo;
  /** The placement.updated payload carries the recomputed soonest deadline. */
  placementDeadlines: PlacementDeadlinesRepo;
}

export type OpenTourGroupResult =
  | { ok: true; tour: TourItem; conversation: ConversationItem }
  | { ok: false; refusal: RosterOpenRefusal };

export type OpenPlacementGroupResult =
  | { ok: true; placement: PlacementItem; conversation: ConversationItem }
  | { ok: false; refusal: RosterOpenRefusal };

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * The members PROVISION puts on the thread: the resolved roster's phone-bearing
 * entries, ONE slot per number (relay routing is keyed by phone, so two people
 * sharing a handset are one party). A member with no phone is EXCLUDED rather
 * than failing the open - who is reachable is the roster's business.
 */
export function provisionMembersOf(resolved: ResolvedRoster): ConversationParticipant[] {
  const members: ConversationParticipant[] = [];
  const seenPhones = new Set<string>();
  for (const member of resolved.members) {
    const phone = member.phone;
    if (typeof phone !== 'string' || phone.length === 0) continue; // unreachable member
    if (seenPhones.has(phone)) continue; // one slot per number (shared phones)
    seenPhones.add(phone);
    members.push({
      phone,
      contactId: member.contactId ?? '',
      ...(member.name !== undefined && { name: member.name }),
    });
  }
  return members;
}

/**
 * The property-ZIP hint for a potential tier-3 buy (area-code preference).
 * Best-effort - a missing unit/address (or a repo hiccup) just means no hint,
 * never a failed group creation.
 */
async function postalCodeHint(
  deps: RosterProvisionDeps,
  unitId: string,
  ownerLog: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    return zipFive((await deps.units.getById(unitId))?.address);
  } catch (err) {
    deps.log.warn(
      { err, ...ownerLog },
      'roster open: unit ZIP hint lookup failed - creating the group without the hint',
    );
    return undefined;
  }
}

/**
 * The guard both the tour route and the poller apply BEFORE anything else: a
 * dead tour gets no group thread (a stale page's click must not buy a pool
 * number and text intros for a canceled/closed tour), and a tour that already
 * carries a pointer is never provisioned twice.
 */
export function tourOpenGuard(tour: TourItem): RosterOpenRefusal | undefined {
  if (tour.status === 'canceled' || tour.status === 'closed') {
    return {
      status: 409,
      body: {
        error: 'tour_not_active',
        detail: `cannot open a group thread on a ${tour.status} tour`,
      },
    };
  }
  if (typeof tour.groupThreadId === 'string' && tour.groupThreadId.length > 0) {
    return { status: 409, body: { error: 'relay_already_provisioned' } };
  }
  return undefined;
}

/**
 * The kill-switch refusal, identical to the one the immediate path renders when
 * provisioning throws from inside the open (both owners answer this body).
 */
function provisioningDisabledRefusal(): RosterOpenRefusal {
  return {
    status: 503,
    body: { error: 'relay_provisioning_disabled', message: RELAY_PROVISIONING_DISABLED_MESSAGE },
  };
}

// ---------------------------------------------------------------------------
// Tours
// ---------------------------------------------------------------------------

/** The resolver's owner view of a tour (thread pointer + plan override). */
export function tourRosterOwner(tour: TourItem): RosterOwner {
  return {
    type: 'tour',
    id: tour.tourId,
    tenantId: tour.tenantId,
    unitId: tour.unitId,
    ...(tour.groupThreadId !== undefined && { groupThreadId: tour.groupThreadId }),
    ...(tour.roster !== undefined && { roster: tour.roster }),
  };
}

/**
 * Resolve the tour's roster into relay members, or name the rung that failed.
 * The six detail strings are the dashboard's error copy and are asserted
 * verbatim by the API tests - do not reword them here.
 */
async function resolveTourMembers(
  deps: OpenTourGroupDeps,
  tour: TourItem,
): Promise<{ members: ConversationParticipant[] } | { unresolvable: string }> {
  const resolved = await resolveRoster(
    { conversations: deps.conversations, units: deps.units, contacts: deps.contacts, log: deps.log },
    tourRosterOwner(tour),
  );
  // Unreachable from the route (the one-thread-per-tour guard already refused a
  // tour carrying a pointer), but the resolver's contract is explicit: an
  // unreadable thread is NEVER silently re-resolved.
  if (resolved.source === 'unavailable') {
    return { unresolvable: 'the group thread could not be read' };
  }

  const members = provisionMembersOf(resolved);
  if (members.length >= 2) return { members };

  // Too thin to relay. Name the rung that failed.
  if (resolved.source === 'plan') {
    return { unresolvable: 'this tour roster has fewer than two reachable members' };
  }
  const tenant = await deps.contacts.getById(tour.tenantId);
  if (!tenant) return { unresolvable: 'tenant contact not found' };
  const tenantPhone =
    typeof tenant.phone === 'string' && tenant.phone.length > 0
      ? normalizeToE164(tenant.phone)
      : undefined;
  if (tenantPhone === undefined) return { unresolvable: 'tenant contact has no phone' };

  const unit = await deps.units.getById(tour.unitId);
  if (!unit) return { unresolvable: 'unit not found (cannot resolve landlord)' };
  // The property's contact is the primaryContact row, falling back to the
  // landlord of record (D3) - the same ladder the resolver walked.
  const propertyContactId =
    unitContacts(unit).find((c) => c.primaryContact === true)?.contactId ??
    (typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined);
  if (propertyContactId === undefined) {
    return { unresolvable: 'unit has no landlord (cannot resolve landlord)' };
  }
  const landlord = await deps.contacts.getById(propertyContactId);
  if (!landlord) return { unresolvable: 'landlord contact not found' };
  const landlordPhone =
    typeof landlord.phone === 'string' && landlord.phone.length > 0
      ? normalizeToE164(landlord.phone)
      : undefined;
  if (landlordPhone === undefined) return { unresolvable: 'landlord contact has no phone' };
  // Both rungs resolve and share ONE number (tenant === property contact): a
  // relay needs two distinct parties.
  return { unresolvable: 'this tour roster has fewer than two reachable members' };
}

/**
 * WHAT A QUIET-HOURS DEFERRAL MUST STILL REFUSE (spec 6.2: "The route keeps its
 * guard regardless"). Deferring is a promise that this open will happen at
 * quiet-end - so a click the server ALREADY KNOWS it must refuse has to be
 * refused NOW, in the immediate path's exact wire shape, rather than answered
 * 202 with an "Opens at 8:00 AM" banner that resolves hours later into a skip
 * notice nobody is watching for.
 *
 * These are precisely the two checks the poller runs PRE-CLAIM against the same
 * world (jobs/rosterActions: 'roster_too_thin', 'provisioning_unavailable'):
 *
 *   1. a roster too thin to relay -> the immediate 400 (each owner's ladder),
 *   2. relay live provisioning off -> the immediate 503.
 *
 * Reads only, and deliberately NOT a copy of the dead-owner / already-open
 * guards (the routes run those first, before any body parsing). The resolver's
 * 'unavailable' is deliberately NOT a refusal here either: the poller WAITS on
 * an unreadable world rather than skipping, so that deferral still stands.
 */
export async function tourOpenDeferralRefusal(
  deps: OpenTourGroupDeps,
  tour: TourItem,
  relayLiveProvisioning: boolean,
): Promise<RosterOpenRefusal | undefined> {
  // 'unavailable' cannot reach this line: tourOpenGuard already refused every
  // tour carrying a pointer, and the resolver only reports it FOR a pointer.
  const resolved = await resolveTourMembers(deps, tour);
  if ('unresolvable' in resolved) {
    return {
      status: 400,
      body: { error: 'relay_member_unresolvable', detail: resolved.unresolvable },
    };
  }
  if (!relayLiveProvisioning) return provisioningDisabledRefusal();
  return undefined;
}

/**
 * Open the tour's masked relay group.
 *
 * `members` (the route's explicit-members body) bypasses roster resolution;
 * omit it for the founder/auto path AND for every deferred apply - a deferred
 * open must resolve the plan at APPLY time (D7).
 */
export async function openTourGroup(
  deps: OpenTourGroupDeps,
  tour: TourItem,
  opts: { actor?: string; members?: ConversationParticipant[]; introBody?: string } = {},
): Promise<OpenTourGroupResult> {
  const { log } = deps;
  const tourId = tour.tourId;
  const actor = opts.actor;

  const guard = tourOpenGuard(tour);
  if (guard !== undefined) return { ok: false, refusal: guard };

  let members: ConversationParticipant[];
  if (opts.members !== undefined) {
    members = opts.members;
  } else {
    const resolved = await resolveTourMembers(deps, tour);
    if ('unresolvable' in resolved) {
      return {
        ok: false,
        refusal: {
          status: 400,
          body: { error: 'relay_member_unresolvable', detail: resolved.unresolvable },
        },
      };
    }
    members = resolved.members;
  }

  const postalCode = await postalCodeHint(deps, tour.unitId, { tourId });

  // Atomically claim the group-thread slot BEFORE buying anything: the read
  // guard above is check-then-act, so two overlapping opens could both pass it,
  // buy two pool numbers, and orphan the first thread. The claim's
  // ConditionExpression (attribute_not_exists(groupThreadId)) makes the race
  // loser refuse here, before any provisioning side effects. The sentinel is
  // replaced by the real conversation id on success and released on failure; a
  // crash inside this window leaves the sentinel behind (rare - clears by
  // removing groupThreadId), which we prefer over the double-buy.
  const claimSentinel = `provisioning:${tourId}`;
  try {
    await deps.tours.claimGroupThread(tourId, claimSentinel);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { ok: false, refusal: { status: 409, body: { error: 'relay_already_provisioned' } } };
    }
    throw err;
  }

  // Provision the relay group owned by this tour.
  let conversation: ConversationItem;
  try {
    conversation = await provisionRelayGroup(
      {
        conversationsRepo: deps.conversations,
        poolNumbersService: deps.poolNumbers,
        auditRepo: deps.audit,
        events: deps.events,
        logger: log,
      },
      {
        members,
        owner: { type: 'tour', id: tourId },
        ...(actor !== undefined && { actor }),
        ...(postalCode !== undefined && { postalCode }),
        ...(opts.introBody !== undefined && { introBody: opts.introBody }),
      },
    );
  } catch (err) {
    // Provisioning failed - release the claim so a retry can provision.
    await deps.tours.releaseGroupThreadClaim(tourId, claimSentinel);
    if (err instanceof RelayProvisioningDisabledError) {
      log.warn({ err: { name: err.name }, tourId }, 'tour relay create: number provisioning disabled');
      return {
        ok: false,
        refusal: {
          status: 503,
          body: { error: 'relay_provisioning_disabled', message: (err as Error).message },
        },
      };
    }
    if (err instanceof VoiceCapabilityError) {
      log.error({ err: { name: err.name }, tourId }, 'tour relay create: no voice-capable pool number available');
      return {
        ok: false,
        refusal: {
          status: 503,
          body: { error: 'relay_provisioning_failed', message: (err as Error).message },
        },
      };
    }
    throw err;
  }

  // Stamp the real groupThreadId over the claim sentinel - the ONE write that
  // turns the claim into a pointer, and therefore the one that must not fail
  // unguarded: an unguarded transient failure here left the sentinel on the
  // tour FOREVER (every later open refuses relay_already_provisioned, every
  // resolver read goes 'unavailable', and no code path ever clears it). So
  // RELEASE the claim, say loudly that a provisioned group is now unpointered
  // (the known no-atomic-claim class - ids only, never members), and let the
  // failure propagate in this route's existing shape (the 500 handler).
  let updatedTour: TourItem;
  try {
    updatedTour = await deps.tours.patch(tourId, { groupThreadId: conversation.conversationId });
  } catch (err) {
    try {
      await deps.tours.releaseGroupThreadClaim(tourId, claimSentinel);
    } catch (releaseErr) {
      log.error(
        { err: releaseErr, tourId },
        'tour relay: releasing the claim after a failed pointer write ALSO failed - the tour is stuck on its provisioning sentinel until groupThreadId is removed by hand',
      );
    }
    log.error(
      { err, tourId, conversationId: conversation.conversationId },
      'tour relay: writing the group-thread pointer FAILED - claim released and the plan kept, but the provisioned group has no owner pointing at it',
    );
    throw err;
  }

  // THE PLAN IS CONSUMED (spec D1) - and only now, AFTER the thread pointer is
  // written. From here the conversation's participants are the roster, so a
  // second persisted roster must not survive to disagree with them. Order
  // matters both ways: clearing BEFORE the pointer write would lose the plan on
  // a failed stamp, and a crash BETWEEN the two leaves a stale plan that is
  // INERT by precedence (the resolver reads participants first whenever the
  // pointer is set) - never "defensively" merge it back in.
  if (updatedTour.roster !== undefined) {
    try {
      await deps.tours.clearRoster(tourId);
      updatedTour = { ...updatedTour };
      delete updatedTour.roster;
      delete updatedTour.rosterVersion;
    } catch (err) {
      log.error({ err, tourId }, 'tour relay: clearing the consumed roster plan failed (inert leftover)');
    }
  }

  // Connect-when-ready (T6): the group may be CONNECTING (no number yet) rather
  // than open - "opened" would be premature, so mark the audit/log accordingly.
  const connecting = conversation.status === 'connecting';

  // Tour-history milestone: a tours#<tourId> audit row carrying the opened
  // thread id. Best-effort: a failed write must never fail the open. IDs only.
  try {
    await deps.audit.append(`tours#${tourId}`, 'tour_group_opened', {
      tourId,
      conversationId: conversation.conversationId,
      connecting,
      ...(actor !== undefined && { actor }),
    });
  } catch (err) {
    log.error({ err, tourId }, 'tour_group audit failed (best-effort)');
  }

  // ...and a person milestone on the feed of everyone WHO IS IN THE GROUP.
  // Roster-driven, NOT dual-party (lib/personEvents explains the split): "Relay
  // group opened" asserts membership of this conversation, so it follows
  // `members` - the roster we just provisioned - the same way
  // added_to_group_text follows the member it names. The pin fires even on the
  // `connecting` path (no pool number yet): parity, not a new claim.
  await recordRosterMilestone(
    { activityEvents: deps.activityEvents, log },
    {
      members,
      type: 'tour_group_opened',
      label: 'Relay group opened',
      refType: 'tour',
      refId: tourId,
    },
  );

  // Live tour-page refresh: ID + status only (no PII).
  deps.events.emit('tour.updated', { tourId, status: updatedTour.status });

  log.info(
    { tourId, conversationId: conversation.conversationId, memberCount: members.length, connecting },
    connecting ? 'tour relay group provisioned (connecting - awaiting number)' : 'tour relay group provisioned',
  );
  return { ok: true, tour: updatedTour, conversation };
}

// ---------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------

/** The resolver's owner view of a placement (`group_thread` is the pointer). */
export function placementRosterOwner(item: PlacementItem): RosterOwner {
  return {
    type: 'placement',
    id: item.placementId,
    tenantId: item.tenantId,
    unitId: item.unitId,
    ...(typeof item.group_thread === 'string' && { groupThreadId: item.group_thread }),
    ...(item.roster !== undefined && { roster: item.roster }),
  };
}

/**
 * Name the rung that left a placement roster too thin to relay. The three
 * legacy codes (tenant_unreachable / unit_not_found / landlord_unreachable) are
 * the dashboard's error copy and are preserved verbatim for the PROPERTY
 * DEFAULT - the only source that had them before rosters existed. A roster the
 * operator chose (a plan, or a previous thread's members) cannot be described by
 * that ladder, so it refuses with the tours-style code instead.
 */
async function describeThinPlacementRoster(
  deps: OpenPlacementGroupDeps,
  item: PlacementItem,
  source: 'participants' | 'plan' | 'default',
): Promise<RosterOpenRefusal> {
  if (source !== 'default') {
    return {
      status: 400,
      body: {
        error: 'relay_member_unresolvable',
        detail: 'this placement roster has fewer than two reachable members',
      },
    };
  }
  const tenant = await deps.contacts.getById(item.tenantId);
  if (!tenant || typeof tenant.phone !== 'string' || tenant.phone.length === 0) {
    return {
      status: 400,
      body: { error: 'tenant_unreachable', message: 'the placement tenant has no phone on file' },
    };
  }
  const unit = await deps.units.getById(item.unitId);
  if (!unit) return { status: 400, body: { error: 'unit_not_found' } };
  const propertyContactId =
    unitContacts(unit).find((c) => c.primaryContact === true)?.contactId ?? unit.landlordId;
  const landlord =
    typeof propertyContactId === 'string' && propertyContactId.length > 0
      ? await deps.contacts.getById(propertyContactId)
      : undefined;
  if (!landlord || typeof landlord.phone !== 'string' || landlord.phone.length === 0) {
    return {
      status: 400,
      body: { error: 'landlord_unreachable', message: 'the unit landlord has no phone on file' },
    };
  }
  // Both rungs resolve and share ONE number (the tenant IS the property
  // contact): a relay needs two distinct parties.
  return {
    status: 400,
    body: {
      error: 'relay_member_unresolvable',
      detail: 'this placement roster has fewer than two reachable members',
    },
  };
}

/**
 * The placement twin of `tourOpenGuard`, minus the pointer check (which needs a
 * conversation READ - an OPEN or CONNECTING relay is what blocks a re-open, a
 * closed one does not). A terminal placement gets no new relay group.
 */
export function placementOpenGuard(item: PlacementItem): RosterOpenRefusal | undefined {
  if (TERMINAL_STAGES.has(item.stage)) {
    return {
      status: 409,
      body: {
        error: 'placement_not_active',
        detail: `cannot open a relay group on a ${item.stage} placement`,
      },
    };
  }
  return undefined;
}

/**
 * The placement twin of `tourOpenDeferralRefusal` (same contract, same two
 * checks, this owner's refusal ladder). An 'unavailable' roster - a closed or
 * unreadable pointer, which this owner's guard does NOT refuse - defers as
 * before: the poller waits on it, so the deferral is still honest.
 */
export async function placementOpenDeferralRefusal(
  deps: OpenPlacementGroupDeps,
  item: PlacementItem,
  relayLiveProvisioning: boolean,
): Promise<RosterOpenRefusal | undefined> {
  const resolved = await resolveRoster(
    { conversations: deps.conversations, units: deps.units, contacts: deps.contacts, log: deps.log },
    placementRosterOwner(item),
  );
  if (resolved.source === 'unavailable') return undefined;
  if (provisionMembersOf(resolved).length < 2) {
    return await describeThinPlacementRoster(deps, item, resolved.source);
  }
  if (!relayLiveProvisioning) return provisioningDisabledRefusal();
  return undefined;
}

/** Open the placement's masked relay group (the twin of openTourGroup). */
export async function openPlacementGroup(
  deps: OpenPlacementGroupDeps,
  item: PlacementItem,
  opts: { actor?: string; introBody?: string } = {},
): Promise<OpenPlacementGroupResult> {
  const { log } = deps;
  const placementId = item.placementId;
  const actor = opts.actor;

  // Idempotency (D10): an OPEN *or CONNECTING* relay already fronts this
  // placement -> never double-provision. A connecting group is mid-buy (its warm
  // number has not registered yet); treating it as "already provisioned" stops a
  // re-click from buying a SECOND number for the same placement.
  if (typeof item.group_thread === 'string' && item.group_thread.length > 0) {
    const existing = await deps.conversations.getById(item.group_thread);
    if (
      existing &&
      existing.type === 'relay_group' &&
      (existing.status === 'open' || existing.status === 'connecting')
    ) {
      return { ok: false, refusal: { status: 409, body: { error: 'relay_exists', conversation: existing } } };
    }
  }

  // Resolve the roster through the ONE shared resolver: the roster PLAN when the
  // operator materialized one, else the property default (tenant + the unit's
  // primaryContact, with the landlord-of-record fallback). Members need an SMS
  // number to be in the relay, so a phone-less member is EXCLUDED and a roster
  // that cannot muster two reachable people refuses - never a half-roster relay.
  const resolved = await resolveRoster(
    { conversations: deps.conversations, units: deps.units, contacts: deps.contacts, log },
    placementRosterOwner(item),
  );
  if (resolved.source === 'unavailable') {
    // A pointer that will not load is NEVER silently re-resolved from the
    // property (spec D1) - refuse and let the operator retry.
    return {
      ok: false,
      refusal: {
        status: 400,
        body: { error: 'relay_member_unresolvable', detail: 'the group thread could not be read' },
      },
    };
  }

  const members = provisionMembersOf(resolved);
  if (members.length < 2) {
    return { ok: false, refusal: await describeThinPlacementRoster(deps, item, resolved.source) };
  }

  const tag =
    typeof item.placement_tag === 'string' && item.placement_tag.length > 0
      ? item.placement_tag
      : undefined;
  const postalCode = await postalCodeHint(deps, item.unitId, { placementId });

  let conversation: ConversationItem;
  try {
    conversation = await provisionRelayGroup(
      {
        conversationsRepo: deps.conversations,
        poolNumbersService: deps.poolNumbers,
        auditRepo: deps.audit,
        events: deps.events,
        logger: log,
      },
      {
        members,
        placementId,
        ...(tag !== undefined && { tag }),
        ...(actor !== undefined && { actor }),
        ...(postalCode !== undefined && { postalCode }),
        ...(opts.introBody !== undefined && { introBody: opts.introBody }),
      },
    );
  } catch (err) {
    // Kill-switch (M1.7): live provisioning is off pre-A2P - no number bought.
    if (err instanceof RelayProvisioningDisabledError) {
      log.warn({ err: { name: err.name }, placementId, actor }, 'placement relay: number provisioning disabled');
      await deps.audit.append(`placements#${placementId}`, 'relay_provisioning_disabled', {
        actor,
        reason: 'placement',
      });
      return {
        ok: false,
        refusal: { status: 503, body: { error: 'relay_provisioning_disabled', message: err.message } },
      };
    }
    if (err instanceof VoiceCapabilityError) {
      log.error({ err: { name: err.name }, placementId }, 'placement relay: no voice-capable pool number available');
      return { ok: false, refusal: { status: 503, body: { error: 'pool_number_unavailable' } } };
    }
    throw err;
  }

  // Link the placement -> its relay thread. The conversation already carries
  // placementId (the back-reference, set at createRelayGroup); a link-write
  // failure is logged, not fatal (the conversation.placementId back-ref still
  // resolves it).
  let updatedPlacement = item;
  let linked = false;
  try {
    updatedPlacement = await deps.placements.update(placementId, {
      group_thread: conversation.conversationId,
    });
    linked = true;
  } catch (err) {
    log.error(
      { err, placementId, conversationId: conversation.conversationId },
      'placement relay: linking group_thread failed - relay created',
    );
  }

  // THE PLAN IS CONSUMED (spec D1) - and only after the thread pointer write
  // SUCCEEDS (A8). On a failed link the plan deliberately STAYS: the placement
  // has no pointer, so the resolver is still in plan mode and dropping it would
  // strand the operator's roster.
  if (linked && updatedPlacement.roster !== undefined) {
    try {
      await deps.placements.clearRoster(placementId);
      updatedPlacement = { ...updatedPlacement };
      delete updatedPlacement.roster;
      delete updatedPlacement.rosterVersion;
    } catch (err) {
      log.error({ err, placementId }, 'placement relay: clearing the consumed roster plan failed (inert leftover)');
    }
  }
  await deps.audit.append(`placements#${placementId}`, 'placement_relay_provisioned', {
    actor,
    conversationId: conversation.conversationId,
  });
  // ...and a person milestone on the feed of everyone WHO IS IN THE GROUP (spec
  // D8). Roster-driven, NOT dual-party. A member who was unreachable at open is
  // not in that fan-out and gets NO pin: pins are facts about texts.
  await recordRosterMilestone(
    { activityEvents: deps.activityEvents, log },
    {
      members,
      type: 'placement_group_opened',
      label: 'Relay group opened',
      refType: 'placement',
      refId: placementId,
    },
  );
  await emitPlacementUpdated(deps, updatedPlacement);
  log.info(
    { placementId, conversationId: conversation.conversationId, actor },
    'placement relay thread provisioned via api',
  );
  return { ok: true, placement: updatedPlacement, conversation };
}

/** Emit placement.updated with the recomputed soonest deadline (one query).
 *  Exported because the roster-action poller pokes the same event when it
 *  RESOLVES a deferral (a skip changes the card's notices without touching the
 *  placement itself, so nothing else would emit). */
export async function emitPlacementUpdated(
  deps: OpenPlacementGroupDeps,
  placement: PlacementItem,
): Promise<void> {
  const deadlines = await deps.placementDeadlines.listByPlacement(placement.placementId);
  deps.events.emit('placement.updated', toPlacementUpdatedEvent(placement, soonestDeadline(deadlines)));
}
