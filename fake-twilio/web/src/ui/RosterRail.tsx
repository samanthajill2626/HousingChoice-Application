// RosterRail — the left rail of the fake-phones UI. Personas are grouped under
// role headings (Landlord / Tenant / PM / Staff / Unknown); each row is a button showing
// the persona label, its number, and an unread badge. Below the persona role
// groups, a "Group texts" section lists the traffic-inferred relay groups —
// one row per group (formatted pool number + member count + the same unread
// treatment), rendered only when groups exist. The selected row (persona OR
// group) is visually active and carries aria-current. A "＋ Ad-hoc number"
// button at the bottom opens the AdHocDialog (the parent owns that state).
// Pure presentational: all data + callbacks arrive as props.
import { formatPhoneDisplay } from '../lib/phone.js';
import type { GroupSnapshot, Persona, Role } from '../api/types.js';
import styles from './RosterRail.module.css';

export interface RosterRailProps {
  personas: Persona[];
  unreadByNumber: Record<string, number>;
  /** Selected party number, or null. */
  selected: string | null;
  onSelect: (partyNumber: string) => void;
  onAddAdHoc: () => void;
  // ---- "Group texts" section (all optional so non-group usage is unchanged) ----
  /** Traffic-inferred relay groups; the section renders only when non-empty. */
  groups?: GroupSnapshot[];
  /** Per-pool unread transcript-activity count (mirrors unreadByNumber). */
  groupUnreadByPool?: Record<string, number>;
  /** Selected group's pool number, or null. */
  selectedGroup?: string | null;
  onSelectGroup?: (poolNumber: string) => void;
}

// 'unknown' (auto-registered parties — an app send to an unregistered number)
// groups LAST. It must be in ROLE_ORDER: the grouping FILTERS by these roles, so
// omitting it would hide auto-registered phones from the rail entirely — the
// exact invisibility auto-registration exists to fix.
const ROLE_ORDER: ReadonlyArray<Role> = ['landlord', 'tenant', 'pm', 'staff', 'unknown'];
const ROLE_HEADING: Record<Role, string> = {
  landlord: 'Landlord',
  tenant: 'Tenant',
  pm: 'PM',
  staff: 'Staff',
  unknown: 'Unknown',
};

export function RosterRail({
  personas,
  unreadByNumber,
  selected,
  onSelect,
  onAddAdHoc,
  groups: relayGroups = [],
  groupUnreadByPool = {},
  selectedGroup = null,
  onSelectGroup,
}: RosterRailProps): React.JSX.Element {
  const groups = ROLE_ORDER.map((role) => ({
    role,
    items: personas.filter((p) => p.role === role),
  })).filter((g) => g.items.length > 0);

  return (
    <nav className={styles.rail} aria-label="Personas">
      <div className={styles.groups}>
        {groups.map(({ role, items }) => (
          <section key={role} className={styles.group}>
            <h2 className={styles.heading}>{ROLE_HEADING[role]}</h2>
            <ul className={styles.list}>
              {items.map((p) => {
                const unread = unreadByNumber[p.number] ?? 0;
                const isSelected = p.number === selected;
                const name =
                  unread > 0
                    ? `${p.label}, ${p.number}, ${unread} unread`
                    : `${p.label}, ${p.number}`;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`${styles.row} ${isSelected ? styles.selected : ''}`}
                      aria-label={name}
                      {...(isSelected && { 'aria-current': 'true' as const })}
                      onClick={() => onSelect(p.number)}
                    >
                      <span className={styles.rowText}>
                        <span className={styles.label}>{p.label}</span>
                        <span className={styles.number}>{p.number}</span>
                      </span>
                      {unread > 0 && (
                        <span className={styles.unread} aria-hidden="true">
                          {unread}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {relayGroups.length > 0 && (
          <section className={styles.group}>
            <h2 className={styles.heading}>Group texts</h2>
            <ul className={styles.list}>
              {relayGroups.map((g) => {
                const unread = groupUnreadByPool[g.poolNumber] ?? 0;
                const isSelected = g.poolNumber === selectedGroup;
                const pool = formatPhoneDisplay(g.poolNumber);
                const membersText = `${g.members.length} member${g.members.length === 1 ? '' : 's'}`;
                const name =
                  unread > 0
                    ? `Group ${pool}, ${membersText}, ${unread} unread`
                    : `Group ${pool}, ${membersText}`;
                return (
                  <li key={g.poolNumber}>
                    <button
                      type="button"
                      className={`${styles.row} ${isSelected ? styles.selected : ''}`}
                      aria-label={name}
                      {...(isSelected && { 'aria-current': 'true' as const })}
                      onClick={() => onSelectGroup?.(g.poolNumber)}
                    >
                      <span className={styles.rowText}>
                        <span className={styles.label}>{pool}</span>
                        <span className={styles.number}>{membersText}</span>
                      </span>
                      {unread > 0 && (
                        <span className={styles.unread} aria-hidden="true">
                          {unread}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      <button type="button" className={styles.adHoc} onClick={onAddAdHoc}>
        <span aria-hidden="true">＋</span> Ad-hoc number
      </button>
    </nav>
  );
}
