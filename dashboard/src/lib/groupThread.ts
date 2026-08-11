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
    const name = m.name?.trim() ?? '';
    // First name only - a group title is a glance, not a directory entry.
    const first = name.length > 0 ? (name.split(/\s+/)[0] ?? '') : '';
    const label = first.length > 0 ? first : formatPhoneDisplay(m.phone) || m.phone;
    if (label.length > 0) parts.push(label);
  }
  if (parts.length === 0) return 'Group text';
  const shown = parts.slice(0, GROUP_TITLE_NAMES);
  const rest = parts.length - shown.length;
  return rest > 0 ? `With ${shown.join(' & ')} +${rest} more` : `With ${shown.join(' & ')}`;
}
