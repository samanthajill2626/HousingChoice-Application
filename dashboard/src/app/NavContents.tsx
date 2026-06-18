// NavContents — the nav body (the two groups + the Settings footer), rendered
// from the LOCKED nav model (app/nav.ts). One source of truth shared by BOTH the
// desktop sidebar and the mobile drawer, so the IA can never drift between them.
//
// The rail treatment is ENTIRELY CSS, scoped to `.sidebar.collapsed` (hiding
// labels, centering icons, hover-label tooltips, turning Contacts' children into
// a flyout), so this component is mode-agnostic and the drawer reuses it verbatim.
// Each link keeps an explicit `aria-label` so its name survives even when the
// visible label is a hover-only tooltip in the rail.
//
// `onNavigate` lets the drawer close itself when a link is tapped.
import { NavLink } from 'react-router-dom';
import { NAV_ICONS } from '../ui/icons.js';
import { useUnread } from './UnreadContext.js';
import { NAV_FOOTER, NAV_GROUPS, isNavParent, type NavLeaf } from './nav.js';
import styles from './AppFrame.module.css';

const DOT_CLASS: Record<NonNullable<NavLeaf['dot']>, string> = {
  tenant: styles.dotTenant ?? '',
  landlord: styles.dotLandlord ?? '',
  unknown: styles.dotUnknown ?? '',
};

function linkClass({ isActive }: { isActive: boolean }): string {
  return `${styles.link} ${isActive ? styles.linkActive : ''}`;
}

function childLinkClass({ isActive }: { isActive: boolean }): string {
  return `${styles.link} ${styles.childLink} ${isActive ? styles.linkActive : ''}`;
}

function NavLeafLink({
  item,
  onNavigate,
}: {
  item: NavLeaf;
  onNavigate?: () => void;
}): React.JSX.Element {
  const Icon = item.icon ? NAV_ICONS[item.icon] : undefined;
  const { unread } = useUnread();
  const badge = item.badge === 'inbox-unread' && unread !== null && unread > 0 ? unread : null;
  return (
    <div className={styles.linkRow}>
      <NavLink
        to={item.to}
        end={item.end ?? false}
        className={linkClass}
        aria-label={item.label}
        {...(onNavigate && { onClick: onNavigate })}
      >
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

export function NavContents({
  onNavigate,
}: {
  onNavigate?: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.nav}>
      {NAV_GROUPS.map((group) => (
        <nav key={group.label} className={styles.group} aria-label={group.label}>
          <span className={styles.groupLabel}>{group.label}</span>
          {group.items.map((item) => (
            // `parent` anchors the rail flyout for a parent's children (CSS turns
            // .children into an absolutely-positioned panel under .sidebar.collapsed).
            <div key={item.to} className={isNavParent(item) ? styles.parent : undefined}>
              <NavLeafLink item={item} onNavigate={onNavigate} />
              {isNavParent(item) && (
                <div className={styles.children}>
                  {item.children.map((child) => (
                    <NavLink
                      key={child.to}
                      to={child.to}
                      className={childLinkClass}
                      {...(onNavigate && { onClick: onNavigate })}
                    >
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
        <NavLeafLink item={NAV_FOOTER} {...(onNavigate && { onNavigate })} />
      </nav>
    </div>
  );
}
