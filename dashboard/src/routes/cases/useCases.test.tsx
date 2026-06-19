import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaseUpdatedEvent, EventStreamHandlers } from '../../api/index.js';

const getCases = vi.fn();
const getContacts = vi.fn();
const getUnits = vi.fn();
// Capture the handlers useCases registers so a test can fire a case.updated event.
let streamHandlers: EventStreamHandlers | null = null;

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getCases: (...a: unknown[]) => getCases(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { useCases } from './useCases.js';

function Probe(): React.JSX.Element {
  const s = useCases();
  const c1 = s.cases.find((c) => c.caseId === 'c1');
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.cases.length}</span>
      <span data-testid="stage">{s.cases[0]?.stage ?? '-'}</span>
      <span data-testid="ids">{s.cases.map((c) => c.caseId).join(',')}</span>
      <span data-testid="attention">{c1?.attention ? 'yes' : 'no'}</span>
      <span data-testid="deadline">{c1?.next_deadline_at ?? '-'}</span>
    </div>
  );
}

beforeEach(() => {
  getCases.mockReset();
  getContacts.mockReset();
  getUnits.mockReset();
  streamHandlers = null;
  getContacts.mockResolvedValue({ contacts: [], nextCursor: null });
  getUnits.mockResolvedValue({ units: [], nextCursor: null });
});
afterEach(() => vi.restoreAllMocks());

describe('useCases', () => {
  it('loads cases into a ready state', async () => {
    getCases.mockResolvedValue({
      cases: [{ caseId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'collect_rta' }],
      nextCursor: null,
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('stage')).toHaveTextContent('collect_rta');
  });

  it('goes to error when the cases fetch fails', async () => {
    getCases.mockRejectedValue(new Error('boom'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('repositions a card on a case.updated SSE event (patches the stage in place)', async () => {
    getCases.mockResolvedValue({
      cases: [{ caseId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'collect_rta' }],
      nextCursor: null,
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('collect_rta'));

    const ev: CaseUpdatedEvent = {
      caseId: 'c1',
      tenantId: 't1',
      unitId: 'u1',
      stage: 'awaiting_inspection',
      tour_date: null,
      next_deadline_type: null,
      next_deadline_at: null,
      group_thread: null,
      attention: false,
      lost_reason: null,
      updated_at: '2026-06-19T00:00:00Z',
    };
    act(() => streamHandlers?.onCaseUpdated?.(ev));
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('awaiting_inspection'));
  });

  it('M2: an SSE event flips attention on and clears a deadline (null)', async () => {
    getCases.mockResolvedValue({
      cases: [
        {
          caseId: 'c1',
          tenantId: 't1',
          unitId: 'u1',
          stage: 'collect_rta',
          next_deadline_type: 'rta_window',
          next_deadline_at: '2026-06-25T00:00:00Z',
        },
      ],
      nextCursor: null,
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // Initially: not flagged, a deadline present.
    expect(screen.getByTestId('attention')).toHaveTextContent('no');
    expect(screen.getByTestId('deadline')).toHaveTextContent('2026-06-25T00:00:00Z');

    const ev: CaseUpdatedEvent = {
      caseId: 'c1',
      tenantId: 't1',
      unitId: 'u1',
      stage: 'collect_rta',
      tour_date: null,
      next_deadline_type: null, // cleared
      next_deadline_at: null, // cleared
      group_thread: null,
      attention: true, // flipped on
      lost_reason: null,
      updated_at: '2026-06-19T00:00:00Z',
    };
    act(() => streamHandlers?.onCaseUpdated?.(ev));

    // Attention dot lights up; the cleared deadline is removed (not kept).
    await waitFor(() => expect(screen.getByTestId('attention')).toHaveTextContent('yes'));
    expect(screen.getByTestId('deadline')).toHaveTextContent('-');
  });

  it('M3: pages through ALL cases (page-2 cases appear on the board)', async () => {
    getCases.mockImplementation((_signal: unknown, cursor?: string) =>
      cursor === undefined
        ? Promise.resolve({
            cases: [{ caseId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'collect_rta' }],
            nextCursor: 'CUR2',
          })
        : Promise.resolve({
            cases: [{ caseId: 'c2', tenantId: 't2', unitId: 'u2', stage: 'determine_rent' }],
            nextCursor: null,
          }),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // Both the page-1 AND the page-2 case are present.
    expect(screen.getByTestId('count')).toHaveTextContent('2');
    expect(screen.getByTestId('ids')).toHaveTextContent('c1,c2');
    // The second call followed the cursor.
    expect(getCases).toHaveBeenCalledTimes(2);
    expect(getCases).toHaveBeenLastCalledWith(expect.anything(), 'CUR2');
  });
});
