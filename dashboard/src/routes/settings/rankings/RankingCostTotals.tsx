// RankingCostTotals - ranking spend by ISO week and environment (WP1 B2a
// spec D11, D18), with this deployment's environment name above the list.
import type { RankingCostResponse } from '../../../api/index.js';
import { Spinner } from '../../../ui/index.js';
import { formatCost } from './rankingFormat.js';
import styles from './RankingsSection.module.css';

/** The range the server totals when a bound is missing (plan PR34, plan
 *  review R2B6; S6 round 2): no bound is the last 12 ISO weeks; `to` alone
 *  is the 12 ISO weeks ending with `to`'s week; `from` alone reads through
 *  today. Both bounds set: no note (the inputs say it). */
export function costRangeNote(from: string | undefined, to: string | undefined): string | undefined {
  if (from !== undefined && to !== undefined) return undefined;
  if (from !== undefined) return `From ${from} through today.`;
  return to === undefined ? 'The last 12 weeks.' : `The 12 weeks ending the week of ${to}.`;
}

export function RankingCostTotals({
  cost,
  status,
  rangeNote,
  onRetry,
}: {
  cost: RankingCostResponse | undefined;
  status: 'loading' | 'ready' | 'error';
  /** costRangeNote's text, or undefined when the staff member set `from`. */
  rangeNote: string | undefined;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <section className={styles.panel} aria-label="Cost by week">
      <h3 className={styles.panelHeading}>Cost by week</h3>
      {status === 'loading' ? <Spinner center label="Loading cost totals" /> : null}
      {status === 'error' ? (
        <div className={styles.error} role="alert">
          <p>We could not load the cost totals.</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      {status === 'ready' && cost !== undefined ? (
        <>
          <p className={styles.note}>Environment: {cost.environment}</p>
          {rangeNote !== undefined ? <p className={styles.note}>{rangeNote}</p> : null}
          {cost.incomplete === true ? <p className={styles.note}>Some runs could not be read; totals may be low</p> : null}
          {cost.weeks.length === 0 ? (
            <p className={styles.empty}>No ranking cost in this range.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} aria-label="Weekly ranking cost">
                <thead>
                  <tr>
                    <th scope="col">Week</th>
                    <th scope="col">Environment</th>
                    <th scope="col">Runs</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {cost.weeks.map((week) => (
                    <tr key={`${week.week}#${week.environment}`}>
                      <td>{week.week}</td>
                      <td>{week.environment}</td>
                      <td>{week.runs}</td>
                      <td>{formatCost(week.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
