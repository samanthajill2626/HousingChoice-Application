import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankingRunListRowLive } from '../../../api/index.js';
import type { RankAnchorPanelProps } from './RankAnchorPanel.js';

const useRankingRunList = vi.fn();
const useRankingRun = vi.fn();
const useRankingCost = vi.fn();
let panelProps: RankAnchorPanelProps | undefined;

vi.mock('./useRankingRuns.js', () => ({
  useRankingRunList: (...args: unknown[]) => useRankingRunList(...args),
  useRankingRun: (...args: unknown[]) => useRankingRun(...args),
  useRankingCost: (...args: unknown[]) => useRankingCost(...args),
}));
vi.mock('./RankAnchorPanel.js', () => ({
  RankAnchorPanel: (next: RankAnchorPanelProps) => {
    panelProps = next;
    return null;
  },
}));

import { RankingsSection } from './RankingsSection.js';

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
  latencyMs: 20,
  outcome: 'scored',
  environment: 'local',
};

function Location(): React.JSX.Element {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderSection(path = '/settings/rankings'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <RankingsSection />
      <Location />
    </MemoryRouter>,
  );
}

function panel(): RankAnchorPanelProps {
  if (panelProps === undefined) throw new Error('the panel did not render');
  return panelProps;
}

const listRetry = vi.fn();
const costRetry = vi.fn();

beforeEach(() => {
  panelProps = undefined;
  listRetry.mockReset();
  costRetry.mockReset();
  useRankingRunList.mockReturnValue({
    rows: [ROW], status: 'ready', hasMore: false, loadingMore: false, loadMoreFailed: false, incomplete: false, loadMore: vi.fn(), retry: listRetry,
  });
  useRankingRun.mockReturnValue({ detail: undefined, status: 'idle', retry: vi.fn() });
  useRankingCost.mockReturnValue({ cost: { environment: 'local', weeks: [], totalUsd: 0, truncated: false }, status: 'ready', retry: costRetry });
});

describe('RankingsSection', () => {
  it('renders the Rankings heading, the panel, the cost totals and the runs', () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Rankings', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cost by week' })).toHaveTextContent('Environment: local');
    // No range set: the server totals the last 12 weeks (plan PR34).
    expect(screen.getByRole('region', { name: 'Cost by week' })).toHaveTextContent('The last 12 weeks.');
    expect(screen.getByRole('list', { name: 'Ranking runs' })).toBeInTheDocument();
    expect(panel().anchor).toBeUndefined();
    expect(panel().includeOlder).toBe(false);
  });

  it('reads the panel anchor and window from the URL and writes a pick back', () => {
    renderSection('/settings/rankings?rank=unit%3Aunit-1&older=1');
    expect(panel().anchor).toEqual({ kind: 'unit', id: 'unit-1' });
    expect(panel().includeOlder).toBe(true);
    act(() => panel().onAnchorChange({ kind: 'tenant', id: 'contact-1' }));
    expect(screen.getByTestId('location')).toHaveTextContent('rank=tenant%3Acontact-1');
    act(() => panel().onIncludeOlderChange(false));
    expect(screen.getByTestId('location')).not.toHaveTextContent('older=');
    act(() => panel().onAnchorChange(undefined));
    expect(screen.getByTestId('location')).not.toHaveTextContent('rank=');
  });

  it('Show runs for this anchor filters the run list; All anchors clears it', async () => {
    renderSection('/settings/rankings?from=2026-07-01');
    expect(useRankingRunList).toHaveBeenLastCalledWith({ from: '2026-07-01', to: undefined, anchor: undefined });
    act(() => panel().onShowRuns({ kind: 'unit', id: 'unit-1' }));
    expect(screen.getByTestId('location')).toHaveTextContent('anchor=unit%3Aunit-1');
    expect(useRankingRunList).toHaveBeenLastCalledWith({ from: '2026-07-01', to: undefined, anchor: { kind: 'unit', id: 'unit-1' } });
    expect(screen.getByText(/Anchor: 12 Oak St, Atlanta/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'All anchors' }));
    expect(screen.getByTestId('location')).not.toHaveTextContent('anchor=');
  });

  it('opening a run puts it in the URL and reads its detail', async () => {
    renderSection();
    await userEvent.click(within(screen.getByRole('list', { name: 'Ranking runs' })).getByRole('button'));
    expect(screen.getByTestId('location')).toHaveTextContent('run=run-1');
    expect(useRankingRun).toHaveBeenLastCalledWith('run-1');
  });

  it("notes the 12 weeks ending To's week when only To is set (plan review R2B6)", () => {
    renderSection('/settings/rankings?to=2026-07-31');
    expect(screen.getByRole('region', { name: 'Cost by week' })).toHaveTextContent('The 12 weeks ending the week of 2026-07-31.');
    expect(useRankingCost).toHaveBeenLastCalledWith({ from: undefined, to: '2026-07-31' });
  });

  it('stores the date range in the URL and gives it to the cost totals', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByLabelText('From'), '2026-07-01');
    expect(screen.getByTestId('location')).toHaveTextContent('from=2026-07-01');
    expect(useRankingCost).toHaveBeenLastCalledWith({ from: '2026-07-01', to: undefined });
  });

  it('Refresh reads the runs and the cost again', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(listRetry).toHaveBeenCalledTimes(1);
    expect(costRetry).toHaveBeenCalledTimes(1);
  });
});
