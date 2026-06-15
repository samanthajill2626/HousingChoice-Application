// BoardDetail tests — render a mocked getCase; changing the stage <select> +
// Save calls updateCase with the new stage; the "Set up relay thread" button
// calls setUpCaseRelay and, on success, surfaces a link to the conversation.
// Mock getCase/getContact/getUnit/updateCase/setUpCaseRelay + useEventStream
// (capture handlers); keep useApi + ApiError real. No network.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CaseItem,
  CaseUpdatedEvent,
  Contact,
  Conversation,
  EventStreamHandlers,
  UnitItem,
} from '../api/index.js';

const api = vi.hoisted(() => ({
  getCase: vi.fn(),
  getContact: vi.fn(),
  getUnit: vi.fn(),
  updateCase: vi.fn(),
  setCaseDeadline: vi.fn(),
  setUpCaseRelay: vi.fn(),
  eventHandlers: { current: undefined as EventStreamHandlers | undefined },
}));

vi.mock('../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../api/index.js')>();
  return {
    ...actual,
    getCase: api.getCase,
    getContact: api.getContact,
    getUnit: api.getUnit,
    updateCase: api.updateCase,
    setCaseDeadline: api.setCaseDeadline,
    setUpCaseRelay: api.setUpCaseRelay,
    useEventStream: (handlers: EventStreamHandlers) => {
      api.eventHandlers.current = handlers;
    },
  };
});

// The Toast provider is required by useToast; render under a real provider.
const { ToastProvider } = await import('../ui/index.js');
const { default: BoardDetail } = await import('./BoardDetail.js');

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

function contact(over: Partial<Contact> = {}): Contact {
  return { contactId: 't1', type: 'tenant', firstName: 'Sam', lastName: 'Smith', ...over };
}

function unit(over: Partial<UnitItem> = {}): UnitItem {
  return { unitId: 'u1', landlordId: 'k1', status: 'available', address: '5 Maple St', ...over };
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: 'conv-9',
    participant_phone: '+13135550000',
    status: 'open',
    last_activity_at: '2026-06-14T00:00:00.000Z',
    type: 'relay_group',
    ai_mode: 'manual',
    created_at: '2026-06-14T00:00:00.000Z',
    ...over,
  };
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
    updated_at: '2026-06-14T02:00:00.000Z',
    ...over,
  };
}

function renderScreen(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/boards/case-1']}>
        <Routes>
          <Route path="/boards/:caseId" element={<BoardDetail />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  api.getCase.mockReset();
  api.getContact.mockReset();
  api.getUnit.mockReset();
  api.updateCase.mockReset();
  api.setCaseDeadline.mockReset();
  api.setUpCaseRelay.mockReset();
  api.eventHandlers.current = undefined;
  api.getContact.mockResolvedValue(contact());
  api.getUnit.mockResolvedValue(unit());
});

