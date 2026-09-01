// relay.fanOut (M1.7) — fan an inbound relay-group message out to the OTHER
// members, throttled and idempotent.
//
// The relayed message is stored ONCE (the inbound SOURCE message); this job
// NEVER persists N outbound copies. It sends one provider message per
// recipient FROM the pool number, sender-name-prefixed, and records each send
// in the source message's delivery_recipients map + a relaysid pointer (so the
// per-recipient delivery callback can find the right slot).
//
// Idempotency (SQS at-least-once + our own continuation re-enqueues):
//   - the job execution marker (existing pattern) guards the WHOLE job per
//     envelope jobId;
//   - per recipient, a slot already in a TERMINAL state (sent/delivered/
//     failed) is SKIPPED, so a redelivered/continuation job never double-sends.
//
// Error handling per recipient:
//   - transient (429 / Twilio 30022) → re-enqueue a continuation relay.fanOut
//     for the REMAINING recipients with exponential backoff (attempt cap 3);
//   - 30007 (carrier filtering) → mark the recipient failed, NEVER retry;
//   - SendRefusedError (opt-out / breaker / manual) → mark the recipient
//     failed and CONTINUE with the others.
//
// PII (doc §9): never log the body, the sender's phone, or member phones —
// IDs / member keys / counts only, correlated via the pino mixin.
import { createMessagingAdapter, type MessagingAdapter } from '../adapters/messaging.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { getContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import {
  createConversationsRepo,
  getOwner,
  type ConversationParticipant,
  type ConversationsRepo,
  type RelayOwner,
} from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createToursRepo, type ToursRepo } from '../repos/toursRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import { createUnitsRepo, unitContacts, type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import { resolveTourContactNames, type TourContactNames } from '../lib/tourContacts.js';
import { formatStreet } from '../lib/address.js';
import { formatLocalDate, formatLocalTime } from '../lib/localTime.js';
import { localDateOf, resolveQuietHoursTimezone } from '../lib/quietHours.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  relayMemberKey,
  type MessagesRepo,
  type RelayRecipientDelivery,
} from '../repos/messagesRepo.js';
import { SMS_BRAND_NAME } from '../lib/smsCompliance.js';
import { SendRefusedError } from '../services/sendMessage.js';
import { isMemberSuppressed, sendRelayAnnouncement } from '../services/relayAnnouncements.js';
import { resolveMessage } from '../messages/index.js';
import { defineJobHandler, enqueue } from './jobs.js';

// Canonical home moved to services/relayAnnouncements.ts (tourReminders.ts and
// this module's fan-out loop import it from here historically) — re-exported.
export { isMemberSuppressed } from '../services/relayAnnouncements.js';

export const RELAY_FANOUT_JOB = 'relay.fanOut';
export const RELAY_INTRO_JOB = 'relay.intro';
export const RELAY_MEMBER_ADDED_JOB = 'relay.memberAdded';

/** Continuation cap: a transient failure re-enqueues at most this many times. */
export const MAX_FANOUT_ATTEMPTS = 3;

/**
 * Outbound MMS presign TTL for relay legs (design Sec 7): 1 hour. Presigned
 * PER LEG at leg-send time - never batched up front - so a token-bucket-paced
 * roster or a backed-off continuation never hands Twilio an expired URL.
 */
export const RELAY_PRESIGN_TTL_SECONDS = 3600;

/** Exponential backoff for the transient-failure continuation: 5s, 10s, 20s. */
export function fanOutBackoffMs(attempt: number): number {
  return 5_000 * 2 ** (attempt - 1);
}

/** Twilio transient error codes that warrant a backed-off continuation. */
const TRANSIENT_CODES = new Set(['429', '30022']);
/** Twilio carrier-filtering: NEVER retry (re-sending filtered content compounds harm). */
const CARRIER_FILTERED_CODE = '30007';

/** Neutral sender label when a member has no resolved name (never leak phone). */
const ANONYMOUS_SENDER_LABEL = 'A member';

/**
 * FIX 2 — neutral team label prefixed on a TEAM-authored relay message (a
 * teammate posting into the thread from the dashboard). There is no member
 * sender, so the prefix must be this team label — NEVER a phone number. A2P
 * (spec section 5): the SMS-facing sender label always comes from the single
 * source of truth in lib/smsCompliance.ts, never from a literal spelled here --
 * that stays true even now that the SMS brand and the internal name are both
 * "HousingChoice".
 */
export const TEAM_SENDER_LABEL = SMS_BRAND_NAME;

/**
 * FIX 2 — senderKey sentinel for a TEAM message: it matches no member key, so
 * the fan-out excludes NO member (every member receives the team message) and
 * resolves the prefix from senderNameOverride instead of a member's name.
 */
export const TEAM_SENDER_KEY = 'team';

export interface RelayFanOutPayload {
  relayConversationId: string;
  /** SK of the source (inbound) message whose body is being relayed. */
  sourceTsMsgId: string;
  /** Member key (relayMemberKey) of the sender — never a recipient. */
  senderKey: string;
  /**
   * FIX 2 — explicit sender-prefix label for a TEAM message (a teammate posting
   * from the dashboard): there is no member sender to derive a name from, so
   * this neutral team label is the prefix. NEVER a phone. Absent on a normal
   * member-relayed message (the prefix comes from the sender member's name).
   */
  senderNameOverride?: string;
  /** 1-based continuation attempt (absent = first run, treated as 1). */
  attempt?: number;
  /**
   * When set (continuation only), restrict fan-out to these recipient member
   * keys — the remaining recipients after a transient failure. Absent = all
   * non-sender members.
   */
  recipientKeys?: string[];
}

