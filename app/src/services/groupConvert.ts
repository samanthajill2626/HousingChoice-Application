// Conversion of an IMPORTED relay group into a native group text
// (group-texting spec section 9).
//
// The founder's 132 carrier group chats land from the Quo/Airtable importer as
// `relay_group`/`connecting` rows - the only multi-party shape that existed when
// the importer was written. They are not relay groups: they are real carrier
// group texts that must keep working as carrier group texts. This module is the
// ONE place that rewrites such a row onto the native `group_text` shape.
//
// TWO CALLERS, ONE CORE:
//   - the bulk migration runner (lib/import/convertGroups.ts), which checks
//     exclusion-set parity against the export BEFORE converting anything, and
//   - the runtime inline path: an inbound group message whose derived id lands
//     on a still-unconverted imported row (spec 5.3(c)). That caller has no
//     export to compare against and is guarded instead by boot validation plus
//     the persisted identity fingerprint.
// Parity is therefore NOT this function's job - it takes no ownNumbers and
// never checks any.
//
// IDEMPOTENT AND CONVERGENT. The conversationId never changes (it is already the
// derived group id both the importer and detection produce), so history stays
// attached. Re-running short-circuits the TYPE TRANSITION only: the roster
// backfill and the member consent-basis stamps are re-attempted on every call,
// because a crash between the durable steps must be healed by the next run
// rather than reported as "already done".
//
// PII (doc 9): logs conversationId + counts only - never a member phone.
import { contactIdForPhone, conversationIdForGroup } from '../lib/import/ids.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { GROUP_DETECTION_ORIGIN } from './groupMembers.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
} from '../repos/conversationsRepo.js';

/** Why a conversion did not happen. Stable strings - the report groups on them. */
export type GroupConvertRefusal =
  | 'not_found'
  | 'not_a_relay_group'
  | 'not_connecting'
  | 'has_pool_number'
  | 'roster_id_mismatch'
  /** The conversion THREW (transient repo failure). Only the bulk runner mints
   *  this one - it isolates a throwing row rather than losing the report. */
  | 'threw';

export interface GroupConvertOptions {
  conversationsRepo: ConversationsRepo;
  contactsRepo: ContactsRepo;
  /**
   * The `group_participation_at` instant stamped on members that carry none.
   * Defaults to now; the bulk runner passes ONE instant for the whole run so a
   * migration is legible as a single event in the audit trail.
   */
  at?: string;
  logger?: Logger;
}

export interface GroupConvertResult {
  conversationId: string;
  /**
   * `converted` - this call performed the type transition.
   * `already_converted` - it was already a group_text; convergence still ran.
   * `refused` - a precondition did not hold; NOTHING was written.
   */
  outcome: 'converted' | 'already_converted' | 'refused';
  /** Set iff refused. */
  refusal?: GroupConvertRefusal;
  /** Set iff refused: the operator-facing sentence, house style. */
  refusedReason?: string;
  /**
   * The single stored connect-flag field (`import_connect_requested`, from the
   * workbook's `connect_day_one` column). REPORTED, never a refusal: Cameron's
   * auto-convert ruling is that every imported group becomes a native group
   * text regardless of whether she had asked to relay-connect it.
   */
  importConnectRequested: boolean;
  /** Roster entries whose empty `contactId` this call filled in. */
  contactIdsBackfilled: number;
  /**
   * Roster entries whose missing `name` this call filled in from the member's
   * contact record. Counted separately from `contactIdsBackfilled` because it
   * is the LARGEST data change the migration makes - an imported roster carries
   * no names at all, and the group title is derived from the roster - and the
   * report is the cutover gate, so it cannot be invisible in it.
   */
  namesBackfilled: number;
  /** Member contacts this call stamped with `group_participation_at`. */
  membersStamped: number;
  /** Member contacts that were already stamped (convergence, not work). */
  membersAlreadyStamped: number;
  /**
   * Roster slots whose contact record was ABSENT and which this call RE-MINTED
   * as a group-scoped stub (see remintMemberStub).
   */
  membersReminted: number;
  /**
   * Member contactIds with NO contact record at all AND which could not be
   * re-minted (the create itself failed). A residual entry here is a thread that
   * can receive and can never reply, so the migration report gates on it.
   */
  membersMissing: string[];
  /** The roster as it stands after this call (empty when refused). */
  members: ConversationParticipant[];
}

const REFUSAL_SENTENCE: Record<GroupConvertRefusal, string> = {
  not_found: 'no conversation with that id exists',
  not_a_relay_group: 'the thread is not a relay group',
  not_connecting: 'the relay group is not in the connecting state (it was connected or closed)',
  has_pool_number: 'the relay group already fronts a pool number, so it is a real relay thread',
  roster_id_mismatch:
    'its stored roster does not hash back to its own conversation id, so the roster does not ' +
    'describe this group - convert it only after a human decides which side is right ' +
    '(a workbook `drop` on a group member is the known producer)',
  threw: 'the conversion threw',
};

