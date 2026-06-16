// App shell integration-ish tests. The control client + SSE hook are mocked at
// the package boundary so the test can: (a) assert the dev banner + roster
// render from the loaded personas; (b) select a persona and see its thread in
// the PhonePanel; (c) type + Send and assert client.sendAsParty is called with
// { from: <selected number>, body }; and (d) drive a live message.updated SSE
// event and watch the message's StatusChip flip to "delivered". Components are
// real (we only mock the boundaries — fetch/EventSource).
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, Persona, Thread, ThreadMessage } from '../api/types.js';

// ---- Boundary mocks ---------------------------------------------------------

let capturedOnEvent: ((e: EngineEvent) => void) | undefined;

vi.mock('../api/useFakeEvents.js', () => ({
  useFakeEvents: (handlers: { onEvent: (e: EngineEvent) => void }) => {
    capturedOnEvent = handlers.onEvent;
  },
}));

const personas: Persona[] = [
  { id: 'a', label: 'Ana Tenant', role: 'tenant', number: '+15550100001', adHoc: false },
  { id: 'b', label: 'Bob Landlord', role: 'landlord', number: '+15550100002', adHoc: false },
];

const seededMsg: ThreadMessage = {
  sid: 'SMoutbound',
  direction: 'outbound',
  from: '+15550009999',
  to: '+15550100001',
  body: 'Welcome to your new home',
  state: 'queued',
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z',
};
const threads: Thread[] = [{ partyNumber: '+15550100001', messages: [seededMsg] }];

const sendAsParty = vi.fn(async () => 'SMx');
const setDeliveryOutcome = vi.fn(async () => undefined);
const addAdHoc = vi.fn(async () => personas[0]!);

vi.mock('../api/client.js', () => ({
  getPersonas: vi.fn(async () => personas),
  getThreads: vi.fn(async () => threads),
  sendAsParty: (...args: unknown[]) => sendAsParty(...(args as [])),
  addAdHoc: (...args: unknown[]) => addAdHoc(...(args as [])),
  setDeliveryOutcome: (...args: unknown[]) => setDeliveryOutcome(...(args as [])),
  resetAll: vi.fn(async () => undefined),
}));

import { App } from './App.js';

beforeEach(() => {
  capturedOnEvent = undefined;
});
afterEach(() => vi.clearAllMocks());

describe('App shell', () => {
  it('shows the dev banner', async () => {
    render(<App />);
    expect(await screen.findByText(/no real messages are sent/i)).toBeVisible();
  });

  it('lists a seeded persona in the roster', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: /Ana Tenant/ })).toBeVisible();
  });

  it('shows an empty state until a persona is selected', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /Ana Tenant/ });
    // No conversation log yet.
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.getByText(/select a persona/i)).toBeVisible();
  });

  it('selecting a persona renders the PhonePanel with its thread', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Ana Tenant/ }));

    // Header shows the selected persona label + number.
    const log = await screen.findByRole('log');
    expect(log).toBeVisible();
    expect(screen.getByText('Welcome to your new home')).toBeVisible();
    // The number appears in the panel header.
    expect(screen.getAllByText('+15550100001').length).toBeGreaterThan(0);
  });

  it('typing + Send calls sendAsParty with { from: <number>, body }', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Ana Tenant/ }));

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello there');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(sendAsParty).toHaveBeenCalledWith(
      expect.objectContaining({ from: '+15550100001', body: 'hello there' }),
    );
  });

  it('surfaces an error and keeps the typed message when sendAsParty rejects', async () => {
    const user = userEvent.setup();
    sendAsParty.mockRejectedValueOnce(new Error('sendAsParty: mediaUrl … is not an http(s) URL'));
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Ana Tenant/ }));

    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'see this photo');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // The failure is shown (not silently swallowed) …
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not an http\(s\) URL/i);
    // … and the message is preserved for a retry.
    expect(box).toHaveValue('see this photo');
  });

  it('a message.updated SSE event flips a message StatusChip to delivered', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Ana Tenant/ }));

    // The seeded outbound message starts queued. The StatusChip is no longer a
    // live region (the conversation log announces updates), so reach it by text.
    expect(await screen.findByText('Queued')).toBeVisible();

    act(() =>
      capturedOnEvent?.({
        type: 'message.updated',
        partyNumber: '+15550100001',
        message: { ...seededMsg, state: 'delivered', updatedAt: '2026-06-15T00:01:00.000Z' },
      }),
    );

    await waitFor(() => expect(screen.getByText('Delivered')).toBeVisible());
  });
});