export function parseRelayFanOutPayload(payload: unknown): RelayFanOutPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('relayFanOut: payload is not an object');
  }
  const p = payload as Partial<RelayFanOutPayload>;
  if (typeof p.relayConversationId !== 'string' || p.relayConversationId.length === 0) {
    throw new Error('relayFanOut: missing relayConversationId');
  }
  if (typeof p.sourceTsMsgId !== 'string' || p.sourceTsMsgId.length === 0) {
    throw new Error('relayFanOut: missing sourceTsMsgId');
  }
  if (typeof p.senderKey !== 'string' || p.senderKey.length === 0) {
    throw new Error('relayFanOut: missing senderKey');
  }
  const senderNameOverride =
    typeof p.senderNameOverride === 'string' && p.senderNameOverride.length > 0
      ? p.senderNameOverride
      : undefined;
  const attempt =
    typeof p.attempt === 'number' && Number.isInteger(p.attempt) && p.attempt >= 1
      ? p.attempt
      : 1;
  const recipientKeys =
    Array.isArray(p.recipientKeys) && p.recipientKeys.every((k) => typeof k === 'string')
      ? p.recipientKeys
      : undefined;
  return {
    relayConversationId: p.relayConversationId,
    sourceTsMsgId: p.sourceTsMsgId,
    senderKey: p.senderKey,
    ...(senderNameOverride !== undefined && { senderNameOverride }),
    attempt,
    ...(recipientKeys !== undefined && { recipientKeys }),
  };
}

/** Terminal recipient states never re-sent (idempotency). */
function isTerminal(status: RelayRecipientDelivery['status'] | undefined): boolean {
  return status === 'sent' || status === 'delivered' || status === 'failed';
}

/** Compose the relayed body: "<SenderName>: <body>" — never leaks a phone. */
export function composeRelayBody(senderName: string | undefined, body: string): string {
  const label = senderName && senderName.trim().length > 0 ? senderName : ANONYMOUS_SENDER_LABEL;
  return `${label}: ${body}`;
}

/**
 * FIRST name only, for the connection sentence below. The stored display name is
 * the "First Last" join (lib/rosterResolution.ts), which read as over-formal in a
 * group intro: the founder reported 2026-08-20 that a landlord came through as
 * "First Last" while the tenant came through as a bare first name. That was never
 * a data difference - most imported tenant contacts simply have no lastName on
 * file, so the join yields one token and LOOKED right. Everyone gets first names
 * now, so the two render alike.
 *
 * Deliberately accepted: two members sharing a first name are ambiguous here
 * (founder's call, 2026-08-20 - a natural-sounding intro is worth it).
 */
function firstNameOnly(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name.trim();
}

/**
 * The value of the `{names}` token: the bare member list, FIRST names where
 * known, a neutral count phrasing otherwise - NEVER a phone number (PII).
 *
 * Phase B (spec 9.2) renamed this composer and narrowed what it owns - the old
 * name said "sentence". It used to return the whole "You're now connected with ... on
 * this number. Reply here and everyone in the group sees it." SENTENCE, fixed
 * copy and all; that copy now lives in the `relay.intro` catalog default where
 * it is visible, and this function returns only the list that varies.
 *
 * It is TOTAL - it never returns the empty string, on ANY roster including an
 * empty one. That is not defensiveness: `{names}` feeds a NON-EDITABLE catalog
 * default, and an unvalued token there does not degrade, it THROWS
 * (messages/resolve.ts) - which would kill the intro job AFTER its
 * putJobExecutionMarker claim (announcement lost, not retried) and 500 the
 * add-preview route. The preview builder can reach the no-names branch.
 *
 * The old zero-others branch RESTRUCTURED the sentence, which a token cannot do,
 * so spec 9.2's table routes it to the "1 other person" phrasing: copy that is
 * mildly wrong on an edge case, in exchange for a template that always works.
 * Every other roster composes BYTE-IDENTICALLY to the pre-change body.
 */
export function composeNameList(memberNames: (string | undefined)[]): string {
  const named = memberNames
    .map((n) => (n && n.trim().length > 0 ? firstNameOnly(n) : undefined))
    .filter((n): n is string => n !== undefined);
  if (named.length === 0) {
    const others = Math.max(memberNames.length - 1, 0);
    return others > 1 ? `${others} other people` : '1 other person';
  }
  return named.length === 1
    ? named[0]!
    : named.length === 2
      ? `${named[0]} and ${named[1]}`
      : `${named.slice(0, -1).join(', ')}, and ${named[named.length - 1]}`;
}

/**
 * The value of the `{name}` token on the member-added announcements (spec 9.4):
 * the joiner's FIRST name, or a neutral phrase - NEVER a phone number.
 *
 * TOTAL for the same reason `composeNameList` is: a relay member can be a bare
 * phone with no contact row, and an unvalued `{name}` in a non-editable default
 * throws rather than degrading.
 *
 * Lower-cased, unlike the sentence-initial constant it replaced ("A new
 * member"), because Sam's Phase B wording puts it MID-sentence: "Hey, adding a
 * new member to the group."
 */
export function joinedName(name: string | undefined): string {
  return name && name.trim().length > 0 ? firstNameOnly(name) : 'a new member';
}

/**
 * The plain values the two relay composers interpolate, resolved ONCE by
 * resolveRelayComposeInputs below and then handed to a PURE, synchronous
 * composer - the same resolver/composer split Phase A's tour copy uses
 * (messages/tourCopy.ts). No repo read lives below this shape.
 *
 * `variant` is the entry selection (spec 9.1): tour today / tour any other day
 * / placement / the naked intro. `role` is the member-added half only (9.4) and
 * is resolved INDEPENDENTLY of the variant - a group whose intro degraded to
 * naked for want of a street still knows who joined it.
 */
export interface RelayComposeInputs {
  variant: 'tour_today' | 'tour' | 'placement' | 'naked';
  /** Absent -> the composer substitutes 'there' (spec 9.5's in-sentence exception). */
  tenantFirstName?: string;
  /** Absence forces variant 'naked' (spec 9.5). */
  propertyContactFirstName?: string;
  /** The STREET only (formatStreet). Empty forces variant 'naked' (spec 9.5). */
  where?: string;
  /** "Tue, Sep 8 at 3:00 PM" - the dated tour variant only. */
  when?: string;
  /** "3:00 PM" - the today tour variant only. */
  time?: string;
  /** member_added only (spec 9.4's role table). */
  role?: 'property manager' | 'landlord' | 'tenant';
}

