// rosterDriftTally - the pure count and the sourcing behind the --audit-denorm
// group pass in app/scripts/measure-unread-contact-coverage.ts. Counts only,
// never names.
//
// Sourcing is the part that was broken: the 1:1 walk reads the 'open'
// partition, which never returns a native group text (status `group_open`) or
// a closed relay group. Groups need listGroupTexts + listRelayGroups.
import { contactDisplayName } from './contactName.js';
import { isDeleted, type ContactDisplayItem } from '../repos/contactsRepo.js';
import type { ConversationParticipant, ConversationsRepo } from '../repos/conversationsRepo.js';

export interface RosterDriftTally {
  rosters: number;
  members: number;
  withContactId: number;
  /** contact has a name; the row stores none */
  nameMissingButKnown: number;
  /** both present and different */
  nameDrift: number;
  /** contactId present, no contact behind it (or the read did not return it) */
  danglingContactId: number;
  /** contact is soft-deleted: the read path deliberately leaves these alone */
  deletedContact: number;
  /** bare-phone member */
  noContactId: number;
}

export function tallyRosterDrift(
  rosters: readonly (readonly ConversationParticipant[])[],
  contacts: ReadonlyMap<string, ContactDisplayItem>,
): RosterDriftTally {
  const t: RosterDriftTally = {
    rosters: rosters.length, members: 0, withContactId: 0, nameMissingButKnown: 0,
    nameDrift: 0, danglingContactId: 0, deletedContact: 0, noContactId: 0,
  };
  for (const roster of rosters) {
    for (const p of roster) {
      t.members += 1;
      if (typeof p.contactId !== 'string' || p.contactId.length === 0) { t.noContactId += 1; continue; }
      t.withContactId += 1;
      const contact = contacts.get(p.contactId);
      if (contact === undefined) { t.danglingContactId += 1; continue; }
      if (isDeleted(contact)) { t.deletedContact += 1; continue; }
      const want = contactDisplayName(contact);
      const have = typeof p.name === 'string' && p.name.trim().length > 0 ? p.name.trim() : undefined;
      if (want !== undefined && have === undefined) t.nameMissingButKnown += 1;
      else if (want !== undefined && have !== undefined && want !== have) t.nameDrift += 1;
    }
  }
  return t;
}

/** Every group_text page plus all three relay partitions. */
export async function collectGroupRosters(
  conversations: Pick<ConversationsRepo, 'listGroupTexts' | 'listRelayGroups'>,
): Promise<{ rosters: ConversationParticipant[][]; groupTextTruncated: boolean; relayTruncated: string[] }> {
  const rosters: ConversationParticipant[][] = [];
  let groupTextTruncated = false;
  let cursor: string | undefined;
  do {
    const page = await conversations.listGroupTexts({ limit: 100, ...(cursor !== undefined && { cursor }) });
    for (const conv of page.items) rosters.push(conv.participants ?? []);
    groupTextTruncated ||= page.truncated;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const relayTruncated: string[] = [];
  for (const status of ['open', 'connecting', 'closed'] as const) {
    const { items, truncated } = await conversations.listRelayGroups(status);
    for (const conv of items) rosters.push(conv.participants ?? []);
    if (truncated) relayTruncated.push(status);
  }
  return { rosters, groupTextTruncated, relayTruncated };
}
