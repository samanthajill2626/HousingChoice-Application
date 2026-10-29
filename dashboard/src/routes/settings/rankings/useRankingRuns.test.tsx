import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RankingCostResponse,
  RankingRunDetailResponse,
  RankingRunListPage,
  RankingRunListRowLive,
} from '../../../api/index.js';

const listRankingRuns = vi.fn();
const getRankingRun = vi.fn();
const getRankingCost = vi.fn();

vi.mock('../../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../api/index.js')>('../../../api/index.js');
  return {
    ...actual,
    listRankingRuns: (...args: unknown[]) => listRankingRuns(...args),
    getRankingRun: (...args: unknown[]) => getRankingRun(...args),
    getRankingCost: (...args: unknown[]) => getRankingCost(...args),
  };
});

import { useRankingCost, useRankingRun, useRankingRunList } from './useRankingRuns.js';

function liveRow(runId: string): RankingRunListRowLive {
  return {
    runId,
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
    latencyMs: 20,
    outcome: 'scored',
    environment: 'local',
  };
}

function page(runIds: string[], nextCursor?: string): RankingRunListPage {
  return { runs: runIds.map(liveRow), ...(nextCursor !== undefined && { nextCursor }) };
}

function ListProbe({ from, anchorId }: { from?: string; anchorId?: string }): React.JSX.Element {
  const state = useRankingRunList({
    from,
    anchor: anchorId === undefined ? undefined : { kind: 'unit', id: anchorId },
  });
  return createElement(
    'div',
    undefined,
    createElement('span', { 'data-testid': 'status' }, state.status),
    createElement('span', { 'data-testid': 'rows' }, state.rows.map((row) => row.runId).join(',')),
    createElement('span', { 'data-testid': 'hasMore' }, String(state.hasMore)),
    createElement('span', { 'data-testid': 'loadMoreFailed' }, String(state.loadMoreFailed)),
    createElement('span', { 'data-testid': 'incomplete' }, String(state.incomplete)),
    createElement('button', { type: 'button', onClick: state.loadMore }, 'more'),
    createElement('button', { type: 'button', onClick: state.retry }, 'retry'),
  );
}

function DetailProbe({ runId }: { runId?: string }): React.JSX.Element {
  const state = useRankingRun(runId);
  return createElement(
    'div',
    undefined,
    createElement('span', { 'data-testid': 'detail-status' }, state.status),
    createElement('span', { 'data-testid': 'detail-run' }, state.detail?.run.runId ?? ''),
  );
}

function CostProbe({ from, to }: { from?: string; to?: string }): React.JSX.Element {
  const state = useRankingCost({ from, to });
  return createElement(
    'div',
    undefined,
    createElement('span', { 'data-testid': 'cost-status' }, state.status),
    createElement('span', { 'data-testid': 'cost-env' }, state.cost?.environment ?? ''),
    createElement('button', { type: 'button', onClick: state.retry }, 'retry cost'),
  );
}

beforeEach(() => {
  listRankingRuns.mockReset();
  getRankingRun.mockReset();
  getRankingCost.mockReset();
});