/**
 * What the resolver reads, all OPTIONAL (ruling R11).
 *
 * The JOB wires every one of them; a PREVIEW caller wires what its route holds,
 * and `services/rosterEdits` threads them off RosterResolutionDeps, whose new
 * picks are optional so the ~25 hand-built deps objects in rosterEdits.test.ts
 * stay valid. An absent repo is simply a read that cannot answer, which lands
 * in the same place every failed read does: `variant: 'naked'` (spec 9.5).
 *
 * `nowIso` is the instant the "is the tour TODAY" test is made against. The
 * preview passes its QuietHoursState's own `nowIso` (the routes' injected
 * clock), so a pinned-clock test sees a deterministic variant.
 */
export interface RelayComposeDeps {
  toursRepo?: Pick<ToursRepo, 'get'>;
  placementsRepo?: Pick<PlacementsRepo, 'getById'>;
  unitsRepo?: Pick<UnitsRepo, 'getById'>;
  contactsRepo?: Pick<ContactsRepo, 'getById'>;
  settingsRepo?: Pick<SettingsRepo, 'getOrgSettings'>;
  nowIso?: string;
  logger?: Logger;
}

/** Spec 9.4's role table. Source is UnitContact.role (repos/unitsRepo.ts), NOT
 *  ContactItem.type, which has no property-manager value at all. The owning
 *  tour's / placement's own tenant outranks any roster row they might also
 *  hold. Anything else - 'other', a stranger, a bare-phone member with no
 *  contactId, no unit - resolves to NO role, which routes the announcement to
 *  the no-role entry rather than faking one. */
function resolveMemberRole(
  unit: UnitItem | undefined,
  tenantId: string,
  addedContactId: string | undefined,
): RelayComposeInputs['role'] | undefined {
  if (addedContactId === undefined || addedContactId.length === 0) return undefined;
  if (addedContactId === tenantId) return 'tenant';
  if (unit === undefined) return undefined;
  const row = unitContacts(unit).find((c) => c.contactId === addedContactId);
  switch (row?.role) {
    case 'pm':
      return 'property manager';
    case 'landlord':
    case 'owner':
      return 'landlord';
    default:
      return undefined;
  }
}

/**
 * Resolve everything the relay intro / member-added copy needs, from the
 * conversation's OWNER (spec 9.3).
 *
 * Keyed on the owner `{type, id}` rather than on a conversation ON PURPOSE:
 * buildOpenPreview (services/rosterEdits.ts) has no conversation to pass -
 * preview-open runs BEFORE provisioning and 409s once a thread exists - so a
 * conversation-keyed resolver would be uncallable from the very authoring path
 * that stores the operator's edited intro_body. Both jobs and both owner
 * previews go through this one function, so the preview cannot drift from the
 * send by construction rather than by discipline.
 *
 * IT NEVER THROWS. Every read gets its OWN try/catch and degrades toward
 * `variant: 'naked'` (spec 9.5): a relay intro must never be lost over a failed
 * unit read - it is composed AFTER the job's putJobExecutionMarker claim, so a
 * throw loses the announcement rather than retrying it - and the preview route
 * must never 500. formatLocalDate / formatLocalTime RangeError on an
 * unparseable instant, so they are inside the try as well.
 *
 * A SETTINGS read failure degrades the tour variants to naked rather than
 * assuming the default zone (choice recorded here): {time} and {when} are FACTS
 * in a tenant's SMS, and a wrong-zone "3:00 PM" is worse copy than the naked
 * intro. getOrgSettings already answers with defaults when no row exists, so a
 * throw here is a genuine read failure, not an unconfigured org. The placement
 * variant reads no settings at all.
 *
 * A tour that has ALREADY STARTED is treated exactly as a tour with no time at
 * all - naked. See the tour branch below for why; the short version is that
 * "let us know when you're on the way" is not a sentence to send after the tour.
 *
 * That guard governs the COMPOSED variants only - precedence 2-4. An
 * operator-EDITED `intro_body` (precedence 1) is applied by the caller ABOVE
 * this function and still sends verbatim past the tour, by design: a human
 * chose those words for this group, and second-guessing them on a clock is not
 * this resolver's job. Narrow in practice - the quiet-hours deferral path drops
 * the edit entirely (routes/tours.ts), so the only reachable case is a
 * `connecting` group whose number purchase straddles the tour start.
 */