function refuse(conversationId: string, refusal: GroupConvertRefusal): GroupConvertResult {
  return {
    conversationId,
    outcome: 'refused',
    refusal,
    refusedReason: `${conversationId} was NOT converted: ${REFUSAL_SENTENCE[refusal]}.`,
    importConnectRequested: false,
    contactIdsBackfilled: 0,
    namesBackfilled: 0,
    membersStamped: 0,
    membersAlreadyStamped: 0,
    membersReminted: 0,
    membersMissing: [],
    members: [],
  };
}

/**
 * THE IDENTITY INVARIANT, checked (invariant 13.5).
 *
 * A group thread's conversationId IS uuidv5 over its sorted roster, so the
 * roster stored on the row must hash back to the row's own id. Nothing else in
 * the system compares the two, and they can genuinely diverge: the importer
 * derives the id from ALL participants but writes a roster filtered by the
 * founder's workbook `drop` column, so one dropped member leaves a short roster
 * under a full-set id.
 *
 * Converting such a row propagates the lie - detection then adopts the short
 * roster and a real member of the carrier group has no chip, no attribution, no
 * stub, and no slot in the Conversations rail.
 *
 * REFUSE, NEVER REPAIR. Re-keying the roster to match the id invents members;
 * re-keying the id to match the roster changes THREAD IDENTITY and orphans
 * every message already filed under it. Both are migration-grade decisions, so
 * this is a reported refusal the founder adjudicates against the workbook.
 */
function rosterMatchesId(conversationId: string, members: readonly ConversationParticipant[]): boolean {
  return conversationIdForGroup(members.map((m) => m.phone)) === conversationId;
}

/** The preconditions, in the order they are reported. */
function precondition(item: ConversationItem): GroupConvertRefusal | undefined {
  if (item.type !== 'relay_group') return 'not_a_relay_group';
  if (item.status !== 'connecting') return 'not_connecting';
  if (typeof item.pool_number === 'string' && item.pool_number.length > 0) {
    return 'has_pool_number';
  }
  if (!rosterMatchesId(item.conversationId, (item.participants ?? []) as ConversationParticipant[])) {
    return 'roster_id_mismatch';
  }
  return undefined;
}

/**
 * Fill every empty `contactId` in an imported roster.
 *
 * Imported rosters carry `contactId: ''` for any phone with traffic but no
 * merged person record (apply.ts builds them from the people it actually wrote).
 * `contactIdForPhone` is the SAME derivation the importer and detection both
 * use, so filling them converges all three id schemes and makes member keying,
 * member chips and per-member suppression work on the converted thread.
 */
function backfillRoster(members: readonly ConversationParticipant[]): {
  members: ConversationParticipant[];
  backfilled: number;
} {
  let backfilled = 0;
  const filled = members.map((member) => {
    if (typeof member.contactId === 'string' && member.contactId.length > 0) return member;
    backfilled += 1;
    return { ...member, contactId: contactIdForPhone(member.phone) };
  });
  return { members: filled, backfilled };
}

/**
 * Fill every missing `name` in a roster from the member's contact record.
 *
 * Best-effort by construction: a read failure or an absent contact leaves the
 * entry nameless and the title falls back to the formatted number, exactly as
 * it does for a member nobody has ever named. Never OVERWRITES a stored name -
 * a roster snapshot a human curated outranks a lookup.
 */
async function backfillRosterNames(
  members: readonly ConversationParticipant[],
  contactsRepo: Pick<ContactsRepo, 'getById'>,
  log: Logger,
): Promise<{ members: ConversationParticipant[]; backfilled: number }> {
  let backfilled = 0;
  const out: ConversationParticipant[] = [];
  for (const member of members) {
    const existing = typeof member.name === 'string' ? member.name.trim() : '';
    if (existing.length > 0 || member.contactId.length === 0) {
      out.push(member);
      continue;
    }
    let name: string | undefined;
    try {
      const contact = await contactsRepo.getById(member.contactId);
      const first = typeof contact?.firstName === 'string' ? contact.firstName.trim() : '';
      const last = typeof contact?.lastName === 'string' ? contact.lastName.trim() : '';
      const joined = [first, last].filter((p) => p.length > 0).join(' ');
      name = joined.length > 0 ? joined : undefined;
    } catch (err) {
      log.warn(
        { err, contactId: member.contactId },
        'group text conversion: member name lookup failed - the roster entry stays nameless (title falls back to the number)',
      );
    }
    if (name === undefined) {
      out.push(member);
      continue;
    }
    backfilled += 1;
    out.push({ ...member, name });
  }
  return { members: out, backfilled };
}

