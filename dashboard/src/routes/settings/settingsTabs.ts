// The Settings tab model — the SINGLE source of truth for the section tabs.
// Drives BOTH the desktop wrapping tab row and the mobile section <select>
// (mirroring how nav.ts feeds the sidebar + drawer). Each tab carries an
// `adminOnly` flag; visibleTabs() filters the model for the viewer's role, and
// the routes themselves are guarded (admin-only chrome is NOT enough).
export interface SettingsTab {
  id: string;
  label: string;
  path: string;
  /** Hidden from VAs AND route-guarded (a VA hitting the path is redirected). */
  adminOnly: boolean;
}

/** The ordered tab set. `system` (System status) is INCLUDED now but renders a
 *  Phase-A "available soon" stub; Phase B fills it. It's admin-only so VAs never
 *  see it. */
export const SETTINGS_TABS: SettingsTab[] = [
  { id: 'team', label: 'Team', path: '/settings/team', adminOnly: true },
  { id: 'templates', label: 'Templates', path: '/settings/templates', adminOnly: false },
  { id: 'notifications', label: 'Notifications', path: '/settings/notifications', adminOnly: false },
  // Voice: self-service cell verification (Voice Phase 1 §7) — reachable by ANY
  // logged-in user (not admin-only), so a VA can set + verify their own cell.
  { id: 'voice', label: 'Voice', path: '/settings/voice', adminOnly: false },
  { id: 'system', label: 'System status', path: '/settings/system', adminOnly: true },
];

/** The self cell-verification tab path — the CallMenu deep-links here when the
 *  navigator has no verified cell. */
export const VOICE_TAB_PATH = '/settings/voice';

/** The tabs visible to a viewer of this role (admin sees all; a VA sees only the
 *  non-admin-only ones). */
export function visibleTabs(isAdmin: boolean): SettingsTab[] {
  return SETTINGS_TABS.filter((t) => isAdmin || !t.adminOnly);
}

/** The default landing tab path for a role: the first VISIBLE tab — admin →
 *  /settings/team, VA → /settings/templates. */
export function defaultTabPath(isAdmin: boolean): string {
  return visibleTabs(isAdmin)[0]?.path ?? '/settings/templates';
}

/** The fallback a guarded (admin-only) route redirects a VA to. */
export const VA_DEFAULT_TAB_PATH = '/settings/templates';
