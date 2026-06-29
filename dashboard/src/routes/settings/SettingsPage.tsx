// SettingsPage — the tab shell for the Settings surface. Role-aware (reads
// useAuth().isAdmin → visibleTabs), responsive (a wrapping tab row on desktop;
// a labeled section <select> below the nav breakpoint), and renders the routed
// section via <Outlet/>. One source of truth for the tab model (settingsTabs).
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../app/AuthContext.js';
import { useIsMobile } from './useIsMobile.js';
import { visibleTabs } from './settingsTabs.js';
import styles from './SettingsPage.module.css';

export function SettingsPage(): React.JSX.Element {
  const { isAdmin } = useAuth();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();

  const tabs = visibleTabs(isAdmin);
  // The active tab = the one whose path prefixes the current pathname (so a
  // nested/deep path still highlights its tab). Falls back to the first tab.
  const active = tabs.find((t) => location.pathname.startsWith(t.path)) ?? tabs[0];

  return (
    <section className={styles.page}>
      <h1 className={styles.heading}>Settings</h1>

      {isMobile ? (
        <label className={styles.mobileSelect}>
          <span className={styles.srOnly}>Settings section</span>
          <select
            aria-label="Settings section"
            className={styles.select}
            value={active?.path ?? ''}
            onChange={(e) => navigate(e.target.value)}
          >
            {tabs.map((tab) => (
              <option key={tab.id} value={tab.path}>
                {tab.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div role="tablist" aria-label="Settings sections" className={styles.tabs}>
          {tabs.map((tab) => (
            <NavLink
              key={tab.id}
              to={tab.path}
              role="tab"
              aria-selected={active?.id === tab.id}
              className={({ isActive }) =>
                `${styles.tab} ${isActive ? styles.tabActive : ''}`.trim()
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>
      )}

      <div className={styles.panel}>
        <Outlet />
      </div>
    </section>
  );
}
