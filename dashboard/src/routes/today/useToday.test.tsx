import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { CasesPage, ConversationsPage, TodayResponse } from '../../api/index.js';

// Mock the api barrel: stub the three fetchers + capture the SSE handlers so the
// test can drive a live event. ApiError is re-exported real.
const getToday = vi.fn();
const getCases = vi.fn();
const getConversations = vi.fn();
let lastHandlers: { onCaseUpdated?: () => void; onConversationUpdated?: () => void } = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getToday: (...a: unknown[]) => getToday(...a),
    getCases: (...a: unknown[]) => getCases(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    useEventStream: (handlers: typeof lastHandlers) => {
      lastHandlers = handlers;
    },
  };
});

import { useToday } from './useToday.js';

function Probe(): React.JSX.Element {
  const { status, items, source } = useToday();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="source">{source}</span>
      <span data-testid="count">{items.length}</span>
      <span data-testid="first">{items[0]?.who ?? ''}</span>
    </div>
  );
}

const TODAY: TodayResponse = {
  generatedAt: '2026-06-16T12:00:00Z',
  items: [
    { group: 'needs_you_now', refType: 'case', refId: 'k1', who: 'Server Tasha', why: 'RTA' },
  ],
};

const CASES: CasesPage = {
  nextCursor: null,
  cases: [
    {
      caseId: 'k9',
      tenantId: 'Fallback Tenant',
      unitId: 'u9',
      stage: 'schedule_inspection',
      next_deadline_type: 'rta_window',
      next_deadline_at: '2999-01-01T00:00:00Z',
    },
  ],
};
const CONVERSATIONS: ConversationsPage = { nextCursor: null, conversations: [] };

beforeEach(() => {
  getToday.mockReset();
  getCases.mockReset();
  getConversations.mockReset();
  lastHandlers = {};
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useToday', () => {
  it('uses the server endpoint when /api/today succeeds', async () => {
    getToday.mockResolvedValue(TODAY);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('source')).toHaveTextContent('server');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('first')).toHaveTextContent('Server Tasha');
    expect(getCases).not.toHaveBeenCalled();
    // The browser owns "today": the server call carries the operator's LOCAL
    // calendar day (YYYY-MM-DD), not a UTC toISOString() date.
    expect(getToday).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.anything(),
    );
  });

  it('falls back to cases+conversations on a 404', async () => {
    getToday.mockRejectedValue(new ApiError(404, 'not_found', 'no'));
    getCases.mockResolvedValue(CASES);
    getConversations.mockResolvedValue(CONVERSATIONS);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('source')).toHaveTextContent('fallback');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('first')).toHaveTextContent('Fallback Tenant');
  });

  it('surfaces error status when the fallback itself fails', async () => {
    getToday.mockRejectedValue(new ApiError(404, 'not_found', 'no'));
    getCases.mockRejectedValue(new ApiError(500, 'boom', 'server error'));
    getConversations.mockResolvedValue(CONVERSATIONS);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('surfaces error status when /api/today fails with a non-404', async () => {
    getToday.mockRejectedValue(new ApiError(500, 'boom', 'server error'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(getCases).not.toHaveBeenCalled();
  });

  it('refetches when a case.updated event arrives', async () => {
    getToday.mockResolvedValue(TODAY);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getToday).toHaveBeenCalledTimes(1);

    getToday.mockResolvedValue({
      ...TODAY,
      items: [{ group: 'needs_you_now', refType: 'case', refId: 'k2', who: 'Updated', why: 'x' }],
    });
    lastHandlers.onCaseUpdated?.();
    await waitFor(() => expect(screen.getByTestId('first')).toHaveTextContent('Updated'));
    expect(getToday).toHaveBeenCalledTimes(2);
  });
});
