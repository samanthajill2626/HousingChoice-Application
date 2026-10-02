// AuthoritySummary - the Properties page's by-housing-authority summary (Active
// tab only; tracker #1, docs/superpowers/specs/
// 2026-10-01-properties-available-view-design.md). Sam's old dashboard opened
// with exactly this breakdown: how many properties each authority has available
// now and coming soon. Pure presentation - unitListFacets computes the counts
// and ListingsList decides where each count links and what a click applies.
//
// A real <table> (caption + column and row headers) so a screen reader hears
// "DCA, Available, 4". Every non-zero count is a link that filters the list to
// exactly the properties it counted; a zero is plain text, since a link to
// nothing is dead UI.
import type { MouseEvent } from 'react';
import { Link, type To } from 'react-router-dom';
import { NONE_KEY } from '../contacts/tenantFacets.js';
import type { AuthoritySummaryModel, SummaryCounts } from './unitListFacets.js';
import styles from './AuthoritySummary.module.css';

export interface AuthoritySummaryProps {
  summary: AuthoritySummaryModel;
  /** Where one count links: that column's status and that authority
   *  (`null` = the All row, which clears the authority filter). */
  linkFor: (column: keyof SummaryCounts, key: string | null) => To;
  /** Applies the same selection IN PLACE on a plain left click, so the list
   *  follows the click even when the router turns a same-URL link into a
   *  REPLACE (which ListingsList does not read back). */
  onCount: (column: keyof SummaryCounts, key: string | null) => void;
}

/** How each column reads inside a count's accessible name. */
const COLUMN_WORD: Record<keyof SummaryCounts, string> = {
  available: 'available',
  comingSoon: 'coming soon',
};

/** The end of a count's accessible name: which authority it counts. */
function scopePhrase(key: string | null, label: string): string {
  if (key === null) return 'for all authorities';
  if (key === NONE_KEY) return 'with no housing authority recorded';
  return `for ${label}`;
}

/** The router's own test for "this click navigates in place": a plain primary
 *  click. A modified or middle click opens elsewhere and must change nothing here. */
function isPlainLeftClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey;
}

function CountCell({
  count,
  column,
  rowKey,
  label,
  linkFor,
  onCount,
}: {
  count: number;
  column: keyof SummaryCounts;
  rowKey: string | null;
  label: string;
  linkFor: AuthoritySummaryProps['linkFor'];
  onCount: AuthoritySummaryProps['onCount'];
}): React.JSX.Element {
  if (count === 0) return <td className={`${styles.num} ${styles.zero}`}>0</td>;
  const noun = count === 1 ? 'property' : 'properties';
  return (
    <td className={styles.num}>
      <Link
        to={linkFor(column, rowKey)}
        className={styles.count}
        // The visible text is the bare number; the name says what it opens
        // (and still contains the number, so voice control can say it).
        aria-label={`Show ${count} ${COLUMN_WORD[column]} ${noun} ${scopePhrase(rowKey, label)}`}
        onClick={(e) => {
          if (isPlainLeftClick(e)) onCount(column, rowKey);
        }}
      >
        {count}
      </Link>
    </td>
  );
}

export function AuthoritySummary({ summary, linkFor, onCount }: AuthoritySummaryProps): React.JSX.Element {
  const rows: Array<SummaryCounts & { key: string | null; label: string }> = [
    { key: null, label: 'All authorities', ...summary.all },
    ...summary.rows,
  ];
  const excluded = summary.unrecordedExcluded;
  return (
    <div className={styles.summary}>
      <table className={styles.table}>
        <caption className={styles.caption}>By housing authority</caption>
        <thead>
          <tr>
            <th scope="col">Housing authority</th>
            <th scope="col" className={styles.num}>
              Available
            </th>
            <th scope="col" className={styles.num}>
              Coming soon (Setup)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key ?? '__all__'} className={row.key === null ? styles.allRow : undefined}>
              <th scope="row" className={styles.authority}>
                {row.label}
              </th>
              <CountCell
                count={row.available}
                column="available"
                rowKey={row.key}
                label={row.label}
                linkFor={linkFor}
                onCount={onCount}
              />
              <CountCell
                count={row.comingSoon}
                column="comingSoon"
                rowKey={row.key}
                label={row.label}
                linkFor={linkFor}
                onCount={onCount}
              />
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.note}>A property that accepts several housing authorities counts under each.</p>
      {/* A size filter must not shrink the counts silently: say how many
       *  properties it left out only because nobody recorded their size. */}
      {excluded > 0 ? (
        <p className={styles.note}>
          {excluded === 1
            ? '1 property has no voucher size recorded and is not counted.'
            : `${excluded} properties have no voucher size recorded and are not counted.`}
        </p>
      ) : null}
    </div>
  );
}
