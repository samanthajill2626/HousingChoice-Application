// RankingRunDetail - one ranking run (WP1 B2a spec D11, D18): its fields, the
// raw output and the input (both collapsed; the server decompresses the
// input), and its pairs from the run's OWN results[] - what THIS run said.
// The matches store holds one row per pair, rewritten by later presses from
// either anchor, so each pair is marked against the current match's runId:
// "This run", "Since re-scored" or "No current match".
import type { RankingFairHousingFlag, RankingRunDetailResponse } from '../../../api/index.js';
import { Spinner } from '../../../ui/index.js';
import { bandLabel, currentMatchText, directionLabel, formatCost, reasonsText } from './rankingFormat.js';
import styles from './RankingsSection.module.css';

function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input) as unknown, null, 2);
  } catch {
    return input;
  }
}

function flagsText(flags: readonly RankingFairHousingFlag[]): string {
  if (flags.length === 0) return '-';
  return flags.map((flag) => `${flag.kind} on ${flag.field}`).join(', ');
}

export function RankingRunDetail({
  detail,
  status,
  onRetry,
}: {
  detail: RankingRunDetailResponse | undefined;
  status: 'idle' | 'loading' | 'ready' | 'error';
  onRetry: () => void;
}): React.JSX.Element {
  if (status === 'loading') return <Spinner center label="Loading the run" />;
  if (status === 'error') {
    return (
      <div className={styles.error} role="alert">
        <p>We could not load this ranking run.</p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (status === 'idle' || detail === undefined) return <p className={styles.empty}>Select a run to see its pairs.</p>;
  const { run, anchorDisplay, input, pairs, flags, currentUnavailable, flagsUnavailable } = detail;
  const dropped = run.droppedUnlawfulFlags ?? 0;
  // `usage` may be absent on a stored run (plan IR35).
  const usage = run.usage;
  const usageText =
    usage === undefined
      ? 'no usage recorded'
      : `${usage.inputTokens} input tokens - ${usage.outputTokens} output tokens${
          usage.cacheReadInputTokens !== undefined ? ` - ${usage.cacheReadInputTokens} cache read tokens` : ''
        }`;
  // `matchesWritten` is { count, at }; absent = the write did not finish (PR15).
  const written = run.matchesWritten;
  return (
    <section className={styles.detailPane} aria-label="Ranking run detail">
      <header className={styles.detailHeader}>
        <h3>Run {run.runId}</h3>
        <p>
          {anchorDisplay} - {directionLabel(run.direction)} - batch {run.batchIndex + 1}
        </p>
        <p>
          {new Date(run.startedAt).toLocaleString()} - {run.outcome} - {run.driver} / {run.model} - {run.latencyMs} ms
        </p>
        <p>
          {run.candidateCount} candidates - {usageText} - {formatCost(run.costUsd)}
        </p>
        <p>
          Rubric {run.rubricVersion} - examples {run.examplesVersion} - prompt fingerprint {run.promptFingerprint}
        </p>
        <p>
          Environment: {run.environment}
          {dropped > 0 ? ` - ${dropped} unlawful flag${dropped === 1 ? '' : 's'} dropped` : ''}
          {run.outcome === 'scored'
            ? written === undefined
              ? ' - Matches: not written'
              : ` - ${written.count} match${written.count === 1 ? '' : 'es'} written`
            : ''}
        </p>
      </header>
      {run.outcome === 'failed' ? (
        <section className={styles.failure} aria-label="Run failure">
          <h4>Failed: {(run.failure ?? 'unknown').replaceAll('_', ' ')}</h4>
          {run.message !== undefined ? <p>{run.message}</p> : null}
        </section>
      ) : null}
      {pairs.length > 0 ? (
        <section className={styles.block}>
          <h4>Pairs</h4>
          <div className={styles.tableWrap}>
            <table className={styles.table} aria-label="Run pairs">
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">Score</th>
                  <th scope="col">Band</th>
                  <th scope="col">Cap</th>
                  <th scope="col">For</th>
                  <th scope="col">Against</th>
                  <th scope="col">Missing</th>
                  <th scope="col">Flags</th>
                  <th scope="col">Current match</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((pair) => (
                  <tr key={pair.candidateId}>
                    <th scope="row">{pair.display}</th>
                    <td>{pair.returned && pair.score !== undefined ? pair.score : '-'}</td>
                    <td>{pair.returned && pair.band !== undefined ? bandLabel(pair.band) : 'not returned'}</td>
                    <td>{pair.returned ? (pair.cappedAtRun ? 'Capped' : 'No') : '-'}</td>
                    <td>{reasonsText(pair.for)}</td>
                    <td>{reasonsText(pair.against)}</td>
                    <td>{pair.missing.length === 0 ? '-' : pair.missing.map((item) => item.text).join(', ')}</td>
                    <td>{flagsText(pair.fairHousingFlags)}</td>
                    <td>{currentMatchText(pair.currentRunId, run.runId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {currentUnavailable === true ? (
        <p className={styles.note}>Could not check the current matches; the Current match column may be wrong.</p>
      ) : null}
      {flagsUnavailable === true ? <p className={styles.note}>Could not read the open fair-housing flags.</p> : null}
      {flags.length > 0 ? (
        <section className={styles.block} aria-label="Open fair-housing flags">
          <h4>Open fair-housing flags</h4>
          <ul>
            {flags.map((flag) => (
              <li key={`${flag.unitId}#${flag.field}`}>
                {flag.field}: {flag.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {run.rawText !== undefined ? (
        <details className={styles.raw}>
          <summary>Raw model output</summary>
          <pre>{run.rawText}</pre>
        </details>
      ) : null}
      <details className={styles.raw}>
        <summary>Input sent</summary>
        {input === null ? (
          <p>{run.inputOmitted === true ? 'The input was too large to keep.' : 'No input recorded.'}</p>
        ) : (
          <pre>{prettyInput(input)}</pre>
        )}
      </details>
    </section>
  );
}