describe('<BoardDetail>', () => {
  it('renders the case with its stage and hydrated party names', async () => {
    api.getCase.mockResolvedValue(caseItem());
    renderScreen();

    const heading = await screen.findByRole('heading', { name: 'Smith → Maple St' });
    const header = heading.closest('header') as HTMLElement;
    // Hydrated tenant name + listing address appear in the header lead line.
    await waitFor(() => expect(within(header).getByText(/Sam Smith/)).toBeInTheDocument());
    expect(within(header).getByText(/5 Maple St/)).toBeInTheDocument();
    // The stage badge renders in the header.
    expect(within(header).getByText('Interested')).toBeInTheDocument();
  });

  it('changes the stage <select> and Save calls updateCase with the new stage', async () => {
    api.getCase.mockResolvedValue(caseItem());
    api.updateCase.mockResolvedValue(caseItem({ stage: 'applied' }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Smith → Maple St' });

    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'applied' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save stage' }));

    await waitFor(() =>
      expect(api.updateCase).toHaveBeenCalledWith('case-1', { stage: 'applied' }),
    );
  });

  it('schedules a tour via updateCase({ tour_date })', async () => {
    api.getCase.mockResolvedValue(caseItem());
    api.updateCase.mockResolvedValue(caseItem({ tour_date: '2026-07-01' }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Smith → Maple St' });

    fireEvent.change(screen.getByLabelText('Tour date'), { target: { value: '2026-07-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tour' }));

    await waitFor(() =>
      expect(api.updateCase).toHaveBeenCalledWith('case-1', { tour_date: '2026-07-01' }),
    );
  });

  it('clears the tour via updateCase({ tour_date: null })', async () => {
    api.getCase.mockResolvedValue(caseItem({ tour_date: '2026-07-01' }));
    api.updateCase.mockResolvedValue(caseItem());
    renderScreen();
    await screen.findByRole('heading', { name: 'Smith → Maple St' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear tour' }));
    await waitFor(() =>
      expect(api.updateCase).toHaveBeenCalledWith('case-1', { tour_date: null }),
    );
  });

  it('sets up a relay thread and surfaces a link to the conversation on success', async () => {
    api.getCase.mockResolvedValue(caseItem());
    api.setUpCaseRelay.mockResolvedValue({
      conversation: conversation({ conversationId: 'conv-9' }),
      case: caseItem({ group_thread: 'conv-9' }),
    });
    renderScreen();
    await screen.findByRole('heading', { name: 'Smith → Maple St' });

    fireEvent.click(screen.getByRole('button', { name: 'Set up relay thread' }));

    await waitFor(() => expect(api.setUpCaseRelay).toHaveBeenCalledWith('case-1'));
    const link = await screen.findByRole('link', { name: 'Open relay thread' });
    expect(link).toHaveAttribute('href', '/conversations/conv-9');
  });

  it('links to the existing conversation on a 409 relay_exists', async () => {
    const { ApiError } = await import('../api/index.js');
    api.getCase.mockResolvedValue(caseItem());
    api.setUpCaseRelay.mockRejectedValueOnce(
      new ApiError(409, 'relay_exists', 'relay_exists', {
        error: 'relay_exists',
        conversation: conversation({ conversationId: 'conv-existing' }),
      }),
    );
    renderScreen();
    await screen.findByRole('heading', { name: 'Smith → Maple St' });

    fireEvent.click(screen.getByRole('button', { name: 'Set up relay thread' }));

    const link = await screen.findByRole('link', { name: 'Open relay thread' });
    expect(link).toHaveAttribute('href', '/conversations/conv-existing');
    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
  });

  it('shows the disabled message on a 503 relay_provisioning_disabled', async () => {
    const { ApiError } = await import('../api/index.js');
    api.getCase.mockResolvedValue(caseItem());
    api.setUpCaseRelay.mockRejectedValueOnce(
      new ApiError(503, 'relay_provisioning_disabled', 'relay_provisioning_disabled'),
    );
    renderScreen();
    await screen.findByRole('heading', { name: 'Smith → Maple St' });

    fireEvent.click(screen.getByRole('button', { name: 'Set up relay thread' }));
    expect(await screen.findByText(/disabled until A2P approval/i)).toBeInTheDocument();
  });

  it('shows an existing relay link when group_thread is already set', async () => {
    api.getCase.mockResolvedValue(caseItem({ group_thread: 'conv-linked' }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Smith → Maple St' });

    const link = screen.getByRole('link', { name: 'Open relay thread' });
    expect(link).toHaveAttribute('href', '/conversations/conv-linked');
  });

  it('clears the attention flag via updateCase({ attention: null })', async () => {
    api.getCase.mockResolvedValue(
      caseItem({ attention: { reason: 'failed send', at: '2026-06-14T00:00:00.000Z' } }),
    );
    api.updateCase.mockResolvedValue(caseItem());
    renderScreen();
    await screen.findByRole('heading', { name: 'Smith → Maple St' });

    expect(screen.getByText(/failed send/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear attention' }));
    await waitFor(() =>
      expect(api.updateCase).toHaveBeenCalledWith('case-1', { attention: null }),
    );
  });

  it('patches the displayed stage live on a scoped case.updated event', async () => {
    api.getCase.mockResolvedValue(caseItem({ stage: 'interested' }));
    renderScreen();
    const header = (await screen.findByRole('heading', { name: 'Smith → Maple St' })).closest(
      'header',
    ) as HTMLElement;
    expect(within(header).getByText('Interested')).toBeInTheDocument();

    act(() => {
      api.eventHandlers.current?.onCaseUpdated?.(event({ stage: 'touring' }));
    });

    expect(within(header).getByText('Touring')).toBeInTheDocument();
  });

  it('shows a not-found state for a missing case', async () => {
    const { ApiError } = await import('../api/index.js');
    api.getCase.mockRejectedValueOnce(new ApiError(404, 'case_not_found', 'case_not_found'));
    renderScreen();
    expect(await screen.findByText('Case not found')).toBeInTheDocument();
  });
});
