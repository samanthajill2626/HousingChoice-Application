// Boards tests — render the kanban columns + a card from a mocked listCases,
// and the live-update guarantee: a `case.updated` SSE event MOVES a card to the
// new stage column (in place, no refetch). Mock listCases + useEventStream
// (capture the handlers); keep useApi + ApiError real. No network.
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaseItem, CasesPage, CaseUpdatedEvent, EventStreamHandlers } from '../api/index.js';

const api = vi.hoisted(() => ({
  listCases: vi.fn(),
  eventHandlers: { current: undefined as EventStreamHandlers | undefined },
}));

vi.mock('../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../api/index.js')>();
  return {
    ...actual,
    listCases: api.listCases,
    useEventStream: (handlers: EventStreamHandlers) => {
      api.eventHandlers.current = handlers;
    },
  };
});

const { default: Boards } = await import('./Boards.js');

function caseItem(over: Partial<CaseItem> = {}): CaseItem {
  return {
    caseId: 'case-1',
    tenantId: 't1',
    unitId: 'u1',
    stage: 'interested',
    placement_tag: 'Smith → Maple St',
    created_at: '2026-06-14T00:00:00.000Z',
    updated_at: '2026-06-14T00:00:00.000Z',
    ...over,
  };
}

function page(cases: CaseItem[], nextCursor: string | null = null): CasesPage {
  return { cases, nextCursor };
}

function event(over: Partial<CaseUpdatedEvent> = {}): CaseUpdatedEvent {
  return {
    caseId: 'case-1',
    tenantId: 't1',
    unitId: 'u1',
    stage: 'touring',
    tour_date: null,
    next_deadline_type: null,
    next_deadline_at: null,
    group_thread: null,
    attention: false,
    lost_reason: null,
    updated_at: '2026-06-14T01:00:00.000Z',
    ...over,
  };
}

function renderScreen(): void {
  render(
    <MemoryRouter initialEntries={['/boards']}>
      <Boards />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.listCases.mockReset();
  api.eventHandlers.current = undefined;
});

describe('<Boards>', () => {
  it('renders the stage columns and a case card', async () => {
    api.listCases.mockResolvedValue(page([caseItem()]));
    renderScreen();

    expect(await screen.findByText('Boards')).toBeInTheDocument();
    // Every stage renders a column (stable board) — assert a couple by aria-label.
    expect(screen.getByLabelText('Interested')).toBeInTheDocument();
    expect(screen.getByLabelText('Touring')).toBeInTheDocument();

    // The card shows the placement_tag, under the Interested column, linking to detail.
    const interested = screen.getByLabelText('Interested');
    const card = within(interested).getByText('Smith → Maple St');
    expect(card).toBeInTheDocument();
    const link = within(interested).getByRole('link', { name: /Smith → Maple St/ });
    expect(link).toHaveAttribute('href', '/boards/case-1');
  });

  it('moves a card to the new stage column on a case.updated SSE event (live update)', async () => {
    api.listCases.mockResolvedValue(page([caseItem()]));
    renderScreen();
    await screen.findByText('Boards');

    // Initially under Interested, NOT under Touring.
    expect(
      within(screen.getByLabelText('Interested')).queryByText('Smith → Maple St'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Touring')).queryByText('Smith → Maple St'),
    ).not.toBeInTheDocument();

    // Fire the SSE event that moves the case to 'touring'.
    act(() => {
      api.eventHandlers.current?.onCaseUpdated?.(event({ stage: 'touring' }));
    });

    // The card now lives under Touring and is gone from Interested — no refetch.
    expect(
      within(screen.getByLabelText('Touring')).getByText('Smith → Maple St'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Interested')).queryByText('Smith → Maple St'),
    ).not.toBeInTheDocument();
    expect(api.listCases).toHaveBeenCalledTimes(1);
  });

  it('flips a card to "Needs attention" live on a case.updated event', async () => {
    api.listCases.mockResolvedValue(page([caseItem()]));
    renderScreen();
    await screen.findByText('Boards');
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();

    act(() => {
      api.eventHandlers.current?.onCaseUpdated?.(event({ stage: 'interested', attention: true }));
    });

    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('refetches the first page on an event for an unknown case', async () => {
    api.listCases.mockResolvedValueOnce(page([caseItem({ caseId: 'case-1' })]));
    renderScreen();
    await screen.findByText('Boards');

    api.listCases.mockResolvedValueOnce(
      page([caseItem({ caseId: 'case-1' }), caseItem({ caseId: 'case-2', placement_tag: 'New deal' })]),
    );
    act(() => {
      api.eventHandlers.current?.onCaseUpdated?.(event({ caseId: 'case-2', stage: 'interested' }));
    });

    expect(await screen.findByText('New deal')).toBeInTheDocument();
    expect(api.listCases).toHaveBeenCalledTimes(2);
  });

  it('shows the empty state when there are no cases', async () => {
    api.listCases.mockResolvedValue(page([]));
    renderScreen();
    expect(await screen.findByText('No cases yet')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const { ApiError } = await import('../api/index.js');
    api.listCases.mockRejectedValueOnce(new ApiError(500, 'boom', 'boom'));
    renderScreen();
    expect(await screen.findByText("Couldn't load the board")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
