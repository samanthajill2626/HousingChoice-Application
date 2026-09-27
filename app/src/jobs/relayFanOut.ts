// relay.fanOut (M1.7) - fan an inbound relay-group message out to the OTHER
// members, throttled and idempotent.
//
// The relayed message is stored ONCE (the inbound SOURCE message); this job
// NEVER persists N outbound copies. It sends one provider message per
// recipient FROM the pool number, sender-name-prefixed, and records each send
// in the source message's delivery_recipients map + a relaysid pointer (so the
// per-recipient delivery callback can find the right slot).
//
// Each member is ONE leg (`sendOneRelayLeg`) with three phases (SOR spec
// D7a), run inside one try/catch that tracks the phase, so nothing in the leg
// throws out of the loop and a failure is handled by WHERE it happened:
//   - PREPARE: skip a TERMINAL slot (sent/delivered/failed); the roster
//     suppression check (an opted-out member is failed contact_opted_out,
//     behind the D8 gate so it never overwrites a member another attempt
//     owns); the A2P token acquire (bounded only for the 30003 retry rung,
//     whose deadline is `deadline_exceeded`, never a claim); then the CLAIM on
//     the member's send-attempt record (D8a) - a fresh foreign attempt defers
//     the member, a terminal one skips it, a stale one is taken over into
//     reconcile; the attempt clock on the slot; the per-leg presign; the
//     `attempted` aggregation write. A throw before the claim sent nothing
//     and defers the member with NO slot write; a throw after it releases the
//     attempt as retryable and defers.
//   - SEND: the provider call. A failure is classified (D1-D6): a refusal
//     fails the member with its code; `rejected` fails it with the provider
//     code (30007 never retried; an HTTP status never reaches a slot);
//     `retryable` defers it to the backed-off continuation (capped at
//     MAX_FANOUT_ATTEMPTS); `unknown` hands it to the send.reconcile job (D7) -
//     the slot stays `queued` and only the verdict writes it.
//   - RECORD: the slot (sent/queued, sid, sentAt), then the relaysid pointer,
//     then the record done/sent. A failure here is `sent_unrecorded`: the text
//     went out, so the member is handed to reconcile WITH its SID and never
//     re-sent (D3a).
//
// The leg never enqueues: the loop hands a `handed_to_reconcile` /
// `sent_unrecorded` outcome to the reconcile job with the continuation
// context it holds. Every failure-arm write goes through guardWrite: a lost
// write is logged at ERROR and the attempt record decides. The outage brake
// (D9): three consecutive UNKNOWN outcomes end the pass early - every member
// not yet attempted is deferred to the continuation and one WARN (event
// `outage_brake`) names the count. A cap-close passes the D8 gate per member.
//
// Idempotency (SQS at-least-once + our own continuation re-enqueues):
//   - the job execution marker (existing pattern) guards the WHOLE job per
//     envelope jobId;
//   - per recipient, a slot already in a TERMINAL state is SKIPPED, and the
//     claim on the send-attempt record refuses a second attempt while one is
//     open or after one sent (a relay success may leave the slot `queued`), so
//     a redelivered / continuation / re-drive job never double-sends.
//
// PII (doc Sec 9): never log the body, the sender's phone, or member phones -
// IDs / member keys (through logSafeMemberKey / safeRecipientKey) / counts
// only, correlated via the pino mixin.
import {
  createMessagingAdapter,
  type CarrierMessageSender,
  type MessagingAdapter,
  type MessageTransportIntent,
  type SendMessageParams,
  type SendMessageResult,
} from '../adapters/messaging.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { getContext } from '../lib/context.js';
import { guardWrite } from '../lib/guardWrite.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { bodyFingerprint, recipientDigest, safeRecipientKey } from '../lib/sendFingerprint.js';
import {
  classifySendFailure,
  ENQUEUE_FAILED_CODE,
  isProviderCode,
  OUTAGE_BRAKE_UNKNOWN_STREAK,
  REDRIVE_REFUSED_CODE,
  SEND_RETRYABLE_CODE,
  SEND_UNCONFIRMED_CODE,
  SMS_SENDING_DISABLED_CODE,
  TRANSIENT_CAP_CODE,
} from '../lib/sendOutcome.js';
import { TokenBucketBusyError, type TokenBucket } from '../lib/tokenBucket.js';
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
  type MediaAttachment,
  type MessageItem,
  type MessagesRepo,
  type RelayRecipientDelivery,
  type TransportMutationOutcome,
} from '../repos/messagesRepo.js';
import {
  createSendAttemptsRepo,
  type AttemptRef,
  type SendAttemptOwner,
  type SendAttemptsRepo,
} from '../repos/sendAttemptsRepo.js';
import { TRANSPORT_SCHEMA_VERSION } from '../lib/messageTransport.js';
import { gateFor } from '../lib/sendAttemptGate.js';
import type { FanoutClaimResult } from '../repos/fanoutClaim.js';
import { SMS_BRAND_NAME } from '../lib/smsCompliance.js';
import { SendRefusedError } from '../services/sendMessage.js';
import {
  isMemberSuppressed,
  logSafeMemberKey,
  sendRelayAnnouncement,
} from '../services/relayAnnouncements.js';
import { resolveMessage } from '../messages/index.js';
import { defineJobHandler, enqueue } from './jobs.js';
import { enqueueSendReconcile, reconcileDelayMs, toOwnerRef } from './sendReconcile.js';

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

/**
 * Exponential backoff for the transient-failure continuation. The call site
 * passes the CURRENT pass number, not the next one (M5 D7/D11: relay's
 * argument differs from broadcastFanOut's deliberately and is preserved, not
 * normalised), so the live ladder is 5s then 10s ONLY - pass 3 reaches the
 * cap and closes instead of enqueueing, which leaves the 20s rung unreachable.
 */
