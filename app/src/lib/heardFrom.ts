// The ONE attribution rule for "which contact is this inbound row FROM",
// and the instant normalizer every last_heard_from_at writer shares (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1 and 14.2).
import type { ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationItem } from '../repos/conversationsRepo.js';
import type { MessageItem } from '../repos/messagesRepo.js';

const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.length > 0;

/** Canonical ISO form of any parseable instant; undefined when unparseable.
 *  DynamoDB compares stored strings LEXICALLY, so every writer stores this
 *  form ('2026-09-01T10:00:00Z' sorts AFTER '2026-09-01T10:00:00.500Z'). */
export function normalizeInstant(s: string | undefined): string | undefined {
  if (!nonEmpty(s)) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export type MaybePromise<T> = T | Promise<T>;

export interface HeardFromLookup {
  byPhone(e164: string): MaybePromise<{ contactId: string } | undefined>;
  byEmail(address: string): MaybePromise<{ contactId: string } | undefined>;
}

/** The row fields the rule reads - the PERSISTED message/call row. */
export type HeardFromRow = Pick<
  MessageItem,
  | 'direction'
  | 'type'
  | 'relay_sender_key'
  | 'relay_retry_of'
  | 'email_new_address'
  | 'relay_external_caller_contact_id'
  | 'relay_external_caller_phone'
>;

/** The thread fields the rule reads - the PERSISTED conversation. */
export type HeardFromThread = Pick<ConversationItem, 'type' | 'participants' | 'participant_phone' | 'participant_email'>;

/** Multi-party thread types: attribution is per SENDER KEY, never the roster. */
const GROUP_THREAD_TYPES: ReadonlySet<string> = new Set(['relay_group', 'group_text']);
/** The staff sentinel sender key (TEAM_SENDER_KEY, jobs/relayFanOut.ts). */
const TEAM_SENDER_KEY = 'team';
/** groupMemberKey / relayMemberKey's phone-scoped key prefix. */
const PHONE_KEY_PREFIX = 'phone#';

/** WHICH contact an inbound row is FROM (spec 5.1 + 14.2) - the ONE rule.
 *  `row` is the persisted message/call row, `thread` the PERSISTED conversation
 *  it lives on. Returns undefined when the row is not attributable.
 *  Discriminated by THREAD TYPE, never by which fields a row happens to carry.
 *  Always async: the lookup may answer synchronously (the seed) or not. */
export async function attributeInbound(
  row: HeardFromRow,
  thread: HeardFromThread,
  lookup: HeardFromLookup,
): Promise<string | undefined> {
  // 1. Only inbound counts. A relay 30003 retry COPIES the original's
  //    direction (the retry append in webhooks/twilio.ts), so it is never
  //    attributed.
  if (row.direction !== 'inbound' || nonEmpty(row.relay_retry_of)) return undefined;

  // 2. Group threads: the sender key decides.
  if (GROUP_THREAD_TYPES.has(thread.type)) {
    const key = row.relay_sender_key;
    if (nonEmpty(key)) {
      if (key === TEAM_SENDER_KEY) return undefined;
      if (key.startsWith(PHONE_KEY_PREFIX)) {
        const e164 = key.slice(PHONE_KEY_PREFIX.length);
        // An entry with an EMPTY contactId (a phone-only relay member, an
        // imported roster) counts as absent.
        const member = (thread.participants ?? []).find((p) => p.phone === e164 && nonEmpty(p.contactId));
        if (member !== undefined) return member.contactId;
        return (await lookup.byPhone(e164))?.contactId;
      }
      return key;
    }
    // A KEYLESS row: only a refused non-member call says who it was from.
    // A roster member is NEVER the fallback (an imported group call stays
    // unattributed).
    if (nonEmpty(row.relay_external_caller_contact_id)) return row.relay_external_caller_contact_id;
    if (nonEmpty(row.relay_external_caller_phone)) {
      return (await lookup.byPhone(row.relay_external_caller_phone))?.contactId;
    }
    return undefined;
  }

  // 3. Any other thread (a 1:1 of any type, or a legacy typeless row). An
  //    email from an address on no contact is not attributed until staff link
  //    it - keyed on email_new_address, never on author 'unknown' (which a
  //    verified stub or team-member sender also gets).
  if (row.type === 'email' && row.email_new_address === true) return undefined;
  return oneToOneThreadContactId(thread, lookup);
}

/** The ONE contact a ONE-TO-ONE thread belongs to: its first roster contact,
 *  else the contact holding its phone, else the contact holding its email.
 *  undefined for a multi-party thread (relay_group, group_text), which names
 *  no single contact. Step 3 of attributeInbound, shared with the outbound
 *  twin of the dev fixtures (routes/dev.ts touchFixtureReachedOut,
 *  today-checklist W8). */
export async function oneToOneThreadContactId(
  thread: HeardFromThread,
  lookup: HeardFromLookup,
): Promise<string | undefined> {
  if (GROUP_THREAD_TYPES.has(thread.type)) return undefined;
  const participant = (thread.participants ?? []).find((p) => nonEmpty(p.contactId));
  if (participant !== undefined) return participant.contactId;
  if (nonEmpty(thread.participant_phone)) {
    const hit = await lookup.byPhone(thread.participant_phone);
    if (hit !== undefined) return hit.contactId;
  }
  if (nonEmpty(thread.participant_email)) {
    const hit = await lookup.byEmail(thread.participant_email);
    if (hit !== undefined) return hit.contactId;
  }
  return undefined;
}

/** A HeardFromLookup over a contacts repo, with an optional pre-resolved cache
 *  (the live paths pass the contacts they already hold, keyed by the phone or
 *  address they resolved them from). findByPhone ignores soft-deletion, so a
 *  deleted contact still resolves (and a restored one keeps its value). */
export function repoLookup(
  contacts: Pick<ContactsRepo, 'findByPhone' | 'findByEmail'>,
  cache?: ReadonlyMap<string, { contactId: string }>,
): HeardFromLookup {
  return {
    byPhone: (e164) => cache?.get(e164) ?? contacts.findByPhone(e164),
    byEmail: (address) => cache?.get(address) ?? contacts.findByEmail(address),
  };
}
