// NumbersSection - the admin-only "Group text numbers" inventory. A read-only
// table of every relay pool number: state, group counts, burn count, last
// activity / last-closed stamps, and a retirement countdown that MIRRORS the
// gated sweep exactly. Each number expands into its group history (newest first),
// every group linking to its conversation thread. Filter chips scope by lifecycle
// state - "Active" (active + releasing; the default), "Released", "All". No
// mutations: retirement stays the gated CLI sweep; the page only SHOWS what that
// sweep would consider so the two never disagree.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listPoolNumbers, type PoolNumberRow } from '../../api/index.js';
import { formatPhoneDisplay } from '../../lib/phone.js';
import { Button, Spinner } from '../../ui/index.js';
import styles from './NumbersSection.module.css';

type Status = 'loading' | 'ready' | 'error';
type StateFilter = 'active' | 'released' | 'all';

const FILTERS: { id: StateFilter; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'released', label: 'Released' },
  { id: 'all', label: 'All' },
];

/** The lifecycle states a filter reveals. "Active" pairs active + releasing so an
 *  in-flight release still shows under the default view (its State cell reads
 *  "releasing"); "Released" is release-only; "All" is unfiltered. */
function matchesFilter(n: PoolNumberRow, filter: StateFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'released') return n.state === 'released';
  return n.state === 'active' || n.state === 'releasing';
}

/** Local date formatter (the sibling Settings-table idiom); absent/invalid ->
 *  ASCII "-". The dashboard-wide em-dash placeholder is DELIBERATELY not used on
 *  this page (spec adjudication A10). */
function formatDate(iso: string | undefined): string {
  if (iso === undefined) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The Retirement cell copy (adjudication A9): eligible -> "Eligible"; counting
 *  down -> "<n>d remaining"; a released number -> "Released <date>"; otherwise
 *  "-" (open groups, never-hosted, or a "releasing" row). */
function retirementLabel(n: PoolNumberRow): string {
  if (n.retire.eligible) return 'Eligible';
  if (n.retire.daysRemaining !== undefined) return `${n.retire.daysRemaining}d remaining`;
  if (n.state === 'released') return `Released ${formatDate(n.releasedAt)}`;
  return '-';
}

/** Owns the inventory data: status + rows + retry, AbortController-guarded
 *  (the useTeam idiom; no react-query in this app). Read-only - no mutations. */
function usePoolNumbers(): { status: Status; numbers: PoolNumberRow[]; retry: () => void } {
  const [status, setStatus] = useState<Status>('loading');
  const [numbers, setNumbers] = useState<PoolNumberRow[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const rows = await listPoolNumbers(controller.signal);
      if (controller.signal.aborted) return;
      setNumbers(rows);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const retry = useCallback(() => {
    setStatus('loading');
    void load();
  }, [load]);

  return { status, numbers, retry };
}

// The data columns (excluding the leading expander control column). colSpan on
// the expanded detail row = COLUMN_COUNT + 1 (the expander column).
const COLUMN_COUNT = 8;

export function NumbersSection(): React.JSX.Element {
  const { status, numbers, retry } = usePoolNumbers();
  const [filter, setFilter] = useState<StateFilter>('active');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((number: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }, []);

  const visible = numbers.filter((n) => matchesFilter(n, filter));

  return (
    <section className={styles.section} aria-labelledby="numbers-heading">
      <h2 id="numbers-heading" className={styles.heading}>
        Group text numbers
      </h2>
      <p className={styles.lede}>
        Every relay number the pool holds - its usage history, burn count, and
        retirement eligibility. Read-only: retirement runs as the gated sweep.
      </p>

      {status === 'loading' ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : status === 'error' ? (
        <div role="alert" className={styles.errorBlock}>
          <p>Couldn't load the group text numbers.</p>
          <Button variant="secondary" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : numbers.length === 0 ? (
        <p className={styles.empty}>No group text numbers yet - a number is provisioned with the first group text.</p>
      ) : (
        <>
          <div className={styles.chips} role="group" aria-label="Filter by state">
            {FILTERS.map((f) => {
              const isActive = filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`${styles.chip} ${isActive ? styles.chipActive : ''}`.trim()}
                  aria-pressed={isActive}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          {visible.length === 0 ? (
            <p className={styles.empty}>No group text numbers match this filter.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th} scope="col">
                      <span className={styles.srOnly}>Groups</span>
                    </th>
                    <th className={styles.th} scope="col">
                      Number
                    </th>
                    <th className={styles.th} scope="col">
                      State
                    </th>
                    <th className={styles.th} scope="col">
                      Open groups
                    </th>
                    <th className={styles.th} scope="col">
                      Total groups
                    </th>
                    <th className={styles.th} scope="col">
                      People burned
                    </th>
                    <th className={styles.th} scope="col">
                      Last activity
                    </th>
                    <th className={styles.th} scope="col">
                      Last closed
                    </th>
                    <th className={styles.th} scope="col">
                      Retirement
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((n) => {
                    const isOpen = expanded.has(n.number);
                    const formatted = formatPhoneDisplay(n.number);
                    const detailId = `pool-groups-${n.number}`;
                    return (
                      <Fragment key={n.number}>
                        <tr>
                          <td className={styles.cell}>
                            <button
                              type="button"
                              className={styles.expander}
                              aria-expanded={isOpen}
                              aria-controls={detailId}
                              aria-label={`${isOpen ? 'Hide' : 'Show'} groups for ${formatted}`}
                              onClick={() => toggle(n.number)}
                            >
                              <span aria-hidden="true">{isOpen ? 'v' : '>'}</span>
                            </button>
                          </td>
                          <td className={styles.cell}>
                            <span className={styles.number}>{formatted}</span>
                          </td>
                          <td className={styles.cell}>{n.state}</td>
                          <td className={styles.cell}>{n.openGroups}</td>
                          <td className={styles.cell}>{n.totalGroups}</td>
                          <td className={styles.cell}>{n.burnedCount}</td>
                          <td className={styles.cell}>{formatDate(n.lastActivityAt)}</td>
                          <td className={styles.cell}>{formatDate(n.lastGroupClosedAt)}</td>
                          <td className={styles.cell}>{retirementLabel(n)}</td>
                        </tr>
                        {isOpen ? (
                          <tr>
                            <td className={styles.detailCell} colSpan={COLUMN_COUNT + 1} id={detailId}>
                              {n.groups.length === 0 ? (
                                <p className={styles.detailEmpty}>No groups on this number yet.</p>
                              ) : (
                                <ul className={styles.groupList}>
                                  {n.groups.map((g) => (
                                    <li key={g.conversationId} className={styles.groupRow}>
                                      <Link
                                        className={styles.groupLink}
                                        to={`/conversations/${encodeURIComponent(g.conversationId)}`}
                                      >
                                        {g.label}
                                      </Link>
                                      <span className={styles.groupMeta}>
                                        {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}
                                      </span>
                                      <span className={styles.groupMeta}>{g.status}</span>
                                      <span className={styles.groupMeta}>Opened {formatDate(g.createdAt)}</span>
                                      <span className={styles.groupMeta}>Closed {formatDate(g.closedAt)}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
