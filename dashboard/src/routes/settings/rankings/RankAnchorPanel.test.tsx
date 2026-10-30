import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, RankingJobView, RankingReadResponse, UnitItem } from '../../../api/index.js';
import type { AnchorRankingState } from './useAnchorRanking.js';
import type { RankCandidates } from './useRankCandidates.js';

const useAnchorRanking = vi.fn();
const useRankCandidates = vi.fn();

vi.mock('./useAnchorRanking.js', () => ({
  useAnchorRanking: (...args: unknown[]) => useAnchorRanking(...args),
}));
vi.mock('./useRankCandidates.js', () => ({
  useRankCandidates: (...args: unknown[]) => useRankCandidates(...args),
}));

import { RankAnchorPanel, type RankAnchorPanelProps } from './RankAnchorPanel.js';

const UNIT: UnitItem = {
  unitId: 'unit-1',
  status: 'available',
  address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30314' },
};
const TENANT: Contact = { contactId: 'contact-1', type: 'tenant', firstName: 'Ada', lastName: 'Ranked', phone: '+14045550101' };

const READ: RankingReadResponse = {
  anchor: {
    kind: 'unit',
    id: 'unit-1',
    display: '12 Oak St, Atlanta',
    anchorNotes: ['not_available'],
    missing: [{ key: 'rent', label: 'Rent' }],
    cardChanged: true,
  },
  job: null,
  poolWindowDays: 90,
  rows: [{ candidateId: 'contact-1', display: 'Ada Ranked', notScored: false, match: null }],
  flags: [{ unitId: 'unit-1', field: 'qualifications', reason: 'says no kids', raisedAt: '2026-07-01T10:00:00.000Z', runId: 'run-1' }],
};

function job(over: Partial<RankingJobView> = {}): RankingJobView {
  return {
    status: 'queued',
    generation: 'gen-1',
    includeOlder: false,
    requestedAt: '2026-07-01T12:00:00.000Z',
    batchCount: 0,
    batchesDone: [],
    failedBatches: [],
    notScored: [],
    ...over,
  };
}

function state(over: Partial<AnchorRankingState> = {}): AnchorRankingState {
  return {
    read: undefined,
    readStatus: 'idle',
    readError: null,
    poolWindowDays: null,
    job: null,
    joined: false,
    ranking: false,
    rankError: null,
    rank: vi.fn(),
    retryRead: vi.fn(),
    ...over,
  };
}

function props(over: Partial<RankAnchorPanelProps> = {}): RankAnchorPanelProps {
  return {
    anchor: undefined,
    includeOlder: false,
    onAnchorChange: vi.fn(),
    onIncludeOlderChange: vi.fn(),
    onShowRuns: vi.fn(),
    ...over,
  };
}

const UNIT_ANCHOR = { kind: 'unit', id: 'unit-1' } as const;
const WINDOW_LABEL = 'Include tenants not heard from in 90 days';

beforeEach(() => {
  useAnchorRanking.mockReset();
  useRankCandidates.mockReset();
  useAnchorRanking.mockReturnValue(state());
  const candidates: RankCandidates = { units: [UNIT], tenants: [TENANT], status: 'ready' };
  useRankCandidates.mockReturnValue(candidates);
});

