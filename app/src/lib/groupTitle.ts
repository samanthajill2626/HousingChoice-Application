// groupTitle - THE roster-derived title for a native group text (spec 4.2:
// "headers render a DERIVED name from the roster - member first names, else
// formatted numbers").
//
// A `group_text` carries NO stored display name, NO operator tag and NO pool
// number, so relayRowFor's precedence chain collapses to this one rule - and it
// must be ONE rule. Three surfaces name the same thread: the inbox row, the
// contact page's "Group threads" card, and the thread header. When they each
// derived their own title they disagreed in public: after the migration every
// imported roster is nameless, so the inbox said "With (555) 010-0002 & ..." and
// the card said "Group text" while the header showed the real names.
//
// MIRROR: dashboard/src/lib/groupThread.ts `groupThreadLabel` implements the
// identical rule client-side for the thread header, whose route is a raw
// passthrough that hands down no label and which cannot import from app/src.
// Those two are the only copies, and they change together.
//
// PII (doc 9): the roster carries names and phones - render data for an authed
// staff surface, never log output.
import { formatPhoneForDisplay } from './phone.js';
import type { ConversationItem, ConversationParticipant } from '../repos/conversationsRepo.js';

/** How many roster names a title spells out before it summarizes. A nine-member
 *  carrier group would otherwise render an unreadable row/header. */
export const GROUP_TITLE_NAMES = 3;

/** The title. `members` is the roster (or the roster minus self, on the contact
 *  card - "the OTHERS in this group" is the same rule over a smaller set). */
export function groupThreadLabel(
  members: readonly ConversationParticipant[] | undefined,
): string {
  const parts: string[] = [];
  for (const p of members ?? []) {
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    // First name only - a group title is a glance, not a directory entry.
    const first = name.length > 0 ? (name.split(/\s+/)[0] ?? '') : '';
    // GUARDED (A25 / adversarial 21). `formatPhoneForDisplay` returns undefined
    // for an absent number and the `?? p.phone` fallback then hands back
    // `undefined`, so `label.length` on the next line throws - inside
    // `groupRowFor`, inside the inbox handler, which 500s GET /api/inbox for the
    // WHOLE org. The type says `phone: string`; the wire shape is what is not
    // guaranteed. A member we can say nothing about contributes no part. The
    // dashboard mirror (dashboard/src/lib/groupThread.ts) guards identically.
    const phone = typeof p.phone === 'string' ? p.phone : '';
    const label = first.length > 0 ? first : (formatPhoneForDisplay(phone) ?? phone);
    if (label.length > 0) parts.push(label);
  }
  if (parts.length === 0) return 'Group text';
  const shown = parts.slice(0, GROUP_TITLE_NAMES);
  const rest = parts.length - shown.length;
  return rest > 0 ? `With ${shown.join(' & ')} +${rest} more` : `With ${shown.join(' & ')}`;
}

/**
 * ONE member's STAFF-FACING label: their name, else their OWN formatted phone.
 *
 * THE LINE (founder ruling 2026-08-19), and it is not "preview vs not-preview":
 *
 *   OUTBOUND MESSAGE CONTENT - anything a tenant or landlord actually receives -
 *   carries names and NEVER a phone. jobs/relayFanOut composeNameList
 *   drops a nameless member and falls back to a neutral count rather than print
 *   their number, and that stays exactly as it is.
 *
 *   STAFF-ONLY CHROME - a label or sentence only a navigator ever sees - falls
 *   back to the number. Rendering "Unknown" gives a navigator nothing to act on,
 *   and silently DROPPING the member loses a person from a staff-facing list.
 *   This is already the app's convention: contactDisplayName
 *   (dashboard/src/routes/contact/format.ts) is name -> formatted phone.
 *
 * The relay chains avoided the fallback wholesale only because ONE resolved name
 * used to feed both consumers. This helper serves the staff half ONLY - never
 * pass its output to a message body.
 *
 * `anyNamed` rides along because every caller's TAG rung depends on it: an
 * operator's deliberate `placement_tag` beats a list of raw digits, so the tag
 * still wins when NOBODY on the roster has a real name. Without that carve-out
 * the tag rung would be dead code for every group that has participants, which
 * would silently retire an operator-facing feature.
 *
 * `trimNames` is the one caller-visible difference between the chains: the
 * inbox/push chain trims, poolNumbersAdmin's serverLabel deliberately does not.
 * Emptiness is judged on the TRIMMED value either way - a whitespace-only name
 * is not a name, whichever chain is asking.
 *
 * GUARDED (A25 / adversarial 21): formatPhoneForDisplay returns undefined for an
 * absent number, so `?? phone` keeps every element a string. A member with
 * NEITHER a name NOR a phone contributes nothing.
 */
