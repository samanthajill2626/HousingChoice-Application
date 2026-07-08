// PhaseFilter - the placements page's filter: All active / each phase / Closed,
// each with a live count. ONE component, TWO layouts (CSS only): a vertical rail
// on desktop, a horizontally scrollable chip strip under the search box on
// mobile (max-width: 767.98px). Entries are Links (the filter lives in the URL);
// the selected entry carries aria-current.
import { Link } from 'react-router-dom';
import { PLACEMENT_PHASES } from '../../api/index.js';
import { filterSearch, type LedgerCounts, type LedgerFilter } from './pageModel.js';
import styles from './PhaseFilter.module.css';

export interface PhaseFilterProps {
  counts: LedgerCounts;
  filter: LedgerFilter;
}

interface Entry {
  key: string;
  label: string;
  count: number;
  to: string;
  selected: boolean;
  muted?: boolean;
}

export function PhaseFilter({ counts, filter }: PhaseFilterProps): React.JSX.Element {
  const entries: Entry[] = [
    {
      key: 'all',
      label: 'All active',
      count: counts.all,
      to: '/placements',
      selected: filter.kind === 'all',
    },
    ...PLACEMENT_PHASES.map((phase) => ({
      key: phase,
      label: phase,
      count: counts.byPhase[phase],
      to: `/placements${filterSearch({ kind: 'phase', phase })}`,
      selected: filter.kind === 'phase' && filter.phase === phase,
    })),
    {
      key: 'closed',
      label: 'Closed',
      count: counts.closed,
      to: `/placements${filterSearch({ kind: 'closed' })}`,
      selected: filter.kind === 'closed',
      muted: true,
    },
  ];

  return (
    <nav className={styles.nav} aria-label="Placement phases">
      <ul className={styles.list}>
        {entries.map((e) => (
          <li key={e.key} className={e.muted ? styles.mutedItem : undefined}>
            <Link
              className={`${styles.entry} ${e.selected ? styles.selected : ''} ${e.muted ? styles.muted : ''}`}
              to={e.to}
              {...(e.selected && { 'aria-current': 'true' as const })}
            >
              <span className={styles.label}>{e.label}</span>
              <span className={styles.count}>{e.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
