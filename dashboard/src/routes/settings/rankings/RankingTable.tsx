// RankingTable - the ranking read (WP1 B2a spec D9) as a plain table: a test
// surface for the engine (spec D18); B3 builds the real ranked row. Rows are
// in the server's order (band, score, ... spec D9) and are never re-sorted.
import type { RankingAnchorKind, RankingReason, RankingRowView } from '../../../api/index.js';
import { NOT_RANKED_YET, NOT_SCORED, bandLabel, cappedText, outOfDateText, reasonsText } from './rankingFormat.js';
import styles from './RankingsSection.module.css';

function Reasons({ label, reasons }: { label: string; reasons: RankingReason[] }): React.JSX.Element | null {
  if (reasons.length === 0) return null;
  return (
    <p className={styles.reasons}>
      <span className={styles.reasonLabel}>{label}:</span> {reasonsText(reasons)}
    </p>
  );
}

function RankingRow({ row }: { row: RankingRowView }): React.JSX.Element {
  const match = row.match;
  if (match === null) {
    return (
      <tr>
        <th scope="row">{row.display}</th>
        <td colSpan={6}>{row.notScored ? NOT_SCORED : NOT_RANKED_YET}</td>
      </tr>
    );
  }
  return (
    <tr>
      <th scope="row">{row.display}</th>
      <td>{bandLabel(match.band)}</td>
      <td>{match.score}</td>
      <td>{cappedText(match.capped)}</td>
      <td>{outOfDateText(match.outOfDate)}</td>
      <td>
        <Reasons label="For" reasons={match.for} />
        <Reasons label="Against" reasons={match.against} />
      </td>
      <td>{match.missing.length === 0 ? '-' : match.missing.map((item) => item.text).join(', ')}</td>
    </tr>
  );
}

export function RankingTable({ rows, anchorKind }: { rows: RankingRowView[]; anchorKind: RankingAnchorKind }): React.JSX.Element {
  if (rows.length === 0) return <p className={styles.empty}>No candidates are in this pool.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label="Ranking">
        <thead>
          <tr>
            <th scope="col">{anchorKind === 'unit' ? 'Tenant' : 'Property'}</th>
            <th scope="col">Band</th>
            <th scope="col">Score</th>
            <th scope="col">Capped</th>
            <th scope="col">Out of date</th>
            <th scope="col">Reasons</th>
            <th scope="col">Missing</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <RankingRow key={row.candidateId} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