export function fanOutBackoffMs(attempt: number): number {
  return 5_000 * 2 ** (attempt - 1);
}

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
  /**
   * SOR D13a/D16: a RE-DRIVE pass - the reconcile ruled one member
   * never_sent and re-drove it. Such a pass claims no ladder rung up front
   * (only after its loop, and only for a transient remainder), so a spent
   * ladder cannot close the member before it is tried; and an early return
   * (the group closed, the source gone) closes the member it carries
   * redrive_refused. A transient continuation never carries it: the gate and
   * the claim treat a `redriven` record the same on every pass.
   */
  redrive?: true;
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
    ...(p.redrive === true && { redrive: true as const }),
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
  adapter?: MessagingAdapter & CarrierMessageSender;
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
  /**
   * The per-recipient send-attempt records (SOR spec D8a): claimed before
   * every relay.fanOut leg and read by the D8 gate. Lazily created on the
   * first fan-out run; a test passes its fake world's so no job run ever
   * opens a real DynamoDB connection.
   */
  sendAttemptsRepo?: SendAttemptsRepo;
  /**
   * The instant the owner-routed copy's "is the tour past / is it TODAY" tests
   * are made against, forwarded to `resolveRelayComposeInputs`. Absent at
   * runtime, which is every production caller, that resolver reads the real
   * clock exactly as before.
   *
   * The seam exists so a test can drive the REAL job at a pinned instant. A
   * scenario that seeds a fixed tour date and reads the wall clock is running
   * on two timelines, and it stays green only until the fixed date goes past -
   * which is how this file's TOUR_AT scenario went red on 2026-09-09 having
   * been written as a "far-future" constant.
   */
  nowIso?: string;
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
  let sendAttempts = deps.sendAttemptsRepo;

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
        ...(deps.nowIso !== undefined && { nowIso: deps.nowIso }),
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
    sendAttempts ??= createSendAttemptsRepo({ logger: deps.logger });
    if (!mediaStoreInit) {
      mediaStore = createMediaStore();
      mediaStoreInit = true;
    }
    // Pinned for the closures below: a captured reassignable `let` loses its
    // non-undefined narrowing inside a closure (build finding T7-4).
    const attempts = sendAttempts;
    const messageStore = messages;
    /**
     * Build finding T8-9: a RE-DRIVE pass that returns before its loop closes
     * the member it carries (record FIRST, then the slot) - see
     * closeRedriveRefused. A no-op on every other pass.
     */
    const refuseRedrive = (cause: string): Promise<void> =>
      closeRedriveRefused(messageStore, attempts, payload, log, payload.recipientKeys ?? [], cause);

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
      await refuseRedrive('conversation_not_found');
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
      await refuseRedrive('group_not_open');
      return;
    }
    const poolNumber = conversation.pool_number;
    if (typeof poolNumber !== 'string' || poolNumber.length === 0) {
      log.warn({ conversationId: payload.relayConversationId }, 'relayFanOut: relay conversation has no pool number — skipping');
      await refuseRedrive('no_pool_number');
      return;
    }

    // Re-read the exact source message by SK (a tight window that includes it).
    // A continuation or a re-drive decides from a strongly consistent snapshot
    // (SOR D11, D16): the pass before it, or the reconcile, wrote the slots it
    // reads. The first pass keeps the cheap read.
    const consistent = payload.recipientKeys !== undefined;
    const windowOpts = { before: bumpKey(payload.sourceTsMsgId), limit: 5 };
    const window = consistent
      ? await messages.listByConversationConsistent(payload.relayConversationId, windowOpts)
      : await messages.listByConversation(payload.relayConversationId, windowOpts);
    const sourceMessage = window.find((m) => m.tsMsgId === payload.sourceTsMsgId);
    if (!sourceMessage) {
      log.warn({ conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId }, 'relayFanOut: source message not found');
      await refuseRedrive('source_not_found');
      return;
    }
    const execution: RelayFanOutExecutionDeps = {
      adapter,
      conversations,
      messages,
      contacts,
      conversation,
      poolNumber,
      mediaStore,
      tokenBucket: deps.tokenBucket,
      sendAttempts: attempts,
      consistent,
      log,
    };
    if (sourceMessage.transport_schema_version !== TRANSPORT_SCHEMA_VERSION) {
      await runLegacyRelayFanOut(sourceMessage, payload, execution);
      return;
    }
    await runVersionedRelayFanOut(sourceMessage, payload, execution);
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

interface RelayFanOutExecutionDeps {
  adapter: MessagingAdapter & CarrierMessageSender;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  contacts: ContactsRepo;
  conversation: Awaited<ReturnType<ConversationsRepo['getById']>> & {};
  poolNumber: string;
  mediaStore: MediaStore | undefined;
  tokenBucket: TokenBucket | undefined;
  /** The send-attempt records (SOR D8a): the legs' claims and the cap-close gate. */
  sendAttempts: SendAttemptsRepo;
  /** A continuation or a re-drive: every source re-read is strongly consistent (SOR D11). */
  consistent: boolean;
  log: Logger;
}

/**
 * Which transport contract a relay send runs under. EXPORTED because the 30003
 * retry job resolves the mode from the ORIGINAL source row (spec D2 - every
 * relay source written before 2026-09-02 is legacy) and hands it to
 * `sendOneRelayLeg`, so its own job signature has to name this type.
 */
export type RelayTransportMode =
  | { kind: 'legacy' }
  | { kind: 'versioned'; intent: MessageTransportIntent };

async function runLegacyRelayFanOut(
  source: MessageItem,
  payload: RelayFanOutPayload,
  deps: RelayFanOutExecutionDeps,
): Promise<void> {
  await runRelayFanOutExecution(source, payload, deps, { kind: 'legacy' });
}

async function runVersionedRelayFanOut(
  source: MessageItem,
  payload: RelayFanOutPayload,
  deps: RelayFanOutExecutionDeps,
): Promise<void> {
  const durableMedia = mediaAttachmentsOf(source);
  const intent = deps.adapter.classifyMessageTransport({
    hasForwardableMedia: durableMedia.length > 0 && deps.mediaStore !== undefined,
  });
  await runRelayFanOutExecution(source, payload, deps, { kind: 'versioned', intent });
}