/**
 * RE-MINT the contact stub behind a roster slot whose contact record is GONE
 * (adversarial finding 2).
 *
 * THE HOLE THIS FILLS. A workbook `drop` on a group member skips the contact
 * write (and retracts an earlier one), but the group roster deliberately KEEPS
 * the member - a group thread's identity IS its full sorted roster, so removing
 * one would leave a row that cannot describe its own thread. `backfillRoster`
 * then fills the empty slot with a well-formed `contactIdForPhone(phone)` that
 * has NO ROW BEHIND IT, and from that moment `groupSend` refuses EVERY outbound
 * on the thread - its consent fence is a WHOLE-SEND refusal, and nothing
 * re-resolves an existing thread's roster, so it never self-heals. The founder's
 * only signal used to be a warning line in a report that simultaneously printed
 * COMPLETE.
 *
 * WHAT IS MINTED, and what deliberately is NOT. Exactly detection's stub
 * (services/groupMembers.ts stubFor): `unknown`/`needs_review` because seeing
 * somebody on a group envelope says nothing about who they are, the
 * `group_detection` origin marker so the import's own `retractImported` refuses
 * to delete it again, and `group_participation_at` as the group consent BASIS.
 * NO `consent_method`, NO `consent_at`, NO `capture_source` - those are what
 * `hasSmsConsent` and `consentMethodFromCaptureSource` read, and stamping any of
 * them would hand a group member proactive 1:1 sendability the drop was meant to
 * deny. The `drop` therefore still holds for every 1:1 and history purpose; only
 * the GROUP roster slot comes back.
 */
async function remintMemberStub(
  member: ConversationParticipant,
  at: string,
  contactsRepo: Pick<ContactsRepo, 'createIfAbsent' | 'stampGroupParticipation'>,
  log: Logger,
): Promise<'reminted' | 'stamped' | 'already' | 'missing'> {
  const stub: ContactItem = {
    contactId: member.contactId,
    type: 'unknown',
    status: 'needs_review',
    phone: member.phone,
    origin: GROUP_DETECTION_ORIGIN,
    group_participation_at: at,
    created_at: at,
  };
  try {
    const created = await contactsRepo.createIfAbsent(stub);
    // Lost a same-id race (live detection minted it between our stamp and our
    // create): the row exists now, so the only thing left is the basis stamp.
    if (!created) return contactsRepo.stampGroupParticipation(member.contactId, at);
    log.info(
      { contactId: member.contactId },
      'group text conversion: RE-MINTED a group member stub for a roster slot whose contact record was absent (group_participation_at only, never consent_method)',
    );
    return 'reminted';
  } catch (err) {
    log.error(
      { err, contactId: member.contactId },
      'group text conversion: re-minting an absent member stub FAILED - the thread cannot send until this contact exists',
    );
    return 'missing';
  }
}

/**
 * Everything that must be true AFTER the type transition, re-applied on EVERY
 * call: the roster backfill and the per-member consent-basis stamps.
 *
 * A crash between the durable steps leaves a converted thread whose members have
 * no consent basis, so "already converted" must never short-circuit past this -
 * the next run is what heals it (spec 15.4 convergence).
 */
