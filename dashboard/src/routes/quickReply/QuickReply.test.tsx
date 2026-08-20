// QuickReply tests - the missed-call one-tap reply sheet.
//
// The load-bearing behaviours, in rough order of how badly getting them wrong
// would hurt: an '#action=qr-<n>' arrival sends that reply EXACTLY ONCE (it is a
// real text, and there is no undo); a stale action id sends NOTHING; and a
// deep-link with no conversation says so instead of guessing a thread.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../api/index.js';

const getSettings = vi.fn();
const getConversation = vi.fn();
const sendMessage = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSettings: (...a: unknown[]) => getSettings(...a),
    getConversation: (...a: unknown[]) => getConversation(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
  };
});

import { QuickReply } from './QuickReply.js';

const REPLIES = ['Please text me', "I'll call you back soon"];

function settingsWith(quickReplies: string[]): unknown {
  return {
    settings: { quickReplies, missedCallAutoText: 'auto text body' },
    welcomeTextDefault: '',
  };
}

/** Render the route at /quick-reply/CA123, optionally with a query and hash.
 *  The hash is put on window.location because that is where the service worker
 *  writes it and where the component reads it - MemoryRouter does not touch it. */
function renderSheet(search = '?conversationId=conv-9', hash = ''): void {
  window.history.replaceState(null, '', `/quick-reply/CA123${search}${hash}`);
  render(
    <MemoryRouter initialEntries={[`/quick-reply/CA123${search}${hash}`]}>
      <Routes>
        <Route path="/quick-reply/:callId" element={<QuickReply />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(settingsWith(REPLIES));
  getConversation.mockResolvedValue({
    conversationId: 'conv-9',
    type: '1:1',
    status: 'open',
    participant_phone: '+16785551212',
    participants: [{ contactId: 'c-1', phone: '+16785551212', name: 'Dana Reed' }],
  });
  sendMessage.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('QuickReply - the manual (iOS / plain tap) path', () => {
  it('names the caller and offers each configured reply as a button', async () => {
    renderSheet();
    expect(await screen.findByRole('button', { name: 'Please text me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "I'll call you back soon" })).toBeInTheDocument();
    // Who the text is going to, shown BEFORE the tap - the send is final.
    expect(screen.getByText(/Missed call from Dana Reed/)).toBeInTheDocument();
  });

  it('falls back to the caller number when the thread has no resolved name', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-9',
      type: '1:1',
      status: 'open',
      participant_phone: '+16785551212',
      participants: [{ contactId: 'c-1', phone: '+16785551212' }],
    });
    renderSheet();
    await screen.findByRole('button', { name: 'Please text me' });
    expect(screen.getByText(/Missed call from .*678.*555.*1212/)).toBeInTheDocument();
  });

  it('still offers the replies when the thread header fails to load', async () => {
    // The header is decoration. Losing the caller's name must not cost the
    // founder the ability to reply at all.
    getConversation.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    renderSheet();
    expect(await screen.findByRole('button', { name: 'Please text me' })).toBeInTheDocument();
    expect(screen.getByText(/^Missed call\./)).toBeInTheDocument();
  });

  it('tapping a reply sends it to the thread and confirms', async () => {
    renderSheet();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Please text me' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith('conv-9', { body: 'Please text me' });
    expect(await screen.findByText('Sent')).toBeInTheDocument();
    // Terminal: the buttons are gone, so a second tap cannot double-text.
    expect(screen.queryByRole('button', { name: 'Please text me' })).not.toBeInTheDocument();
  });

  it('a failed send says so and leaves the buttons tappable for a retry', async () => {
    sendMessage.mockRejectedValueOnce(new ApiError(503, 'sms_unavailable', 'Carrier is down'));
    renderSheet();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Please text me' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Carrier is down/);
    expect(alert).toHaveTextContent(/Tap again to retry/);

    await user.click(screen.getByRole('button', { name: 'Please text me' }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Sent')).toBeInTheDocument();
  });
});

describe('QuickReply - the Android action-button (true one-tap) path', () => {
  it('#action=qr-1 sends that reply on arrival, exactly once', async () => {
    renderSheet('?conversationId=conv-9', '#action=qr-1');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith('conv-9', { body: "I'll call you back soon" });
    expect(await screen.findByText('Sent')).toBeInTheDocument();
    // Settle, then prove no second send crept in behind the confirmation.
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });

  it('strips the #action so a refresh cannot replay the send', async () => {
    renderSheet('?conversationId=conv-9', '#action=qr-0');
    await screen.findByText('Sent');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?conversationId=conv-9');
  });

  it('sends NOTHING for an action id the current settings no longer cover', async () => {
    // The operator edited the replies between the push and the tap. Sending the
    // neighbouring reply would text the caller words nobody chose.
    renderSheet('?conversationId=conv-9', '#action=qr-7');
    expect(await screen.findByRole('button', { name: 'Please text me' })).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends nothing when the deep-link carries no action at all', async () => {
    renderSheet('?conversationId=conv-9');
    await screen.findByRole('button', { name: 'Please text me' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('QuickReply - honest dead ends', () => {
  it('says so when the deep-link carries no conversation, and never sends', async () => {
    renderSheet('');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't tell which conversation/i);
    expect(alert).toHaveTextContent(/CA123/);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('points at Settings when no quick replies are configured', async () => {
    getSettings.mockResolvedValue(settingsWith([]));
    renderSheet();
    expect(await screen.findByText(/No quick replies are set up yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up quick replies' })).toHaveAttribute(
      'href',
      '/settings/templates',
    );
  });

  it('offers a retry when the replies fail to load', async () => {
    getSettings.mockRejectedValueOnce(new ApiError(500, 'server_error', 'settings exploded'));
    renderSheet();
    expect(await screen.findByRole('alert')).toHaveTextContent(/settings exploded/);

    getSettings.mockResolvedValue(settingsWith(REPLIES));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Please text me' })).toBeInTheDocument();
  });
});
