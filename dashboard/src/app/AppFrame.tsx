// AppFrame — the authenticated shell. The left nav is responsive (see
// useNavChrome): at ≥768px a PERSISTENT sidebar that the operator can collapse to
// an icon rail (preference persisted); below 768px an OFF-CANVAS drawer behind a
// top-bar hamburger. The nav body itself (the LOCKED IA) lives in NavContents and
// is shared verbatim by both, so they can't drift. Around it: the routed
// <Outlet/> and a top-right account menu. Accessibility-first throughout — the
// drawer locks scroll, traps focus, closes on Escape/scrim/link, and restores
// focus to the hamburger.
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { logout } from '../api/index.js';
import { Button } from '../ui/index.js';
import { ChevronIcon, CloseIcon, MenuIcon } from '../ui/icons.js';
import { useAuth } from './AuthContext.js';
import { NavContents } from './NavContents.js';
import { useNavChrome } from './useNavChrome.js';
import styles from './AppFrame.module.css';

export function AppFrame(): React.JSX.Element {
  const { me, refresh } = useAuth();
  const { collapsed, toggleCollapsed, drawerOpen, openDrawer, closeDrawer, isMobile } =
    useNavChrome();
  const drawerRef = useRef<HTMLElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  async function handleSignOut(): Promise<void> {
    try {
      await logout();
    } finally {
      // Re-probe → AuthContext flips to anonymous → the shell shows Login.
      await refresh();
    }
  }

  // Drawer a11y, active only while open: lock body scroll, move focus into the
  // drawer, trap Tab within it, close on Escape, and restore focus to the
  // hamburger when it closes.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const drawer = drawerRef.current;
    if (!drawer) return undefined;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusables = (): HTMLElement[] =>
      Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    focusables()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDrawer();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      hamburgerRef.current?.focus();
    };
  }, [drawerOpen, closeDrawer]);

  return (
    <div className={styles.shell}>
      <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`} aria-label="Primary">
        <div className={styles.brandRow}>
          <NavLink to="/" className={styles.brand} end aria-label="HousingChoice home">
            <span className={styles.brandFull}>HousingChoice</span>
            <span className={styles.brandMark} aria-hidden="true">
              HC
            </span>
          </NavLink>
          <button
            type="button"
            className={styles.collapseToggle}
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-pressed={collapsed}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            <ChevronIcon dir={collapsed ? 'right' : 'left'} />
          </button>
        </div>
        <NavContents />
      </aside>

      {isMobile ? (
        <>
          <div
            className={`${styles.scrim} ${drawerOpen ? styles.scrimOpen : ''}`}
            onClick={closeDrawer}
            aria-hidden="true"
          />
          <aside
            id="nav-drawer"
            ref={drawerRef}
            className={`${styles.drawer} ${drawerOpen ? styles.drawerOpen : ''}`}
            aria-label="Primary"
            {...(!drawerOpen && { 'aria-hidden': true })}
          >
            <div className={styles.drawerHead}>
              <NavLink to="/" className={styles.brand} end onClick={closeDrawer}>
                HousingChoice
              </NavLink>
              <button
                type="button"
                className={styles.collapseToggle}
                onClick={closeDrawer}
                aria-label="Close navigation"
              >
                <CloseIcon />
              </button>
            </div>
            <NavContents onNavigate={closeDrawer} />
          </aside>
        </>
      ) : null}

      <div className={styles.main}>
        <header className={styles.topbar}>
          <button
            ref={hamburgerRef}
            type="button"
            className={styles.hamburger}
            onClick={openDrawer}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="nav-drawer"
          >
            <MenuIcon size={22} />
          </button>
          <NavLink to="/" className={styles.topbarBrand} end>
            HousingChoice
          </NavLink>
          <div className={styles.topbarRight}>
            <AccountMenu email={me?.email ?? ''} role={me?.role ?? 'va'} onSignOut={handleSignOut} />
          </div>
        </header>
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function AccountMenu({
  email,
  role,
  onSignOut,
}: {
  email: string;
  role: string;
  onSignOut: () => void | Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.account} ref={ref}>
      <button
        type="button"
        className={styles.accountTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.accountEmail}>{email}</span>
      </button>
      {open && (
        <div className={styles.popover} role="menu">
          <div className={styles.identity}>
            <div className={styles.identityEmail}>{email}</div>
            <div className={styles.identityRole}>{role}</div>
          </div>
          <div className={styles.divider} />
          <Button variant="secondary" size="sm" block onClick={() => void onSignOut()}>
            Sign out
          </Button>
        </div>
      )}
    </div>
  );
}
