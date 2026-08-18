import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AiRunScope } from '../../../api/index.js';
import { useTwoPaneNarrow } from '../../../ui/index.js';
import shell from '../../../ui/twoPaneShell.module.css';
import { AiRunDetail } from './AiRunDetail.js';
import { AiRunList } from './AiRunList.js';
import styles from './AiRunsSection.module.css';
import { useAiRun, useAiRunList } from './useAiRuns.js';
import { useSystemFlags } from '../useSystemStatus.js';

function scopeFrom(value: string | null): AiRunScope { return value === null || value === '' ? 'global' : value as AiRunScope; }

export function AiRunsSection(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = scopeFrom(searchParams.get('scope'));
  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;
  const runId = searchParams.get('run') ?? undefined;
  const narrow = useTwoPaneNarrow();
  const [pane, setPane] = useState<'list' | 'detail'>(runId === undefined ? 'list' : 'detail');
  const list = useAiRunList({ scope, from, to });
  const activeRunId = !narrow || pane === 'detail' ? runId : undefined;
  const detail = useAiRun(activeRunId);
  const flags = useSystemFlags();
  const setParam = (key: 'scope' | 'run' | 'from' | 'to', value: string | undefined): void => {
    const next = new URLSearchParams(searchParams);
    if (value === undefined || value === '' || (key === 'scope' && value === 'global')) next.delete(key); else next.set(key, value);
    setSearchParams(next);
  };
  const flagItems = flags.flags ? [
    ['AI extraction', flags.flags.aiExtractionEnabled ? 'on' : 'off'], ['Extraction driver', flags.flags.aiExtractionDriver],
    ['Extraction model', flags.flags.aiExtractionModel], ['Prompt fingerprint', flags.flags.aiExtractionPromptFingerprint],
  ] : [];
  return <div className={shell.page}>
    <header className={shell.header}><div className={shell.identity}><div className={shell.nameRow}><h2 id="ai-runs-heading" className={shell.name}>AI run log</h2></div><p className={styles.headerLede}>Forensic record of what extraction saw, proposed, and did.</p></div></header>
    {/* A `<ul>` of `<li>`s, mirroring FlagPills: `aria-label` on a bare div/span
        (role=generic) is dropped by assistive tech even though Testing Library
        and Playwright honour it. `list`/`listitem` support naming from author.
        The EXPLICIT role is load-bearing, not redundant: WebKit strips
        list/listitem semantics from a list styled `list-style: none` (which
        .configStrip is), which would drop these labels back onto role=generic
        in Safari/VoiceOver - the exact AT this markup exists for. Neither
        Testing Library nor Playwright can see the difference (adv P3-5). */}
    <ul className={styles.configStrip} role="list" aria-label="Extraction configuration">{flagItems.map(([label, flagValue]) => <li key={label} className={styles.configItem} aria-label={`${label}: ${flagValue}`}>{label}: {flagValue}</li>)}</ul>
    <div className={shell.segMobile} role="group" aria-label="View"><button type="button" className={pane === 'list' ? shell.segOn : shell.segBtn} aria-pressed={pane === 'list'} onClick={() => setPane('list')}>Runs</button><button type="button" className={pane === 'detail' ? shell.segOn : shell.segBtn} aria-pressed={pane === 'detail'} onClick={() => setPane('detail')}>Detail</button></div>
    <div className={shell.body}>
      <div className={`${shell.left} ${pane === 'list' ? shell.paneActive : shell.paneHidden}`}><AiRunList rows={list.rows} status={list.status} scope={scope} scopeContact={list.scopeContact} from={from ?? ''} to={to ?? ''} onScopeChange={(next) => setParam('scope', next)} onFromChange={(next) => setParam('from', next)} onToChange={(next) => setParam('to', next)} onOpen={(id) => { setParam('run', id); setPane('detail'); }} hasMore={list.hasMore} loadingMore={list.loadingMore} loadMoreFailed={list.loadMoreFailed} onLoadMore={list.loadMore} onRetry={list.retry} /></div>
      <div className={`${shell.right} ${pane === 'detail' ? shell.paneActive : shell.paneHidden}`}><div className={shell.rightInner}><AiRunDetail detail={detail.detail} status={detail.status} onRetry={detail.retry} /></div></div>
    </div>
  </div>;
}
