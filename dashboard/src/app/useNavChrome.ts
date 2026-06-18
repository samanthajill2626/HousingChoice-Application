// useNavChrome — the small bit of state behind the responsive left nav. Two
// independent pieces plus the mode that picks between them:
//   - collapsed   desktop (≥768px): sidebar shrunk to the icon rail. PERSISTED
//                 (localStorage) so it's a per-user preference, not per-session.
//   - drawerOpen  mobile (<768px): the off-canvas drawer is open. EPHEMERAL —
//                 always starts closed.
//   - isMobile    viewport is below the nav breakpoint (drawer mode vs sidebar).
// Kept out of AppFrame so the behavior is unit-testable and the frame stays an
// orchestrator.
import { useCallback, useEffect, useState } from 'react';

/** The single nav breakpoint. Below it the persistent sidebar becomes an
 *  off-canvas drawer; at/above it the sidebar is persistent + collapsible to the
 *  icon rail. 768px = the standard phone↔tablet divider (Bootstrap/Tailwind md,
 *  iPad portrait). Mirror this in AppFrame.module.css's media queries. */
export const NAV_BREAKPOINT_PX = 768;
const MOBILE_QUERY = `(max-width: ${NAV_BREAKPOINT_PX - 0.02}px)`;

const COLLAPSED_KEY = 'hc.nav.collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function matchesMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export interface NavChrome {
  /** Desktop: sidebar collapsed to the icon rail (persisted). */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Mobile: off-canvas drawer open (ephemeral). */
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  /** Viewport is below the nav breakpoint → drawer mode. */
  isMobile: boolean;
}

export function useNavChrome(): NavChrome {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(matchesMobile);

  // Track the breakpoint live; closing the drawer when we grow back into desktop
  // so a left-open drawer can't linger off-screen once the sidebar is shown.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (): void => {
      setIsMobile(mql.matches);
      if (!mql.matches) setDrawerOpen(false);
    };
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* localStorage unavailable (private mode / quota) — preference just
           won't persist; the in-memory toggle still works this session. */
      }
      return next;
    });
  }, []);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return { collapsed, toggleCollapsed, drawerOpen, openDrawer, closeDrawer, isMobile };
}
