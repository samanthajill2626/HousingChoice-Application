// AuthoritySummary - the Properties page's by-housing-authority summary (Active
// tab only; tracker #1, docs/superpowers/specs/
// 2026-10-01-properties-available-view-design.md). Sam's old dashboard opened
// with exactly this breakdown: how many properties each authority has available
// now and coming soon. Pure presentation - unitListFacets computes the counts
// and ListingsList decides where each count links (a click is an ordinary
// navigation, which ListingsList adopts from the URL it lands on).
//
// A real <table> (caption + column and row headers) so a screen reader hears
// "DCA, Available, 4". Every non-zero count is a link that filters the list to
// exactly the properties it counted; a zero is plain text, since a link to
// nothing is dead UI.
import { Link, type To } from 'react-router-dom';
import { NONE_KEY } from '../contacts/tenantFacets.js';
import type { AuthoritySummaryModel, SummaryCounts } from './unitListFacets.js';
import styles from './AuthoritySummary.module.css';

export interface AuthoritySummaryProps {
  summary: AuthoritySummaryModel;
  /** Where one count links: that column's status and that authority
   *  (`null` = the All row, which clears the authority filter). */
  linkFor: (column: keyof SummaryCounts, key: string | null) => To;
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

function CountCell({
  count,
  column,
  rowKey,
  label,
  linkFor,
}: {
  count: number;
  column: keyof SummaryCounts;
  rowKey: string | null;
  label: string;
  linkFor: AuthoritySummaryProps['linkFor'];
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
      >
        {count}
      </Link>
    </td>
  );
}

export function AuthoritySummary({ summary, linkFor }: AuthoritySummaryProps): React.JSX.Element {
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
              />
              <CountCell
                count={row.comingSoon}
                column="comingSoon"
                rowKey={row.key}
                label={row.label}
                linkFor={linkFor}
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