describe('useRankingRunList', () => {
  it('reads the first page with the date and anchor filters', async () => {
    listRankingRuns.mockResolvedValue(page(['r1'], 'c1'));
    render(createElement(ListProbe, { from: '2026-07-01', anchorId: 'unit-1' }));
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(listRankingRuns).toHaveBeenCalledWith(
      { from: '2026-07-01', to: undefined, anchorKind: 'unit', anchorId: 'unit-1' },
      expect.any(AbortSignal),
    );
    expect(screen.getByTestId('rows')).toHaveTextContent('r1');
    expect(screen.getByTestId('hasMore')).toHaveTextContent('true');
  });

  it('Load more passes the cursor and appends the next page', async () => {
    listRankingRuns.mockResolvedValueOnce(page(['r1'], 'c1')).mockResolvedValueOnce(page(['r2']));
    render(createElement(ListProbe, {}));
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('r1'));
    await userEvent.click(screen.getByRole('button', { name: 'more' }));
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('r1,r2'));
    expect(listRankingRuns).toHaveBeenLastCalledWith({
      from: undefined, to: undefined, anchorKind: undefined, anchorId: undefined, cursor: 'c1',
    });
    expect(screen.getByTestId('hasMore')).toHaveTextContent('false');
  });

  it('a failed Load more keeps the rows and the cursor', async () => {
    listRankingRuns.mockResolvedValueOnce(page(['r1'], 'c1')).mockRejectedValueOnce(new Error('throttled'));
    render(createElement(ListProbe, {}));
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('r1'));
    await userEvent.click(screen.getByRole('button', { name: 'more' }));
    await waitFor(() => expect(screen.getByTestId('loadMoreFailed')).toHaveTextContent('true'));
    expect(screen.getByTestId('rows')).toHaveTextContent('r1');
    expect(screen.getByTestId('hasMore')).toHaveTextContent('true');
  });

  it('keeps a page that could not read every run marked incomplete across Load more (plan PR34)', async () => {
    listRankingRuns
      .mockResolvedValueOnce({ ...page(['r1'], 'c1'), incomplete: true })
      .mockResolvedValueOnce(page(['r2']));
    render(createElement(ListProbe, {}));
    await waitFor(() => expect(screen.getByTestId('incomplete')).toHaveTextContent('true'));
    await userEvent.click(screen.getByRole('button', { name: 'more' }));
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('r1,r2'));
    expect(screen.getByTestId('incomplete')).toHaveTextContent('true');
  });

  it('an error reads again on retry', async () => {
    listRankingRuns.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(page(['r1']));
    render(createElement(ListProbe, {}));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    await userEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(listRankingRuns).toHaveBeenCalledTimes(2);
  });
});

describe('useRankingRun', () => {
  it('is idle without a run and reads one by id', async () => {
    const detail: RankingRunDetailResponse = {
      run: {
        runId: 'r1', anchorKind: 'unit', anchorId: 'unit-1', direction: 'tenants_for_property', jobGeneration: 'g',
        batchIndex: 0, candidateCount: 3, driver: 'fake', model: 'fake', rubricVersion: 'r1', examplesVersion: 'e1',
        promptFingerprint: 'abc', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0001, latencyMs: 20,
        startedAt: '2026-07-01T10:00:00.000Z', finishedAt: '2026-07-01T10:00:20.000Z', outcome: 'scored',
        matchesWritten: { count: 3, at: '2026-07-01T10:00:20.000Z' }, environment: 'local',
      },
      anchorDisplay: '12 Oak St, Atlanta',
      input: null,
      pairs: [],
      flags: [],
    };
    getRankingRun.mockResolvedValue(detail);
    const { rerender } = render(createElement(DetailProbe, {}));
    expect(screen.getByTestId('detail-status')).toHaveTextContent('idle');
    rerender(createElement(DetailProbe, { runId: 'r1' }));
    expect(screen.getByTestId('detail-status')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('detail-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('detail-run')).toHaveTextContent('r1');
    expect(getRankingRun).toHaveBeenCalledWith('r1', expect.any(AbortSignal));
  });
});

describe('useRankingCost', () => {
  it('reads the totals for the date range and reads again on retry', async () => {
    const cost: RankingCostResponse = { environment: 'local', weeks: [], totalUsd: 0, truncated: false };
    getRankingCost.mockResolvedValue(cost);
    render(createElement(CostProbe, { from: '2026-07-01', to: '2026-07-31' }));
    await waitFor(() => expect(screen.getByTestId('cost-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('cost-env')).toHaveTextContent('local');
    expect(getRankingCost).toHaveBeenCalledWith({ from: '2026-07-01', to: '2026-07-31' }, expect.any(AbortSignal));
    await userEvent.click(screen.getByRole('button', { name: 'retry cost' }));
    await waitFor(() => expect(getRankingCost).toHaveBeenCalledTimes(2));
  });
});
