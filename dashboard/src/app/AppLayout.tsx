// AppLayout — the authenticated shell: a top bar with the brand + a current-user
// menu (email/role + sign out), the routed <Outlet/> content, and navigation
// (a bottom tab bar on mobile, a top nav on wider screens). Admin-only nav items
// (Users, Settings) render only for admins. Renders around every authenticated
// route via the router (src/app/router.tsx).
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { logout } from '../api/index.js';
import { Avatar, Button, InboxIcon, LogoutIcon, SettingsIcon, UsersIcon } from '../ui/index.js';
import { useAuth } from './AuthContext.js';
import styles from './AppLayout.module.css';

interface NavItem {
  to: string;
  label: string;
  icon: React.JSX.Element;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Inbox', icon: <InboxIcon /> },
  { to: '/admin/users', label: 'Users', icon: <UsersIcon />, adminOnly: true },
  { to: '/settings', label: 'Settings', icon: <SettingsIcon />, adminOnly: true },
];

export function AppLayout(): React.JSX.Element {
  const { me, isAdmin, refresh } = useAuth();
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

  async function handleSignOut(): Promise<void> {
    try {
      await logout();
    } finally {
      // Re-probe → AuthContext flips to anonymous → the shell shows Login.
      await refresh();
    }
  }

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <NavLink to="/" className={styles.brand}>
          HousingChoice
        </NavLink>

        <nav className={styles.topnav} aria-label="Primary">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `${styles.topnavLink} ${isActive ? styles.topnavLinkActive : ''}`
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </nav>

        <UserMenu email={me?.email ?? ''} role={me?.role ?? 'va'} onSignOut={handleSignOut} />
      </header>

      <main className={styles.content}>
        <Outlet />
      </main>

      {/* Mobile bottom tab bar. */}
      <nav className={styles.tabbar} aria-label="Primary">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
          >
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function UserMenu({
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
    <div className={styles.userMenu} ref={ref}>
      <button
        type="button"
        className={styles.userTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar name={email} size="sm" />
      </button>
      {open && (
        <div className={styles.popover} role="menu">
          <div className={styles.identity}>
            <div className={styles.email}>{email}</div>
            <div className={styles.role}>{role}</div>
          </div>
          <div className={styles.divider} />
          <Button variant="secondary" size="sm" block onClick={() => void onSignOut()}>
            <LogoutIcon size={16} />
            Sign out
          </Button>
        </div>
      )}
    </div>
  );
}
