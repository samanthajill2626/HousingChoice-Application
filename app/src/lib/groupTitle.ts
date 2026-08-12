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
import type { ConversationParticipant } from '../repos/conversationsRepo.js';

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
