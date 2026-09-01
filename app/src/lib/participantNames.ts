// participantNames - resolve a conversation roster's display names from the
// contacts it points at, IN MEMORY, at a read boundary.
//
// `participants[].name` is a write-time snapshot nothing refreshes (M1,
// 2026-08-31). Rather than trust it, each read boundary does ONE batched
// display-projection read for the page and hands the existing label functions
// (lib/groupTitle.ts, describeRoster, ...) a fresher array. Those functions do
// not change.
//
// THE CHAIN, per member: live contact name (non-deleted, non-empty) -> the
// stored snapshot -> nothing (the client renders the phone). A member with no
// contactId has nothing to resolve and is returned as-is.
//
// READ POSTURE: getDisplaysByIds is best-effort - a throttle returns a SHORT map
// and a thrown chunk is swallowed by the repo. Either way an unresolved member
// keeps its stored name, which is exactly today's behavior. This module never
// rejects; a repo throw degrades to "no names resolved" with one warn.
//
// PHONE IS NEVER TOUCHED. Routing, deliverability and removal all read the
// stored `participants[].phone`; this module only ever rewrites `name`.
//
// PII (doc section 9): ids and counts in logs, never names or phones.
import { contactDisplayName } from './contactName.js';
import type { Logger } from './logger.js';
import { isDeleted, type ContactDisplayItem, type ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationItem, ConversationParticipant } from '../repos/conversationsRepo.js';

/** The batch read this module needs - the display projection only. */
export type NameSource = Pick<ContactsRepo, 'getDisplaysByIds'>;

/** Unique, non-empty contactIds across every roster given. */
export function collectRosterContactIds(
  convs: readonly Pick<ConversationItem, 'participants'>[],
): string[] {
  const ids = new Set<string>();
  for (const conv of convs) {
    for (const p of conv.participants ?? []) {
      if (typeof p.contactId === 'string' && p.contactId.length > 0) ids.add(p.contactId);
    }
  }
  return [...ids];
}

/**
 * ONE batch read for a page of conversations. Never rejects: a repo throw
 * yields an empty map (every member keeps its stored name) and one warn.
 */
export async function resolveRosterNames(
  convs: readonly Pick<ConversationItem, 'participants'>[],
  contacts: NameSource,
  log: Logger,
): Promise<ReadonlyMap<string, ContactDisplayItem>> {
  const ids = collectRosterContactIds(convs);
  if (ids.length === 0) return new Map();
  try {
    return await contacts.getDisplaysByIds(ids);
  } catch (err) {
    log.warn({ err, contactCount: ids.length }, 'participant names: batch read failed - stored names stand');
    return new Map();
  }
}

/** PURE. A new roster with each member's name resolved per the chain above. */
export function withLiveNames(
  participants: readonly ConversationParticipant[] | undefined,
  names: ReadonlyMap<string, ContactDisplayItem>,
): ConversationParticipant[] {
  return (participants ?? []).map((p) => {
    if (typeof p.contactId !== 'string' || p.contactId.length === 0) return { ...p };
    const contact = names.get(p.contactId);
    if (contact === undefined || isDeleted(contact)) return { ...p };
    const live = contactDisplayName(contact);
    return live === undefined ? { ...p } : { ...p, name: live };
  });
}

/** resolveRosterNames + withLiveNames per row. New objects; input untouched. */
export async function hydrateConversationRosters<T extends ConversationItem>(
  convs: readonly T[],
  contacts: NameSource,
  log: Logger,
): Promise<T[]> {
  const names = await resolveRosterNames(convs, contacts, log);
  return convs.map((conv) => ({ ...conv, participants: withLiveNames(conv.participants, names) }));
}