async function runRelayFanOutExecution(
  source: MessageItem,
  payload: RelayFanOutPayload,
  deps: RelayFanOutExecutionDeps,
  transport: RelayTransportMode,
): Promise<void> {
  const { adapter, conversations, messages, contacts, conversation, poolNumber, mediaStore, log } = deps;
  const attempts = deps.sendAttempts;
  const body = typeof source.body === 'string' ? source.body : '';
  const sourceMedia = mediaAttachmentsOf(source);
  const hasMedia = sourceMedia.length > 0;
  const roster = (conversation.participants ?? []) as ConversationParticipant[];
  const senderMember = roster.find((member) => relayMemberKey(member) === payload.senderKey);
  const senderName = payload.senderNameOverride ?? senderMember?.name;
  const senderLabel =
    senderName && senderName.trim().length > 0 ? senderName : ANONYMOUS_SENDER_LABEL;
  let relayBody: string;
  if (body.length > 0) {
    relayBody = composeRelayBody(senderName, body);
  } else if (hasMedia) {
    relayBody = resolveMessage('relay.media_only', { name: senderLabel });
  } else {
    log.info(
      { conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId },
      'relayFanOut: source has neither text nor media - nothing relayed',
    );
    await closeRedriveRefused(messages, attempts, payload, log, payload.recipientKeys ?? [], 'nothing_to_relay');
    return;
  }
  if (hasMedia && !mediaStore) {
    log.error(
      {
        conversationId: payload.relayConversationId,
        tsMsgId: payload.sourceTsMsgId,
        mediaCount: sourceMedia.length,
      },
      'relayFanOut: source has media but no MediaStore - relaying body only, media dropped',
    );
  }

  const currentRoster = roster.filter((member) => relayMemberKey(member) !== payload.senderKey);
  let recipients = currentRoster;
  if (payload.recipientKeys !== undefined) {
    const allowed = new Set(payload.recipientKeys);
    recipients = recipients.filter((member) => allowed.has(relayMemberKey(member)));
  }

  let currentSource = source;
  if (transport.kind === 'versioned') {
    currentSource = await preflightVersionedRecipients(
      source,
      payload,
      recipients,
      currentRoster,
      transport.intent,
      messages,
      deps.consistent,
    );
    const persistedRequests = new Set(
      recipients
        .map((member) => currentSource.delivery_recipients?.[relayMemberKey(member)]?.requestedTransport)
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
    );
    if (
      (source.requested_transport !== undefined &&
        source.requested_transport !== transport.intent.requestedTransport) ||
      [...persistedRequests].some((request) => request !== transport.intent.requestedTransport)
    ) {
      log.warn(
        {
          conversationId: payload.relayConversationId,
          tsMsgId: payload.sourceTsMsgId,
          requestedTransport: source.requested_transport,
          executionTransport: transport.intent.requestedTransport,
        },
        'relayFanOut: persisted transport intent differs from execution classification',
      );
    }
  }

  let claim: FanoutClaimResult | undefined;

  /** The log context of a member known only by its key: through safeRecipientKey, never a raw phone key (G9). */
  function keyCtx(memberKey: string): { conversationId: string; tsMsgId: string; recipientKey: string } {
    return {
      conversationId: payload.relayConversationId,
      tsMsgId: payload.sourceTsMsgId,
      recipientKey: safeRecipientKey(memberKey),
    };
  }

  /**
   * Enqueue check 0 of the send.reconcile chain for one member (D7), carrying
   * the continuation context a never_sent verdict needs to re-drive it - the
   * sender key and name override this pass holds (D12). NEVER throws: an
   * enqueue that fails closes the member unresolved on the spot - the slot
   * `failed` / send_unconfirmed FIRST, then the record done / unresolved (D7,
   * D13a) - so nothing waits on a chain that never started.
   */
  async function handOff(owner: RelayLegOwner, attemptedAt: string): Promise<void> {
    const ctx = keyCtx(owner.memberKey);
    try {
      await enqueueSendReconcile(
        {
          owner: toOwnerRef(owner),
          attemptedAt,
          checkNo: 0,
          continuation: {
            senderKey: payload.senderKey,
            ...(payload.senderNameOverride !== undefined && { senderNameOverride: payload.senderNameOverride }),
          },
        },
        reconcileDelayMs(attemptedAt, 0, Date.now()),
      );
    } catch (err) {
      await guardWrite(log, ctx, 'closeUnconfirmed', () =>
        messages.closeRelayRecipientIfUnsent(payload.relayConversationId, payload.sourceTsMsgId, owner.memberKey, {
          status: 'failed',
          errorCode: SEND_UNCONFIRMED_CODE,
        }),
      );
      await guardWrite(log, ctx, 'closeFromReconcile', () =>
        attempts.closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause: ENQUEUE_FAILED_CODE }),
      );
      log.error(
        { err, ...ctx, cause: ENQUEUE_FAILED_CODE },
        'relayFanOut: reconcile enqueue failed - member closed unresolved (send_unconfirmed)',
      );
    }
  }

  /**
   * M5 D8: terminal-close every still-open member in `memberKeys` with `code`
   * - the cap reached mid-ladder (close A), a pass beginning with the ladder
   * spent (close B), a continuation the queue refused (close C, `code`
   * enqueue_failed) - and write one operator ERROR line.
   *
   * SOR D8: this is a close by a writer OTHER than the member's own attempt,
   * so each member passes the D8 gate first: an absent, done/retryable or
   * redriven record is closed (a redriven one's record too - `code` keeps
   * the caller's reason, build finding G7); a stale attempting record is
   * taken over and handed to reconcile; a live or terminal one is left to
   * its owner. The slot close itself is conditional: it writes an ABSENT slot
   * (a legacy source starts with an empty map) or a `queued` one with no
   * sid, never a send that landed. Each member is its own try/catch: one
   * failure never skips the rest or the operator line (build finding T8-6).
   */
  async function closeRelay(
    memberKeys: string[],
    code: string,
    cause?: unknown,
  ): Promise<void> {
    for (const key of memberKeys) {
      if (isTerminal(currentSource.delivery_recipients?.[key]?.status)) continue;
      const owner = legOwner(payload, key);
      const ctx = keyCtx(key);
      try {
        const gate = await gateFor(attempts, owner, Date.now());
        if (gate.kind === 'taken_over') {
          await handOff(owner, gate.record.attemptedAt);
          continue;
        }
        if (gate.kind !== 'proceed') {
          log.info({ ...ctx, gate: gate.kind, closeCode: code }, 'relayFanOut: close left the member to its own attempt');
          continue;
        }
        await messages.closeRelayRecipientIfUnsent(payload.relayConversationId, payload.sourceTsMsgId, key, {
          status: 'failed',
          errorCode: code,
        });
        if (gate.record?.state === 'redriven') {
          await guardWrite(log, ctx, 'closeRedriven', () =>
            attempts.closeRedriven(owner, {
              outcome: code === ENQUEUE_FAILED_CODE ? 'enqueue_failed' : 'refused',
              cause: code,
            }),
          );
        }
      } catch (err) {
        log.error({ err, ...ctx, label: 'capClose' }, 'relayFanOut: closing one member failed; the rest still close');
      }
    }
    const fanoutAttempt =
      claim !== undefined && claim.outcome !== 'missing' ? claim.attempt : undefined;
    log.error(
      {
        conversationId: payload.relayConversationId,
        tsMsgId: payload.sourceTsMsgId,
        deferred: memberKeys.length,
        closeCode: code,
        fanoutAttempt,
        envelopeAttempt: payload.attempt,
        ...(cause !== undefined && { err: cause }),
      },
      'relayFanOut: fan-out closed - remaining recipients marked failed',
    );
  }

  // The continuation budget is stored on the source message. This preserves
  // main's durable cap for both schema-absent jobs and versioned transport jobs.
  // SOR D13a: a RE-DRIVE pass claims nothing up front - only after its loop,
  // and only if it has a transient remainder - so a spent ladder cannot close
  // the re-driven member before it is tried.
  const pending = recipients.filter(
    (member) =>
      !isTerminal(currentSource.delivery_recipients?.[relayMemberKey(member)]?.status),
  );
  if (pending.length > 0 && payload.redrive !== true) {
    claim = await messages.claimFanoutPass(
      payload.relayConversationId,
      payload.sourceTsMsgId,
      MAX_FANOUT_ATTEMPTS,
    );
    if (claim.outcome === 'missing') {
      log.warn(
        { conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId },
        'relayFanOut: source message vanished before the pass claim - nothing relayed',
      );
      return;
    }
    if (claim.outcome === 'capped') {
      await closeRelay(pending.map(relayMemberKey), TRANSIENT_CAP_CODE);
      return;
    }
  }

  const transientRemaining: string[] = [];
  let sentCount = 0;
  let handedCount = 0;
  // D9 outage brake: consecutive UNKNOWN outcomes in THIS pass (see
  // isUnknownOutcome). Any other outcome - sent, rejected, retryable,
  // refused, a skip, a deferral, a takeover - resets it. Once braked, every
  // member not yet attempted in this pass is deferred with no slot write,
  // whatever its record says.
  let unknownStreak = 0;
  let braked = false;
  let untried = 0;
  for (const member of recipients) {
    const memberKey = relayMemberKey(member);
    // Already terminal - never re-sent. Checked BEFORE the brake, so a
    // terminal member is never carried (build finding T7-12).
    if (isTerminal(currentSource.delivery_recipients?.[memberKey]?.status)) continue;
    if (braked) {
      transientRemaining.push(memberKey);
      untried += 1;
      continue;
    }
    const owner = legOwner(payload, memberKey);
    let unknown = false;
    // The leg never throws (D7a); this catch is the loop's own guarantee that
    // a member is deferred, never dropped, and nothing leaves the job.
    try {
      const outcome = await sendOneRelayLeg({
        messages,
        conversations,
        contacts,
        adapter,
        mediaStore,
        log,
        tokenBucket: deps.tokenBucket,
        payload,
        member,
        currentSource,
        poolNumber,
        legBody: relayBody,
        sourceMedia,
        transport,
        sendAttempts: attempts,
        owner,
      });
      unknown = isUnknownOutcome(outcome);
      switch (outcome.kind) {
        case 'sent':
          sentCount += 1;
          break;
        case 'transient':
          // A deferral because a FOREIGN attempt owns the member wrote no slot;
          // it is carried only by a continuation (D8a: "a refused claim on a
          // recipient a continuation carries is deferred again") - on a first
          // pass the attempt that owns it is another pass's, which carries it.
          if (outcome.deferredByClaim !== true || payload.recipientKeys !== undefined) {
            transientRemaining.push(memberKey);
          }
          break;
        case 'stranded':
          // The hand-off write failed: the record stays attempting, the slot
          // untouched. Carried with no slot write; the relay ladder (5 s + 10 s)
          // cannot outlast the claim TTL, so a still-fresh record is deferred
          // at the cap and left for the sweeper (spec D8a, revision 11).
          transientRemaining.push(memberKey);
          break;
        case 'handed_to_reconcile':
        case 'sent_unrecorded':
          if (outcome.attemptRef === undefined) {
            // Unreachable since the leg's record args are required (SOR Task
            // 9): the narrowing the optional field needs, logged not thrown.
            log.error(
              { ...memberCtx(payload, member), legOutcome: outcome.kind },
              'relayFanOut: a leg outcome for the reconcile came back without an attempt record - nothing handed off',
            );
            break;
          }
          handedCount += 1;
          await handOff(owner, outcome.attemptRef.attemptedAt);
          break;
        case 'skipped_terminal':
        case 'suppressed':
        case 'refused':
        case 'filtered':
        case 'rejected':
        case 'deadline_exceeded':
          break;
        default: {
          const unhandled: never = outcome.kind;
          throw new Error(`relayFanOut: unhandled leg outcome ${String(unhandled)}`);
        }
      }
    } catch (err) {
      log.error(
        { err, ...memberCtx(payload, member) },
        'relayFanOut: a leg failed outside its own handling - member deferred to the continuation',
      );
      transientRemaining.push(memberKey);
    }
    if (unknown) {
      unknownStreak += 1;
      if (unknownStreak >= OUTAGE_BRAKE_UNKNOWN_STREAK) braked = true;
    } else {
      unknownStreak = 0;
    }
  }
  if (braked) {
    log.warn(
      {
        event: 'outage_brake',
        conversationId: payload.relayConversationId,
        tsMsgId: payload.sourceTsMsgId,
        untried,
        deferred: transientRemaining.length,
        attempt: payload.attempt,
      },
      'relayFanOut: outage brake - consecutive unknown send outcomes; the untried remainder is deferred',
    );
  }

  log.info(
    {
      conversationId: payload.relayConversationId,
      tsMsgId: payload.sourceTsMsgId,
      recipientCount: recipients.length,
      sentCount,
      handed: handedCount,
      deferred: transientRemaining.length,
      attempt: payload.attempt,
    },
    'relay fan-out complete',
  );

  if (transientRemaining.length === 0) return;
  if (claim === undefined) {
    // Reached only by a RE-DRIVE pass (every other pass with a non-terminal
    // member claimed above): it claims its rung now, because it has a
    // remainder to defer, and takes the same branches the up-front claim
    // takes - never a close for want of a claim.
    claim = await messages.claimFanoutPass(
      payload.relayConversationId,
      payload.sourceTsMsgId,
      MAX_FANOUT_ATTEMPTS,
    );
    if (claim.outcome === 'missing') {
      log.warn(
        { conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId },
        'relayFanOut: source message vanished before the pass claim - nothing to defer',
      );
      await closeRedriveRefused(messages, attempts, payload, log, transientRemaining, 'source_vanished');
      return;
    }
    if (claim.outcome === 'capped') {
      await closeRelay(transientRemaining, TRANSIENT_CAP_CODE);
      return;
    }
  }
  if (claim.outcome !== 'claimed') {
    // Unreachable by construction: both claims return above on `missing` and
    // `capped`. Narrowed rather than asserted, and closed rather than ignored.
    await closeRelay(transientRemaining, TRANSIENT_CAP_CODE);
    return;
  }
  if (claim.attempt >= MAX_FANOUT_ATTEMPTS) {
    await closeRelay(transientRemaining, TRANSIENT_CAP_CODE);
    return;
  }
  const nextAttempt = claim.attempt + 1;
  try {
    // A transient continuation never carries `redrive` (SOR D13a): a
    // redriven record is claimable and closable by any pass.
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
      { runAt: new Date(Date.now() + fanOutBackoffMs(claim.attempt)) },
    );
  } catch (err) {
    await closeRelay(transientRemaining, ENQUEUE_FAILED_CODE, err);
  }
}

