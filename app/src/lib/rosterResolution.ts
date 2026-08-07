// The ONE shared tour/placement roster resolver (contact-rosters spec D1/D3/5.2).
//
// PLAN vs FACT. A roster has exactly one source of truth at any moment, and
// WHICH source is decided by one question: does a relay thread exist for this
// owner?
//
//   NO THREAD  -> the roster is a PLAN: the `roster` override when the operator
//                 materialized one, else the property default (the tenant plus
//                 the unit's primary contact, falling back to the landlord of
//                 record when no roster row is primary).
//   A THREAD   -> the roster is a FACT: `relay.participants` on that
//                 conversation, in ANY status - open, connecting, or CLOSED.
//                 Reopen is a pure status flip, so a close-edit-reopen sequence
//                 must land on the participants, not on a plan reopen ignores.
//
// THE CARDINAL RULE - do not "improve" this into a fallback: WHEN THE POINTER
// IS SET BUT THE CONVERSATION READ FAILS OR RETURNS NOTHING, the answer is
// source 'unavailable' with NO members. It never falls through to the plan or
// the default. By the time a pointer exists the plan was CONSUMED at provision,
// so the fallback would serve exactly the roster the operator edited away from:
// the People card would silently show the wrong people, and the D11 reminder
// check could text a removed tenant on a Dynamo blip. "Never 500 a page" is
// right; "never be wrong about who gets texted" outranks it. Callers handle
// 'unavailable' explicitly (card: an unavailable state with a retry; reminders:
// leave the rung unclaimed).
//
// Every repo read here is try/caught for the same reason - resolution feeds
// page loads, so a repo hiccup degrades the answer, never the response.
//
// PHONES ARE NORMALIZED TO E.164 ON EVERY PLAN/DEFAULT PATH (the storage
// convention). Participants are returned with the phone STORED ON THE ROW: in
// fact mode the fan-out sends to that stored number, so deliverability and the
// recipient count must be derived from it and never from the contact's current
// phone.
//
// PII (doc section 9): ids and counts only - never phones or names in logs.
import type { Logger } from './logger.js';
import { normalizeToE164 } from './phone.js';
import { isDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';
import { relayMemberKey } from '../repos/messagesRepo.js';
import type {
  PendingRosterActionItem,
  PendingRosterActionsRepo,
  RosterActionKind,
  RosterActionSkipReason,
} from '../repos/pendingRosterActionsRepo.js';
import { unitContacts, type UnitContact, type UnitsRepo } from '../repos/unitsRepo.js';

/** One PLAN entry: exactly one of contactId / phone (validated at write time). */
export interface RosterEntry {
  contactId?: string;
  phone?: string;
}

/**
 * A conditional plan write lost its race: either a concurrent MATERIALIZE won
 * (`attribute_not_exists(roster)` failed) or the caller's `expectedVersion` is
 * stale. Both repos throw this on ConditionalCheckFailedException so callers
 * re-read and continue onto the EXISTING override rather than overwriting it.
 */
export class RosterPlanConflictError extends Error {
  constructor(message = 'roster plan changed under this write; re-read and retry') {
    super(message);
    this.name = 'RosterPlanConflictError';
  }
}

/** The tour or placement whose roster is being resolved. */
export interface RosterOwner {
  type: 'tour' | 'placement';
  id: string;
  tenantId: string;
  unitId: string;
  /** tours: `groupThreadId`; placements: `group_thread`. Presence = a thread exists. */
  groupThreadId?: string;
  /** The plan override; absent means "resolve from the property". */
  roster?: RosterEntry[];
}

/** Which of the three sources answered - plus the unreadable-thread outcome. */
export type RosterSource = 'participants' | 'plan' | 'default' | 'unavailable';

/**
 * HOW LONG A SCHEDULED SEND WAITS ON AN 'unavailable' ROSTER (one hour).
 *
 * Both ladders (jobs/tourReminders, jobs/placementNudges) leave a tenant-routed
 * rung UNCLAIMED while the roster cannot be read - the right answer for a
 * transient blip, since the next tick retries and nothing was burned on a false
 * skip. But 'unavailable' can also be PERMANENT (a pointer at a conversation
 * that no longer exists, a provisioning sentinel a crash left behind): then the
 * rung re-lists every tick forever - never sent, never visibly skipped, and
 * nothing on the panel ever says so.
 *
 * So the wait is bounded by TIME PAST DUE: past this window the rung is retired
 * with the visible `roster_unavailable` skip. Measured from the rung's own
 * dueAt (not from when the outage started - the rows carry no such stamp), and
 * one hour is long enough that a Dynamo blip or a redeploy never trips it.
 */
export const ROSTER_UNAVAILABLE_GRACE_MS = 60 * 60 * 1000;

/**
 * Has a rung due at `dueAt` waited longer than the grace window for a roster
 * that will not resolve? An unparseable dueAt answers false - keep waiting is
 * always the safer half of this decision.
 */
export function rosterWaitExpired(dueAt: string, nowIso: string): boolean {
  const due = Date.parse(dueAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(due) || Number.isNaN(now)) return false;
  return now - due > ROSTER_UNAVAILABLE_GRACE_MS;
}

export interface ResolvedMember {
  /** Absent for bare-phone participants / plan entries. */
  contactId?: string;
  /** participants: the STORED row phone (fact mode). plan/default: E.164 from the contact. */
  phone?: string;
  name?: string;
}

export interface ResolvedRoster {
  source: RosterSource;
  members: ResolvedMember[];
}

/** Narrow structural views - every caller already holds these three repos. */
export interface RosterResolutionDeps {
  conversations: Pick<ConversationsRepo, 'getById'>;
  units: Pick<UnitsRepo, 'getById'>;
  contacts: Pick<ContactsRepo, 'getById'>;
  /**
   * Quiet-hours deferrals (spec 5.3 / 6.5), OPTIONAL: supply it and every
   * roster payload carries this owner's `pending[]` + `skipped[]`; omit it and
   * both arrays are EMPTY (never absent - one decoder rule holds for every
   * caller). resolveRoster itself never reads it: a deferred action is not
   * membership, it is a promise about membership.
   */
  actions?: Pick<PendingRosterActionsRepo, 'listByOwner'>;
  log: Logger;
}

/** Display name from a contact (mirrors relayGroups.nameFromContact, no import cycle). */
function displayName(contact: ContactItem): string | undefined {
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build a member from a contactId. A contact that cannot be read - deleted,
 * dangling, or a repo throw - KEEPS ITS ROW (spec 5.2 DANGLING IDS): the row
 * renders as "removed contact", is excluded from every send and from call
 * routing, and stays removable like any other member. Dropping it would hide a
 * member the operator can still see on the thread.
 */
async function memberFromContact(
  deps: RosterResolutionDeps,
  contactId: string,
): Promise<ResolvedMember> {
  let contact: ContactItem | undefined;
  try {
    contact = await deps.contacts.getById(contactId);
  } catch (err) {
    deps.log.warn({ err, contactId }, 'roster resolution: contact read failed - bare row kept');
  }
  if (!contact) return { contactId };
  const phone = nonEmpty(contact.phone);
  const normalized = phone !== undefined ? normalizeToE164(phone) : undefined;
  const name = displayName(contact);
  return {
    contactId,
    ...(normalized !== undefined && { phone: normalized }),
    ...(name !== undefined && { name }),
  };
}

/**
 * Resolve who is on this tour's / placement's roster, right now.
 *
 * Precedence: participants (a thread exists, any status) > plan override >
 * property default. Never throws.
 */
export async function resolveRoster(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
): Promise<ResolvedRoster> {
  // --- FACT: a thread exists -------------------------------------------------
  const threadId = nonEmpty(owner.groupThreadId);
  if (threadId !== undefined) {
    let conversation;
    try {
      conversation = await deps.conversations.getById(threadId);
    } catch (err) {
      deps.log.warn(
        { err, ownerType: owner.type, ownerId: owner.id },
        'roster resolution: thread read failed - roster unavailable',
      );
      return { source: 'unavailable', members: [] };
    }
    if (!conversation) {
      // A dangling pointer (or the tours `provisioning:<tourId>` claim sentinel,
      // which nothing loads under). Unavailable, NOT the plan/default - see the
      // cardinal rule at the top of this file.
      deps.log.warn(
        { ownerType: owner.type, ownerId: owner.id },
        'roster resolution: thread pointer resolves to nothing - roster unavailable',
      );
      return { source: 'unavailable', members: [] };
    }
    const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
    return {
      source: 'participants',
      members: participants.map((p) => {
        const contactId = nonEmpty(p.contactId);
        const name = nonEmpty(p.name);
        return {
          ...(contactId !== undefined && { contactId }),
          // The STORED phone, verbatim: it is what the fan-out will dial/text.
          ...(nonEmpty(p.phone) !== undefined && { phone: p.phone }),
          ...(name !== undefined && { name }),
        };
      }),
    };
  }

  // --- PLAN: the override, verbatim and in stored order ----------------------
  // A PRESENT array wins even when empty: the override materialized on a human
  // edit and persists until "Reset to property default" - it must never
  // silently re-resolve to the people who were edited away.
  if (Array.isArray(owner.roster)) {
    const members: ResolvedMember[] = [];
    for (const entry of owner.roster) {
      const contactId = nonEmpty(entry.contactId);
      if (contactId !== undefined) {
        members.push(await memberFromContact(deps, contactId));
        continue;
      }
      const raw = nonEmpty(entry.phone);
      if (raw === undefined) continue; // `{}` is rejected at write time; ignore here.
      // Normalize; keep the raw value when it will not parse so the row still
      // renders (and stays removable) rather than vanishing.
      members.push({ phone: normalizeToE164(raw) ?? raw });
    }
    return { source: 'plan', members };
  }

  // --- DEFAULT: the tenant + the property's primary contact ------------------
  const members: ResolvedMember[] = [];
  const tenantId = nonEmpty(owner.tenantId);
  if (tenantId !== undefined) members.push(await memberFromContact(deps, tenantId));

  let unit;
  try {
    unit = await deps.units.getById(owner.unitId);
  } catch (err) {
    deps.log.warn(
      { err, ownerType: owner.type, ownerId: owner.id, unitId: owner.unitId },
      'roster resolution: unit read failed - property contact omitted',
    );
  }
  if (!unit) return { source: 'default', members };

  // The property's default contact, with the D3 fallback: when NO roster row
  // carries primaryContact (zero-primary is legal and reachable, spec 5.1) fall
  // back to the LANDLORD OF RECORD - exactly the pre-roster behavior, so no
  // working property regresses to a too-thin roster.
  const roster = unitContacts(unit);
  const primary = roster.find((c) => c.primaryContact === true);
  const propertyContactId = primary?.contactId ?? nonEmpty(unit.landlordId);
  if (propertyContactId === undefined || propertyContactId.length === 0) {
    return { source: 'default', members };
  }
  // De-dupe the degenerate case where the tenant IS the property contact.
  if (propertyContactId !== tenantId) {
    members.push(await memberFromContact(deps, propertyContactId));
  }
  return { source: 'default', members };
}

/**
 * Is this contact on the resolved roster? Bare-phone members have no contactId
 * to match. An 'unavailable' roster answers false because it carries no
 * members - callers that CARE (D11's reminder suppression) must branch on
 * `source === 'unavailable'` themselves rather than reading a false here as
 * "not a member".
 */
export function isOnRoster(roster: ResolvedRoster, contactId: string): boolean {
  if (contactId.length === 0) return false;
  return roster.members.some((m) => m.contactId === contactId);
}

// ---------------------------------------------------------------------------
// describeRoster - the People card payload (spec 5.2 / plan Task 5)
// ---------------------------------------------------------------------------

/**
 * The role label the card shows, DERIVED at read time and never stored:
 * the owner's tenant, a unit-roster row's own role, a member the operator
 * added, or a row whose contact is gone.
 */
export type RosterMemberRole = 'tenant' | UnitContact['role'] | 'added' | 'removed_contact';

/** Whether this member would actually receive the group text, right now. */
export type RosterReachability = 'reachable' | 'no_phone' | 'opted_out';

/**
 * One roster row on the wire.
 *
 * PHONES: a CONTACT-BACKED row carries no phone anywhere - `phoneLast4` is the
 * only digits it exposes, and it is display-only. A BARE-PHONE row is different
 * BY DESIGN: it has no other identity, so its `memberKey` IS `phone:<E164>` -
 * the full number - because that key is what a client sends back to remove it.
 * (Bare-phone rows exist only where the operator typed a number, and the
 * membership itself is the only thing the key reveals.)
 */
export interface RosterMemberView {
  /**
   * The ONLY key a client ever sends back: the contactId when the member has
   * one, else `phone:<E164>` (see the PHONES note above - a bare-phone member
   * is keyed by its full number). Deliberately NOT relayMemberKey's
   * `phone#<E164>` - that key is the delivery-map/pointer key and must not
   * become a client contract.
   */
  memberKey: string;
  contactId?: string;
  /** Last 4 digits of the phone this member would be texted on. Display only. */
  phoneLast4?: string;
  name?: string;
  role: RosterMemberRole;
  reachability: RosterReachability;
  /** The EARLIER member sharing this same number ("one message", spec 5.2). */
  sharesPhoneWithName?: string;
}

/**
 * One roster change the operator confirmed during QUIET HOURS, waiting for
 * quiet-end (spec 5.3 / 6.5). The card renders it as a banner on the control it
 * belongs to: an `open_group` row is "Opens at 8:00 AM - quiet hours" on the
 * Open button; an `add_member` row is "Joins at 8:00 AM - quiet hours" on that
 * person's row (they are NOT a member yet - membership defers with the message,
 * so a pending add is deliberately absent from `members`).
 */
export interface RosterPendingActionView {
  /** The DETERMINISTIC action id - the token the pending endpoints take. */
  actionId: string;
  kind: RosterActionKind;
  /** add_member only: who joins when it applies. */
  contactId?: string;
  /** add_member only: their display name, best-effort (absent if unreadable). */
  name?: string;
  /** ISO 8601 - quiet-end, when the poller applies it. */
  dueAt: string;
}

/**
 * One RESOLVED action that still owes the operator a notice (spec 6.5): the
 * world moved under a deferred change, so it was retired instead of applied -
 * or a human canceled it. VISIBLE UNTIL DISMISSED; a dismissed row never
 * appears here again. APPLIED actions carry no notice: the roster itself is the
 * receipt.
 */
export interface RosterSkippedActionView {
  actionId: string;
  kind: RosterActionKind;
  contactId?: string;
  name?: string;
  /**
   * Why it did not happen. The repo's skip reasons, plus `'canceled'` for the
   * operator's own cancel (which is NOT a skip reason - the repo records it as
   * a status, and the card's copy for it is "Canceled", not a failure).
   */
  reason: RosterActionSkipReason | 'canceled';
  /** ISO 8601 - when it resolved. */
  at: string;
}

/** GET /api/{tours,placements}/:id/roster - the People card's whole payload. */
export interface RosterView {
  source: RosterSource;
  members: RosterMemberView[];
  /** The current roster differs from the property default (rosterEquals). */
  customized: boolean;
  /** The property's default contact, for the "the property's default is X" note. */
  defaultPrimaryName?: string;
  /** D11 note driver: is the owner's tenant on this roster at all? */
  tenantOnRoster: boolean;
  /** >= 2 reachable members on DISTINCT numbers, and no thread yet. */
  canOpenGroup: boolean;
  threadExists: boolean;
  /** Quiet-hours deferrals still waiting. ALWAYS present (empty when none). */
  pending: RosterPendingActionView[];
  /** Terminal notices not yet dismissed. ALWAYS present (empty when none). */
  skipped: RosterSkippedActionView[];
}

/** Last four digits of an E.164 (or any) phone - never the full number. */
function last4(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

/**
 * The thread's own opt-out annotations (`relay_opted_out_members`), keyed by
 * relayMemberKey. FACT-mode deliverability needs them: the fan-out records a
 * member here when it skipped them, and a bare-phone member has no contact
 * record to carry the flag. Re-reads the conversation (resolveRoster does not
 * surface it) and degrades to "no annotations" on any failure - a read hiccup
 * must never claim someone is reachable-or-not on invented data.
 */
async function optedOutMemberKeys(
  deps: RosterResolutionDeps,
  threadId: string,
  ownerId: string,
): Promise<Set<string>> {
  try {
    const conversation = await deps.conversations.getById(threadId);
    const map = conversation?.relay_opted_out_members;
    if (map === undefined || map === null || typeof map !== 'object') return new Set();
    return new Set(Object.keys(map));
  } catch (err) {
    deps.log.warn(
      { err, ownerId },
      'roster payload: relay opt-out annotations unreadable - treating as none',
    );
    return new Set();
  }
}

/**
 * Serialize a roster for the People card - the ONE payload builder both the
 * tour and the placement endpoint call.
 *
 * PII (doc section 9): the RESPONSE carries names + last4 to the authed client
 * (the card shows people, not numbers); the LOGS carry ids and counts only, and
 * the full phone NEVER leaves the server.
 *
 * Reachability follows the send path, not the address book (spec 5.2):
 * - FACT mode reads the phone STORED ON THE PARTICIPANT ROW (what the fan-out
 *   will text) plus the thread's opt-out annotations.
 * - PLAN/DEFAULT mode reads the contact's CURRENT phone plus its own
 *   contact-level `sms_opt_out`.
 * The contact flag is honored in BOTH modes: it is the gate the fan-out itself
 * checks, and the annotation is only its recorded consequence.
 *
 * Never throws: every read is guarded, and an unreadable thread yields the
 * `unavailable` payload (empty members) rather than the property default.
 */
export async function describeRoster(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
): Promise<RosterView> {
  const resolved = await resolveRoster(deps, owner);
  const threadExists = nonEmpty(owner.groupThreadId) !== undefined;
  // Deferred actions are INDEPENDENT of who is currently on the roster, so they
  // are read (and served) even when the thread itself is unreadable - a pending
  // "opens at 8 AM" must not vanish because of a Dynamo blip.
  const { pending, skipped } = await describeRosterActions(deps, owner);

  if (resolved.source === 'unavailable') {
    // The cardinal rule: no members, and NOT the property default in their
    // place. The card renders a retry; nothing here implies who is on the text.
    return {
      source: 'unavailable',
      members: [],
      customized: false,
      tenantOnRoster: false,
      canOpenGroup: false,
      threadExists,
      pending,
      skipped,
    };
  }

  // The unit roster supplies the per-member role labels (D3's primary contact
  // included). A unit read failure just means every non-tenant row reads
  // "added" - degraded, never fatal.
  const roleById = new Map<string, UnitContact['role']>();
  try {
    const unit = await deps.units.getById(owner.unitId);
    if (unit) for (const row of unitContacts(unit)) roleById.set(row.contactId, row.role);
  } catch (err) {
    deps.log.warn(
      { err, ownerType: owner.type, ownerId: owner.id, unitId: owner.unitId },
      'roster payload: unit read failed - roles degrade to added',
    );
  }

  const threadId = nonEmpty(owner.groupThreadId);
  const optedOutKeys =
    resolved.source === 'participants' && threadId !== undefined
      ? await optedOutMemberKeys(deps, threadId, owner.id)
      : new Set<string>();

  const tenantId = nonEmpty(owner.tenantId);
  const members: RosterMemberView[] = [];
  /** First member seen on each number - the one a later duplicate "shares with". */
  const firstOnPhone = new Map<string, string | undefined>();
  const reachablePhones = new Set<string>();

  for (const member of resolved.members) {
    const contactId = nonEmpty(member.contactId);
    let contact: ContactItem | undefined;
    if (contactId !== undefined) {
      try {
        contact = await deps.contacts.getById(contactId);
      } catch (err) {
        deps.log.warn(
          { err, ownerType: owner.type, ownerId: owner.id },
          'roster payload: contact read failed - row kept as a removed contact',
        );
      }
    }
    // A row whose person is GONE (dangling id, or soft-deleted) is FIRST a
    // removed contact: rendering them as an active tenant/PM would invite an
    // operator to rely on someone no send will reach (spec 5.2 DANGLING IDS).
    const removed = contactId !== undefined && (contact === undefined || isDeleted(contact));
    const role: RosterMemberRole = removed
      ? 'removed_contact'
      : contactId !== undefined && contactId === tenantId
        ? 'tenant'
        : contactId !== undefined
          ? (roleById.get(contactId) ?? 'added')
          : 'added';

    const phone = nonEmpty(member.phone);
    const optedOut =
      contact?.sms_opt_out === true ||
      optedOutKeys.has(relayMemberKey({ ...(contactId !== undefined && { contactId }), phone: phone ?? '' }));
    const reachability: RosterReachability =
      phone === undefined ? 'no_phone' : optedOut ? 'opted_out' : 'reachable';

    // Display-name backfill: a FACT row can carry no name (a pointer at a
    // non-relay thread, or a row predating name storage) while its contactId
    // resolves fine - the card and tabs must say "Tina Tenant", never
    // "Number ending 0301" or a raw id, for a person we positively identified
    // two paragraphs up. Display only: reachability keeps the STORED phone,
    // and a removed contact keeps whatever the row itself said.
    const name =
      nonEmpty(member.name) ?? (!removed && contact !== undefined ? displayName(contact) : undefined);
    let sharesPhoneWithName: string | undefined;
    if (phone !== undefined) {
      if (firstOnPhone.has(phone)) {
        // Only nameable when the earlier member HAS a name; the card's copy is
        // "shares a number with <name>", so an anonymous row says nothing.
        sharesPhoneWithName = firstOnPhone.get(phone);
      } else {
        firstOnPhone.set(phone, name);
      }
      if (reachability === 'reachable') reachablePhones.add(phone);
    }

    const phoneLast4 = phone !== undefined ? last4(phone) : undefined;
    members.push({
      memberKey: contactId ?? `phone:${phone ?? ''}`,
      ...(contactId !== undefined && { contactId }),
      ...(phoneLast4 !== undefined && { phoneLast4 }),
      ...(name !== undefined && { name }),
      role,
      reachability,
      ...(sharesPhoneWithName !== undefined && { sharesPhoneWithName }),
    });
  }

  // The property default, for the customized note + "the default is <name>".
  // Resolving it a second time (rather than re-deriving it here) keeps ONE
  // definition of "the default" - and is skipped entirely when the default IS
  // the answer.
  const defaultMembers =
    resolved.source === 'default'
      ? resolved.members
      : (
          await resolveRoster(deps, {
            type: owner.type,
            id: owner.id,
            tenantId: owner.tenantId,
            unitId: owner.unitId,
          })
        ).members;
  const defaultPrimary = defaultMembers.find((m) => nonEmpty(m.contactId) !== tenantId);

  return {
    source: resolved.source,
    members,
    customized:
      resolved.source === 'default' ? false : !rosterEquals(resolved.members, defaultMembers),
    ...(defaultPrimary?.name !== undefined && { defaultPrimaryName: defaultPrimary.name }),
    tenantOnRoster: tenantId !== undefined && isOnRoster(resolved, tenantId),
    // Distinct NUMBERS, not rows: relay provisioning de-dupes by phone, so two
    // members on one handset are one party and cannot make a group.
    canOpenGroup: !threadExists && reachablePhones.size >= 2,
    threadExists,
    pending,
    skipped,
  };
}

/**
 * The quiet-hours half of the payload: this owner's PENDING rows and the
 * terminal rows that still owe a notice.
 *
 * - `pending` = status 'pending', due-first.
 * - `skipped` = status 'skipped' or 'canceled', NOT dismissed (spec 6.5's
 *   visible-until-dismissed), newest-first - a fresh notice reads at the top.
 * - `applied` rows are in NEITHER list: the roster itself is the receipt.
 *
 * Names are a best-effort contact read for add rows (the card says "Alicia
 * Grant joins at 8:00 AM", never a contact id). Never throws: an unreadable
 * actions table degrades to "no deferrals", exactly like every other read here.
 */
async function describeRosterActions(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
): Promise<{ pending: RosterPendingActionView[]; skipped: RosterSkippedActionView[] }> {
  if (deps.actions === undefined) return { pending: [], skipped: [] };
  let rows: PendingRosterActionItem[];
  try {
    rows = await deps.actions.listByOwner({ ownerType: owner.type, ownerId: owner.id });
  } catch (err) {
    deps.log.warn(
      { err, ownerType: owner.type, ownerId: owner.id },
      'roster payload: pending actions unreadable - serving none',
    );
    return { pending: [], skipped: [] };
  }

  /** Display name for an add row's contact (absent for open rows / read fails). */
  const nameOf = async (contactId: string | undefined): Promise<string | undefined> => {
    if (contactId === undefined || contactId.length === 0) return undefined;
    try {
      const contact = await deps.contacts.getById(contactId);
      return contact === undefined ? undefined : displayName(contact);
    } catch {
      return undefined;
    }
  };

  const pending: RosterPendingActionView[] = [];
  const skipped: RosterSkippedActionView[] = [];
  // The name lookup is a SERIAL contact read, so it happens only for rows this
  // payload actually renders. Action rows are never deleted, so every roster GET
  // re-walks the owner's whole history: naming rows that are then discarded made
  // the card degrade monotonically for the life of the tour/placement.
  for (const row of rows) {
    const contactId = nonEmpty(row.contactId);
    if (row.status === 'pending') {
      const name = await nameOf(contactId);
      pending.push({
        actionId: row.actionId,
        kind: row.action,
        ...(contactId !== undefined && { contactId }),
        ...(name !== undefined && { name }),
        dueAt: row.dueAt,
      });
      continue;
    }
    if (row.status === 'applied' || row.dismissedAt !== undefined) continue;
    const name = await nameOf(contactId);
    skipped.push({
      actionId: row.actionId,
      kind: row.action,
      ...(contactId !== undefined && { contactId }),
      ...(name !== undefined && { name }),
      reason: row.status === 'canceled' ? 'canceled' : (row.skippedReason ?? 'owner_canceled'),
      at: row.resolvedAt ?? row.createdAt,
    });
  }
  pending.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));
  skipped.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { pending, skipped };
}

/**
 * Customized-note equality (spec 5.2), used for PLAN and FACT comparisons
 * alike: an order-insensitive SET comparison where contact-backed entries
 * compare by contactId and bare-phone entries by E.164 phone. A contact whose
 * number was corrected after they joined still matches; a legacy thread with
 * bare-phone participants never matches the property default (so it reads
 * "Customized" indefinitely - accurate, and expected in dev).
 */
export function rosterEquals(a: ResolvedMember[], b: ResolvedMember[]): boolean {
  const keys = (members: ResolvedMember[]): Set<string> => {
    const set = new Set<string>();
    for (const m of members) {
      const contactId = nonEmpty(m.contactId);
      if (contactId !== undefined) {
        set.add(`c:${contactId}`);
        continue;
      }
      const phone = nonEmpty(m.phone);
      // A row carrying neither field is degenerate (write-time validation
      // rejects it); collapse every such row onto one slot.
      set.add(phone === undefined ? 'x:' : `p:${normalizeToE164(phone) ?? phone}`);
    }
    return set;
  };
  const setA = keys(a);
  const setB = keys(b);
  if (setA.size !== setB.size) return false;
  for (const key of setA) if (!setB.has(key)) return false;
  return true;
}
