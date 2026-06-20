import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaseUpdatedEvent, EventStreamHandlers, HistoryRow } from '../../api/index.js';

const getPlacementHistory = vi.fn();
// Capture the handlers useCaseHistory registers so a test can fire case.updated.
let streamHandlers: EventStreamHandlers | null = null;

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getPlacementHistory: (...a: unknown[]) => getPlacementHistory(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { useCaseHistory } from './useCaseHistory.js';

function row(over: Partial<HistoryRow>): HistoryRow {
  return { entityKey: 'case#c1', event_type: 'stage_changed', ts: '2026-06-18T13:00:00Z', ...over };
}

function Probe({ caseId }: { caseId: string }): React.JSX.Element {
  const s = useCaseHistory(caseId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.rows.length}</span>
      <span data-testid="types">{s.rows.map((r) => r.event_type).join(',')}</span>
    </div>
  );
}

const evt = (caseId: string): CaseUpdatedEvent => ({
  caseId,
  tenantId: 't1',
  unitId: 'u1',
  stage: 'schedule_inspection',
  tour_date: null,
  next_deadline_type: null,
  next_deadline_at: null,
  group_thread: null,
  attention: false,
  lost_reason: null,
  updated_at: null,
});

beforeEach(() => {
  getPlacementHistory.mockReset();
  streamHandlers = null;
});
afterEach(() => vi.restoreAllMocks());

describe('useCaseHistory', () => {
  it('loads the initial newest page', async () => {
    getPlacementHistory.mockResolvedValue([row({ event_type: 'created' })]);
    render(<Probe caseId="c1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(getPlacementHistory).toHaveBeenCalledTimes(1);
  });

  it('refetches the newest page when a case.updated event for this case arrives', async () => {
    getPlacementHistory.mockResolvedValueOnce([row({ event_type: 'created' })]);
    render(<Probe caseId="c1" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));

    // A transition lands → the SSE event fires → the panel refetches, now showing
    // the new audit row WITHOUT a manual reload.
    getPlacementHistory.mockResolvedValueOnce([
      row({ event_type: 'stage_changed' }),
      row({ event_type: 'created' }),
    ]);
    act(() => streamHandlers?.onCaseUpdated?.(evt('c1')));

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(screen.getByTestId('types')).toHaveTextContent('stage_changed,created');
    expect(getPlacementHistory).toHaveBeenCalledTimes(2);
  });

  it('ignores a case.updated event for a different case', async () => {
    getPlacementHistory.mockResolvedValue([row({ event_type: 'created' })]);
    render(<Probe caseId="c1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    act(() => streamHandlers?.onCaseUpdated?.(evt('other-case')));
    // No refetch for an unrelated case.
    expect(getPlacementHistory).toHaveBeenCalledTimes(1);
  });
});