/**
 * The source-row coordinates every relay slot write is addressed by, plus the
 * envelope attempt the transient log line reports. Narrowed from
 * `RelayFanOutPayload` so a caller that is NOT a fan-out job - the 30003 retry
 * ladder, which addresses its own single-recipient retry row (spec D10) - can
 * drive the per-leg unit without inventing a `senderKey` it has no use for.
 * Purely a type narrowing: every existing call site still passes a whole
 * `RelayFanOutPayload`, which satisfies this shape structurally.
 */
export type RelayLegPayload = Pick<
  RelayFanOutPayload,
  'relayConversationId' | 'sourceTsMsgId' | 'attempt'
>;

/**
 * How one relay leg ended (SOR spec D7a). The unit writes every slot it
 * decides itself and NEVER enqueues; the caller counts the kind, carries the
 * member when told to, and enqueues the reconcile for the two hand-off kinds.
 *
 * - `sent`: the provider accepted; the slot, the relaysid pointer and the
 *   record done/sent are written. `providerSid`.
 * - `skipped_terminal`: nothing done - the slot was terminal, the member's
 *   attempt record is terminal or being reconciled (a refused claim, or the
 *   D8 gate's skip on the suppression arm), or a takeover or a hand-off lost
 *   its fence to another writer, which owns the record. Never carried.
 *   `reason: 'unknown'` marks the lost hand-off of an UNKNOWN send outcome:
 *   it counts toward the outage brake like any unknown (the broadcast twin).
 * - `suppressed` / `refused` / `filtered`: a TERMINAL slot with that arm's
 *   code (`contact_opted_out`, the refusal code, 30007) is written.
 * - `rejected`: the provider refused (D5): the slot is failed with the
 *   provider code (`errorCode`; ABSENT for a code-less 4xx - an HTTP status
 *   never reaches a slot, D10) and the record done/rejected. Also the D13a
 *   close of a re-drive attempt whose outcome is unknown AGAIN: `errorCode`
 *   send_unconfirmed, the record done/unresolved, no second reconcile.
 * - `transient`: defer to the continuation. `errorCode` is the slot code
 *   written (the provider's, or send_retryable). With `deferredByClaim` NO
 *   slot was written: a FOREIGN attempt owns the member (the gate's defer or
 *   a fresh refused claim). A throw before the claim also writes no slot
 *   (build ruling A3).
 * - `deadline_exceeded` (retry-send-window spec D4) is reachable ONLY for a
 *   caller that passed `sendDeadlineMs` - the 30003 retry job; the fan-out
 *   never does. The bounded token-bucket wait ran out BEFORE the claim:
 *   NOTHING was written (no slot, no aggregation state, no record) and
 *   nothing was sent, so the caller owns the close. It is terminal for a
 *   retry rung - never a `transient` to re-defer, whose branch assumes a
 *   provider refusal and would re-open a send past the window.
 * - `sent_unrecorded` (D3a): the provider ACCEPTED but a record-phase write
 *   threw. `providerSid`; `attemptRef` - the record moved to reconciling
 *   WITH the SID and the caller hands off (the known-SID reconcile repairs
 *   the writes).
 * - `handed_to_reconcile`: the record is reconciling and the caller must hand
 *   off, exactly once. `reason: 'unknown'` - the provider outcome was unknown
 *   (D7); `reason: 'takeover'` - a stale attempt was taken over (D8a) and
 *   `attemptRef` carries THAT attempt's clock. Both hand-off kinds always
 *   carry `attemptRef`: the record args are required (SOR Task 9).
 * - `stranded`: the hand-off write itself failed (D7a): the record stays
 *   attempting, the slot untouched; the caller carries the member with no
 *   slot write, and the claim refuses any re-send. `afterSend` - the send is
 *   KNOWN to have happened (a record-phase failure), so it does not count
 *   toward the outage brake.
 */
export interface RelayLegSendOutcome {
  kind:
    | 'sent'
    | 'skipped_terminal'
    | 'suppressed'
    | 'refused'
    | 'filtered'
    | 'rejected'
    | 'transient'
    | 'deadline_exceeded'
    | 'sent_unrecorded'
    | 'handed_to_reconcile'
    | 'stranded';
  providerSid?: string;
  errorCode?: string;
  /** On `sent_unrecorded` / `handed_to_reconcile`: the attempt to hand off. */
  attemptRef?: AttemptRef;
  /** On `handed_to_reconcile` (and a lost hand-off's `skipped_terminal`): why. */
  reason?: 'unknown' | 'takeover';
  /** On `transient`: a FOREIGN attempt owns the member; no slot was written. */
  deferredByClaim?: true;
  /** On `stranded`: the send is known to have happened. */
  afterSend?: true;
}

/**
 * D9: did this leg end in an UNKNOWN provider outcome? A hand-off, a strand
 * before any known send, a re-drive attempt's second unknown (closed
 * send_unconfirmed - it counts, as the broadcast twin's does) and the lost
 * hand-off of an unknown all count toward the outage brake; everything else -
 * a takeover, a strand after a KNOWN send, a rejection, a retryable - resets.
 */