export async function resolveRelayComposeInputs(
  owner: RelayOwner,
  deps: RelayComposeDeps,
  /** member_added only: resolve {role} for THIS contact (spec 9.4). */
  addedContactId?: string,
): Promise<RelayComposeInputs> {
  const log = deps.logger ?? defaultLogger;
  if (owner.type === null) return { variant: 'naked' };
  const nowIso = deps.nowIso ?? new Date().toISOString();

  let tenantId: string;
  let unitId: string;
  let scheduledAt: string | undefined;
  try {
    if (owner.type === 'tour') {
      // ToursRepo's getter is get(), never getById().
      const tour = await deps.toursRepo?.get(owner.id);
      if (!tour) return { variant: 'naked' };
      tenantId = tour.tenantId;
      unitId = tour.unitId;
      // OPTIONAL on TourItem: a 'requested' tour has no time at all, which
      // spec 9.5 routes to the naked intro (there is no {when} to render).
      //
      // A tour that has ALREADY STARTED is dropped here and takes exactly the
      // same route, because both tour entries end "Please let us know when
      // you're on the way" - copy that assumes the tour has not happened. This
      // is the third writer of tour-time copy and the same staleness class the
      // ladder's fire-time gate (retiredByTourStart) exists for; the two
      // reachable paths are an operator opening the group from a tour whose
      // outcome is not recorded yet, and a quiet-hours deferral that straddles
      // the tour start (routes/tours.ts defers the open to quiet-end, and this
      // composes THEN).
      //
      // AT-OR-AFTER, matching retiredByTourStart's `now >= start` exactly
      // (round 2, R2-S1). An earlier draft was strictly-before while claiming
      // kinship with that gate, which meant one codebase answering "is
      // forward-looking tour copy stale at t=start" two ways, with the newer
      // site citing the older one as its authority. Same sentence, same
      // boundary.
      //
      // An unparseable scheduledAt is NOT dropped here - Number.isFinite is
      // false, so it falls through to the formatter's own try/catch, which
      // already degrades it. An unparseable `nowIso` likewise leaves the guard
      // OFF (NaN comparisons are false) and the tour variant composes: a
      // deliberate fail-OPEN, because this resolver's first duty is never to
      // throw and never to lose an intro, and every production caller supplies
      // an ISO instant (the quiet-hours state, or the job's own default).
      scheduledAt = tour.scheduledAt;
      const startedAt = Date.parse(scheduledAt ?? '');
      if (Number.isFinite(startedAt) && startedAt <= Date.parse(nowIso)) scheduledAt = undefined;
    } else {
      const placement = await deps.placementsRepo?.getById(owner.id);
      if (!placement) return { variant: 'naked' };
      tenantId = placement.tenantId;
      unitId = placement.unitId;
    }
  } catch (err) {
    log.warn({ err, ownerType: owner.type, ownerId: owner.id }, 'relay copy: owner read failed - naked intro');
    return { variant: 'naked' };
  }

  let unit: UnitItem | undefined;
  try {
    unit = await deps.unitsRepo?.getById(unitId);
  } catch (err) {
    log.warn({ err, unitId }, 'relay copy: unit read failed - naked intro');
  }

  // The role is a DIFFERENT question from the intro variant and is answered
  // even when the variant degrades: it needs only the unit roster.
  const role = resolveMemberRole(unit, tenantId, addedContactId);
  const withRole = role !== undefined ? { role } : {};

  // REUSE (spec 9.3): resolveTourContactNames already applies the primary-
  // contact-then-landlord rule, the tenant de-dupe, and inertName's brace
  // stripping (which is what keeps a user-supplied name from re-opening a
  // token). It never throws; the try is belt-and-braces around the repo pick.
  let names: TourContactNames = {};
  if (deps.contactsRepo !== undefined) {
    try {
      const resolved = await resolveTourContactNames({
        tenantId,
        unit,
        contactsRepo: deps.contactsRepo,
        ...(deps.logger !== undefined && { logger: deps.logger }),
      });
      names = resolved.names;
    } catch (err) {
      log.warn({ err, unitId }, 'relay copy: name resolution failed - naked intro');
    }
  }
  const withNames = {
    ...(names.tenantFirstName !== undefined && { tenantFirstName: names.tenantFirstName }),
    ...withRole,
  };

  const where = formatStreet(unit?.address);
  if (names.propertyContactFirstName === undefined || where.length === 0) {
    return { variant: 'naked', ...withNames };
  }
  const named = {
    ...withNames,
    propertyContactFirstName: names.propertyContactFirstName,
    where,
  };

  if (owner.type === 'placement') return { variant: 'placement', ...named };
  if (scheduledAt === undefined) return { variant: 'naked', ...withNames };

  let timezone: string;
  try {
    const settings = await deps.settingsRepo?.getOrgSettings();
    if (!settings) return { variant: 'naked', ...withNames };
    // The SAME seam the booked-too-late same-day test uses, so "today" here and
    // "today" there can never disagree (spec 9.1).
    timezone = resolveQuietHoursTimezone(settings);
  } catch (err) {
    log.warn({ err }, 'relay copy: org settings read failed - naked intro');
    return { variant: 'naked', ...withNames };
  }

  try {
    const time = formatLocalTime(scheduledAt, timezone);
    if (localDateOf(nowIso, timezone) === localDateOf(scheduledAt, timezone)) {
      return { variant: 'tour_today', ...named, time };
    }
    // "on {when}", not Sam's "at {when}": our {when} renders "Tue, Sep 8 at
    // 3:00 PM" (tourCopy.ts builds it the same way), so "at Tue, Sep 8 at
    // 3:00 PM" reads badly. Cameron approved "on" for the dated form.
    return { variant: 'tour', ...named, when: `${formatLocalDate(scheduledAt, timezone)} at ${time}` };
  } catch (err) {
    log.warn({ err, ownerId: owner.id }, 'relay copy: tour time unformattable - naked intro');
    return { variant: 'naked', ...withNames };
  }
}

/**
 * The relay intro body, routed on the conversation's owner (spec 9.1).
 *
 * PURE and synchronous: everything it needs was resolved above. Precedence 1 -
 * an operator-edited intro_body - is applied by the CALLER, above this.
 *
 * TOTAL, twice over. `tenantFirstName` falls back to 'there' the way Phase A
 * does (messages/tourCopy.ts), because the tour and placement entries OPEN with
 * "Hey {tenantFirstName}!" and are strict non-editable defaults - an unvalued
 * declared token there THROWS rather than degrading. And a variant whose own
 * tokens are missing falls back to the naked entry rather than throwing: the
 * resolver already guarantees they are present, but this is the last line of
 * spec 9.5's defence for a hand-built inputs value.
 */
export function composeIntroBody(
  inputs: RelayComposeInputs,
  memberNames: (string | undefined)[],
): string {
  const tenantFirstName = inputs.tenantFirstName ?? 'there';
  const propertyContactFirstName = inputs.propertyContactFirstName ?? '';
  const where = inputs.where ?? '';
  if (propertyContactFirstName.length > 0 && where.length > 0) {
    if (inputs.variant === 'tour_today' && inputs.time !== undefined) {
      return resolveMessage('relay.intro_tour_today', {
        tenantFirstName,
        propertyContactFirstName,
        time: inputs.time,
        where,
      });
    }
    if (inputs.variant === 'tour' && inputs.when !== undefined) {
      return resolveMessage('relay.intro_tour', {
        tenantFirstName,
        propertyContactFirstName,
        when: inputs.when,
        where,
      });
    }
    if (inputs.variant === 'placement') {
      return resolveMessage('relay.intro_placement', {
        tenantFirstName,
        propertyContactFirstName,
        where,
      });
    }
  }
  // The naked intro: the live copy, unchanged, naming whoever is connected.
  return resolveMessage('relay.intro', { names: composeNameList(memberNames) });
}

/**
 * The GROUP half of the member-added split (spec 9.4): what everyone ALREADY on
 * the thread receives. The NEW member receives the naked intro instead
 * (composeIntroBody with variant 'naked'), which is defined at the member-added
 * job handler below and at buildAddPreview's docblock.
 *
 * Two entries rather than one with an empty clause, because {role} sits
 * MID-sentence and Phase A spec 6.4's empty-clause trick only works for a
 * trailing sentence. `{name}` is TOTAL (joinedName) - never a phone.
 */
