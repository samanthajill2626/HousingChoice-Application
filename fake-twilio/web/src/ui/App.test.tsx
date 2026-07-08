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
import type { EngineEvent, GroupSnapshot, Persona, Thread, ThreadMessage } from '../api/types.js';

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
// Mutable so group-flow tests can seed a relay group; reset in beforeEach.
let groups: GroupSnapshot[] = [];

const sendAsParty = vi.fn(async () => 'SMx');
const setDeliveryOutcome = vi.fn(async () => undefined);
const addAdHoc = vi.fn(async () => personas[0]!);

vi.mock('../api/client.js', () => ({
  getPersonas: vi.fn(async () => personas),
  getThreads: vi.fn(async () => threads),
  getGroups: vi.fn(async () => groups),
  sendAsParty: (...args: unknown[]) => sendAsParty(...(args as [])),
  addAdHoc: (...args: unknown[]) => addAdHoc(...(args as [])),
  setDeliveryOutcome: (...args: unknown[]) => setDeliveryOutcome(...(args as [])),
  resetAll: vi.fn(async () => undefined),
}));

import { App } from './App.js';

beforeEach(() => {
  capturedOnEvent = undefined;
  groups = [];
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

  it('reverts the delivery-profile radio to Normal after an outbound consumes the one-shot', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Ana Tenant/ }));

    // Arm "Fail" for the selected party.
    await user.click(screen.getByRole('radio', { name: /fail/i }));
    expect(screen.getByRole('radio', { name: /fail/i })).toBeChecked();
    expect(setDeliveryOutcome).toHaveBeenCalledWith('+15550100001', { kind: 'fail' });

    // An app→party OUTBOUND lands — the engine consumed the armed one-shot — so the
    // radio must stop claiming "Fail" is still armed.
    act(() =>
      capturedOnEvent?.({
        type: 'message.appended',
        partyNumber: '+15550100001',
        message: {
          ...seededMsg,
          sid: 'SMoutbound2',
          state: 'failed',
          errorCode: '30007',
          createdAt: '2026-06-15T00:02:00.000Z',
          updatedAt: '2026-06-15T00:02:00.000Z',
        },
      }),
    );

    await waitFor(() => expect(screen.getByRole('radio', { name: /normal/i })).toBeChecked());
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

// ---- Relay groups (Group texts) ----------------------------------------------

const relayGroup: GroupSnapshot = {
  poolNumber: '+15550160001',
  members: [
    { number: '+15550100001', label: 'Ana Tenant' },
    { number: '+15550100002', label: 'Bob Landlord' },
  ],
  entries: [],
  lastActivityAt: '2026-06-15T00:10:00.000Z',
};

describe('App shell — relay groups', () => {
  it('selecting a group opens the GroupPanel; persona and group selection are mutually exclusive', async () => {
    groups = [relayGroup];
    const user = userEvent.setup();
    render(<App />);
    // A persona first.
    await user.click(await screen.findByRole('button', { name: /Ana Tenant/ }));
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeVisible();
    // Selecting the group replaces the persona panel with the group panel.
    await user.click(screen.getByRole('button', { name: /\(555\) 016-0001/ }));
    expect(await screen.findByRole('log', { name: 'Group conversation' })).toBeVisible();
    expect(screen.queryByRole('log', { name: 'Conversation' })).toBeNull();
    // And selecting a persona again swaps back.
    await user.click(screen.getByRole('button', { name: /Ana Tenant/ }));
    expect(await screen.findByRole('log', { name: 'Conversation' })).toBeVisible();
    expect(screen.queryByRole('log', { name: 'Group conversation' })).toBeNull();
  });

  it('a group reply calls sendAsParty with from=<picked member> and to=<pool> (the real fan-out trigger)', async () => {
    groups = [relayGroup];
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /\(555\) 016-0001/ }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: /reply as/i }),
      '+15550100002',
    );
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi from Bob');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(sendAsParty).toHaveBeenCalledWith({
      from: '+15550100002',
      to: '+15550160001',
      body: 'hi from Bob',
    });
  });

  it('relay-group traffic is HIDDEN from the 1:1 pane (renders only in the GroupPanel)', async () => {
    // 2026-07-07 UX fix: pool legs used to double-show (group transcript + a
    // badged copy in the member's 1:1 thread). The 1:1 pane now filters to
    // DIRECT business traffic (isDirectMessage); the raw thread state still
    // carries the legs (mirrors /control/threads).
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Ana Tenant/ }));
    // The seeded business message renders.
    expect(await screen.findByText('Welcome to your new home')).toBeVisible();
    // A relay fan-out leg (from = pool) and Ana's own group send (to = pool)
    // arrive live — neither may render in the 1:1 pane.
    act(() => {
      capturedOnEvent?.({
        type: 'message.appended',
        partyNumber: '+15550100001',
        message: {
          sid: 'SMpoolleg',
          direction: 'outbound',
          from: '+15550160001',
          to: '+15550100001',
          body: 'Diana Osei: see you at the tour',
          state: 'queued',
          createdAt: '2026-06-15T00:01:00.000Z',
          updatedAt: '2026-06-15T00:01:00.000Z',
        },
      });
      capturedOnEvent?.({
        type: 'message.appended',
        partyNumber: '+15550100001',
        message: {
          sid: 'SMgroupsend',
          direction: 'inbound',
          from: '+15550100001',
          to: '+15550160001',
          body: 'my own group reply',
          state: 'delivered',
          createdAt: '2026-06-15T00:02:00.000Z',
          updatedAt: '2026-06-15T00:02:00.000Z',
        },
      });
    });
    expect(screen.queryByText('Diana Osei: see you at the tour')).toBeNull();
    expect(screen.queryByText('my own group reply')).toBeNull();
    // A DIRECT business message still lands live in the pane.
    act(() => {
      capturedOnEvent?.({
        type: 'message.appended',
        partyNumber: '+15550100001',
        message: {
          sid: 'SMdirect',
          direction: 'outbound',
          from: '+15550009999',
          to: '+15550100001',
          body: 'a normal business text',
          state: 'queued',
          createdAt: '2026-06-15T00:03:00.000Z',
          updatedAt: '2026-06-15T00:03:00.000Z',
        },
      });
    });
    expect(await screen.findByText('a normal business text')).toBeVisible();
  });
});