export function relayMemberLabels(
  members: readonly ConversationParticipant[] | undefined,
  opts: { trimNames?: boolean } = {},
): { labels: string[]; anyNamed: boolean } {
  const labels: string[] = [];
  let anyNamed = false;
  for (const p of members ?? []) {
    const raw = typeof p.name === 'string' ? p.name : '';
    if (raw.trim().length > 0) {
      anyNamed = true;
      labels.push(opts.trimNames === true ? raw.trim() : raw);
      continue;
    }
    const phone = typeof p.phone === 'string' ? p.phone : '';
    const label = formatPhoneForDisplay(phone) ?? phone;
    if (label.length > 0) labels.push(label);
  }
  return { labels, anyNamed };
}

/**
 * The relay-group thread label - the EXACT precedence chain the inbox
 * row uses (member labels -> operator placement_tag -> formatted pool
 * number -> "Relay group"), extracted from routes/inbox.ts relayRowFor
 * so the push title and the inbox row cannot drift.
 *
 * The FIRST rung is per-member (relayMemberLabels): each participant renders
 * their name, else their own formatted phone, so a MIXED roster reads
 * "With Dana Reed & (555) 010-0002" instead of dropping the second person. This
 * is staff-only chrome - see relayMemberLabels for the outbound/staff line.
 * When NOBODY has a real name the tag rung still wins.
 *
 * SCOPE GUARD: this consolidates ONLY the inbox row + push title.
 * Other relay-label chains (notably routes/poolNumbersAdmin.ts
 * serverLabel and routes/contacts.ts `otherMemberNames`) are DELIBERATELY
 * different precedences pinned by their own tests - do not re-point them
 * here. They share the per-member fallback via relayMemberLabels and
 * NOTHING else. serverLabel differs in two ways on purpose: it has NO
 * pool-number rung (the number is the parent row's own column) and it
 * does not trim member names.
 *
 * CLIENT MIRROR: dashboard/src/routes/contact/GroupTextsCard.tsx
 * groupLabel carries the same four-step precedence client-side over its
 * own server-computed RelayGroupRow DTO (it cannot import from app/src)
 * - the groupThreadLabel precedent above; they change together. Its name
 * rung reads the server-computed `otherMemberNames`, so the per-member
 * fallback reaches it from routes/contacts.ts with no client edit; the
 * tag carve-out reaches it the same way, by leaving that array empty.
 *
 * Unlike groupThreadLabel this takes the WHOLE ConversationItem: the tag
 * and pool-number rungs read fields that live on the conversation, not
 * on the roster.
 */
export function relayThreadLabel(conv: ConversationItem): string {
  const { labels, anyNamed } = relayMemberLabels(conv.participants, { trimNames: true });
  // GOTCHA: the operator tag rides ConversationItem's index signature
  // under the key `placement_tag` (NOT `tag`) and is untyped.
  const tag = typeof conv['placement_tag'] === 'string' ? conv['placement_tag'].trim() : '';
  // The tag carve-out: raw digits lose to a deliberate operator label, but only
  // when there is no real name anywhere on the roster.
  if (labels.length > 0 && (anyNamed || tag.length === 0)) return `With ${labels.join(' & ')}`;
  if (tag.length > 0) return tag;
  const pool =
    typeof conv.pool_number === 'string' && conv.pool_number.length > 0 ? conv.pool_number : '';
  if (pool.length > 0) return formatPhoneForDisplay(pool) ?? pool;
  return 'Relay group';
}
