import type { AiRunListRow, AiRunScope } from '../../../api/index.js';
import { Spinner } from '../../../ui/index.js';
import { humanizeEnum } from './AiRunDetail.js';
import styles from './AiRunsSection.module.css';

const SCOPES: Array<{ value: AiRunScope; label: string }> = [
  { value: 'global', label: 'Global' },
  { value: 'outcome#applied', label: 'Applied' },
  { value: 'outcome#no_op', label: 'No-op' },
  { value: 'outcome#skipped', label: 'Skipped' },
  { value: 'outcome#failed', label: 'Failed' },
];

function scopedOption(scope: AiRunScope): { value: AiRunScope; label: string } | undefined {
  if (scope.startsWith('contacts#')) return { value: scope, label: `Contact: ${scope.slice('contacts#'.length)}` };
  if (scope.startsWith('conversations#')) return { value: scope, label: `Conversation: ${scope.slice('conversations#'.length)}` };
  return undefined;
}

export function AiRunList({
  rows, status, scope, from, to, onScopeChange, onFromChange, onToChange, onOpen, hasMore, loadingMore, loadMoreFailed, onLoadMore, onRetry,
}: {
  rows: AiRunListRow[]; status: 'loading' | 'ready' | 'error'; scope: AiRunScope;
  from: string; to: string; onScopeChange: (scope: AiRunScope) => void; onFromChange: (value: string) => void; onToChange: (value: string) => void; onOpen: (runId: string) => void;
  hasMore: boolean; loadingMore: boolean; loadMoreFailed: boolean; onLoadMore: () => void; onRetry: () => void;
}): React.JSX.Element {
  return <section className={styles.listPane} aria-label="AI run list">
    <fieldset className={styles.scope}>
      <legend>Scope</legend>
      <div role="radiogroup" aria-label="AI run scope" className={styles.scopeOptions}>
        {[...SCOPES, ...(scopedOption(scope) ? [scopedOption(scope)!] : [])].map((option) => <label key={option.value} className={styles.radioLabel}>
          <input type="radio" name="ai-run-scope" value={option.value} checked={scope === option.value} onChange={() => onScopeChange(option.value)} />
          {option.label}
        </label>)}
      </div>
      <div className={styles.dateRange}>
        <label className={styles.dateLabel}>From<input className={styles.dateInput} type="date" value={from} onChange={(event) => onFromChange(event.target.value)} /></label>
        <label className={styles.dateLabel}>To<input className={styles.dateInput} type="date" value={to} onChange={(event) => onToChange(event.target.value)} /></label>
      </div>
    </fieldset>
    {status === 'loading' ? <Spinner center /> : null}
    {status === 'error' ? <div className={styles.error} role="alert"><p>We could not load the AI run log.</p><button type="button" onClick={onRetry}>Retry</button></div> : null}
    {status === 'ready' && rows.length === 0 ? <p className={styles.empty}>No extraction runs match this scope.</p> : null}
    {status === 'ready' && rows.length > 0 ? <>
      {/* Explicit role: `list-style: none` makes WebKit drop the implicit list
          role, and this ul's aria-label (the e2e anchor) rides on that role. */}
      <ul className={styles.rows} role="list" aria-label="AI runs">
        {rows.map((row) => row.expired ? <li key={row.runId} className={styles.expired}>Expired run {row.runId}</li> : <li key={row.runId}>
          {/* No `aria-label`: it would OVERRIDE the row's contents, and the
              runId it carried is rendered nowhere a sighted operator can see.
              Named from content, the row reads as what the run actually did. */}
          <button type="button" className={styles.runRow} onClick={() => onOpen(row.runId)}>
            <span className={styles.runTime}>{new Date(row.startedAt).toLocaleString()}</span>
            <span className={styles.outcome}>{humanizeEnum(row.outcome)}</span>
            <span>{row.trigger} via {row.driver}</span>
            <span>{row.contactId ?? row.conversationId}</span>
            {/* NOT a total of `decisionCounts`: `pending` is a VERDICT cross-tab
                over the same targets the five outcome buckets already partition
                (app/src/routes/aiRuns.ts:27-36), so summing them double-counts
                every pending decision. Show the two buckets an operator scanning
                the log is actually looking for. */}
            <span>{row.decisionCounts['wrote'] ?? 0} wrote, {row.decisionCounts['suggested'] ?? 0} suggested</span>
          </button>
        </li>)}
      </ul>
      {/* The next page failed, not the log: the same Load more is still there and
          this retry asks for the very same page again. */}
      {loadMoreFailed ? <div className={styles.error} role="alert"><p>We could not load more runs.</p><button type="button" onClick={onLoadMore}>Retry</button></div> : null}
      {hasMore ? <button type="button" className={styles.loadMore} disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? 'Loading...' : 'Load more'}</button> : null}
    </> : null}
  </section>;
}
