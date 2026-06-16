// RosterRail — the left rail of the fake-phones UI. Personas are grouped under
// role headings (Landlord / Tenant / PM / Staff); each row is a button showing
// the persona label, its number, and an unread badge. The selected row is
// visually active and carries aria-current. A "＋ Ad-hoc number" button at the
// bottom opens the AdHocDialog (the parent owns that state). Pure presentational:
// all data + callbacks arrive as props.
import type { Persona, Role } from '../api/types.js';
import styles from './RosterRail.module.css';

export interface RosterRailProps {
  personas: Persona[];
  unreadByNumber: Record<string, number>;
  /** Selected party number, or null. */
  selected: string | null;
  onSelect: (partyNumber: string) => void;
  onAddAdHoc: () => void;
}

const ROLE_ORDER: ReadonlyArray<Role> = ['landlord', 'tenant', 'pm', 'staff'];
const ROLE_HEADING: Record<Role, string> = {
  landlord: 'Landlord',
  tenant: 'Tenant',
  pm: 'PM',
  staff: 'Staff',
};

export function RosterRail({
  personas,
  unreadByNumber,
  selected,
  onSelect,
  onAddAdHoc,
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
      </div>
      <button type="button" className={styles.adHoc} onClick={onAddAdHoc}>
        <span aria-hidden="true">＋</span> Ad-hoc number
      </button>
    </nav>
  );
}
