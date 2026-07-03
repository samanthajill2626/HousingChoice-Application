// Today — the home action queue (§B1). Renders the prioritized, entity-anchored
// queue from useToday() as grouped sections of white row cards (who · why · an
// optional red urgency chip · a "Placement · Touring"-style tag · an amber attention
// dot), each row a link to its placement/contact/conversation. Empty groups are
// skipped; loading shows a Spinner, error an inline message, all-empty a
// friendly "all caught up" state. Matches the locked mockup structure in the new
// design language (tokens + CSS Modules).
import { Link } from 'react-router-dom';
import type { TodayGroup, TodayItem } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { useToday } from './useToday.js';
import styles from './Today.module.css';

/** Human heading per group, in canonical display order. */
const GROUP_META: { group: TodayGroup; label: string }[] = [
  { group: 'needs_you_now', label: 'Needs you now' },
  { group: 'tours_today', label: 'Tours today' },
  { group: 'unreplied', label: 'Unreplied' },
  { group: 'follow_ups', label: 'Follow-ups due' },
];

/** The deep-link target for a row, driven by its refType. The contact +
 *  conversation routes are placeholders for now (B2+) — that's expected. */
function hrefFor(item: TodayItem): string {
  switch (item.refType) {
    case 'placement':
      return `/placements/${item.refId}`;
    case 'contact':
      return `/contacts/${item.refId}`;
    case 'conversation':
      return `/conversations/${item.refId}`;
    case 'tour':
      return `/tours/${item.refId}`;
  }
}

function Row({ item }: { item: TodayItem }): React.JSX.Element {
  const hasMeta = Boolean(item.urgency) || Boolean(item.tag);
  return (
    <li className={styles.rowItem}>
      <Link to={hrefFor(item)} className={styles.row}>
        {item.attention ? <span className={styles.dot} aria-label="Needs attention" /> : null}
        {/* Text block (who · why). On a tight content pane it stacks above the meta
         *  chips (container query in the CSS) so the "why" never gets crushed. */}
        <span className={styles.main}>
          <span className={styles.who}>{item.who}</span>
          <span className={styles.why}>{item.why}</span>
        </span>
        {hasMeta ? (
          <span className={styles.meta}>
            {item.urgency ? <span className={styles.urg}>{item.urgency}</span> : null}
            {item.tag ? <span className={styles.tag}>{item.tag}</span> : null}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export function Today(): React.JSX.Element {
  const { status, items } = useToday();

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Today</h1>
      <p className={styles.sub}>What needs you, across every placement and contact.</p>

      {status === 'loading' ? <Spinner center /> : null}

      {status === 'error' ? (
        <p className={styles.error} role="alert">
          We couldn&apos;t load your queue. Please try again.
        </p>
      ) : null}

      {status === 'ready' && items.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>All caught up</p>
          <p className={styles.emptyBody}>Nothing needs you right now.</p>
        </div>
      ) : null}

      {status === 'ready' && items.length > 0
        ? GROUP_META.map(({ group, label }) => {
            const rows = items.filter((i) => i.group === group);
            if (rows.length === 0) return null;
            return (
              <section key={group} className={styles.group}>
                <h2 className={styles.groupHeading}>
                  {label}
                  <span className={styles.count}>{rows.length}</span>
                </h2>
                <ul className={styles.rows} aria-label={label}>
                  {rows.map((item) => (
                    <Row key={`${item.refType}:${item.refId}`} item={item} />
                  ))}
                </ul>
              </section>
            );
          })
        : null}
    </div>
  );
}