export function composeMemberAddedGroupBody(
  inputs: RelayComposeInputs,
  newMemberName: string | undefined,
): string {
  const name = joinedName(newMemberName);
  return inputs.role !== undefined
    ? resolveMessage('relay.member_added_role', { name, role: inputs.role })
    : resolveMessage('relay.member_added', { name });
}

export interface RelayIntroPayload {
  relayConversationId: string;
  /**
   * false = legs-only: send the intro texts but persist NO announcement row.
   * The dev replay seam's mode (POST /__dev/relay/replay-intros re-fires
   * intros at every boot to materialize fake-phones groups — it must never
   * grow the seeded threads). Absent/true on real provisioning: the intro is
   * persisted so the dashboard thread shows it (founder decision 2026-07-14).
   */
  persist?: boolean;
}

export function parseRelayIntroPayload(payload: unknown): RelayIntroPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('relayIntro: payload is not an object');
  }
  const p = payload as Partial<RelayIntroPayload>;
  if (typeof p.relayConversationId !== 'string' || p.relayConversationId.length === 0) {
    throw new Error('relayIntro: missing relayConversationId');
  }
  return {
    relayConversationId: p.relayConversationId,
    ...(p.persist === false && { persist: false }),
  };
}

export interface RelayMemberAddedPayload {
  relayConversationId: string;
  /** relayMemberKey of the just-added member — resolved against the CURRENT
   *  roster at job time for the display name (a raced remove degrades to the
   *  neutral joined label, never a failure). */
  addedMemberKey: string;
}

export function parseRelayMemberAddedPayload(payload: unknown): RelayMemberAddedPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('relayMemberAdded: payload is not an object');
  }
  const p = payload as Partial<RelayMemberAddedPayload>;
  if (typeof p.relayConversationId !== 'string' || p.relayConversationId.length === 0) {
    throw new Error('relayMemberAdded: missing relayConversationId');
  }
  if (typeof p.addedMemberKey !== 'string' || p.addedMemberKey.length === 0) {
    throw new Error('relayMemberAdded: missing addedMemberKey');
  }
  return { relayConversationId: p.relayConversationId, addedMemberKey: p.addedMemberKey };
}

export interface RelayFanOutJobDeps {
  adapter?: MessagingAdapter;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  /**
   * The four reads the OWNER-ROUTED intro / member-added copy needs (Phase B
   * spec 9.3). Optional and lazily created like every repo above; a test injects
   * fakes through them. Absent at runtime they are built on first job run.
   */
  unitsRepo?: UnitsRepo;
  toursRepo?: ToursRepo;
  placementsRepo?: PlacementsRepo;
  settingsRepo?: SettingsRepo;
  /**
   * Media bucket store for presigning relay-leg media (outbound MMS). Undefined
   * when MEDIA_BUCKET is unset (a no-bucket dev loop): the media-only body still
   * relays as text, but no media is attached. Lazily created on first job run.
   */
  mediaStore?: MediaStore;
  /** Shared A2P token bucket (worker boot). Optional — tests may omit pacing. */
  tokenBucket?: TokenBucket;
  logger?: Logger;
}