describe('RankAnchorPanel', () => {
  it('starts on Property, and Rank is off until an anchor is picked', () => {
    render(<RankAnchorPanel {...props()} />);
    const panel = screen.getByRole('region', { name: 'Rank this anchor' });
    expect(within(panel).getByRole('heading', { name: 'Rank this anchor' })).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: 'Property' })).toBeChecked();
    expect(within(panel).getByRole('button', { name: 'Rank' })).toBeDisabled();
    expect(within(panel).getByText('Pick a property or a tenant to see its ranking.')).toBeInTheDocument();
    expect(useAnchorRanking).toHaveBeenLastCalledWith(undefined, false);
    // The window is known only from a read (plan PR26): no checkbox yet.
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('names the configured window in the checkbox once a read has answered (plan PR26)', () => {
    useAnchorRanking.mockReturnValue(state({ poolWindowDays: 60, readStatus: 'ready', read: { ...READ, poolWindowDays: 60 } }));
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    expect(screen.getByRole('checkbox', { name: 'Include tenants not heard from in 60 days' })).not.toBeChecked();
  });

  it('picking a property names it as the anchor', async () => {
    const onAnchorChange = vi.fn();
    render(<RankAnchorPanel {...props({ onAnchorChange })} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'Property to rank' }), 'Oak');
    await userEvent.click(screen.getByRole('option', { name: /12 Oak St/ }));
    expect(onAnchorChange).toHaveBeenLastCalledWith({ kind: 'unit', id: 'unit-1' });
  });

  it('Tenant swaps in the tenant search and drops the window checkbox', async () => {
    const onAnchorChange = vi.fn();
    useAnchorRanking.mockReturnValue(state({ poolWindowDays: 90 }));
    render(<RankAnchorPanel {...props({ onAnchorChange })} />);
    expect(screen.getByRole('checkbox', { name: WINDOW_LABEL })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Tenant' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox', { name: 'Tenant to rank' }), 'Ada');
    await userEvent.click(screen.getByRole('option', { name: /Ada Ranked/ }));
    expect(onAnchorChange).toHaveBeenLastCalledWith({ kind: 'tenant', id: 'contact-1' });
  });

  it('switching kind clears an anchor of the other kind', async () => {
    const onAnchorChange = vi.fn();
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR, onAnchorChange })} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Tenant' }));
    expect(onAnchorChange).toHaveBeenLastCalledWith(undefined);
  });

  it('a tenant anchor from the URL stays on Tenant when its field is cleared (WORKLIST WL-S7-4)', async () => {
    const onAnchorChange = vi.fn();
    const tenantAnchor = { kind: 'tenant', id: 'contact-1' } as const;
    const { rerender } = render(<RankAnchorPanel {...props({ anchor: tenantAnchor, onAnchorChange })} />);
    expect(screen.getByRole('radio', { name: 'Tenant' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Clear Tenant to rank' }));
    expect(onAnchorChange).toHaveBeenLastCalledWith(undefined);
    // The section owns the anchor (the URL) and drops it; the kind stays.
    rerender(<RankAnchorPanel {...props({ anchor: undefined, onAnchorChange })} />);
    expect(screen.getByRole('radio', { name: 'Tenant' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Tenant to rank' })).toHaveValue('');
    expect(screen.queryByRole('combobox', { name: 'Property to rank' })).not.toBeInTheDocument();
  });

  it('the window applies to a property anchor only', () => {
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR, includeOlder: true })} />);
    expect(useAnchorRanking).toHaveBeenLastCalledWith({ kind: 'unit', id: 'unit-1' }, true);
    render(<RankAnchorPanel {...props({ anchor: { kind: 'tenant', id: 'contact-1' }, includeOlder: true })} />);
    expect(useAnchorRanking).toHaveBeenLastCalledWith({ kind: 'tenant', id: 'contact-1' }, false);
  });

  it('ticking the checkbox reports the window choice', async () => {
    const onIncludeOlderChange = vi.fn();
    useAnchorRanking.mockReturnValue(state({ poolWindowDays: 90 }));
    render(<RankAnchorPanel {...props({ onIncludeOlderChange })} />);
    await userEvent.click(screen.getByRole('checkbox', { name: WINDOW_LABEL }));
    expect(onIncludeOlderChange).toHaveBeenCalledWith(true);
  });

  it('with an anchor, the field shows its display and Rank presses', async () => {
    const rank = vi.fn();
    useAnchorRanking.mockReturnValue(state({ rank, readStatus: 'ready', read: READ }));
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    expect(screen.getByRole('combobox', { name: 'Property to rank' })).toHaveValue('12 Oak St, Atlanta');
    await userEvent.click(screen.getByRole('button', { name: 'Rank' }));
    expect(rank).toHaveBeenCalledTimes(1);
  });

  it('shows the anchor notes, missing flags, card change and open flags as text, then the table', () => {
    useAnchorRanking.mockReturnValue(state({ readStatus: 'ready', read: READ }));
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    const facts = screen.getByRole('list', { name: 'About this anchor' });
    expect(facts).toHaveTextContent('This property is not available.');
    expect(facts).toHaveTextContent('Missing on this record: Rent');
    expect(facts).toHaveTextContent('This record changed since it was last ranked.');
    expect(facts).toHaveTextContent('Fair-housing flag on 12 Oak St, Atlanta, qualifications: says no kids');
    expect(screen.getByRole('table', { name: 'Ranking' })).toHaveTextContent('not ranked yet');
  });

  // Spec D10 rev 7 (charter item 16): a tenant anchor's ranking carries no
  // flag list - the server sends flags: [], and the panel shows none whatever
  // it is sent.
  it("a tenant anchor's ranking shows no fair-housing flag line", () => {
    const tenantRead: RankingReadResponse = {
      ...READ,
      anchor: { kind: 'tenant', id: 'contact-1', display: 'Ada Ranked', anchorNotes: [], missing: [], cardChanged: true },
      rows: [{ candidateId: 'unit-1', display: '12 Oak St, Atlanta', notScored: false, match: null }],
    };
    useAnchorRanking.mockReturnValue(state({ readStatus: 'ready', read: tenantRead }));
    render(<RankAnchorPanel {...props({ anchor: { kind: 'tenant', id: 'contact-1' } })} />);
    const facts = screen.getByRole('list', { name: 'About this anchor' });
    expect(facts).toHaveTextContent('This record changed since it was last ranked.');
    expect(facts).not.toHaveTextContent('Fair-housing flag');
    expect(screen.queryByText(/Fair-housing flag/)).not.toBeInTheDocument();
  });

  it('a pool over the ceiling shows the message instead of a table, the anchor block still read (plan PR16)', () => {
    useAnchorRanking.mockReturnValue(
      state({
        readStatus: 'ready',
        read: {
          ...READ,
          // FB4: over the ceiling the anchor's missing flags are still computed.
          anchor: { ...READ.anchor, missing: [{ key: 'payment_standard', label: 'Payment standard' }], cardChanged: false },
          rows: [],
          flags: [],
          // The pool's own text, sent by S6 (plan review BA3); shown verbatim.
          poolTooLarge: { size: 412, message: 'Pool too large to rank (412 candidates).' },
        },
      }),
    );
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    expect(screen.getByText('Pool too large to rank (412 candidates).')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'About this anchor' })).toHaveTextContent('This property is not available.');
    expect(screen.getByRole('list', { name: 'About this anchor' })).toHaveTextContent('Missing on this record: Payment standard');
    expect(screen.queryByRole('table', { name: 'Ranking' })).not.toBeInTheDocument();
  });

  it.each<[Partial<RankingJobView>, string]>([
    [{ status: 'queued' }, 'Waiting for a free slot'],
    [{ status: 'running', batchCount: 3, batchesDone: [0] }, 'Ranking: 1 of 3 batches finished'],
    [
      { status: 'done', batchCount: 2, batchesDone: [0], failedBatches: [{ index: 1, candidateIds: ['c'], failure: 'timeout' }] },
      'Done: 2 batches; 1 candidate not scored. Press Rank again.',
    ],
    [
      // PR43: a property anchor whose own reads failed after the pool.
      {
        status: 'done',
        poolSize: 2,
        batchCount: 0,
        notScored: [
          { candidateId: 't1', reason: 'unreadable' },
          { candidateId: 't2', reason: 'unreadable' },
        ],
        message: "Could not read this property's record. Press Rank again.",
      },
      "Done: 2 candidates not scored. Could not read this property's record. Press Rank again.",
    ],
  ])('shows the job status per batch (%o)', (over, text) => {
    useAnchorRanking.mockReturnValue(state({ readStatus: 'ready', read: READ, job: job(over) }));
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    expect(screen.getByRole('status', { name: 'Ranking job' })).toHaveTextContent(text);
  });

  it('after an unreadable tenant anchor, the rows read not scored - retry under the job message (plan PR38)', () => {
    const notScoredRead: RankingReadResponse = {
      ...READ,
      anchor: { kind: 'tenant', id: 'contact-1', display: 'Ada Ranked', anchorNotes: [], missing: [], cardChanged: false },
      job: job({
        status: 'done',
        poolSize: 1,
        batchCount: 0,
        notScored: [{ candidateId: 'unit-1', reason: 'unreadable' }],
        message: "Could not read this tenant's record. Press Rank again.",
      }),
      rows: [{ candidateId: 'unit-1', display: '12 Oak St, Atlanta', notScored: true, match: null }],
      flags: [],
    };
    useAnchorRanking.mockReturnValue(state({ readStatus: 'ready', read: notScoredRead, job: notScoredRead.job }));
    render(<RankAnchorPanel {...props({ anchor: { kind: 'tenant', id: 'contact-1' } })} />);
    expect(screen.getByRole('status', { name: 'Ranking job' })).toHaveTextContent(
      "Done: 1 candidate not scored. Could not read this tenant's record. Press Rank again.",
    );
    expect(screen.getByRole('table', { name: 'Ranking' })).toHaveTextContent('not scored - retry');
  });

  it('Rank is off while the job is queued or running, and on again once it ends', () => {
    useAnchorRanking.mockReturnValue(state({ readStatus: 'ready', read: READ, job: job({ status: 'running' }) }));
    const { rerender } = render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    expect(screen.getByRole('button', { name: 'Rank' })).toBeDisabled();
    useAnchorRanking.mockReturnValue(state({ readStatus: 'ready', read: READ, job: job({ status: 'done', batchCount: 0 }) }));
    rerender(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    expect(screen.getByRole('button', { name: 'Rank' })).toBeEnabled();
  });

  it('says when a press joined the job already running', () => {
    useAnchorRanking.mockReturnValue(state({ readStatus: 'ready', read: READ, job: job({ status: 'running' }), joined: true }));
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    expect(screen.getByRole('status', { name: 'Ranking job' })).toHaveTextContent('(joined the ranking already running)');
  });

  it('shows a refused press as an alert', () => {
    useAnchorRanking.mockReturnValue(
      state({ readStatus: 'ready', read: READ, rankError: 'A ranking is running for this record. Try again when it finishes.' }),
    );
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('A ranking is running for this record. Try again when it finishes.');
  });

  it('a read failure offers Retry', async () => {
    const retryRead = vi.fn();
    useAnchorRanking.mockReturnValue(state({ readStatus: 'error', readError: 'This record was not found.', retryRead }));
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This record was not found.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryRead).toHaveBeenCalledTimes(1);
  });

  it('Show runs for this anchor hands the anchor to the run list', async () => {
    const onShowRuns = vi.fn();
    useAnchorRanking.mockReturnValue(state({ readStatus: 'ready', read: READ }));
    render(<RankAnchorPanel {...props({ anchor: UNIT_ANCHOR, onShowRuns })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show runs for this anchor' }));
    expect(onShowRuns).toHaveBeenCalledWith({ kind: 'unit', id: 'unit-1' });
  });

  it('says when the property and tenant lists cannot load', () => {
    const failed: RankCandidates = { units: [], tenants: [], status: 'error' };
    useRankCandidates.mockReturnValue(failed);
    render(<RankAnchorPanel {...props()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('We could not load the properties and tenants to search. Reload the page to try again.');
  });
});