function isUnknownOutcome(outcome: RelayLegSendOutcome): boolean {
  switch (outcome.kind) {
    case 'handed_to_reconcile':
    case 'skipped_terminal':
      return outcome.reason === 'unknown';
    case 'stranded':
      return outcome.afterSend !== true;
    case 'rejected':
      return outcome.errorCode === SEND_UNCONFIRMED_CODE;
    default:
      return false;
  }
}

/** The relay-leg member of the send-attempt owner union. */
type RelayLegOwner = Extract<SendAttemptOwner, { kind: 'relay_leg' }>;

function legOwner(payload: RelayLegPayload, memberKey: string): RelayLegOwner {
  return {
    kind: 'relay_leg',
    relayConversationId: payload.relayConversationId,
    sourceTsMsgId: payload.sourceTsMsgId,
    memberKey,
  };
}

/** The log context of one roster member: through logSafeMemberKey, never a phone (G9). */
function memberCtx(
  payload: RelayLegPayload,
  member: ConversationParticipant,
): { conversationId: string; tsMsgId: string; memberKey: string } {
  return {
    conversationId: payload.relayConversationId,
    tsMsgId: payload.sourceTsMsgId,
    memberKey: logSafeMemberKey(member),
  };
}

/**
 * SOR D16 / build finding T8-9: a RE-DRIVE pass that cannot run (the group
 * closed or vanished, no pool number, the source gone, nothing to relay)
 * closes each member it carries. The RECORD first - closeRedriven is fenced on
 * `redriven`, so it moves only a record no pass has claimed since - and the
 * slot `failed` / redrive_refused only when that fence won, so a pass that no
 * longer owns the record never closes a slot another pass may be sending. A
 * no-op on any other pass. Every write is best-effort; never throws.
 */
async function closeRedriveRefused(
  messages: MessagesRepo,
  attempts: SendAttemptsRepo,
  payload: RelayFanOutPayload,
  log: Logger,
  memberKeys: readonly string[],
  cause: string,
): Promise<void> {
  if (payload.redrive !== true) return;
  let closedCount = 0;
  for (const memberKey of memberKeys) {
    const ctx = {
      conversationId: payload.relayConversationId,
      tsMsgId: payload.sourceTsMsgId,
      recipientKey: safeRecipientKey(memberKey),
    };
    let closed = false;
    await guardWrite(log, ctx, 'closeRedriven', async () => {
      closed = await attempts.closeRedriven(legOwner(payload, memberKey), { outcome: 'redrive_refused', cause });
    });
    if (!closed) continue;
    closedCount += 1;
    await guardWrite(log, ctx, 'redriveRefusedSlot', () =>
      messages.closeRelayRecipientIfUnsent(payload.relayConversationId, payload.sourceTsMsgId, memberKey, {
        status: 'failed',
        errorCode: REDRIVE_REFUSED_CODE,
      }),
    );
  }
  log.warn(
    {
      conversationId: payload.relayConversationId,
      tsMsgId: payload.sourceTsMsgId,
      cause,
      carried: memberKeys.length,
      closed: closedCount,
    },
    'relayFanOut: re-drive refused - the carried members were closed redrive_refused',
  );
}

/**
 * Send ONE relay leg to ONE member and record the result on the source row.
 *
 * THIS UNIT ALREADY PERSISTS - callers must not repeat either write. On the
 * success path it writes the member's delivery slot (sent/queued, sid, sentAt,
 * actualTransport) AND the `relaysid#` pointer the per-recipient status
 * callback resolves through. On `suppressed`, `refused`, `filtered` and
 * `rejected` it has already written a TERMINAL slot carrying that arm's
 * specific error code, so re-closing the slot afterwards would only overwrite
 * it with a vaguer one.
 *
 * Extracted from the fan-out loop body (spec D10) so the 30003 retry job
 * reuses the transport-fidelity machinery instead of forking it. SOR spec D7a
 * split it into PREPARE / SEND / RECORD phases inside ONE try/catch that
 * tracks the phase, and the phase decides the catch - so NOTHING in here
 * throws: a throw before the claim defers the member with no slot write; a
 * throw after the claim and before the send releases the attempt retryable
 * and defers; a throw at 'sending' is classified and is NEVER turned into a
 * re-send (unknown -> reconcile); a throw at 'record' happened after a KNOWN
 * send and hands the SID to reconcile. Every failure-arm write goes through
 * guardWrite (a lost write is logged at ERROR and the attempt record decides).
 *
 * `suppressionChecked` and `sendDeadlineMs` (both optional) are the two
 * behavioral knobs, and the fan-out passes neither - see each one's own doc
 * below: why a caller that has just run the same suppression check must not
 * let this unit run it a second time, and why a retry rung's wait on the A2P
 * meter is bounded by its send window. `sendAttempts` + `owner` switch on the
 * send-attempt record (SOR D8a); see their doc.
 */
