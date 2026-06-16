// Relay-group helpers (M1.7) — PURE, unit-testable. Mirrors the backend's
// member-key convention (relayMemberKey in app/src/repos/messagesRepo.ts) so the
// dashboard resolves attribution + per-recipient delivery labels from the ROSTER
// rather than parsing message bodies. Honest identity throughout: a member with
// no name shows their formatted phone, never a fabricated name.
import { formatPhone } from './identity';
import type { ConversationParticipant } from '../../api';

/** The team sentinel sender key (app/src/jobs/relayFanOut.ts TEAM_SENDER_KEY). */
export const TEAM_SENDER_KEY = 'team';
/** The neutral team label fan-out uses as the prefix (TEAM_SENDER_LABEL). */
export const TEAM_SENDER_LABEL = 'Housing Choice';

/**
 * The stable member key for a roster entry: the contactId when present, else
 * `phone#<E164>`. Must match the server (relayMemberKey) byte-for-byte so the
 * delivery_recipients map + relay_sender_key resolve against the roster.
 */
export function relayMemberKey(member: { contactId?: string; phone: string }): string {
  return member.contactId && member.contactId.length > 0
    ? member.contactId
    : `phone#${member.phone}`;
}

/** Find the roster member a member key refers to, or undefined when unknown. */
export function findMemberByKey(
  roster: ConversationParticipant[],
  key: string,
): ConversationParticipant | undefined {
  return roster.find((m) => relayMemberKey(m) === key);
}

/**
 * The honest display label for a member key resolved against the roster: the
 * member's name when known, else their formatted phone. A `phone#<E164>` key for
 * a member no longer on the roster still yields the formatted phone (never the
 * raw key). The TEAM sentinel resolves to the neutral team label.
 */
export function memberLabelForKey(
  roster: ConversationParticipant[],
  key: string | undefined,
): string {
  if (key === undefined || key.length === 0) return 'Unknown sender';
  if (key === TEAM_SENDER_KEY) return TEAM_SENDER_LABEL;
  const member = findMemberByKey(roster, key);
  if (member) return member.name ?? formatPhone(member.phone);
  // Unknown key: recover a phone from a `phone#<E164>` key; otherwise it's a
  // contactId we can't resolve (member removed) — fall back honestly.
  if (key.startsWith('phone#')) return formatPhone(key.slice('phone#'.length));
  return 'Unknown sender';
}

/** The honest display label for a roster member (name, else formatted phone). */
export function memberLabel(member: ConversationParticipant): string {
  return member.name ?? formatPhone(member.phone);
}
