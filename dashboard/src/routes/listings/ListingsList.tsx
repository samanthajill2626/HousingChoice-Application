// ListingsList — the Listings list view (§IA: Workspace ▸ Listings). FIRST-PASS
// / pending-design: a clean, conventional, accessible records list (heading ·
// search box · a list of rows linking to the listing detail page) in the new
// design language (tokens + CSS Modules). Reuses the listing format helpers
// (shortAddress / statusLabel / formatBedsBaths / formatRent). Not the final
// visual design — deliberately low-risk.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { UnitItem } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import {
  formatBedsBaths,
  formatRent,
  shortAddress,
  statusLabel,
} from '../listing/listingFormat.js';
import { useListings } from './useListings.js';
import styles from './ListingsList.module.css';

function Row({ unit }: { unit: UnitItem }): React.JSX.Element {
  const address = shortAddress(unit.address, unit.unitId);
  const beds = formatBedsBaths(unit.beds, unit.baths);
  const rent = formatRent(unit.rent_min, unit.rent_max);
  return (
    <li className={styles.rowItem}>
      <Link to={`/listings/${unit.unitId}`} className={styles.row}>
        <span className={styles.address}>{address}</span>
        <span className={styles.badge}>{statusLabel(unit.status)}</span>
        {beds ? <span className={styles.beds}>{beds} bd/ba</span> : null}
        {rent ? <span className={styles.rent}>{rent}/mo</span> : null}
      </Link>
    </li>
  );
}

export function ListingsList(): React.JSX.Element {
  const { status, units } = useListings();
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return units;
    return units.filter((u) => shortAddress(u.address, u.unitId).toLowerCase().includes(q));
  }, [units, query]);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Listings</h1>
      <p className={styles.sub}>Showing the first page of unit records.</p>

      <div className={styles.search}>
        <label className={styles.searchLabel} htmlFor="listings-search">
          Search listings
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
          We couldn&apos;t load listings. Please try again.
        </p>
      ) : null}

      {status === 'ready' && units.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No listings yet</p>
          <p className={styles.emptyBody}>Nothing here to show right now.</p>
        </div>
      ) : null}

      {status === 'ready' && units.length > 0 ? (
        visible.length > 0 ? (
          <ul className={styles.rows} aria-label="Listings">
            {visible.map((unit) => (
              <Row key={unit.unitId} unit={unit} />
            ))}
          </ul>
        ) : (
          <p className={styles.noMatches}>No matches for &ldquo;{query.trim()}&rdquo;.</p>
        )
      ) : null}
    </div>
  );
}