export async function sendOneRelayLeg(args: {
  messages: MessagesRepo;
  conversations: ConversationsRepo;
  contacts: ContactsRepo;
  /** Intersection, not `MessagingAdapter` alone: the prepare/send split and
   *  `classifyMessageTransport` live on `CarrierMessageSender`. */
  adapter: MessagingAdapter & CarrierMessageSender;
  mediaStore?: MediaStore;
  log: Logger;
  tokenBucket?: TokenBucket;
  payload: RelayLegPayload;
  member: ConversationParticipant;
  /** The source row as last read - its `delivery_recipients` map is what the
   *  terminal-slot skip is decided from. */
  currentSource: MessageItem;
  poolNumber: string;
  /**
   * The COMPOSED leg copy - `composeRelayBody(senderName, body)` - NEVER the
   * source row's raw body. A caller that passes the raw body double-prefixes
   * the message (design Sec 10, the reason fan-out reuse was rejected); the
   * retry job passes the stored `relay_retry_leg_body` here.
   */
  legBody: string;
  sourceMedia: MediaAttachment[];
  transport: RelayTransportMode;
  /**
   * The CALLER already asked `isMemberSuppressed` for this member, moments ago,
   * and it answered NO - so skip the duplicate read (code review R2, W4).
   *
   * This exists because the two reads must not be able to DISAGREE. The 30003
   * retry job runs the same check as its own D9 gate and then calls this unit;
   * if the answer flips in between, this unit stamps `contact_opted_out` on the
   * retry row's slot - a code `presentRelayDelivery` filters out of its
   * denominator (`deliveryStatus.ts`, the `fanned` filter), so a one-member
   * relay group loses its whole rollup and the row reads "Not sent - opted out"
   * about a leg that WAS sent. Re-stamping afterwards cannot fix it: on a
   * VERSIONED row - which is every relay source written today -
   * `applyRecipientSendResult` deliberately preserves the FIRST terminal code.
   * Not reading twice is the only fix that works on the live shape.
   *
   * DEFAULT FALSE, and the fan-out passes nothing: its own behaviour, and the
   * 186 tests over it, are unchanged by construction. The window this trades
   * away is the sub-second one between the caller's gate and this call, on a
   * ladder whose gate refusal is itself the D9 answer.
   */
  suppressionChecked?: boolean;
  /**
   * retry-send-window spec D4: the epoch-ms instant after which this leg must
   * NOT go out - the 30003 retry job's send-window end (origin + 15 minutes).
   * When set, the token-bucket wait is BOUNDED by it (`acquire(1,
   * { timeoutMs })`, the group-send precedent) instead of lasting as long as
   * the shared A2P meter takes, and a timeout returns `deadline_exceeded`
   * before any write. Unset - the fan-out, and a retry rung with no usable
   * origin - the acquire is unbounded exactly as before.
   */
  sendDeadlineMs?: number;
  /**
   * SOR spec D8a: the send-attempt records and THIS leg's owner - a
   * `relay_leg` from the fan-out loop, a `relay_rung` from the 30003 retry
   * rung. REQUIRED on both callers (SOR Task 9): the leg gates its
   * suppression close on the member's record (D8), claims the member after
   * the token acquire and before the presign (D7a "Claim placement"), stamps
   * the attempt clock on the slot, and fences every later record write on its
   * own attempt.
   */
  sendAttempts: SendAttemptsRepo;
  owner: SendAttemptOwner;
}): Promise<RelayLegSendOutcome> {
  const {
    messages,
    conversations,
    contacts,
    adapter,
    mediaStore,
    log,
    tokenBucket,
    payload,
    member,
    currentSource,
    poolNumber,
    legBody,
    sourceMedia,
    transport,
    suppressionChecked = false,
    sendDeadlineMs,
    sendAttempts,
    owner,
  } = args;
  const hasMedia = sourceMedia.length > 0;

  const key = relayMemberKey(member);
  const priorSlot = currentSource.delivery_recipients?.[key];
  if (isTerminal(priorSlot?.status)) return { kind: 'skipped_terminal' };

  const ctx = memberCtx(payload, member);
  let phase: 'prepare' | 'sending' | 'record' = 'prepare';
  let ref: AttemptRef | undefined;
  let result: SendMessageResult | undefined;
  let secondUnknownWouldClose = false;
  try {
    // PREPARE. The roster suppression check: an opted-out member's decline is
    // a pre-claim close by a writer other than its own attempt, so it passes
    // the D8 gate first (a live foreign attempt defers it, a terminal record
    // skips it, a stale one is taken over - the caller hands off).
    if (!suppressionChecked && (await isMemberSuppressed(contacts, conversations, member))) {
      const gate = await gateFor(sendAttempts, owner, Date.now());
      if (gate.kind === 'skip') {
        log.info({ ...ctx }, 'relayFanOut: suppression not written - the member attempt is terminal');
        return { kind: 'skipped_terminal' };
      }
      if (gate.kind === 'defer') {
        log.info({ ...ctx }, 'relayFanOut: suppression deferred - another attempt owns the member');
        return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE, deferredByClaim: true };
      }
      if (gate.kind === 'taken_over') {
        return {
          kind: 'handed_to_reconcile',
          reason: 'takeover',
          attemptRef: { attemptNo: gate.record.attemptNo, attemptedAt: gate.record.attemptedAt },
        };
      }
      const redriven = gate.record?.state === 'redriven';
      if (transport.kind === 'versioned') {
        await setVersionedAggregationState(messages, payload, key, 'excluded', ['excluded', 'attempted']);
      }
      await persistRelayRecipientResult(messages, payload, key, {
        status: 'failed',
        errorCode: 'contact_opted_out',
      }, transport);
      if (redriven) {
        // A redriven record belongs to whichever pass reaches it (spec D8): the
        // decline would have applied to the re-drive equally, so it closes it.
        await guardWrite(log, ctx, 'closeRedriven', () =>
          sendAttempts.closeRedriven(owner, { outcome: 'refused', cause: 'contact_opted_out' }),
        );
      }
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
          {
            err,
            conversationId: payload.relayConversationId,
            memberKey: logSafeMemberKey(member),
          },
          'relayFanOut: annotating conversation with member opt-out failed - continuing',
        );
      }
      log.info(
        {
          conversationId: payload.relayConversationId,
          memberKey: logSafeMemberKey(member),
        },
        'relayFanOut: recipient opted out (sms_opt_out) - skipped, not sent',
      );
      return { kind: 'suppressed', errorCode: 'contact_opted_out' };
    }

    if (tokenBucket !== undefined) {
      if (sendDeadlineMs === undefined) {
        await tokenBucket.acquire(1);
      } else {
        // retry-send-window D4. BOUNDED for a caller with a send deadline, and
        // the timeout is an OUTCOME, not a throw: the retry rung owns the close
        // (a terminal retry_window_closed, never a deferral - RSW #5). It
        // returns BEFORE the claim, the presign, the `attempted` aggregation
        // write and the provider call: nothing was attempted and no record is
        // held (RSW #6). Any other acquire failure is a pre-claim throw below.
        try {
          await tokenBucket.acquire(1, { timeoutMs: Math.max(0, sendDeadlineMs - Date.now()) });
        } catch (err) {
          if (err instanceof TokenBucketBusyError) return { kind: 'deadline_exceeded' };
          throw err;
        }
      }
    }

    // CLAIM (D8a) - AFTER the bounded acquire and BEFORE the presign (spec
    // D7a "Claim placement"), so a deadline never holds a claim. The facts are
    // THIS attempt's, the ones a reconcile matches on: the pool number it
    // sends from, the member's number, the composed leg copy, the media it
    // will carry (none without a store to presign it).
    const fp = bodyFingerprint(legBody);
    const claim = await sendAttempts.claim(
      owner,
      {
        recipientDigest: recipientDigest(poolNumber, member.phone),
        sender: poolNumber,
        bodyHash: fp.hash,
        bodyShort: fp.short,
        mediaCount: hasMedia && mediaStore !== undefined ? sourceMedia.length : 0,
      },
      new Date().toISOString(),
    );
    if (claim.outcome === 'refused') {
      // A live foreign attempt (fresh): defer with no slot write. Terminal
      // or reconciling: skip - never carried, never re-sent.
      log.info(
        { ...ctx, state: claim.record.state, fresh: claim.fresh },
        'relayFanOut: claim refused - another attempt owns the member or it is resolved',
      );
      return claim.fresh
        ? { kind: 'transient', errorCode: SEND_RETRYABLE_CODE, deferredByClaim: true }
        : { kind: 'skipped_terminal' };
    }
    if (claim.outcome === 'takeover') {
      // A stale attempt: a process died mid-send, or the call overran. The
      // outcome is unknown - take it over into reconcile, never re-send.
      if (!(await sendAttempts.takeOver(owner, claim.record))) {
        log.info({ ...ctx }, 'relayFanOut: takeover lost - another writer moved the stale attempt');
        return { kind: 'skipped_terminal' };
      }
      return {
        kind: 'handed_to_reconcile',
        reason: 'takeover',
        attemptRef: { attemptNo: claim.record.attemptNo, attemptedAt: claim.record.attemptedAt },
      };
    }
    ref = { attemptNo: claim.record.attemptNo, attemptedAt: claim.record.attemptedAt };
    secondUnknownWouldClose = claim.record.redriveCount >= 1;
    // The attempt clock on the slot (D8a, D20a): best-effort - a wholesale
    // slot write may erase it; the record stays authoritative. An absent
    // legacy slot is created `queued` by the same write.
    try {
      await messages.setRelayRecipientAttemptedAt(
        payload.relayConversationId,
        payload.sourceTsMsgId,
        key,
        ref.attemptedAt,
      );
    } catch (err) {
      log.warn({ err, ...ctx }, 'relayFanOut: attempt clock write failed (best-effort) - the record decides');
    }

    let legMediaUrls: string[] | undefined;
    if (hasMedia && mediaStore) {
      legMediaUrls = await Promise.all(
        sourceMedia.map((attachment) =>
          mediaStore.presign(attachment.s3Key, RELAY_PRESIGN_TTL_SECONDS),
        ),
      );
    }
    const params: SendMessageParams = {
      to: member.phone,
      from: poolNumber,
      body: legBody,
      ...(legMediaUrls !== undefined && { mediaUrls: legMediaUrls }),
    };
    const prepared =
      transport.kind === 'versioned'
        ? adapter.prepareMessageSend(transport.intent, params)
        : undefined;

    if (transport.kind === 'versioned') {
      await setVersionedAggregationState(messages, payload, key, 'attempted', ['attempted']);
    }

    // SEND.
    phase = 'sending';
    result =
      transport.kind === 'versioned'
        ? await adapter.sendPreparedMessage(prepared!)
        : await adapter.sendMessage(params);

    // RECORD, in today's order: the slot FIRST, then the relaysid pointer -
    // SECOND, because on a legacy row a fast receipt that found the pointer
    // before the slot existed would be erased by the wholesale slot write
    // (spec D7a) - then the record done/sent.
    phase = 'record';
    await persistRelayRecipientResult(
      messages,
      payload,
      key,
      {
        status: result.status === 'queued' ? 'queued' : 'sent',
        sid: result.providerSid,
        sentAt: result.providerTs,
        ...(transport.kind === 'versioned' &&
          result.actualTransport !== undefined && { actualTransport: result.actualTransport }),
      },
      transport,
    );
    const pointer = await messages.claimRelaySidPointer(result.providerSid, {
      conversationId: payload.relayConversationId,
      tsMsgId: payload.sourceTsMsgId,
      memberKey: key,
    });
    if (pointer === 'other') {
      // Never rewritten: the leg stays recorded as sent; a reconcile of either
      // owner would rule sid_held_elsewhere (D13).
      log.error(
        { ...ctx, providerSid: result.providerSid },
        'relayFanOut: the SID pointer already names another leg - this leg is recorded as sent anyway',
      );
    }
    if (!(await sendAttempts.finishAttempt(owner, ref, { outcome: 'sent', sid: result.providerSid }))) {
      // Plan deviation 3: the slot is not rolled back - the takeover's
      // reconcile finds the SID through the pointer and repairs.
      log.warn(
        { ...ctx, providerSid: result.providerSid },
        'relayFanOut: attempt fence lost after the slot write; the takeover reconcile repairs',
      );
    }
    return { kind: 'sent', providerSid: result.providerSid };
  } catch (err) {
    if (phase === 'prepare') {
      if (ref === undefined) {
        // Before the claim (the suppression read and writes, the gate, the
        // acquire, the claim itself): nothing was sent and no attempt of ours
        // exists. Deferred with NO slot write on either row kind (build ruling
        // A3): the record's state is unknown here and a legacy row's only slot
        // writer is wholesale.
        log.warn({ err, ...ctx }, 'relayFanOut: prepare failed before the claim - member deferred to the continuation');
        return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE };
      }
      // After the claim, before the send (the presign, the prepare, the
      // aggregation write): nothing was sent. Release THIS attempt as
      // retryable and defer - the slot first, then the record (deviation 3).
      const released = ref;
      log.warn({ err, ...ctx }, 'relayFanOut: prepare failed after the claim - attempt released retryable, member deferred');
      await guardWrite(log, ctx, 'deferSlot', () =>
        persistRelayRecipientResult(messages, payload, key, { status: 'queued', errorCode: SEND_RETRYABLE_CODE }, transport),
      );
      await guardWrite(log, ctx, 'finishAttempt', () =>
        sendAttempts.finishAttempt(owner, released, { outcome: 'retryable', cause: SEND_RETRYABLE_CODE }),
      );
      return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE };
    }
    // Past 'prepare' the claim has run: the phase advances only after it set
    // `ref` (the same reasoning as `result!` at 'record' below).
    const held = { attempts: sendAttempts, owner, ref: ref! };

    /**
     * Move this attempt to `reconciling` (with the SID when one is known).
     * Build finding G5: guardWrite's `true` means the write RESOLVED, not that
     * its fence won - the fence's own answer decides: written AND won ->
     * handed; written but LOST (a takeover owns the record and handed it off
     * itself) -> nothing to do; not written -> STRANDED.
     */
    const handToReconcile = async (
      attempt: typeof held,
      sid?: string,
    ): Promise<'handed' | 'fence_lost' | 'stranded'> => {
      let handed = false;
      const wrote = await guardWrite(log, ctx, 'handToReconcile', async () => {
        handed = await attempt.attempts.handToReconcile(attempt.owner, attempt.ref, sid);
      });
      if (wrote && handed) return 'handed';
      if (wrote) {
        log.info({ ...ctx }, 'relayFanOut: hand-off fence lost - the takeover owns the record');
        return 'fence_lost';
      }
      return 'stranded';
    };

    if (phase === 'record') {
      // The send HAPPENED and its SID is known; a record-phase write threw.
      // Never classified, never re-sent (D3a): handed to reconcile WITH the
      // SID, whose known-SID adoption re-runs those writes idempotently.
      const providerSid = result!.providerSid;
      log.error(
        { err, ...ctx, providerSid },
        'relayFanOut: sent_unrecorded - member sent but not recorded; its SID goes to reconcile',
      );
      const handed = await handToReconcile(held, providerSid);
      if (handed === 'handed') return { kind: 'sent_unrecorded', providerSid, attemptRef: held.ref };
      if (handed === 'fence_lost') return { kind: 'skipped_terminal' };
      return { kind: 'stranded', afterSend: true };
    }

    // phase === 'sending': the provider call threw.
    if (err instanceof SendRefusedError) {
      const refusal = err.code;
      await guardWrite(log, ctx, 'refusedSlot', () =>
        persistRelayRecipientResult(messages, payload, key, { status: 'failed', errorCode: refusal }, transport),
      );
      await guardWrite(log, ctx, 'finishAttempt', () =>
        held.attempts.finishAttempt(held.owner, held.ref, { outcome: 'refused', cause: refusal }),
      );
      log.warn(
        {
          conversationId: payload.relayConversationId,
          memberKey: logSafeMemberKey(member),
          refusal,
        },
        'relayFanOut: send refused for recipient - marked failed, continuing',
      );
      return { kind: 'refused', errorCode: refusal };
    }
    const classification = classifySendFailure(err);
    if (classification.kind === 'rejected') {
      const code = classification.code;
      if (code === CARRIER_FILTERED_CODE) {
        // Today's arm, write unchanged: never retried.
        await guardWrite(log, ctx, 'rejectSlot', () =>
          persistRelayRecipientResult(messages, payload, key, { status: 'failed', errorCode: code }, transport),
        );
        await guardWrite(log, ctx, 'finishAttempt', () =>
          held.attempts.finishAttempt(held.owner, held.ref, { outcome: 'rejected', cause: code }),
        );
        log.error(
          {
            conversationId: payload.relayConversationId,
            memberKey: logSafeMemberKey(member),
            errorCode: code,
          },
          'relayFanOut: carrier filtering (30007) - recipient failed, NOT retried',
        );
        return { kind: 'filtered', errorCode: code };
      }
      // D5: failed with the provider code. An HTTP status NEVER reaches a slot
      // (D10, D23): a code-less 4xx fails the slot with no errorCode; the kill
      // switch's token has prose, so it is kept. Relay records the code only -
      // an MMS leg's 30005 says nothing about SMS reachability.
      const slotCode = isProviderCode(code) || code === SMS_SENDING_DISABLED_CODE ? code : undefined;
      await guardWrite(log, ctx, 'rejectSlot', () =>
        persistRelayRecipientResult(
          messages,
          payload,
          key,
          { status: 'failed', ...(slotCode !== undefined && { errorCode: slotCode }) },
          transport,
        ),
      );
      // The record's cause keeps what the slot may not: the HTTP status of a code-less 4xx.
      const cause = code ?? (classification.status !== undefined ? String(classification.status) : undefined);
      await guardWrite(log, ctx, 'finishAttempt', () =>
        held.attempts.finishAttempt(held.owner, held.ref, { outcome: 'rejected', ...(cause !== undefined && { cause }) }),
      );
      log.warn(
        { ...ctx, errorCode: code, status: classification.status },
        'relayFanOut: send rejected by the provider - recipient failed, NOT retried',
      );
      return { kind: 'rejected', ...(slotCode !== undefined && { errorCode: slotCode }) };
    }
    if (classification.kind === 'retryable') {
      // D6: defer to the backed-off continuation; the slot stays `queued` with
      // the provider code, or send_retryable when there is none (a network
      // string never reaches a slot).
      const code = isProviderCode(classification.code) ? classification.code! : SEND_RETRYABLE_CODE;
      await guardWrite(log, ctx, 'deferSlot', () =>
        persistRelayRecipientResult(messages, payload, key, { status: 'queued', errorCode: code }, transport),
      );
      await guardWrite(log, ctx, 'finishAttempt', () =>
        held.attempts.finishAttempt(held.owner, held.ref, { outcome: 'retryable', cause: code }),
      );
      log.warn(
        { ...ctx, errorCode: code, attempt: payload.attempt },
        'relayFanOut: transient send error - deferring recipient to the continuation',
      );
      return { kind: 'transient', errorCode: code };
    }
    // UNKNOWN (D2, D7): the request may have reached the provider. Never
    // re-sent and never failed here - the reconcile decides; the slot stays
    // `queued` with no code.
    if (secondUnknownWouldClose) {
      // D13a: at most ONE re-drive per member. A re-drive attempt whose
      // outcome is unknown AGAIN closes unresolved here, with no second
      // reconcile: the slot first (conditional on no known send), then the record.
      await guardWrite(log, ctx, 'closeUnconfirmed', () =>
        messages.closeRelayRecipientIfUnsent(payload.relayConversationId, payload.sourceTsMsgId, key, {
          status: 'failed',
          errorCode: SEND_UNCONFIRMED_CODE,
        }),
      );
      await guardWrite(log, ctx, 'finishAttempt', () =>
        held.attempts.finishAttempt(held.owner, held.ref, { outcome: 'unresolved', cause: 'second_unknown' }),
      );
      log.error(
        { err, ...ctx, cause: 'second_unknown' },
        'relayFanOut: unknown send outcome after a re-drive - member closed unresolved (send_unconfirmed)',
      );
      return { kind: 'rejected', errorCode: SEND_UNCONFIRMED_CODE };
    }
    log.warn({ err, ...ctx }, 'relayFanOut: unknown send outcome - member handed to reconcile');
    const handed = await handToReconcile(held);
    if (handed === 'handed') return { kind: 'handed_to_reconcile', reason: 'unknown', attemptRef: held.ref };
    if (handed === 'fence_lost') return { kind: 'skipped_terminal', reason: 'unknown' };
    return { kind: 'stranded' };
  }
}

