// Units — the Properties list (route '/units', authenticated).
//
// A status filter (default: all) and a card list of units. Each row links to
// the unit detail. Built on the shared GET hook; "Load more" pages via the
// server cursor.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listUnits,
  useApi,
  type UnitItem,
  type UnitStatus,
} from '../api/index.js';
import { Badge, Button, EmptyState, Field, HomeIcon, PlusIcon, Spinner } from '../ui/index.js';
import { formatAddress } from './records/Address.js';
import {
  UNIT_STATUSES,
  UNIT_STATUS_LABEL,
  formatRentRange,
  unitSummaryLine,
} from './records/records.js';
import styles from './records/records.module.css';

const PAGE_LIMIT = 50;

const STATUS_TONE: Record<UnitStatus, 'success' | 'neutral' | 'warning'> = {
  available: 'success',
  placed: 'neutral',
  inactive: 'warning',
};

export default function Units(): React.JSX.Element {
  const [status, setStatus] = useState<'' | UnitStatus>('');

  const { data, loading, error, refetch } = useApi(
    (signal) => listUnits({ ...(status !== '' && { status }), limit: PAGE_LIMIT }, signal),
    [status],
  );

  // Cursor pagination on top of the first page.
  const [extra, setExtra] = useState<UnitItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (data) {
      setExtra([]);
      setCursor(data.nextCursor);
    }
  }, [data]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    listUnits({ ...(status !== '' && { status }), limit: PAGE_LIMIT, cursor })
      .then((page) => {
        setExtra((prev) => [...prev, ...page.units]);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        // Keep the cursor so the user can retry "Load more".
      })
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, status]);

  const units = [...(data?.units ?? []), ...extra];

  return (
    <section className={styles.page} aria-labelledby="units-heading">
      <header className={styles.header}>
        <div>
          <h1 id="units-heading">Properties</h1>
          <p className={styles.lead}>Available units and their placement status.</p>
        </div>
        <Button as="a" href="/units/new" size="sm">
          <PlusIcon size={16} />
          New property
        </Button>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <Field label="Status">
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={status}
                onChange={(e) => setStatus(e.target.value as '' | UnitStatus)}
              >
                <option value="">All statuses</option>
                {UNIT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {UNIT_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </div>

      {loading && data === undefined ? (
        <Spinner center label="Loading properties" />
      ) : error ? (
        <EmptyState
          icon={<HomeIcon size={28} />}
          title="Couldn't load properties"
          description="Something went wrong reaching the server."
          action={
            <Button variant="secondary" onClick={refetch}>
              Try again
            </Button>
          }
        />
      ) : units.length === 0 ? (
        <EmptyState
          icon={<HomeIcon size={28} />}
          title="No properties yet"
          description="Add a unit with New property to start tracking it."
        />
      ) : (
        <>
          <ul className={styles.list} aria-label="Properties">
            {units.map((u) => (
              <UnitRow key={u.unitId} unit={u} />
            ))}
          </ul>
          {cursor !== null && (
            <div className={styles.loadMore}>
              <Button variant="secondary" block loading={loadingMore} onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function UnitRow({ unit }: { unit: UnitItem }): React.JSX.Element {
  const rent = formatRentRange(unit.rent_min, unit.rent_max);
  const title = formatAddress(unit.address) ?? unit.jurisdiction ?? `Unit ${unit.unitId}`;

  return (
    <li>
      <Link to={`/units/${encodeURIComponent(unit.unitId)}`} className={styles.cardLink}>
        <div className={styles.rowHead}>
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{title}</span>
            <span className={styles.rowSub}>
              {unitSummaryLine(unit)}
              {rent !== undefined ? ` · ${rent}` : ''}
            </span>
          </div>
          <Badge tone={STATUS_TONE[unit.status]} dot>
            {UNIT_STATUS_LABEL[unit.status]}
          </Badge>
        </div>
      </Link>
    </li>
  );
}
