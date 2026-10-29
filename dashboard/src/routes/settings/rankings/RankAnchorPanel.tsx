// RankAnchorPanel - "Rank this anchor" (WP1 B2a spec D18): pick a property or
// a tenant with the existing search fields, choose the window for a
// property, press Rank, then follow the job per batch and read the ranking
// as a plain table. A test surface for the engine; B3 builds the real row.
// The anchor and the window live in the URL (RankingsSection owns them), so
// a reload reads the same ranking again.
import { useState } from 'react';
import type { RankingAnchorKind, RankingAnchorRef, RankingReadResponse } from '../../../api/index.js';
import { Button, Spinner } from '../../../ui/index.js';
import { ContactSearchField, type ContactSearchValue } from '../../contact/ContactSearchField.js';
import { UnitSearchField, type UnitSearchValue } from '../../contact/UnitSearchField.js';
import { RankingTable } from './RankingTable.js';
import { ANCHOR_NOTE_TEXT, isJobLive, jobStatusText } from './rankingFormat.js';
import { useAnchorRanking } from './useAnchorRanking.js';
import { useRankCandidates } from './useRankCandidates.js';
import styles from './RankingsSection.module.css';

export interface RankAnchorPanelProps {
  anchor: RankingAnchorRef | undefined;
  includeOlder: boolean;
  onAnchorChange: (next: RankingAnchorRef | undefined) => void;
  onIncludeOlderChange: (next: boolean) => void;
  onShowRuns: (anchor: RankingAnchorRef) => void;
}

function AnchorRead({ read, anchorKind }: { read: RankingReadResponse; anchorKind: RankingAnchorKind }): React.JSX.Element {
  // Checked FIRST (plan PR16): over the ceiling the read carries the anchor
  // block but no rows; the page states the pool size instead of a table.
  const tooLarge = read.poolTooLarge;
  const placeOf = (unitId: string): string =>
    unitId === read.anchor.id
      ? read.anchor.display
      : read.rows.find((row) => row.candidateId === unitId)?.display ?? unitId;
  const facts: string[] = [
    ...read.anchor.anchorNotes.map((note) => ANCHOR_NOTE_TEXT[note]),
    ...(read.anchor.missing.length > 0
      ? [`Missing on this record: ${read.anchor.missing.map((flag) => flag.label).join(', ')}`]
      : []),
    ...(read.anchor.cardChanged ? ['This record changed since it was last ranked.'] : []),
    ...read.flags.map((flag) => `Fair-housing flag on ${placeOf(flag.unitId)}, ${flag.field}: ${flag.reason}`),
  ];
  return (
    <>
      {facts.length > 0 ? (
        // Explicit role: `list-style: none` makes WebKit drop the list role
        // its aria-label rides on (AiRunsSection.tsx's note).
        <ul className={styles.facts} role="list" aria-label="About this anchor">
          {facts.map((fact, index) => (
            <li key={`${index}-${fact}`}>{fact}</li>
          ))}
        </ul>
      ) : null}
      {tooLarge !== undefined ? (
        <p className={styles.note}>{tooLarge.message}</p>
      ) : (
        <RankingTable rows={read.rows} anchorKind={anchorKind} />
      )}
    </>
  );
}

