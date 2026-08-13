// groupThread - the roster-derived title for a NATIVE group text.
//
// A group_text carries no stored display name, no operator tag and no pool
// number (spec 4.2), so its title is derived from the roster every time it is
// rendered: member FIRST names, else their formatted numbers.
//
// MIRROR: app/src/lib/groupTitle.ts `groupThreadLabel` is THE derivation - it
// titles the inbox row AND the contact card's rows server-side. This copy exists
// only because the thread-header route is a raw passthrough that hands down no
// label and the dashboard cannot import from app/src. Those are the only two
// copies; change them together - one conversation carrying different names on
// different screens is the failure to avoid.
import { formatPhoneDisplay } from './phone.js';

/** How many roster names a title spells out before it summarizes. A nine-member
 *  carrier group would otherwise render an unreadable row/header. */
const GROUP_TITLE_NAMES = 3;

export function groupThreadLabel(
  members: readonly { name?: string | undefined; phone: string }[] | undefined,
): string {
  const parts: string[] = [];
  for (const m of members ?? []) {
    // GUARDED both fields (A25 + adversarial 21). `m.name?.trim()` throws on a
    // non-string non-null name, which is the same raw-passthrough hazard the
    // phone guard below exists for - and the app mirror (groupTitle.ts) already
    // guarded THIS field while leaving the phone open. Both copies now guard
    // both, so they remain output-equal.
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    // First name only - a group title is a glance, not a directory entry.
    const first = name.length > 0 ? (name.split(/\s+/)[0] ?? '') : '';
    // GUARDED (A25). `formatPhoneDisplay` returns '' for an absent number, and
    // the `|| m.phone` fallback then hands back `undefined` for a member whose
    // phone never arrived - `label.length` on the next line would throw and
    // blank the thread header (and, through the app mirror, the inbox row). The
    // type says `phone: string`; the wire shape is what is not guaranteed. A
    // member we can say nothing about contributes no part.
    const phone = typeof m.phone === 'string' ? m.phone : '';
    const label = first.length > 0 ? first : formatPhoneDisplay(phone) || phone;
    if (label.length > 0) parts.push(label);
  }
  if (parts.length === 0) return 'Group text';
  const shown = parts.slice(0, GROUP_TITLE_NAMES);
  const rest = parts.length - shown.length;
  return rest > 0 ? `With ${shown.join(' & ')} +${rest} more` : `With ${shown.join(' & ')}`;
}

/**
 * ONE member's display label: their FULL name, else their formatted number.
 * The member panel's rule, deliberately NOT the title's (a title spells first
 * names only - a glance, not a directory entry).
 *
 * It lives here beside `groupThreadLabel` because it was three byte-identical
 * private copies - the group member panel, the relay member panel, and the
 * attribution chip's group fallback - and adversarial 17 is exactly what
 * happens when copies of one naming rule drift: two surfaces on one screen
 * spelling the same person differently. Guarded like everything else in this
 * module: these rosters come off raw passthroughs.
 */
export function groupMemberLabel(member: { name?: string | undefined; phone: string }): string {
  const name = typeof member.name === 'string' ? member.name.trim() : '';
  if (name.length > 0) return name;
  const phone = typeof member.phone === 'string' ? member.phone : '';
  return formatPhoneDisplay(phone) || phone;
}
