import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CaseItem, HistoryRow, UnitItem } from '../../api/index.js';

const getCase = vi.fn();
const getUnit = vi.fn();
const getContact = vi.fn();
const transitionPlacement = vi.fn();
const getPlacementHistory = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getCase: (...a: unknown[]) => getCase(...a),
    getUnit: (...a: unknown[]) => getUnit(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    transitionPlacement: (...a: unknown[]) => transitionPlacement(...a),
    getPlacementHistory: (...a: unknown[]) => getPlacementHistory(...a),
  };
});

import { CaseDetail } from './CaseDetail.js';

const CASE: CaseItem = {
  caseId: 'c1',
  tenantId: 't1',
  unitId: 'u1',
  stage: 'awaiting_inspection',
  stage_entered_at: '2026-06-18T13:02:00Z',
};

const UNIT: UnitItem = {
  unitId: 'u1',
  landlordId: 'l1',
  status: 'under_application',
  address: { line1: '12 Oak St' },
  final_rent: 1550,
};

function row(over: Partial<HistoryRow>): HistoryRow {
  return { entityKey: 'case#c1', event_type: 'stage_changed', ts: '2026-06-18T13:02:00Z', ...over };
}

function renderAt(): void {
  render(
    <MemoryRouter initialEntries={['/cases/c1']}>
      <Routes>
        <Route path="/cases/:caseId" element={<CaseDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getCase.mockReset().mockResolvedValue(CASE);
  getUnit.mockReset().mockResolvedValue(UNIT);
  getContact
    .mockReset()
    .mockResolvedValue({ contactId: 't1', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen' });
  transitionPlacement.mockReset();
  getPlacementHistory.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('CaseDetail', () => {
  it('renders the stage, phase, links, time-in-stage, inspection + final rent', async () => {
    getCase.mockResolvedValue({ ...CASE, inspection_outcome: 'pass' });
    renderAt();
    const heading = await screen.findByRole('heading', { name: /Awaiting inspection/ });
    // The phase chip "Inspection" lives inside the heading.
    expect(within(heading).getByText('Inspection')).toBeInTheDocument();
    // M4: the Tenant link shows the contact NAME, not the raw id.
    expect(screen.getByRole('link', { name: 'Tasha Nguyen' })).toHaveAttribute('href', '/contacts/t1');
    expect(screen.getByRole('link', { name: '12 Oak St' })).toHaveAttribute('href', '/listings/u1');
    expect(screen.getByText('Pass')).toBeInTheDocument();
    expect(screen.getByText('$1,550/mo')).toBeInTheDocument();
  });

  it('M4: degrades the Tenant link to the raw id when the contact cannot be loaded', async () => {
    getContact.mockRejectedValue(new Error('not found'));
    renderAt();
    await screen.findByRole('heading', { name: /Awaiting inspection/ });
    expect(screen.getByRole('link', { name: 't1' })).toHaveAttribute('href', '/contacts/t1');
  });

  it('renders history rows newest-first and loads more with the before cursor', async () => {
    const first = Array.from({ length: 20 }, (_, i) =>
      row({
        event_type: 'case_stage_changed',
        ts: `2026-06-18T13:${String(20 - i).padStart(2, '0')}:00Z`,
        payload: { from: 'collect_rta', to: i === 0 ? 'review_rta' : `stage-${i}`, source: 'manual' },
      }),
    );
    getPlacementHistory.mockResolvedValueOnce(first);
    getPlacementHistory.mockResolvedValueOnce([
      row({
        event_type: 'case_stage_changed',
        ts: '2026-06-10T00:00:00Z',
        payload: { from: 'send_application', to: 'collect_rta', source: 'import' },
      }),
    ]);
    renderAt();

    // Stages are LABELED via STAGE_LABELS, not shown as raw snake_case.
    await waitFor(() => expect(screen.getByText(/Collect RTA → Review RTA/)).toBeInTheDocument());
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    const user = userEvent.setup();
    await user.click(loadMore);

    await waitFor(() => expect(screen.getByText(/Send application → Collect RTA/)).toBeInTheDocument());
    // The second call passed the before cursor = the oldest loaded row's ts.
    expect(getPlacementHistory).toHaveBeenLastCalledWith(
      'c1',
      expect.objectContaining({ before: first[first.length - 1]!.ts }),
      expect.anything(),
    );
  });

  it('a move out of awaiting_inspection prompts for the outcome before transitioning', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue({ ...CASE, stage: 'determine_rent' });
    renderAt();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Awaiting inspection/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByRole('combobox', { name: 'Move to stage' }), 'determine_rent');
    expect(screen.getByRole('heading', { name: 'Record inspection outcome' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    await user.click(screen.getByRole('radio', { name: 'Fail' }));
    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'determine_rent',
        source: 'manual',
        inspectionOutcome: 'fail',
      }),
    );
  });

  it('the finalRent prompt rejects ≤0', async () => {
    const user = userEvent.setup();
    getCase.mockResolvedValue({ ...CASE, stage: 'awaiting_rent_acceptance' });
    renderAt();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Awaiting rent acceptance/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByRole('combobox', { name: 'Move to stage' }), 'awaiting_hap_contract');
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText(/Final contract rent/i);
    await user.type(input, '0');
    expect(within(dialog).getByRole('button', { name: 'Confirm move' })).toBeDisabled();
    expect(transitionPlacement).not.toHaveBeenCalled();
  });
});