export function registerRelayFanOutJobHandler(deps: RelayFanOutJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  // Lazy: repos/adapter touch config + DynamoDB only on first job run.
  let adapter = deps.adapter;
  let conversations = deps.conversationsRepo;
  let messages = deps.messagesRepo;
  let contacts = deps.contactsRepo;
  // The owner-routed copy's reads (spec 9.3), lazy on the same `??=` pattern.
  let units = deps.unitsRepo;
  let tours = deps.toursRepo;
  let placements = deps.placementsRepo;
  let settings = deps.settingsRepo;
  // MediaStore can legitimately resolve to undefined (no MEDIA_BUCKET), so a
  // separate init flag drives the lazy build (not `??=`, which would rebuild).
  let mediaStore = deps.mediaStore;
  let mediaStoreInit = deps.mediaStore !== undefined;

  /**
   * The owner-routed copy inputs for both announcement handlers (spec 9.3).
   *
   * The four repos are built ONLY on the owned path: a standalone group's owner
   * is `{type:null}`, the resolver answers naked without reading anything, and
   * building four DynamoDB-backed repos to learn that would be waste - and would
   * drag every standalone relay test into needing them injected.
   */
  async function resolveOwnerInputs(
    owner: RelayOwner,
    addedContactId?: string,
  ): Promise<RelayComposeInputs> {
    if (owner.type === null) return { variant: 'naked' };
    try {
      units ??= createUnitsRepo({ logger: deps.logger });
      tours ??= createToursRepo({ logger: deps.logger });
      placements ??= createPlacementsRepo({ logger: deps.logger });
      settings ??= createSettingsRepo({ logger: deps.logger });
    } catch (err) {
      // CONSTRUCTION, not a read - and it is outside resolveRelayComposeInputs'
      // own try/catches, so without this an unbuildable repo would throw here,
      // AFTER the idempotency claim, and LOSE the announcement. The whole point
      // of spec 9.5 is that a failure downgrades the copy, never the send.
      log.warn({ err, ownerType: owner.type }, 'relay copy: repo construction failed - naked intro');
      return { variant: 'naked' };
    }
    return resolveRelayComposeInputs(
      owner,
      {
        toursRepo: tours,
        placementsRepo: placements,
        unitsRepo: units,
        ...(contacts !== undefined && { contactsRepo: contacts }),
        settingsRepo: settings,
        ...(deps.logger !== undefined && { logger: deps.logger }),
      },
      addedContactId,
    );
  }

  defineJobHandler(RELAY_FANOUT_JOB, async (rawPayload) => {
    const payload = parseRelayFanOutPayload(rawPayload);
    adapter ??= createMessagingAdapter({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });
    if (!mediaStoreInit) {
      mediaStore = createMediaStore();
      mediaStoreInit = true;
    }

    // Whole-job duplicate-delivery guard (existing pattern): conditionally
    // mark this envelope jobId executed BEFORE any send. A redelivery resolves
    // as a no-op so the consumer deletes the message. Per-recipient terminal
    // skips are the second layer (a continuation reuses recipientKeys).
    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const first = await messages.putJobExecutionMarker(jobId, payload.relayConversationId);
      if (!first) {
        log.info({ jobId, conversationId: payload.relayConversationId }, 'relay fan-out duplicate delivery suppressed');
        return;
      }
    } else {
      log.warn(
        { conversationId: payload.relayConversationId },
        'relayFanOut: no jobId in context — duplicate-delivery guard skipped',
      );
    }

    const conversation = await conversations.getById(payload.relayConversationId);
    if (!conversation) {
      log.warn({ conversationId: payload.relayConversationId }, 'relayFanOut: relay conversation not found — nothing to fan out');
      return;
    }
    // AF-2 status gate: the group may have CLOSED between enqueue and now (a
    // queued/continuation job outlives a close). pool_number is KEPT on close
    // (burn-multiplexing), so `status` - not pool_number presence - is the
    // authoritative closed-gate (mirrors relayAnnouncements.ts). A closed group
    // must never fan out: a late relayed message would contradict the already-
    // sent "This group chat is now closed" final message.
    if (conversation.status !== 'open') {
      log.info(
        { conversationId: payload.relayConversationId, status: conversation.status },
        'relay fan-out skipped - group not open',
      );
      return;
    }
    const poolNumber = conversation.pool_number;
    if (typeof poolNumber !== 'string' || poolNumber.length === 0) {
      log.warn({ conversationId: payload.relayConversationId }, 'relayFanOut: relay conversation has no pool number — skipping');
      return;
    }

    // Re-read the exact source message by SK (a tight window that includes it).
    const window = await messages.listByConversation(payload.relayConversationId, {
      before: bumpKey(payload.sourceTsMsgId),
      limit: 5,
    });
    const sourceMessage = window.find((m) => m.tsMsgId === payload.sourceTsMsgId);
    if (!sourceMessage) {
      log.warn({ conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId }, 'relayFanOut: source message not found');
      return;
    }
    const body = typeof sourceMessage.body === 'string' ? sourceMessage.body : '';
    // Media both directions (design Sec 7): the source's DURABLE attachment keys
    // (a team MMS's hub attachments, or a member's mirrored inbound MMS keys) are
    // re-presigned PER LEG below and forwarded to the other members.
    const sourceMedia = mediaAttachmentsOf(sourceMessage);
    const hasMedia = sourceMedia.length > 0;

    // Resolve CURRENT membership at execution time (a mid-thread remove must
    // take effect on the very next fan-out). Sender is excluded by key.
    const roster = (conversation.participants ?? []) as ConversationParticipant[];
    const senderMember = roster.find((m) => relayMemberKey(m) === payload.senderKey);
    // FIX 2: a TEAM message carries an explicit override label (no member
    // sender, senderKey matches nobody so no member is excluded); a normal
    // member-relayed message derives the prefix from the sender's name.
    const senderName = payload.senderNameOverride ?? senderMember?.name;

    // Body for the leg: text (with the "<name>: " prefix) rides media along; a
    // MEDIA-ONLY source uses the relay.media_only catalog copy (no hard-coded
    // string). A source with NEITHER text NOR media is the only true no-op.
    const senderLabel =
      senderName && senderName.trim().length > 0 ? senderName : ANONYMOUS_SENDER_LABEL;
    let relayBody: string;
    if (body.length > 0) {
      relayBody = composeRelayBody(senderName, body);
    } else if (hasMedia) {
      relayBody = resolveMessage('relay.media_only', { name: senderLabel });
    } else {
      // Nothing to relay - never send an empty body.
      log.info(
        { conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId },
        'relayFanOut: source has neither text nor media - nothing relayed',
      );
      return;
    }
    if (hasMedia && !mediaStore) {
      // Degenerate no-bucket config: relay the text notice, but there is no
      // store to presign the media from. Log once (IDs/counts only).
      log.error(
        { conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId, mediaCount: sourceMedia.length },
        'relayFanOut: source has media but no MediaStore - relaying body only, media dropped',
      );
    }

    let recipients = roster.filter((m) => relayMemberKey(m) !== payload.senderKey);
    if (payload.recipientKeys !== undefined) {
      const allowed = new Set(payload.recipientKeys);
      recipients = recipients.filter((m) => allowed.has(relayMemberKey(m)));
    }

    const transientRemaining: string[] = [];
    let sentCount = 0;

    for (const member of recipients) {
      const key = relayMemberKey(member);
      const priorSlot = sourceMessage.delivery_recipients?.[key];
      if (isTerminal(priorSlot?.status)) {
        continue; // already delivered/sent/failed — never double-send
      }

      // Opt-out suppression: relay bypasses the 1:1 sendMessage opt-out gate, so
      // enforce STOP here — an opted-out member is NEVER relayed to. Mark the
      // slot failed/contact_opted_out (terminal → a continuation skips it, no
      // retry) so the thread + Today attention surface can show the member is
      // suppressed. A repo failure propagates (fail CLOSED → job redelivers).
      if (await isMemberSuppressed(contacts, conversations, member)) {
        await markRecipient(messages, payload, key, {
          status: 'failed',
          errorCode: 'contact_opted_out',
        });
        // Annotate the conversation so staff get a Today attention item linking
        // to the member's contact page (they investigate/remove there). BEST-
        // EFFORT: a failure to annotate must NEVER break the fan-out. PII: log
        // IDs/keys only — the stored phone/name are DATA (for display), not a log.
        try {
          await conversations.setRelayMemberOptedOut(payload.relayConversationId, key, {
            ...(member.contactId !== undefined &&
              member.contactId.length > 0 && { contactId: member.contactId }),
            phone: member.phone,
            ...(member.name !== undefined && { name: member.name }),
            at: new Date().toISOString(),
          });
        } catch (err) {
          log.error(
            { err, conversationId: payload.relayConversationId, memberKey: key },
            'relayFanOut: annotating conversation with member opt-out failed — continuing',
          );
        }
        log.info(
          { conversationId: payload.relayConversationId, memberKey: key },
          'relayFanOut: recipient opted out (sms_opt_out) — skipped, not sent',
        );
        continue;
      }

      // A2P meter (FIX 6): ONE token per real outbound SMS — acquired here,
      // per recipient, inside the handler (the correct per-message meter; the
      // producers do not throttle). Paces the fan-out under the registered tier.
      await deps.tokenBucket?.acquire(1);

      // Presign the source media FRESH for THIS leg (design Sec 7: per leg, at
      // leg-send time - a paced roster or backed-off continuation must never
      // hand Twilio an expired URL). Presigned URLs are bearer tokens: passed to
      // the adapter, never logged (the leg logs member keys / counts only).
      let legMediaUrls: string[] | undefined;
      if (hasMedia && mediaStore) {
        const store = mediaStore; // pin for the closure (mediaStore is a let)
        legMediaUrls = await Promise.all(
          sourceMedia.map((a) => store.presign(a.s3Key, RELAY_PRESIGN_TTL_SECONDS)),
        );
      }

      let result;
      try {
        result = await adapter.sendMessage({
          to: member.phone,
          from: poolNumber,
          body: relayBody,
          ...(legMediaUrls !== undefined && { mediaUrls: legMediaUrls }),
        });
      } catch (err) {
        if (err instanceof SendRefusedError) {
          // Opt-out / breaker / manual — by-design refusal for THIS recipient.
          await markRecipient(messages, payload, key, { status: 'failed', errorCode: err.code });
          log.warn({ conversationId: payload.relayConversationId, memberKey: key, refusal: err.code }, 'relayFanOut: send refused for recipient — marked failed, continuing');
          continue;
        }
        // Provider-shaped error: classify by code when present.
        const code = errorCodeOf(err);
        if (code === CARRIER_FILTERED_CODE) {
          await markRecipient(messages, payload, key, { status: 'failed', errorCode: code });
          log.error({ conversationId: payload.relayConversationId, memberKey: key, errorCode: code }, 'relayFanOut: carrier filtering (30007) — recipient failed, NOT retried');
          continue;
        }
        if (code !== undefined && TRANSIENT_CODES.has(code)) {
          // Defer this recipient to a backed-off continuation; keep the slot
          // 'queued' so the continuation re-sends it.
          await markRecipient(messages, payload, key, { status: 'queued', errorCode: code });
          transientRemaining.push(key);
          log.warn({ conversationId: payload.relayConversationId, memberKey: key, errorCode: code, attempt: payload.attempt }, 'relayFanOut: transient send error — deferring recipient to continuation');
          continue;
        }
        // Unknown error: leave the recipient queued and let the job FAIL so
        // SQS redelivers the whole envelope (the marker is per-jobId; the
        // redelivery is a fresh jobId via the visibility timeout).
        throw err;
      }

      // Success: record the per-recipient send result + the relaysid pointer.
      const delivery: RelayRecipientDelivery = {
        status: result.status === 'queued' ? 'queued' : 'sent',
        sid: result.providerSid,
        sentAt: result.providerTs,
      };
      await markRecipient(messages, payload, key, delivery);
      await messages.putRelaySidPointer(result.providerSid, {
        conversationId: payload.relayConversationId,
        tsMsgId: payload.sourceTsMsgId,
        memberKey: key,
      });
      sentCount += 1;
    }

    log.info(
      {
        conversationId: payload.relayConversationId,
        tsMsgId: payload.sourceTsMsgId,
        recipientCount: recipients.length,
        sentCount,
        deferred: transientRemaining.length,
        attempt: payload.attempt,
      },
      'relay fan-out complete',
    );

    // Transient continuation: re-enqueue the remaining recipients with backoff,
    // capped. enqueue() with runAt routes through SQS DelaySeconds (5/10/20s is
    // well within the 12min cap), so the backoff is EXACT — no EventBridge 60s
    // floor inflating a 5s wait to 60s.
    if (transientRemaining.length > 0) {
      const nextAttempt = (payload.attempt ?? 1) + 1;
      if (nextAttempt > MAX_FANOUT_ATTEMPTS) {
        // Cap reached: mark the still-deferred recipients failed so the thread
        // shows the honest outcome (no silent black hole).
        for (const key of transientRemaining) {
          await markRecipient(messages, payload, key, { status: 'failed', errorCode: 'transient_cap' });
        }
        log.error(
          { conversationId: payload.relayConversationId, deferred: transientRemaining.length, attempt: payload.attempt },
          'relayFanOut: transient retry cap reached — remaining recipients marked failed',
        );
        return;
      }
      await enqueue(
        RELAY_FANOUT_JOB,
        {
          relayConversationId: payload.relayConversationId,
          sourceTsMsgId: payload.sourceTsMsgId,
          senderKey: payload.senderKey,
          ...(payload.senderNameOverride !== undefined && {
            senderNameOverride: payload.senderNameOverride,
          }),
          attempt: nextAttempt,
          recipientKeys: transientRemaining,
        } satisfies RelayFanOutPayload,
        { runAt: new Date(Date.now() + fanOutBackoffMs(payload.attempt ?? 1)) },
      );
    }
  });

  // relay.intro (M1.7): on relay-group creation, announce the group to each
  // member FROM the pool number, throttled by the shared bucket. The intro
  // names everyone connected (display names where known, never a phone).
  // Persisted in the thread as a SYSTEM announcement (relayAnnouncements.ts —
  // founder decision 2026-07-14: everything sent into a relay group must be
  // visible in its dashboard thread) UNLESS payload.persist === false (the dev
  // replay seam). Idempotent via the job execution marker so a redelivery
  // never re-texts everyone or double-persists.
  defineJobHandler(RELAY_INTRO_JOB, async (rawPayload) => {
    const payload = parseRelayIntroPayload(rawPayload);
    adapter ??= createMessagingAdapter({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });

    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const first = await messages.putJobExecutionMarker(jobId, payload.relayConversationId);
      if (!first) {
        log.info({ jobId, conversationId: payload.relayConversationId }, 'relay intro duplicate delivery suppressed');
        return;
      }
    }

    // Compose from the CURRENT roster; sendRelayAnnouncement re-validates the
    // conversation (unusable → logged no-op, matching the old intro behavior).
    const conversation = await conversations.getById(payload.relayConversationId);
    const roster = (conversation?.participants ?? []) as ConversationParticipant[];
    // An operator who EDITED the previewed intro gets exactly what they typed
    // (2026-08-20). Untouched, the attribute is absent and we compose from the
    // roster as always - which is the better default, because the roster can
    // still change between the preview and this job, and a composed body follows
    // it while a pinned one cannot. Edited text wins anyway: a human chose it.
    const edited = typeof conversation?.intro_body === 'string' ? conversation.intro_body : '';
    let body: string;
    if (edited.length > 0) {
      // PRECEDENCE 1 (spec 9.1), applied FIRST and verbatim: an operator-edited
      // body wins outright, so the four owner reads below are not even made.
      body = edited;
      log.info(
        { conversationId: payload.relayConversationId },
        'relay intro: sending the operator-edited body, not the composed default',
      );
    } else {
      // Precedence 2-4: tour, then placement, then naked - routed on the
      // conversation's own owner, which this handler already holds.
      const inputs = await resolveOwnerInputs(
        conversation ? getOwner(conversation) : { type: null },
      );
      body = composeIntroBody(
        inputs,
        roster.map((m) => m.name),
      );
    }
    await sendRelayAnnouncement(
      {
        conversationsRepo: conversations,
        messagesRepo: messages,
        contactsRepo: contacts,
        adapter,
        ...(deps.tokenBucket !== undefined && { tokenBucket: deps.tokenBucket }),
        ...(deps.logger !== undefined && { logger: deps.logger }),
      },
      {
        conversationId: payload.relayConversationId,
        body,
        kind: 'relay.intro',
        ...(payload.persist === false && { persist: false }),
      },
    );
  });

  // relay.memberAdded. The founder decision of 2026-07-14 made this ONE body to
  // the whole group, precisely so it could double as the new member's first
  // contact. Phase B REVERSES that (Cameron 2026-08-31, on Sam's 2026-08-24
  // wording, spec 9.4): the group hears "Hey, adding <name> to the group[ as the
  // <role>]." and the new member gets the naked intro. Still ONE persisted row
  // with per-member delivery slots - carrying the NEW MEMBER's body (spec 9.6).
  // Idempotent via the job execution marker.
  defineJobHandler(RELAY_MEMBER_ADDED_JOB, async (rawPayload) => {
    const payload = parseRelayMemberAddedPayload(rawPayload);
    adapter ??= createMessagingAdapter({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });

    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const first = await messages.putJobExecutionMarker(jobId, payload.relayConversationId);
      if (!first) {
        log.info({ jobId, conversationId: payload.relayConversationId }, 'relay member-added duplicate delivery suppressed');
        return;
      }
    }

    const conversation = await conversations.getById(payload.relayConversationId);
    // The POST-ADD roster: the add landed before this job was enqueued, so the
    // new member is on it (a raced remove degrades to the neutral joined label).
    const roster = (conversation?.participants ?? []) as ConversationParticipant[];
    const added = roster.find((m) => relayMemberKey(m) === payload.addedMemberKey);
    // addedMemberKey is a relayMemberKey - the contactId when there is one, ELSE
    // `phone#<E164>` - so it is NOT a contactId in general. The role lookup
    // needs a real contactId, which only the roster row can supply.
    const addedContactId =
      added?.contactId !== undefined && added.contactId.length > 0 ? added.contactId : undefined;
    const inputs = await resolveOwnerInputs(
      conversation ? getOwner(conversation) : { type: null },
      addedContactId,
    );
    // THE SPLIT (spec 9.4): the group hears who joined; the NEW member gets the
    // naked intro instead, because they can see no history - a relay member
    // receives forward traffic only - so this message IS their whole context,
    // and the naked intro is the one that says "it's Sam" and names the group.
    const groupBody = composeMemberAddedGroupBody(inputs, added?.name);
    const newMemberBody = composeIntroBody(
      { ...inputs, variant: 'naked' },
      roster.map((m) => m.name),
    );
    await sendRelayAnnouncement(
      {
        conversationsRepo: conversations,
        messagesRepo: messages,
        contactsRepo: contacts,
        adapter,
        ...(deps.tokenBucket !== undefined && { tokenBucket: deps.tokenBucket }),
        ...(deps.logger !== undefined && { logger: deps.logger }),
      },
      {
        conversationId: payload.relayConversationId,
        // ONE row, and the persisted body is the NEW MEMBER's (spec 9.6,
        // Cameron 2026-08-31): one bubble, one rollup chip, and of the two
        // copies the new member's is the one worth seeing in the thread.
        //
        // EXCEPT in the raced remove the docblock above anticipates: with the
        // joiner already off the roster, `added` is undefined and bodyFor
        // matches nobody, so EVERY leg is the group body. Persisting the new
        // member's copy there would leave a bubble - and an inbox preview -
        // quoting a message no recipient received.
        body: added !== undefined ? newMemberBody : groupBody,
        kind: 'relay.member_added',
        bodyFor: (m) =>
          relayMemberKey(m) === payload.addedMemberKey ? newMemberBody : groupBody,
      },
    );
  });
}

/** Persist one recipient's delivery slot on the source message. */
async function markRecipient(
  messages: MessagesRepo,
  payload: RelayFanOutPayload,
  memberKey: string,
  delivery: RelayRecipientDelivery,
): Promise<void> {
  await messages.setRecipientDelivery(
    payload.relayConversationId,
    payload.sourceTsMsgId,
    memberKey,
    delivery,
  );
}

/**
 * Exclusive `before` bound that INCLUDES the target SK: append the maximal
 * BMP code point so `tsMsgId < before` is true for the target itself (and any
 * later SK in the same second is excluded — relay sources are inbound, one at
 * a time, so the 5-item window comfortably contains it).
 */
function bumpKey(tsMsgId: string): string {
  return `${tsMsgId}￿`;
}

/** Best-effort provider error-code extraction (Twilio attaches `code`). */
function errorCodeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return String(code);
    if (typeof code === 'string' && code.length > 0) return code;
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return String(status);
  }
  return undefined;
}
