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
import { formatPhoneDisplay } from './phone.js';

/**
 * Which multi-party product the roster belongs to. STRUCTURALLY IDENTICAL to
 * `RosterKind` in routes/contact/Timeline.tsx and deliberately re-declared here
 * rather than imported: this module is the leaf both the relay view and the
 * group view depend on, and importing a component module for a string union
 * would make the dependency circular.
 */
export type AttributionKind = 'relay' | 'group_text';

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

/** Find the roster member a delivery/sender key names, matching the SUPERSET of
 *  both conventions described in the module header: a member answers to EITHER
 *  its contactId or its phone-scoped key. First match wins, in roster order.
 *
 *  Extracted from `senderLabel`'s loop so the per-recipient row resolver
 *  (`recipientLabel.ts`) reuses the SAME matcher rather than growing a second
 *  copy. Deliberately does NOT handle the `'team'` / `'system'` sentinels or an
 *  empty key - those are `senderLabel`'s early returns and stay there, so this
 *  helper is exactly the loop and nothing more.
 *
 *  NO NORMALISATION: no trim, no case fold, no re-normalisation of the phone
 *  half. Both sides are compared raw with `===`, because the write side
 *  guarantees E.164 on both halves. */
export function findRosterMember(
  key: string,
  roster: ConversationParticipant[] | undefined,
): ConversationParticipant | undefined {
  for (const m of roster ?? []) {
    // GUARDED, restoring the check the code this replaced carried (A25). The
    // types say `contactId: string` / `phone: string`, but the relay view seeds
    // its roster straight from `header.participants` - the raw passthrough
    // ConversationDetail documents as arriving in more than one wire shape. This
    // function runs for EVERY bubble in BOTH timelines, so an absent field here
    // does not blank one chip: it throws and blanks the whole conversation page.
    const contactId = typeof m.contactId === 'string' ? m.contactId : '';
    const matches =
      (contactId.length > 0 && contactId === key) || phoneMemberKey(m) === key;
    if (matches) return m;
  }
  return undefined;
}

/** Resolve a multi-party message's sender label: the `'team'` sentinel -> "Team";
 *  the `'system'` sentinel -> "Automated" (an app announcement: group intro /
 *  tour reminder rung); a member key (EITHER convention) -> that member's name
 *  (roster lookup); otherwise undefined (no attribution line). Only meaningful
 *  for a multi-party bubble (relay_sender_key set).
 *
 *  THE NAMELESS MEMBER, and why `kind` exists (live QA round 2, L6). EVERY
 *  member a native carrier group detects is a bare stub whose only identity is a
 *  phone number - detection never guesses a name (groupMembers.ts: "seeing
 *  somebody on a group envelope says nothing about who they are"). Returning
 *  `undefined` for a nameless member therefore left EVERY message in EVERY group
 *  thread unattributed, which is the one thing the product exists to show. Spec
 *  4.2 already states the convention - "member first names, else FORMATTED
 *  NUMBERS" - and the thread header and member panel both already follow it.
 *  So a `group_text` roster falls back to the formatted number.
 *
 *  RELAY KEEPS ITS EXACT PRIOR RENDERING (invariant 6): `kind` defaults to
 *  'relay', where a nameless member still yields no attribution line. Relay's
 *  bubbles are a shipped, separately-reviewed surface and this fix wave is not
 *  the place to change what they render; extending the fallback there is a
 *  product decision on its own. */
export function senderLabel(
  senderKey: string | undefined,
  roster: ConversationParticipant[] | undefined,
  kind: AttributionKind = 'relay',
): string | undefined {
  if (senderKey === undefined || senderKey.length === 0) return undefined;
  if (senderKey === 'team') return 'Team';
  if (senderKey === 'system') return 'Automated';
  const m = findRosterMember(senderKey, roster);
  if (m === undefined) return undefined;
  // GUARDED for the same reason, and against the same wire shape, as
  // `contactId` in the matcher (adversarial 28): `name` is the field most likely
  // to arrive off-shape from the raw passthrough, and `m.name?.trim()` throws on
  // a non-string non-null value - blanking the whole conversation page, not one
  // chip.
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (name.length > 0) return name;
  if (kind !== 'group_text') return undefined;
  // The repo's ONE dashboard phone formatter (lib/phone.ts), never a
  // hand-rolled copy: the member panel, the thread header and this chip must
  // spell one person's number identically or they read as two people. A
  // non-NANP number comes back unchanged, and an empty phone falls through
  // to no attribution rather than an empty chip.
  //
  // NOT collapsed into `groupMemberLabel` (lib/groupThread.ts), which looks
  // byte-identical: it falls back to the RAW phone when `formatPhoneDisplay`
  // returns '', where this returns `undefined` (no attribution line). The test
  // at memberAttribution.test.ts:175 pins that difference. They are not
  // interchangeable.
  const formatted = formatPhoneDisplay(m.phone);
  return formatted.length > 0 ? formatted : undefined;
}
