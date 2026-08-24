// recipientLabel - who ONE row of a per-recipient delivery breakdown names.
//
// A multi-party bubble's `delivery_recipients` map is keyed by member, and the
// rollup that used to be the only thing rendered from it threw those keys away
// (`Object.values`), leaving a bare count. This module answers the question the
// count could not: given one map KEY and the CURRENT roster, what does that row
// call the person?
//
// It is deliberately NOT part of `memberAttribution.ts`, which answers a
// different question - who AUTHORED this message - and must stay focused on it.
// This is a composition of three leaves (the matcher from memberAttribution, the
// display rule from groupThread, the formatter from phone), so it lives beside
// them rather than inside one of them.
//
// TWO RULES CARRY THIS MODULE:
//
//  1. EVERY ROW CARRIES A LABEL. A blank row defeats the whole feature. Both
//     `groupMemberLabel` and `formatPhoneDisplay` can hand back '', so every
//     path funnels through a fallback rather than trusting them.
//  2. AN ABSENT ROSTER IS NOT THE SAME FACT AS AN ABSENT MEMBER (spec S2, cases
//     2 and 3). The roster is CURRENT membership while the map is HISTORICAL, so
//     a key that matches nothing IN A POPULATED ROSTER is somebody removed since
//     the send. With NO roster we know nothing and say nothing - claiming former
//     membership there would tell a founder that every recipient of every
//     message had left, which is the confident false reading this whole feature
//     exists to stop.
import type { ConversationParticipant } from '../api/index.js';
import { groupMemberLabel } from './groupThread.js';
import { findMemberByKey } from './memberAttribution.js';
import { formatPhoneDisplay } from './phone.js';

/** How the key resolved against the roster - spec S2's three cases, in order.
 *  `member`: matched a member of a populated roster.
 *  `former_member`: a populated roster, no match - removed since the send.
 *  `unidentified`: no roster to check against, so NO membership claim at all. */
export type RecipientMatch = 'member' | 'former_member' | 'unidentified';

/** One row's naming. The label and the discriminator travel TOGETHER because two
 *  consumers read them - the visible row and the chip's accessible name - and a
 *  consumer that re-derived either would be free to disagree with the other. */
export interface RecipientLabel {
  /** What the row calls this recipient. NEVER empty. */
  label: string;
  /** A membership qualifier to render beside the label. Present ONLY for
   *  `former_member`; absent otherwise, which is what keeps case 3 silent. */
  note?: string;
  /** True iff the map key is phone-keyed (`phone#<E164>`). */
  phoneKeyed: boolean;
  match: RecipientMatch;
}

/** The row's fallback identity when nothing can name the recipient: a matched
 *  member with neither a name nor a number, or an unmatched contactId key. */
export const UNNAMED_RECIPIENT_LABEL = 'Unnamed recipient';

/** The case-2 qualifier. Lives here, not at the render site, so the visible row
 *  and the accessible name spell it identically. */
export const FORMER_MEMBER_NOTE = 'former member';

const PHONE_KEY_PREFIX = 'phone#';

/**
 * The `phone#` discriminator: the E.164 remainder of a phone-scoped delivery key,
 * or undefined when the key is a bare contactId. The two shapes are exhaustive
 * over `delivery_recipients` - `relayMemberKey` returns the contactId when the
 * member has one and `phone#<E164>` otherwise, and a native group_text key is
 * ALWAYS `phone#<E164>` - so this is the ONLY thing a caller may branch on.
 * NEVER branch the phone case on the product (`rosterKind`): a contactless RELAY
 * member is phone-keyed, and a group_text gate would render exactly those rows
 * nameless.
 *
 * THE HASH IS LOAD-BEARING. `RosterMemberView.memberKey` (the tour/placement
 * PeopleCard key space, `app/src/lib/rosterResolution.ts:560`) is `phone:` with
 * a COLON, so `startsWith('phone')` would silently span two key spaces.
 *
 * MIRROR - two other copies of this same split exist and must not drift:
 *   - `dashboard/src/routes/broadcasts/broadcastFormat.ts:116` (`splitContactKey`)
 *   - `app/src/services/groupReceipts.ts:285`
 * They are NOT unified here on purpose: this branch freezes broadcasts to a
 * zero-line diff, so collapsing them is a separate, reviewable change. Filed.
 */
export function phoneFromRecipientKey(key: string): string | undefined {
  // Keys arrive as `Object.keys` of a raw-passthrough map, so they are strings
  // in practice - but this module's contract is that it never throws and never
  // blanks a row, and one `typeof` buys both.
  if (typeof key !== 'string') return undefined;
  return key.startsWith(PHONE_KEY_PREFIX) ? key.slice(PHONE_KEY_PREFIX.length) : undefined;
}

/**
 * Name the recipient one delivery-map key stands for - spec S2's three cases, in
 * order. Takes NO product/rosterKind argument by design: see
 * `phoneFromRecipientKey`.
 *
 * Case 1 applies the NUMBER FALLBACK to a nameless relay member, which
 * `senderLabel` deliberately does not (memberAttribution.ts invariant 6). That
 * split is intended and must not be "fixed" in either direction: a nameless
 * relay member is unnamed as an AUTHOR - an attribution chip may render nothing -
 * and shown by number as a RECIPIENT, because a blank row is useless.
 */
export function resolveRecipientLabel(
  key: string,
  roster: ConversationParticipant[] | undefined,
): RecipientLabel {
  const phone = phoneFromRecipientKey(key);
  const phoneKeyed = phone !== undefined;
  // GUARDED to the standard the rest of this subsystem holds - these rosters come
  // off raw passthroughs (`header.participants`) - but as DEFENCE IN DEPTH, not
  // because an off-shape roster has been observed here. What the guard DOES
  // decide is the semantics: anything that is not an array cannot be searched, so
  // it is an ABSENT roster - case 3 - never a roster that failed to match, which
  // would be a claim about membership.
  const rosterPresent = Array.isArray(roster) && roster.length > 0;

  if (rosterPresent) {
    const found = findMemberByKey(key, roster);
    if (found !== undefined) {
      // groupMemberLabel is the member panel's rule and the ONE place it lives:
      // full name, else formatted number. It returns '' for a member carrying
      // neither, which is the blank row rule 1 forbids.
      const label = groupMemberLabel(found);
      return {
        label: label.length > 0 ? label : UNNAMED_RECIPIENT_LABEL,
        phoneKeyed,
        match: 'member',
      };
    }
    return {
      label: labelFromPhone(phone),
      note: FORMER_MEMBER_NOTE,
      phoneKeyed,
      match: 'former_member',
    };
  }

  // No roster: the number if the key carries one, and otherwise a neutral label.
  // NO `note` - nothing here is evidence of anything about membership.
  return { label: labelFromPhone(phone), phoneKeyed, match: 'unidentified' };
}

/** The number a phone-scoped key carries, formatted - or the neutral fallback.
 *  `formatPhoneDisplay` returns '' for anything falsy and the input unchanged
 *  for a non-NANP number, so a `phone#` key with an empty remainder is the one
 *  shape that would otherwise render blank. */
function labelFromPhone(phone: string | undefined): string {
  const formatted = formatPhoneDisplay(phone);
  return formatted.length > 0 ? formatted : UNNAMED_RECIPIENT_LABEL;
}
