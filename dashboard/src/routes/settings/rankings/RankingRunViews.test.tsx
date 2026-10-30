import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  RankingCostResponse,
  RankingRunDetailResponse,
  RankingRunListRow,
  RankingRunListRowLive,
  RankingRunPair,
} from '../../../api/index.js';
import { RankingCostTotals, costRangeNote } from './RankingCostTotals.js';
import { RankingRunDetail } from './RankingRunDetail.js';
import { RankingRunList, type RankingRunListProps } from './RankingRunList.js';

const ROW: RankingRunListRowLive = {
  runId: 'run-1',
  expired: false,
  startedAt: '2026-07-01T10:00:00.000Z',
  finishedAt: '2026-07-01T10:00:20.000Z',
  anchorKind: 'unit',
  anchorId: 'unit-1',
  anchorDisplay: '12 Oak St, Atlanta',
  direction: 'tenants_for_property',
  batchIndex: 0,
  candidateCount: 3,
  driver: 'fake',
  model: 'fake',
  costUsd: 0.0123,
  latencyMs: 1234,
  outcome: 'scored',
  environment: 'local',
};

function listProps(over: Partial<RankingRunListProps> = {}): RankingRunListProps {
  return {
    rows: [ROW],
    status: 'ready',
    hasMore: false,
    loadingMore: false,
    loadMoreFailed: false,
    incomplete: false,
    from: '',
    to: '',
    anchorFilter: undefined,
    onFromChange: vi.fn(),
    onToChange: vi.fn(),
    onClearAnchor: vi.fn(),
    onOpen: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    ...over,
  };
}

function pair(over: Partial<RankingRunPair> = {}): RankingRunPair {
  return {
    candidateId: 'contact-1',
    handle: 'c1',
    display: 'Ada Ranked',
    returned: true,
    score: 80,
    band: 'strong',
    cappedAtRun: false,
    for: [{ text: 'Area fits', source: 'area' }],
    against: [],
    missing: [{ key: 'payment_standard', text: 'Payment standard' }],
    failedRequirements: [],
    fairHousingFlags: [],
    currentRunId: 'run-1',
    ...over,
  };
}

const DETAIL: RankingRunDetailResponse = {
  run: {
    runId: 'run-1',
    anchorKind: 'unit',
    anchorId: 'unit-1',
    direction: 'tenants_for_property',
    jobGeneration: 'gen-1',
    batchIndex: 0,
    candidateCount: 3,
    driver: 'fake',
    model: 'fake',
    rubricVersion: 'r1',
    examplesVersion: 'e1',
    promptFingerprint: 'abc123',
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0 },
    costUsd: 0.0054,
    latencyMs: 1234,
    startedAt: '2026-07-01T10:00:00.000Z',
    finishedAt: '2026-07-01T10:00:01.234Z',
    outcome: 'scored',
    rawText: '{"candidates":[]}',
    matchesWritten: { count: 2, at: '2026-07-01T10:00:01.300Z' },
    droppedUnlawfulFlags: 1,
    environment: 'local',
  },
  anchorDisplay: '12 Oak St, Atlanta',
  input: '{"anchor":{"card":{"beds":2}}}',
  pairs: [
    pair(),
    pair({
      candidateId: 'contact-2',
      handle: 'c2',
      display: 'Bo Capped',
      score: 45,
      band: 'weak',
      cappedAtRun: true,
      for: [],
      against: [{ text: 'No pets', source: 'pets' }],
      missing: [],
      failedRequirements: ['no_pets'],
      fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }],
      currentRunId: 'run-9',
    }),
    pair({ candidateId: 'contact-3', handle: 'c3', display: 'Cy Gone', currentRunId: null }),
    // The model did not return this candidate (plan IR19): no score, no band.
    {
      candidateId: 'contact-4',
      handle: 'c4',
      display: 'Di Omitted',
      returned: false,
      cappedAtRun: false,
      for: [],
      against: [],
      missing: [],
      failedRequirements: [],
      fairHousingFlags: [],
      currentRunId: null,
    },
  ],
  flags: [{ unitId: 'unit-1', field: 'qualifications', reason: 'says no kids', raisedAt: '2026-07-01T10:00:01.000Z', runId: 'run-1' }],
};

