import type { AiRunDetailResponse, AiRunWindowMessage } from '../../../api/index.js';
import { Spinner } from '../../../ui/index.js';
import styles from './AiRunsSection.module.css';

function value(value: unknown): string {
  if (value === undefined) return '-';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function humanizeEnum(value: string): string {
  return value.replaceAll('_', ' ');
}

function WindowMessages({ messages, full }: { messages: AiRunWindowMessage[]; full: boolean }): React.JSX.Element {
  return <div className={styles.tableWrap}><table className={styles.table} aria-label="Window messages"><thead><tr><th>Message</th><th>Tier</th><th>Text</th>{full ? <><th>Truncated</th><th>Chars</th><th>Hash</th></> : null}</tr></thead><tbody>
    {messages.map((message) => <tr key={message.tsMsgId}><td>{message.tsMsgId}</td><td>{message.tier}</td><td>{message.available ? message.text ?? 'No text available' : 'Unavailable'}</td>{full ? <><td>{message.truncated ? 'yes' : 'no'}</td><td>{message.chars ?? '-'}</td><td>{message.hash ?? '-'}</td></> : null}</tr>)}
  </tbody></table></div>;
}

export function AiRunDetail({ detail, status, onRetry }: { detail: AiRunDetailResponse | undefined; status: 'idle' | 'loading' | 'ready' | 'error'; onRetry: () => void }): React.JSX.Element {
  if (status === 'loading') return <Spinner center />;
  if (status === 'error') return <div className={styles.error} role="alert"><p>We could not load this AI run.</p><button type="button" onClick={onRetry}>Retry</button></div>;
  if (status === 'idle' || detail === undefined) return <p className={styles.empty}>Select a run to inspect its extraction record.</p>;
  const { run, window } = detail;
  const storedWindow = run.window;
  const full = storedWindow?.detail === 'full';
  const decisions = Object.entries(run.decisions).filter(
    (entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== undefined,
  );
  return <section className={styles.detailPane} aria-label="AI run detail">
    <header className={styles.detailHeader}><h3>Run {run.runId}</h3><p>{run.trigger} - {run.outcome} - {run.driver}{run.model ? ` / ${run.model}` : ''}</p><p>{run.contactId ?? run.conversationId} - {run.durationMs} ms</p>{run.promptFingerprint ? <p>Prompt fingerprint: {run.promptFingerprint}</p> : null}{run.usage ? <p>{run.usage.inputTokens} input tokens - {run.usage.outputTokens} output tokens</p> : null}</header>
    {storedWindow ? <section className={styles.block}><h4>{full ? 'Extraction window' : 'Skip window'}</h4>{!full ? <p>This skip window has no byte-level message evidence.</p> : null}<WindowMessages messages={window.messages} full={full} />
      {storedWindow.windowCappedAtLimit ? <p className={styles.note}>Older messages may exist beyond the recorded window.</p> : null}
      {storedWindow.noContent?.length ? <div role="region" aria-label="No content" className={styles.auditList}><h4>No content</h4><ul>{storedWindow.noContent.map((id) => <li key={id}>{id}</li>)}</ul></div> : null}
      {storedWindow.excluded.length ? <div role="region" aria-label="Excluded messages" className={styles.auditList}><h4>Excluded messages</h4><ul>{storedWindow.excluded.map((excluded) => <li key={excluded.tsMsgId}>{excluded.tsMsgId}: {excluded.cause}</li>)}</ul></div> : null}
    </section> : null}
    {decisions.length ? <section className={styles.block}><h4>Decision ledger</h4><div className={styles.tableWrap}><table className={styles.table} aria-label="Decisions"><thead><tr><th>Target</th><th>Proposed</th><th>Was</th><th>Outcome</th><th>Verdict</th><th>Reason</th></tr></thead><tbody>{decisions.map(([target, decision]) => <tr key={target}><td>{target}</td><td>{decision.proposedValue ?? decision.proposedOp}</td><td>{value(decision.previousValue)}</td><td>{humanizeEnum(decision.outcome)}</td><td>{humanizeEnum(decision.verdict)}</td><td>{decision.reason ?? (decision.dropReason ? humanizeEnum(decision.dropReason) : decision.outcome === 'dropped' ? 'unexplained' : '-')}</td></tr>)}</tbody></table></div></section> : null}
    {run.rawText !== undefined ? <details className={styles.raw}><summary>Raw model response</summary><pre>{run.rawText}</pre></details> : null}
    {run.rawResult !== undefined ? <details className={styles.raw}><summary>Parsed result</summary><pre>{JSON.stringify(run.rawResult, null, 2)}</pre></details> : null}
  </section>;
}
