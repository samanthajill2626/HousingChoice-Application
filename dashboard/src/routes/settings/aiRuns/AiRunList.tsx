import type { AiRunListRow, AiRunScope } from '../../../api/index.js';
import { Spinner } from '../../../ui/index.js';
import styles from './AiRunsSection.module.css';

const SCOPES: Array<{ value: AiRunScope; label: string }> = [
  { value: 'global', label: 'Global' },
  { value: 'outcome#applied', label: 'Applied' },
  { value: 'outcome#no_op', label: 'No-op' },
  { value: 'outcome#skipped', label: 'Skipped' },
  { value: 'outcome#failed', label: 'Failed' },
];

export function AiRunList({
  rows, status, scope, onScopeChange, onOpen, hasMore, loadingMore, onLoadMore, onRetry,
}: {
  rows: AiRunListRow[]; status: 'loading' | 'ready' | 'error'; scope: AiRunScope;
  onScopeChange: (scope: AiRunScope) => void; onOpen: (runId: string) => void;
  hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; onRetry: () => void;
}): React.JSX.Element {
  return <section className={styles.listPane} aria-label="AI run list">
    <fieldset className={styles.scope}>
      <legend>Scope</legend>
      <div role="radiogroup" aria-label="AI run scope" className={styles.scopeOptions}>
        {SCOPES.map((option) => <label key={option.value} className={styles.radioLabel}>
          <input type="radio" name="ai-run-scope" value={option.value} checked={scope === option.value} onChange={() => onScopeChange(option.value)} />
          {option.label}
        </label>)}
      </div>
    </fieldset>
    {status === 'loading' ? <Spinner center /> : null}
    {status === 'error' ? <div className={styles.error} role="alert"><p>We could not load the AI run log.</p><button type="button" onClick={onRetry}>Retry</button></div> : null}
    {status === 'ready' && rows.length === 0 ? <p className={styles.empty}>No extraction runs match this scope.</p> : null}
    {status === 'ready' && rows.length > 0 ? <>
      <ul className={styles.rows} aria-label="AI runs">
        {rows.map((row) => row.expired ? <li key={row.runId} className={styles.expired}>Expired run {row.runId}</li> : <li key={row.runId}>
          <button type="button" className={styles.runRow} onClick={() => onOpen(row.runId)} aria-label={`Run ${row.runId}`}>
            <span className={styles.runTime}>{new Date(row.startedAt).toLocaleString()}</span>
            <span className={styles.outcome}>{row.outcome}</span>
            <span>{row.trigger} via {row.driver}</span>
            <span>{row.contactId ?? row.conversationId}</span>
            <span>{Object.values(row.decisionCounts).reduce((sum, count) => sum + count, 0)} decisions</span>
          </button>
        </li>)}
      </ul>
      {hasMore ? <button type="button" className={styles.loadMore} disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? 'Loading...' : 'Load more'}</button> : null}
    </> : null}
  </section>;
}
