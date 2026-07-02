// Nav model — the persistent left navigation, LOCKED by the design spec
// (2026-06-16-new-dashboard-design.md §IA / left nav). Two equal-weight groups
// (nothing dimmed): Workspace and Communications. Contacts is a clickable parent
// (→ the full Contacts list) with three filtered children: Tenants / Landlords /
// Unknown (untriaged inbounds). Settings sits in the footer.
// 2026-07-02: Tours added to Workspace after Placements — founder-approved amendment to the locked nav.
//
// `end` marks an exact-match link (react-router NavLink `end`) so a parent route
// isn't highlighted while a child route is active.

/** Icon id → resolved to a component via `ui/icons.tsx` NAV_ICONS. */
export type NavIconName =
  | 'today'
  | 'placements'
  | 'tours'
  | 'contacts'
  | 'listings'
  | 'inbox'
  | 'broadcasts'
  | 'settings';

export interface NavLeaf {
  to: string;
  label: string;
  /** Exact-match active state (NavLink `end`). */
  end?: boolean;
  /** Leading nav icon (top-level items only). */
  icon?: NavIconName;
  /** Colored filter dot (the Contacts children: tenant/landlord/unknown). */
  dot?: 'tenant' | 'landlord' | 'unknown';
  /** Marks a leaf that renders a live count badge (resolved from context, not
   *  the static model). Currently only the Inbox unread count. */
  badge?: 'inbox-unread';
}

export interface NavParent extends NavLeaf {
  /** Child links rendered indented under the parent (Contacts ▸ …). */
  children: NavLeaf[];
}

export type NavItem = NavLeaf | NavParent;

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function isNavParent(item: NavItem): item is NavParent {
  return (item as NavParent).children !== undefined;
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Today', end: true, icon: 'today' },
      { to: '/placements', label: 'Placements', icon: 'placements' },
      { to: '/tours', label: 'Tours', icon: 'tours' },
      {
        to: '/contacts',
        label: 'Contacts',
        end: true,
        icon: 'contacts',
        children: [
          { to: '/contacts/tenants', label: 'Tenants', dot: 'tenant' },
          { to: '/contacts/landlords', label: 'Landlords', dot: 'landlord' },
          { to: '/contacts/unknown', label: 'Unknown', dot: 'unknown' },
        ],
      },
      { to: '/listings', label: 'Properties', icon: 'listings' },
    ],
  },
  {
    label: 'Communications',
    items: [
      { to: '/inbox', label: 'Inbox', icon: 'inbox', badge: 'inbox-unread' },
      { to: '/broadcasts', label: 'Broadcasts', icon: 'broadcasts' },
    ],
  },
];

/** The footer nav link (rendered apart from the two groups). */
export const NAV_FOOTER: NavLeaf = { to: '/settings', label: 'Settings', icon: 'settings' };

/** Every nav target, flattened (parents + children + footer) — used to mount a
 *  placeholder route per destination so the frame is fully navigable in B0. */
export function allNavTargets(): NavLeaf[] {
  const targets: NavLeaf[] = [];
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      targets.push({ to: item.to, label: item.label, ...(item.end && { end: item.end }) });
      if (isNavParent(item)) targets.push(...item.children);
    }
  }
  targets.push(NAV_FOOTER);
  return targets;
}