export function RankAnchorPanel({
  anchor,
  includeOlder,
  onAnchorChange,
  onIncludeOlderChange,
  onShowRuns,
}: RankAnchorPanelProps): React.JSX.Element {
  // Seeded from an anchor the URL already holds, so clearing that anchor's
  // field keeps its kind (a reloaded tenant ranking stays on Tenant).
  const [chosenKind, setChosenKind] = useState<RankingAnchorKind>(() => anchor?.kind ?? 'unit');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const kind: RankingAnchorKind = anchor?.kind ?? chosenKind;
  // The window applies to a property anchor only (spec D1).
  const older = kind === 'unit' && includeOlder;
  const candidates = useRankCandidates();
  const ranking = useAnchorRanking(anchor, older);
  const jobLive = ranking.job !== null && isJobLive(ranking.job.status);

  // A hand pick keeps its own label; an anchor from the URL reads its display
  // from the ranking read, then falls back to the id.
  const committedLabel =
    anchor === undefined
      ? ''
      : picked !== null && picked.id === anchor.id
        ? picked.label
        : ranking.read?.anchor.display ?? anchor.id;

  const chooseKind = (next: RankingAnchorKind): void => {
    setChosenKind(next);
    setQuery('');
    setPicked(null);
    if (anchor !== undefined && anchor.kind !== next) onAnchorChange(undefined);
  };
  const pick = (next: RankingAnchorRef, label: string): void => {
    setPicked({ id: next.id, label });
    setQuery('');
    onAnchorChange(next);
  };
  const typeQuery = (text: string): void => {
    setQuery(text);
    if (anchor !== undefined) onAnchorChange(undefined);
  };

  const unitValue: UnitSearchValue =
    anchor !== undefined && anchor.kind === 'unit' ? { label: committedLabel, unitId: anchor.id } : { label: query };
  const contactValue: ContactSearchValue =
    anchor !== undefined && anchor.kind === 'tenant' ? { name: committedLabel, contactId: anchor.id } : { name: query };

  return (
    <section className={styles.panel} aria-label="Rank this anchor">
      <h3 className={styles.panelHeading}>Rank this anchor</h3>
      <div role="radiogroup" aria-label="Anchor type" className={styles.kindOptions}>
        <label className={styles.radioLabel}>
          <input type="radio" name="rank-anchor-kind" value="unit" checked={kind === 'unit'} onChange={() => chooseKind('unit')} />
          Property
        </label>
        <label className={styles.radioLabel}>
          <input type="radio" name="rank-anchor-kind" value="tenant" checked={kind === 'tenant'} onChange={() => chooseKind('tenant')} />
          Tenant
        </label>
      </div>
      <div className={styles.pickRow}>
        <div className={styles.pickField}>
          {kind === 'unit' ? (
            <UnitSearchField
              value={unitValue}
              onChange={(next) => {
                if (next.unitId !== undefined) pick({ kind: 'unit', id: next.unitId }, next.label);
                else typeQuery(next.label);
              }}
              candidates={candidates.units}
              inputLabel="Property to rank"
            />
          ) : (
            <ContactSearchField
              value={contactValue}
              onChange={(next) => {
                if (next.contactId !== undefined) pick({ kind: 'tenant', id: next.contactId }, next.name);
                else typeQuery(next.name);
              }}
              candidates={candidates.tenants}
              inputLabel="Tenant to rank"
            />
          )}
        </div>
        {/* The window is the configured RANKING_POOL_WINDOW_DAYS, known only
            from a read (plan PR26), so the checkbox shows once one answered. */}
        {kind === 'unit' && ranking.poolWindowDays !== null ? (
          <label className={styles.checkLabel}>
            <input type="checkbox" checked={includeOlder} onChange={(event) => onIncludeOlderChange(event.target.checked)} />
            Include tenants not heard from in {ranking.poolWindowDays} days
          </label>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={anchor === undefined || ranking.ranking || jobLive}
          onClick={ranking.rank}
        >
          {ranking.ranking ? 'Starting...' : 'Rank'}
        </Button>
        {anchor !== undefined ? (
          <button type="button" className={styles.linkButton} onClick={() => onShowRuns(anchor)}>
            Show runs for this anchor
          </button>
        ) : null}
      </div>
      {candidates.status === 'error' ? (
        <p className={styles.error} role="alert">
          We could not load the properties and tenants to search. Reload the page to try again.
        </p>
      ) : null}
      {ranking.rankError !== null ? (
        <p className={styles.error} role="alert">
          {ranking.rankError}
        </p>
      ) : null}
      {ranking.job !== null ? (
        <p className={styles.jobStatus} role="status" aria-label="Ranking job">
          {jobStatusText(ranking.job)}
          {ranking.joined ? ' (joined the ranking already running)' : ''}
        </p>
      ) : null}
      {anchor === undefined ? <p className={styles.note}>Pick a property or a tenant to see its ranking.</p> : null}
      {anchor !== undefined && ranking.readStatus === 'loading' ? <Spinner center label="Loading the ranking" /> : null}
      {ranking.readStatus === 'error' ? (
        <div className={styles.error} role="alert">
          <p>{ranking.readError}</p>
          <button type="button" onClick={ranking.retryRead}>
            Retry
          </button>
        </div>
      ) : null}
      {anchor !== undefined && ranking.readStatus === 'ready' && ranking.read !== undefined ? (
        <AnchorRead read={ranking.read} anchorKind={anchor.kind} />
      ) : null}
    </section>
  );
}
