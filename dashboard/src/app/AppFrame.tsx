// AppFrame — the authenticated shell: a persistent left nav (Workspace +
// Communications groups, with the Contacts parent ▸ Tenants/Landlords/Unknown
// children, plus a Settings footer link), the routed <Outlet/>, and a top-right
// account menu (the user email + Sign out from AuthContext). Accessibility-first:
// each group is a <nav> with an aria-label and NavLinks render as roled links.
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { logout } from '../api/index.js';
import { Button } from '../ui/index.js';
import { NAV_ICONS } from '../ui/icons.js';
import { useAuth } from './AuthContext.js';
import { NAV_FOOTER, NAV_GROUPS, isNavParent, type NavLeaf } from './nav.js';
import { useUnread } from './UnreadContext.js';
import styles from './AppFrame.module.css';

function linkClass({ isActive }: { isActive: boolean }): string {
  return `${styles.link} ${isActive ? styles.linkActive : ''}`;
}

function childLinkClass({ isActive }: { isActive: boolean }): string {
  return `${styles.link} ${styles.childLink} ${isActive ? styles.linkActive : ''}`;
}

const DOT_CLASS: Record<NonNullable<NavLeaf['dot']>, string> = {
  tenant: styles.dotTenant ?? '',
  landlord: styles.dotLandlord ?? '',
  unknown: styles.dotUnknown ?? '',
};

function NavLeafLink({ item }: { item: NavLeaf }): React.JSX.Element {
  const Icon = item.icon ? NAV_ICONS[item.icon] : undefined;
  const { unread } = useUnread();
  const badge = item.badge === 'inbox-unread' && unread !== null && unread > 0 ? unread : null;
  return (
    <div className={styles.linkRow}>
      <NavLink to={item.to} end={item.end ?? false} className={linkClass}>
        {Icon ? (
          <span className={styles.icon}>
            <Icon />
          </span>
        ) : null}
        <span className={styles.linkLabel}>{item.label}</span>
      </NavLink>
      {badge !== null ? (
        <span className={styles.badge} aria-label={`${badge} unread`}>
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </div>
  );
}

export function AppFrame(): React.JSX.Element {
  const { me, refresh } = useAuth();

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
      <aside className={styles.sidebar}>
        <NavLink to="/" className={styles.brand} end>
          HousingChoice
        </NavLink>
        <div className={styles.nav}>
          {NAV_GROUPS.map((group) => (
            <nav key={group.label} className={styles.group} aria-label={group.label}>
              <span className={styles.groupLabel}>{group.label}</span>
              {group.items.map((item) => (
                <div key={item.to}>
                  <NavLeafLink item={item} />
                  {isNavParent(item) && (
                    <div className={styles.children}>
                      {item.children.map((child) => (
                        <NavLink key={child.to} to={child.to} className={childLinkClass}>
                          {child.dot ? (
                            <span className={`${styles.dot} ${DOT_CLASS[child.dot]}`} />
                          ) : null}
                          <span className={styles.linkLabel}>{child.label}</span>
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </nav>
          ))}
          <nav className={styles.footer} aria-label="Settings">
            <NavLeafLink item={NAV_FOOTER} />
          </nav>
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <AccountMenu email={me?.email ?? ''} role={me?.role ?? 'va'} onSignOut={handleSignOut} />
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
