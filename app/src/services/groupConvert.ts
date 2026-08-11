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
import { contactIdForPhone } from '../lib/import/ids.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
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
  | 'has_pool_number';

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
  /** Member contacts this call stamped with `group_participation_at`. */
  membersStamped: number;
  /** Member contacts that were already stamped (convergence, not work). */
  membersAlreadyStamped: number;
  /**
   * Member contactIds with NO contact record at all - the phones the import
   * dropped or never merged into a person. Reported, never created here:
   * minting contacts is detection's job (and it stamps its own origin marker).
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
};

function refuse(conversationId: string, refusal: GroupConvertRefusal): GroupConvertResult {
  return {
    conversationId,
    outcome: 'refused',
    refusal,
    refusedReason: `${conversationId} was NOT converted: ${REFUSAL_SENTENCE[refusal]}.`,
    importConnectRequested: false,
    contactIdsBackfilled: 0,
    membersStamped: 0,
    membersAlreadyStamped: 0,
    membersMissing: [],
    members: [],
  };
}

/** The three preconditions, in the order they are reported. */
function precondition(item: ConversationItem): GroupConvertRefusal | undefined {
  if (item.type !== 'relay_group') return 'not_a_relay_group';
  if (item.status !== 'connecting') return 'not_connecting';
  if (typeof item.pool_number === 'string' && item.pool_number.length > 0) {
    return 'has_pool_number';
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
  let roster = (item.participants ?? []) as ConversationParticipant[];
  let contactIdsBackfilled = 0;

  // On the `converted` path the backfilled roster landed with the transition
  // itself. On the already-converted path it may still be pending - a thread
  // converted by an older build, or one whose transition wrote a roster we have
  // since learned more about.
  const filled = backfillRoster(roster);
  if (filled.backfilled > 0) {
    const updated = await conversationsRepo.backfillGroupTextRoster(conversationId, filled.members);
    // A lost condition means the row stopped being a group thread under us,
    // which nothing in v1 does; keep the roster we know about.
    roster = (updated?.participants as ConversationParticipant[] | undefined) ?? filled.members;
    contactIdsBackfilled = filled.backfilled;
  }

  let membersStamped = 0;
  let membersAlreadyStamped = 0;
  const membersMissing: string[] = [];
  for (const member of roster) {
    if (typeof member.contactId !== 'string' || member.contactId.length === 0) continue;
    const stamped = await contactsRepo.stampGroupParticipation(member.contactId, at);
    if (stamped === 'stamped') membersStamped += 1;
    else if (stamped === 'already') membersAlreadyStamped += 1;
    else membersMissing.push(member.contactId);
  }

  return {
    conversationId,
    outcome,
    importConnectRequested: item.import_connect_requested === true,
    contactIdsBackfilled,
    membersStamped,
    membersAlreadyStamped,
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