async function preflightVersionedRecipients(
  source: MessageItem,
  payload: RelayFanOutPayload,
  recipients: ConversationParticipant[],
  currentRoster: ConversationParticipant[],
  intent: MessageTransportIntent,
  messages: MessagesRepo,
  /** A continuation or a re-drive: every re-read is strongly consistent (SOR D11, build finding T8-3). */
  consistent: boolean,
): Promise<MessageItem> {
  const currentRosterKeys = new Set(currentRoster.map((member) => relayMemberKey(member)));
  const requestedTransport = source.requested_transport ?? intent.requestedTransport;
  for (const member of recipients) {
    const key = relayMemberKey(member);
    if (source.delivery_recipients?.[key] === undefined) {
      const outcome = await messages.initializeRecipientDelivery(
        payload.relayConversationId,
        payload.sourceTsMsgId,
        key,
        {
          status: 'queued',
          requestedTransport,
          transportAggregationState: 'planned',
        },
      );
      if (outcome !== 'created' && outcome !== 'existing') {
        throw new Error(`relayFanOut: v1 preflight initialize failed: ${outcome}`);
      }
    }
  }

  let current = await readVersionedSource(messages, payload, consistent);
  for (const member of recipients) {
    const key = relayMemberKey(member);
    const slot = current.delivery_recipients?.[key];
    if (!slot) throw new Error('relayFanOut: v1 preflight recipient slot missing');
    if (slot.transportAggregationState === undefined || canReopenExcludedSlot(slot)) {
      await setVersionedAggregationState(
        messages,
        payload,
        key,
        'planned',
        ['planned', 'attempted'],
        consistent,
      );
    }
  }

  current = await readVersionedSource(messages, payload, consistent);
  for (const [key, slot] of Object.entries(current.delivery_recipients ?? {})) {
    if (
      !currentRosterKeys.has(key) &&
      (slot.transportAggregationState === undefined ||
        slot.transportAggregationState === 'planned') &&
      (slot.transportAggregationState === 'planned' ||
        (slot.sid === undefined &&
          slot.sentAt === undefined &&
          slot.actualTransport === undefined))
    ) {
      await setVersionedAggregationState(
        messages,
        payload,
        key,
        'excluded',
        ['excluded', 'attempted'],
        consistent,
      );
    }
  }
  return readVersionedSource(messages, payload, consistent);
}

