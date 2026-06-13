// Create-relay-group flow test (M1.7). Mock createRelayGroup + navigation;
// assert the form POSTs the trimmed members and navigates to the new thread.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../api';

const api = vi.hoisted(() => ({
  createRelayGroup: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, createRelayGroup: api.createRelayGroup };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => api.navigate };
});

const NewRelayGroup = (await import('./NewRelayGroup')).default;
const { ToastProvider } = await import('../ui');

function renderForm(): void {
  render(
    <ToastProvider>
      <MemoryRouter>
        <NewRelayGroup />
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  api.createRelayGroup.mockReset();
  api.navigate.mockReset();
});

describe('<NewRelayGroup>', () => {
  it('creates a relay group from the filled member rows and navigates to the thread', async () => {
    const created: Conversation = {
      conversationId: 'conv-new',
      participant_phone: '+13135559000',
      status: 'open',
      last_activity_at: '2026-06-13T00:00:00Z',
      type: 'relay_group',
      ai_mode: 'manual',
      pool_number: '+13135559000',
      created_at: '2026-06-13T00:00:00Z',
    };
    api.createRelayGroup.mockResolvedValue(created);

    renderForm();

    // Two member rows render by default. (The Phone label carries a required
    // asterisk in its text, so match by regex.)
    const phones = screen.getAllByLabelText(/Phone/);
    const names = screen.getAllByLabelText('Name');
    expect(phones).toHaveLength(2);

    fireEvent.change(phones[0]!, { target: { value: ' +13135550001 ' } });
    fireEvent.change(names[0]!, { target: { value: ' Alice ' } });
    fireEvent.change(phones[1]!, { target: { value: '+14155550100' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create relay group' }));

    await waitFor(() =>
      expect(api.createRelayGroup).toHaveBeenCalledWith({
        members: [{ phone: '+13135550001', name: 'Alice' }, { phone: '+14155550100' }],
      }),
    );
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith('/conversations/conv-new'));
  });

  it('rejects an empty roster with an inline error and does not POST', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create relay group' }));

    expect(await screen.findByText(/add at least one member/i)).toBeInTheDocument();
    expect(api.createRelayGroup).not.toHaveBeenCalled();
  });

  it('can add another member row', async () => {
    renderForm();
    expect(screen.getAllByLabelText(/Phone/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Add another member' }));
    expect(screen.getAllByLabelText(/Phone/)).toHaveLength(3);
  });
});