async function converge(
  conversationId: string,
  item: ConversationItem,
  outcome: 'converted' | 'already_converted',
  opts: GroupConvertOptions,
  at: string,
): Promise<GroupConvertResult> {
  const { conversationsRepo, contactsRepo } = opts;
  const log = opts.logger ?? defaultLogger;

  // THE ROSTER/ID INVARIANT IS A PROPERTY OF THE ROW, NOT OF THE TRANSITION.
  // It used to be checked only in `precondition`, which the already-converted
  // early return skips - so a `group_text` whose roster does not hash back to
  // its own id (written by a build that predates the check, by a partially-run
  // earlier migration, or by any future producer) converged happily, was
  // counted `already_converted`, warned nothing, and let `complete` stay TRUE.
  // The migration report IS the hard cutover gate (spec 14), so it must never
  // report COMPLETE over a corrupt row. Spec 15.4 says convergence re-runs the
  // remaining steps on EVERY pass; this is one of them. Refusing here also
  // refuses the runtime inline auto-convert, which shares this function.
  if (!rosterMatchesId(conversationId, (item.participants ?? []) as ConversationParticipant[])) {
    log.error(
      { conversationId, outcome, rosterSize: (item.participants ?? []).length },
      'group text convergence: the stored roster does not hash back to this thread id - REFUSED, a human must adjudicate which side is right',
    );
    return refuse(conversationId, 'roster_id_mismatch');
  }
  let roster = (item.participants ?? []) as ConversationParticipant[];
  let contactIdsBackfilled = 0;

  // On the `converted` path the backfilled roster landed with the transition
  // itself. On the already-converted path it may still be pending - a thread
  // converted by an older build, or one whose transition wrote a roster we have
  // since learned more about.
  const filled = backfillRoster(roster);

  // NAMES, TOO. An imported roster carries no `name` at all (apply.ts writes
  // `{contactId, phone}`), and the group title is DERIVED FROM THE ROSTER by
  // lib/groupTitle.ts - so without this every migrated group renders as a row
  // of phone numbers in the inbox and on the contact card while the thread view
  // (which re-resolves names from the contact record) shows the real names. One
  // derivation, fed one roster: the fix is to give the roster its names here,
  // where we are already reading every member contact anyway.
  const named = await backfillRosterNames(filled.members, contactsRepo, log);

  if (filled.backfilled > 0 || named.backfilled > 0) {
    // The roster we READ is the precondition (fix wave 5, adversarial 27): the
    // bulk runner and the inline auto-convert can converge one thread at the
    // same instant, and this is a whole-array overwrite. A loser gets
    // `undefined` and keeps the roster it derived rather than clobbering the
    // winner's - which for v1 is the same set of members either way, differing
    // at most in a `name` one side resolved and the other did not.
    const updated = await conversationsRepo.backfillGroupTextRoster(
      conversationId,
      named.members,
      roster,
    );
    // A lost condition means the row stopped being a group thread under us (or
    // another converge won the race); keep the roster we know about.
    roster = (updated?.participants as ConversationParticipant[] | undefined) ?? named.members;
    contactIdsBackfilled = filled.backfilled;
  }

  let membersStamped = 0;
  let membersAlreadyStamped = 0;
  let membersReminted = 0;
  const membersMissing: string[] = [];
  for (const member of roster) {
    if (typeof member.contactId !== 'string' || member.contactId.length === 0) continue;
    let stamped = await contactsRepo.stampGroupParticipation(member.contactId, at);
    // `missing` is not a report line, it is a BRICKED THREAD - re-mint rather
    // than narrate (see remintMemberStub).
    if (stamped === 'missing') {
      const outcome = await remintMemberStub(member, at, contactsRepo, log);
      if (outcome === 'reminted') {
        membersReminted += 1;
        continue;
      }
      stamped = outcome;
    }
    if (stamped === 'stamped') membersStamped += 1;
    else if (stamped === 'already') membersAlreadyStamped += 1;
    else membersMissing.push(member.contactId);
  }

  return {
    conversationId,
    outcome,
    importConnectRequested: item.import_connect_requested === true,
    contactIdsBackfilled,
    namesBackfilled: named.backfilled,
    membersStamped,
    membersAlreadyStamped,
    membersReminted,
    membersMissing,
    members: roster,
  };
}

export async function convertConnectingRelayGroupToGroupText(
  conversationId: string,
  opts: GroupConvertOptions,
): Promise<GroupConvertResult> {
  const { conversationsRepo } = opts;
  const log = opts.logger ?? defaultLogger;
  const at = opts.at ?? new Date().toISOString();

  const existing = await conversationsRepo.getById(conversationId);
  if (!existing) return refuse(conversationId, 'not_found');

  if (existing.type === 'group_text') {
    return converge(conversationId, existing, 'already_converted', opts, at);
  }

  const blocked = precondition(existing);
  if (blocked !== undefined) return refuse(conversationId, blocked);

  const { members, backfilled } = backfillRoster(existing.participants ?? []);
  const converted = await conversationsRepo.convertRelayGroupToGroupText(conversationId, members);

  if (converted === undefined) {
    // LOSER RE-READ. The condition failed between our read and our write: either
    // a concurrent converter (the bulk runner and inbound auto-convert can hit
    // the same thread at the same moment) or a relay lifecycle change. Re-read
    // and report what actually happened rather than guessing.
    const current = await conversationsRepo.getById(conversationId);
    if (!current) return refuse(conversationId, 'not_found');
    if (current.type === 'group_text') {
      log.info({ conversationId }, 'group text conversion lost a race - already converted');
      return converge(conversationId, current, 'already_converted', opts, at);
    }
    return refuse(conversationId, precondition(current) ?? 'not_connecting');
  }

  const result = await converge(conversationId, converted, 'converted', opts, at);
  // The transition itself carried the backfill; converge saw the filled roster
  // and counted nothing.
  return { ...result, contactIdsBackfilled: backfilled };
}