describe('RankingRunList', () => {
  it('lists each run with anchor, direction, model, candidates, cost, latency, time and outcome', () => {
    render(<RankingRunList {...listProps()} />);
    const row = within(screen.getByRole('list', { name: 'Ranking runs' })).getByRole('button');
    expect(row).toHaveTextContent('12 Oak St, Atlanta');
    expect(row).toHaveTextContent('Tenants for property, batch 1');
    expect(row).toHaveTextContent('fake');
    expect(row).toHaveTextContent('3 candidates');
    expect(row).toHaveTextContent('$0.0123');
    expect(row).toHaveTextContent('1234 ms');
    expect(row).toHaveTextContent(new Date('2026-07-01T10:00:00.000Z').toLocaleString());
    expect(row).toHaveTextContent('scored');
  });

  it('says 1 candidate, not 1 candidates (conformance N5)', () => {
    render(<RankingRunList {...listProps({ rows: [{ ...ROW, candidateCount: 1 }] })} />);
    const row = within(screen.getByRole('list', { name: 'Ranking runs' })).getByRole('button');
    expect(row).toHaveTextContent('1 candidate');
    expect(row).not.toHaveTextContent('1 candidates');
  });

  it('opens a run', async () => {
    const onOpen = vi.fn();
    render(<RankingRunList {...listProps({ onOpen })} />);
    await userEvent.click(within(screen.getByRole('list', { name: 'Ranking runs' })).getByRole('button'));
    expect(onOpen).toHaveBeenCalledWith('run-1');
  });

  it('shows an expired pointer without a button', () => {
    const rows: RankingRunListRow[] = [{ runId: 'run-x', expired: true }];
    render(<RankingRunList {...listProps({ rows })} />);
    expect(screen.getByText('Expired run run-x')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Ranking runs' })).queryByRole('button')).not.toBeInTheDocument();
  });

  it('pages with Load more and keeps it after a failed page', async () => {
    const onLoadMore = vi.fn();
    render(<RankingRunList {...listProps({ hasMore: true, loadMoreFailed: true, onLoadMore })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('We could not load more runs.');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('filters by date range and shows the anchor filter with a way back to all anchors', async () => {
    const onFromChange = vi.fn();
    const onClearAnchor = vi.fn();
    render(<RankingRunList {...listProps({ onFromChange, onClearAnchor, anchorFilter: { label: '12 Oak St, Atlanta' } })} />);
    // A controlled date input whose value the test never feeds back: set the
    // whole value in one change (userEvent.type would be reset per key).
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-01' } });
    expect(onFromChange).toHaveBeenLastCalledWith('2026-07-01');
    expect(screen.getByText(/Anchor: 12 Oak St, Atlanta/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'All anchors' }));
    expect(onClearAnchor).toHaveBeenCalledTimes(1);
  });

  it('says when a run could not be read (plan PR34)', () => {
    render(<RankingRunList {...listProps({ incomplete: true })} />);
    expect(screen.getByText('Some runs could not be read; this list may be missing some.')).toBeInTheDocument();
  });

  it('Refresh reads the runs again', async () => {
    const onRefresh = vi.fn();
    render(<RankingRunList {...listProps({ onRefresh })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('says when no run matches and offers Retry on an error', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<RankingRunList {...listProps({ rows: [] })} />);
    expect(screen.getByText('No ranking runs match these filters.')).toBeInTheDocument();
    rerender(<RankingRunList {...listProps({ rows: [], status: 'error', onRetry })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('RankingCostTotals', () => {
  it('puts the environment name above the weekly totals', () => {
    const cost: RankingCostResponse = {
      environment: 'prod',
      weeks: [{ week: '2026-W27', environment: 'prod', runs: 4, inputTokens: 9000, outputTokens: 2000, costUsd: 0.0381 }],
      totalUsd: 0.0381,
      truncated: false,
    };
    render(<RankingCostTotals cost={cost} status="ready" rangeNote={undefined} onRetry={vi.fn()} />);
    const region = screen.getByRole('region', { name: 'Cost by week' });
    expect(within(region).getByText('Environment: prod')).toBeInTheDocument();
    const rows = within(within(region).getByRole('table', { name: 'Weekly ranking cost' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('2026-W27');
    expect(rows[1]).toHaveTextContent('4');
    expect(rows[1]).toHaveTextContent('$0.0381');
  });

  it('says when the range holds no cost', () => {
    render(<RankingCostTotals cost={{ environment: 'local', weeks: [], totalUsd: 0, truncated: false }} status="ready" rangeNote={undefined} onRetry={vi.fn()} />);
    expect(screen.getByText('No ranking cost in this range.')).toBeInTheDocument();
    expect(screen.queryByText('The last 12 weeks.')).not.toBeInTheDocument();
  });

  it('notes the range the server used whenever a bound is missing (plan review R2B6)', () => {
    expect(costRangeNote(undefined, undefined)).toBe('The last 12 weeks.');
    expect(costRangeNote(undefined, '2026-07-31')).toBe('The 12 weeks ending the week of 2026-07-31.');
    expect(costRangeNote('2026-07-01', undefined)).toBe('From 2026-07-01 through today.');
    expect(costRangeNote('2026-07-01', '2026-07-31')).toBeUndefined();
  });

  it('names the default range, and says when runs could not be read (plan PR34)', () => {
    render(
      <RankingCostTotals
        cost={{ environment: 'local', weeks: [], totalUsd: 0, truncated: false, incomplete: true }}
        status="ready"
        rangeNote="The last 12 weeks."
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('The last 12 weeks.')).toBeInTheDocument();
    expect(screen.getByText('Some runs could not be read; totals may be low')).toBeInTheDocument();
    expect(screen.queryByText(TRUNCATED_NOTE)).not.toBeInTheDocument();
  });

  // Conformance N2 (plan PR34: never a silent drop): the server stops
  // totaling at its page cap and says `truncated`; the page says so too.
  it('says when the range held more runs than the totals count', () => {
    const { rerender } = render(
      <RankingCostTotals cost={{ environment: 'local', weeks: [], totalUsd: 0, truncated: false }} status="ready" rangeNote={undefined} onRetry={vi.fn()} />,
    );
    expect(screen.queryByText(TRUNCATED_NOTE)).not.toBeInTheDocument();
    rerender(
      <RankingCostTotals cost={{ environment: 'local', weeks: [], totalUsd: 0, truncated: true }} status="ready" rangeNote={undefined} onRetry={vi.fn()} />,
    );
    expect(screen.getByRole('region', { name: 'Cost by week' })).toHaveTextContent(TRUNCATED_NOTE);
  });
});

const TRUNCATED_NOTE = 'Too many runs in this range to total them all; totals are low. Choose a shorter range.';

describe('RankingRunDetail', () => {
  it('shows the run fields', () => {
    render(<RankingRunDetail detail={DETAIL} status="ready" onRetry={vi.fn()} />);
    const region = screen.getByRole('region', { name: 'Ranking run detail' });
    expect(within(region).getByRole('heading', { name: 'Run run-1' })).toBeInTheDocument();
    expect(region).toHaveTextContent('12 Oak St, Atlanta - Tenants for property - batch 1');
    expect(region).toHaveTextContent('scored - fake / fake - 1234 ms');
    expect(region).toHaveTextContent('3 candidates - 1200 input tokens - 300 output tokens - 0 cache read tokens - $0.0054');
    expect(region).toHaveTextContent('Rubric r1 - examples e1 - prompt fingerprint abc123');
    expect(region).toHaveTextContent('Environment: local - 1 unlawful flag dropped - 2 matches written');
  });

  it('says 1 candidate in the run fields (conformance N5)', () => {
    render(<RankingRunDetail detail={{ ...DETAIL, run: { ...DETAIL.run, candidateCount: 1 } }} status="ready" onRetry={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Ranking run detail' })).toHaveTextContent('1 candidate - 1200 input tokens');
  });

  it('says so when the run recorded no usage (plan IR35)', () => {
    const { usage: _noUsage, ...withoutUsage } = DETAIL.run;
    render(<RankingRunDetail detail={{ ...DETAIL, run: withoutUsage }} status="ready" onRetry={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Ranking run detail' })).toHaveTextContent('3 candidates - no usage recorded - $0.0054');
  });

  it('shows the run OWN pairs, with sources, missing, flags and the since re-scored mark', () => {
    render(<RankingRunDetail detail={DETAIL} status="ready" onRetry={vi.fn()} />);
    const table = screen.getByRole('table', { name: 'Run pairs' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Candidate', 'Score', 'Band', 'Cap', 'For', 'Against', 'Missing', 'Flags', 'Current match',
    ]);
    const [first, second, third] = within(table).getAllByRole('row').slice(1);
    expect(within(first as HTMLElement).getAllByRole('cell').map((td) => td.textContent)).toEqual([
      '80', 'Strong', 'No', 'Area fits (area)', '-', 'Payment standard', '-', 'This run',
    ]);
    expect(within(second as HTMLElement).getAllByRole('cell').map((td) => td.textContent)).toEqual([
      '45', 'Weak', 'Capped', '-', 'No pets (pets)', '-', 'accommodation on no_pets', 'Since re-scored',
    ]);
    expect(third).toHaveTextContent('No current match');
  });

  it('links a re-scored pair to the run that holds its current match (spec D11; conformance SF1)', async () => {
    const onOpenRun = vi.fn();
    render(<RankingRunDetail detail={DETAIL} status="ready" onRetry={vi.fn()} onOpenRun={onOpenRun} />);
    const table = screen.getByRole('table', { name: 'Run pairs' });
    await userEvent.click(within(table).getByRole('button', { name: 'Since re-scored: open the current run for Bo Capped' }));
    expect(onOpenRun).toHaveBeenCalledWith('run-9');
    // "This run" and "No current match" have no other run to open.
    expect(within(table).getAllByRole('button')).toHaveLength(1);
  });

  it('shows a candidate the model did not return as not returned', () => {
    render(<RankingRunDetail detail={DETAIL} status="ready" onRetry={vi.fn()} />);
    const fourth = within(screen.getByRole('table', { name: 'Run pairs' })).getAllByRole('row')[4] as HTMLElement;
    expect(within(fourth).getAllByRole('cell').map((td) => td.textContent)).toEqual([
      '-', 'not returned', '-', '-', '-', '-', '-', 'No current match',
    ]);
  });

  it('says when the current matches or the open flags could not be read', () => {
    render(
      <RankingRunDetail
        detail={{ ...DETAIL, flags: [], currentUnavailable: true, flagsUnavailable: true }}
        status="ready"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('Could not check the current matches; the Current match column may be wrong.')).toBeInTheDocument();
    expect(screen.getByText('Could not read the open fair-housing flags.')).toBeInTheDocument();
  });

  it('lists the property open flags', () => {
    render(<RankingRunDetail detail={DETAIL} status="ready" onRetry={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Open fair-housing flags' })).toHaveTextContent('qualifications: says no kids');
  });

  // Spec D10 rev 7 (charter item 16): a tenant anchor's runs carry no flag
  // list; the server sends none, and the page shows none whatever it is sent.
  it('a tenant-anchor run shows no open-flags section and no flag-read note', () => {
    render(
      <RankingRunDetail
        detail={{
          ...DETAIL,
          run: { ...DETAIL.run, anchorKind: 'tenant', anchorId: 'contact-1', direction: 'properties_for_tenant' },
          flagsUnavailable: true,
        }}
        status="ready"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('table', { name: 'Run pairs' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Open fair-housing flags' })).not.toBeInTheDocument();
    expect(screen.queryByText('Could not read the open fair-housing flags.')).not.toBeInTheDocument();
  });

  // Spec D10 rev 7 (PFW1-6): a tenant anchor's runs carry no flag list, so
  // a pair's Flags cell names no unlawful flag (about the property) whatever
  // the server sends; an accommodation flag is about the pair and shows. A
  // property-anchor run shows both, as the run said.
  const BOTH_KINDS: RankingRunPair['fairHousingFlags'] = [
    { kind: 'unlawful', field: 'qualifications' },
    { kind: 'accommodation', field: 'no_pets' },
  ];
  const flagsCellOf = (table: HTMLElement): string | null =>
    within(within(table).getAllByRole('row')[1] as HTMLElement).getAllByRole('cell')[6]?.textContent ?? null;

  it("a tenant-anchor run's Flags column shows a pair's accommodation flag and no unlawful flag", () => {
    render(
      <RankingRunDetail
        detail={{
          ...DETAIL,
          run: { ...DETAIL.run, anchorKind: 'tenant', anchorId: 'contact-1', direction: 'properties_for_tenant' },
          pairs: [pair({ candidateId: 'unit-7', display: '7 Elm St, Atlanta', fairHousingFlags: BOTH_KINDS })],
          flags: [],
        }}
        status="ready"
        onRetry={vi.fn()}
      />,
    );
    const table = screen.getByRole('table', { name: 'Run pairs' });
    expect(flagsCellOf(table)).toBe('accommodation on no_pets');
    expect(table).not.toHaveTextContent('unlawful on');
  });

  it("(PIN) a property-anchor run's Flags column shows a pair's unlawful and accommodation flags", () => {
    render(<RankingRunDetail detail={{ ...DETAIL, pairs: [pair({ fairHousingFlags: BOTH_KINDS })] }} status="ready" onRetry={vi.fn()} />);
    expect(flagsCellOf(screen.getByRole('table', { name: 'Run pairs' }))).toBe('unlawful on qualifications, accommodation on no_pets');
  });

  it('keeps the raw output and the decompressed input collapsed', () => {
    render(<RankingRunDetail detail={DETAIL} status="ready" onRetry={vi.fn()} />);
    const raw = screen.getByText('Raw model output').closest('details');
    const input = screen.getByText('Input sent').closest('details');
    expect(raw).not.toHaveAttribute('open');
    expect(input).not.toHaveAttribute('open');
    expect(raw).toHaveTextContent('{"candidates":[]}');
    // Pretty-printed from the JSON the server decompressed.
    expect(input?.querySelector('pre')?.textContent).toBe(JSON.stringify({ anchor: { card: { beds: 2 } } }, null, 2));
  });

  it('says when the input was too large to keep', () => {
    render(
      <RankingRunDetail detail={{ ...DETAIL, input: null, run: { ...DETAIL.run, inputOmitted: true } }} status="ready" onRetry={vi.fn()} />,
    );
    expect(screen.getByText('The input was too large to keep.')).toBeInTheDocument();
  });

  it('shows a failed run with its failure and message, and a scored run whose matches did not land', () => {
    const { rerender } = render(
      <RankingRunDetail
        detail={{ ...DETAIL, pairs: [], run: { ...DETAIL.run, outcome: 'failed', failure: 'timeout', message: 'The call took too long.' } }}
        status="ready"
        onRetry={vi.fn()}
      />,
    );
    const failure = screen.getByRole('region', { name: 'Run failure' });
    expect(failure).toHaveTextContent('Failed: timeout');
    expect(failure).toHaveTextContent('The call took too long.');
    expect(screen.queryByRole('table', { name: 'Run pairs' })).not.toBeInTheDocument();
    const { matchesWritten: _unused, ...unwritten } = DETAIL.run;
    rerender(<RankingRunDetail detail={{ ...DETAIL, run: unwritten }} status="ready" onRetry={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Ranking run detail' })).toHaveTextContent('Matches: not written');
  });

  it('asks for a pick when idle and offers Retry on an error', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<RankingRunDetail detail={undefined} status="idle" onRetry={onRetry} />);
    expect(screen.getByText('Select a run to see its pairs.')).toBeInTheDocument();
    rerender(<RankingRunDetail detail={undefined} status="error" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
