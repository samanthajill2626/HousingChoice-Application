// ListingsList — the Listings list view (§IA: Workspace ▸ Listings). FIRST-PASS
// / pending-design: a clean, conventional, accessible records list (heading -
// search box - a list of rows linking to the listing detail page) in the new
// design language (tokens + CSS Modules). Reuses the listing format helpers
// (shortAddress / statusLabel / formatBedsBaths / formatRent). Not the final
// visual design — deliberately low-risk.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  LISTING_STATUSES,
  LISTING_STATUS_LABELS,
  type UnitItem,
  type UnitStatus,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import {
  formatBedsBaths,
  formatRent,
  shortAddress,
  statusLabel,
} from '../listing/listingFormat.js';
import { UnitCreateForm } from '../listing/UnitCreateForm.js';
import { useListings } from './useListings.js';
import styles from './ListingsList.module.css';

type StatusFilter = UnitStatus | 'all';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  ...LISTING_STATUSES.map((s) => ({ value: s, label: LISTING_STATUS_LABELS[s] })),
];

/** Humanize a jurisdiction slug for the filter chips: tokens ≤3 chars become
 *  acronyms, longer ones are title-cased — 'atlanta_housing' → "Atlanta Housing",
 *  'ga_dca' → "GA DCA". */
function humanizeAuthority(slug: string): string {
  return slug
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : `${w[0]!.toUpperCase()}${w.slice(1)}`))
    .join(' ');
}

function Row({ unit }: { unit: UnitItem }): React.JSX.Element {
  const address = shortAddress(unit.address, unit.unitId);
  const beds = formatBedsBaths(unit.beds, unit.baths);
  const rent = formatRent(unit.rent_min, unit.rent_max);
  return (
    <li className={styles.rowItem}>
      <Link to={`/listings/${unit.unitId}`} className={styles.row}>
        <span className={styles.address}>{address}</span>
        {/* Meta chips grouped so on a tight content pane they wrap to their own
         *  line below the address instead of crushing it (container query in CSS). */}
        <span className={styles.meta}>
          <span className={styles.badge}>{statusLabel(unit.status)}</span>
          {beds ? <span className={styles.beds}>{beds} bd/ba</span> : null}
          {rent ? <span className={styles.rent}>{rent}/mo</span> : null}
        </span>
      </Link>
    </li>
  );
}

export interface ListingsListProps {
  /** The "Deleted" view (soft-deleted listings) vs the normal active list. */
  deleted?: boolean;
}

/** Active / Deleted view tabs. Links to the two routes so the URL is the source
 *  of truth (mirrors the Contacts list's filter tabs). */
const VIEW_TABS: { deleted: boolean; label: string; to: string }[] = [
  { deleted: false, label: 'Active', to: '/listings' },
  { deleted: true, label: 'Deleted', to: '/listings/deleted' },
];

export function ListingsList({ deleted = false }: ListingsListProps): React.JSX.Element {
  const navigate = useNavigate();
  const { status, units } = useListings(deleted);
  // The "New property" dialog (Active view only) with an empty landlord picker.
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Multi-select of housing authorities (unit.jurisdiction). EMPTY = no filter →
  // show every authority (the "cleared" state).
  const [selectedHAs, setSelectedHAs] = useState<Set<string>>(new Set());

  // The housing authorities present in the loaded listings — the multi-select
  // options (distinct `jurisdiction` values, sorted).
  const housingAuthorities = useMemo(() => {
    const set = new Set<string>();
    for (const u of units) {
      if (typeof u.jurisdiction === 'string' && u.jurisdiction) set.add(u.jurisdiction);
    }
    return [...set].sort();
  }, [units]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return units.filter((u) => {
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (
        selectedHAs.size > 0 &&
        !(typeof u.jurisdiction === 'string' && selectedHAs.has(u.jurisdiction))
      ) {
        return false;
      }
      if (q && !shortAddress(u.address, u.unitId).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [units, query, statusFilter, selectedHAs]);

  const toggleHA = (ha: string): void =>
    setSelectedHAs((prev) => {
      const next = new Set(prev);
      if (next.has(ha)) next.delete(ha);
      else next.add(ha);
      return next;
    });

  const showControls = status === 'ready' && units.length > 0;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{deleted ? 'Deleted properties' : 'Properties'}</h1>
        {!deleted ? (
          <Button variant="primary" size="sm" type="button" onClick={() => setCreating(true)}>
            + New property
          </Button>
        ) : null}
      </div>
      <p className={styles.sub}>
        {deleted
          ? 'Soft-deleted properties. Open one to restore it.'
          : 'Showing the first page of unit records.'}
      </p>

      <nav className={styles.tabs} aria-label="Properties view">
        {VIEW_TABS.map((t) => (
          <Link
            key={t.label}
            to={t.to}
            className={`${styles.tab} ${t.deleted === deleted ? styles.tabActive : ''}`}
            {...(t.deleted === deleted && { 'aria-current': 'page' })}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {showControls ? (
        <div className={styles.controls}>
          <div className={styles.control}>
            <label className={styles.controlLabel} htmlFor="listings-status">
              Status
            </label>
            <select
              id="listings-status"
              className={styles.select}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {housingAuthorities.length > 0 ? (
            <div className={styles.control}>
              <span className={styles.controlLabel} id="ha-filter-label">
                Housing authority
              </span>
              <div className={styles.chips} role="group" aria-labelledby="ha-filter-label">
                {housingAuthorities.map((ha) => {
                  const on = selectedHAs.has(ha);
                  return (
                    <button
                      key={ha}
                      type="button"
                      className={`${styles.chip} ${on ? styles.chipOn : ''}`}
                      aria-pressed={on}
                      onClick={() => toggleHA(ha)}
                    >
                      {humanizeAuthority(ha)}
                    </button>
                  );
                })}
                {selectedHAs.size > 0 ? (
                  <button
                    type="button"
                    className={styles.clear}
                    onClick={() => setSelectedHAs(new Set())}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={styles.search}>
        <label className={styles.searchLabel} htmlFor="listings-search">
          Search properties
        </label>
        <input
          id="listings-search"
          type="search"
          className={styles.searchInput}
          placeholder="Search by address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={status !== 'ready'}
        />
      </div>

      {status === 'loading' ? <Spinner center /> : null}

      {status === 'error' ? (
        <p className={styles.error} role="alert">
          We couldn&apos;t load properties. Please try again.
        </p>
      ) : null}

      {status === 'ready' && units.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{deleted ? 'No deleted properties' : 'No properties yet'}</p>
          <p className={styles.emptyBody}>
            {deleted ? 'Deleted properties will appear here.' : 'Nothing here to show right now.'}
          </p>
        </div>
      ) : null}

      {status === 'ready' && units.length > 0 ? (
        visible.length > 0 ? (
          <ul className={styles.rows} aria-label="Properties">
            {visible.map((unit) => (
              <Row key={unit.unitId} unit={unit} />
            ))}
          </ul>
        ) : (
          <p className={styles.noMatches}>
            {query.trim()
              ? `No matches for “${query.trim()}”.`
              : 'No properties match the selected filters.'}
          </p>
        )
      ) : null}

      {creating ? (
        <UnitCreateForm
          onClose={() => setCreating(false)}
          onCreated={(u) => {
            setCreating(false);
            void navigate('/listings/' + u.unitId);
          }}
        />
      ) : null}
    </div>
  );
}