function canReopenExcludedSlot(slot: RelayRecipientDelivery): boolean {
  return (
    slot.transportAggregationState === 'excluded' &&
    slot.status !== 'failed' &&
    slot.errorCode !== 'contact_opted_out' &&
    slot.sid === undefined &&
    slot.sentAt === undefined &&
    slot.actualTransport === undefined
  );
}

async function readVersionedSource(
  messages: MessagesRepo,
  payload: RelayLegPayload,
  consistent = false,
): Promise<MessageItem> {
  const source = consistent
    ? await messages.getByTsMsgIdConsistent(payload.relayConversationId, payload.sourceTsMsgId)
    : await messages.getByTsMsgId(payload.relayConversationId, payload.sourceTsMsgId);
  if (!source || source.transport_schema_version !== TRANSPORT_SCHEMA_VERSION) {
    throw new Error('relayFanOut: v1 preflight source missing or changed schema');
  }
  return source;
}

/**
 * EXPORTED for the 30003 retry job (spec D9/D10): its gate refusals mirror this
 * unit's `suppressed` arm - aggregation state `excluded`, then the failed slot -
 * and `closeRelay` (the fan-out's own close) is a nested closure it cannot
 * reach. Mechanical export; no logic change.
 */
export async function setVersionedAggregationState(
  messages: MessagesRepo,
  payload: RelayLegPayload,
  memberKey: string,
  next: NonNullable<RelayRecipientDelivery['transportAggregationState']>,
  acceptableStates: NonNullable<RelayRecipientDelivery['transportAggregationState']>[],
  /** The conflict re-read's consistency (SOR D11): the preflight of a continuation or re-drive passes true. */
  consistent = false,
): Promise<void> {
  const outcome = await messages.setRecipientTransportAggregationState(
    payload.relayConversationId,
    payload.sourceTsMsgId,
    memberKey,
    next,
  );
  if (outcome === 'updated' || outcome === 'idempotent') return;
  if (outcome === 'conflict') {
    const source = await readVersionedSource(messages, payload, consistent);
    const current = source.delivery_recipients?.[memberKey]?.transportAggregationState;
    if (current !== undefined && acceptableStates.includes(current)) return;
  }
  throw new Error(`relayFanOut: v1 preflight aggregation failed: ${outcome}`);
}

/**
 * EXPORTED for the 30003 retry job (spec D9/D10/D14): every close it writes -
 * a gate refusal, `transient_cap`, `enqueue_failed` - goes through THIS
 * transport-aware path, so a legacy retry row keeps taking `markRecipient`'s
 * whole-slot write and a versioned one keeps taking `applyRecipientSendResult`.
 * Mechanical export; no logic change.
 */
export async function persistRelayRecipientResult(
  messages: MessagesRepo,
  payload: RelayLegPayload,
  memberKey: string,
  delivery: RelayRecipientDelivery,
  transport: RelayTransportMode,
): Promise<void> {
  if (transport.kind === 'legacy') {
    await markRecipient(messages, payload, memberKey, delivery);
    return;
  }
  const outcome: TransportMutationOutcome = await messages.applyRecipientSendResult(
    payload.relayConversationId,
    payload.sourceTsMsgId,
    memberKey,
    delivery,
  );
  if (outcome === 'missing' || outcome === 'legacy_noop') {
    throw new Error(`relayFanOut: v1 recipient result failed: ${outcome}`);
  }
}

/** Persist one recipient's delivery slot on the source message. */
async function markRecipient(
  messages: MessagesRepo,
  payload: RelayLegPayload,
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
