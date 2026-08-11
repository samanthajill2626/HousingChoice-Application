// memberAttribution - the ONE place the dashboard resolves a multi-party
// message's sender key against its roster, shared by the relay-group view and
// the native group_text thread view.
//
// The two products key their members DIFFERENTLY on the write side: relay uses
// the app's relayMemberKey convention (contactId when set, else `phone#<E164>`)
// while a native group_text is PHONE-SCOPED always (`phone#<E164>`, spec 15.6 -
// contactId preference would collapse two numbers of one contact into one
// delivery slot). Rather than thread a "which convention am I" mode down four
// component hops, `senderLabel` matches a SUPERSET of keys: a roster member
// answers to EITHER its contactId or its phone-scoped key. The two key spaces
// are disjoint by construction (a contactId is never `phone#...`), so the
// superset can only ever resolve the member the writer meant.
import type { ConversationParticipant } from '../api/index.js';

/** The phone-scoped member key: the ONLY form a native group_text uses. */
export function phoneMemberKey(member: ConversationParticipant): string {
  return `phone#${member.phone}`;
}

/** The relay member key convention (MIRRORS app relayMemberKey): the member's
 *  contactId when set, else `phone#<E164>`. */
export function memberKey(member: ConversationParticipant): string {
  return member.contactId && member.contactId.length > 0
    ? member.contactId
    : phoneMemberKey(member);
}

/** Resolve a multi-party message's sender label: the `'team'` sentinel -> "Team";
 *  the `'system'` sentinel -> "Automated" (an app announcement: group intro /
 *  tour reminder rung); a member key (EITHER convention) -> that member's name
 *  (roster lookup); otherwise undefined (no attribution line). Only meaningful
 *  for a multi-party bubble (relay_sender_key set). */
export function senderLabel(
  senderKey: string | undefined,
  roster: ConversationParticipant[] | undefined,
): string | undefined {
  if (senderKey === undefined || senderKey.length === 0) return undefined;
  if (senderKey === 'team') return 'Team';
  if (senderKey === 'system') return 'Automated';
  for (const m of roster ?? []) {
    const matches =
      (m.contactId.length > 0 && m.contactId === senderKey) || phoneMemberKey(m) === senderKey;
    if (matches) {
      const name = m.name?.trim();
      return name && name.length > 0 ? name : undefined;
    }
  }
  return undefined;
}
