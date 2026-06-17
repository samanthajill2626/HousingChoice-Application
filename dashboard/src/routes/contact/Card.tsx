// Card + PendingPanel — the file-pane building blocks shared by TenantFile and
// LandlordFile. A Card is a stacked white section with an uppercase heading and
// an optional right-aligned action/count slot. PendingPanel is the honest
// "arrives with the backend" empty state for the C4/C5 slices (listings-sent /
// media) and the manual-now preferences — we never fabricate data.
import { Link } from 'react-router-dom';
import styles from './Card.module.css';

export interface CardProps {
  title: string;
  /** Right-aligned slot: an Edit affordance or a count chip. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}

export function Card({ title, aside, children }: CardProps): React.JSX.Element {
  return (
    <section className={styles.card}>
      <h3 className={styles.heading}>
        {title}
        {aside !== undefined ? <span className={styles.aside}>{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** A small muted "pending backend" state for panels whose data arrives with a
 *  backend slice that isn't live yet. */
export function PendingPanel({ note }: { note?: string }): React.JSX.Element {
  return (
    <p className={styles.pending}>{note ?? 'Arrives with the backend.'}</p>
  );
}

/** A muted "nothing here" state for a real-but-empty panel. */
export function EmptyRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className={styles.empty}>{children}</p>;
}

/** A key/value detail row (the Details card). */
export function KV({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <div className={styles.kv}>
      <span className={styles.k}>{k}</span>
      <span className={styles.v}>{v}</span>
    </div>
  );
}

export interface RowProps {
  /** When set, the whole row becomes a link to this route. */
  to?: string;
  label: React.ReactNode;
  /** Right-aligned status / response slot. */
  right?: React.ReactNode;
}

/** A list row (a case / tour / listing / listings-sent entry). Links out when
 *  `to` is set. */
export function Row({ to, label, right }: RowProps): React.JSX.Element {
  const inner = (
    <>
      <span className={styles.liLabel}>{label}</span>
      {right !== undefined ? <span className={styles.liRight}>{right}</span> : null}
    </>
  );
  return to ? (
    <Link className={styles.li} to={to}>
      {inner}
    </Link>
  ) : (
    <div className={styles.li}>{inner}</div>
  );
}

/** A wrapping row of preference / note chips. */
export function Chips({ items }: { items: string[] }): React.JSX.Element {
  return (
    <div className={styles.chips}>
      {items.map((c) => (
        <span key={c} className={styles.chip}>
          {c}
        </span>
      ))}
    </div>
  );
}

/** The CSS-module class for a response/status word, so callers can color a
 *  👍/👎/⏳ or availability label without importing the module. */
export const responseClass = {
  yes: styles.yes ?? '',
  no: styles.no ?? '',
  wait: styles.wait ?? '',
  muted: styles.muted ?? '',
  available: styles.statusAvailable ?? '',
  placed: styles.statusPlaced ?? '',
  inactive: styles.statusInactive ?? '',
};
