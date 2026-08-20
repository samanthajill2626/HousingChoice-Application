// QuickReply tests - the missed-call one-tap reply sheet.
//
// The load-bearing behaviours, in rough order of how badly getting them wrong
// would hurt: the recipient comes from the SERVER's record of the call and never
// from the URL (the view sends a real SMS with no user gesture); an
// '#action=qr-<n>' arrival sends EXACTLY ONCE; and an action that cannot be
// matched says so rather than looking like a successful send.
import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../api/index.js';

const getSettings = vi.fn();
const getCall = vi.fn();
const sendMessage = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSettings: (...a: unknown[]) => getSettings(...a),
    getCall: (...a: unknown[]) => getCall(...a),
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

function callResolving(conversation: unknown): unknown {
  return { call: { type: 'call', provider_sid: 'CA123' }, conversation };
}

/** Render the route at /quick-reply/CA123, optionally with an action hash.
 *  StrictMode is deliberate: it double-invokes effects, which is precisely the
 *  condition the send-once latch has to survive. */
function renderSheet(hash = ''): void {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[`/quick-reply/CA123${hash}`]}>
        <Routes>
          <Route path="/quick-reply/:callId" element={<QuickReply />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(settingsWith(REPLIES));
  getCall.mockResolvedValue(
    callResolving({
      conversationId: 'conv-9',
      type: '1:1',
      status: 'open',
      participant_phone: '+16785551212',
      participants: [{ contactId: 'c-1', phone: '+16785551212', name: 'Dana Reed' }],
    }),
  );
  sendMessage.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe('QuickReply - the recipient comes from the call, not the URL', () => {
  it('resolves the thread through GET /api/calls/:callId', async () => {
    renderSheet();
    await screen.findByRole('button', { name: 'Please text me' });
    expect(getCall).toHaveBeenCalledWith('CA123', expect.anything());
    expect(screen.getByText(/Missed call from Dana Reed/)).toBeInTheDocument();
  });

  it('sends into the conversation the SERVER named for that call', async () => {
    getCall.mockResolvedValue(
      callResolving({
        conversationId: 'conv-from-server',
        type: '1:1',
        status: 'open',
        participants: [],
      }),
    );
    renderSheet();
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Please text me' }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith('conv-from-server', { body: 'Please text me' });
  });

  it('a CallSid naming no call is a dead end, and never sends', async () => {
    getCall.mockRejectedValue(new ApiError(404, 'call_not_found', 'call_not_found'));
    renderSheet('#action=qr-0');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't find that call/i);
    expect(alert).toHaveTextContent(/CA123/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a real call whose thread is gone is a dead end, and never sends', async () => {
    getCall.mockResolvedValue(callResolving(null));
    renderSheet('#action=qr-0');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /isn't linked to a conversation/i,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to the caller number when the thread has no resolved name', async () => {
    getCall.mockResolvedValue(
      callResolving({
        conversationId: 'conv-9',
        type: '1:1',
        status: 'open',
        participant_phone: '+16785551212',
        participants: [{ contactId: 'c-1', phone: '+16785551212' }],
      }),
    );
    renderSheet();
    await screen.findByRole('button', { name: 'Please text me' });
    expect(screen.getByText(/Missed call from .*678.*555.*1212/)).toBeInTheDocument();
  });
});

describe('QuickReply - the manual (iOS / plain tap) path', () => {
  it('offers each configured reply as a button', async () => {
    renderSheet();
    expect(await screen.findByRole('button', { name: 'Please text me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "I'll call you back soon" })).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('tapping a reply sends it and confirms', async () => {
    renderSheet();
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Please text me' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
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
  it('#action=qr-1 sends that reply on arrival, exactly once under StrictMode', async () => {
    renderSheet('#action=qr-1');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith('conv-9', { body: "I'll call you back soon" });
    expect(await screen.findByText('Sent')).toBeInTheDocument();
    // Settle, then prove StrictMode's second effect pass added no second send.
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });

  it('TELLS the founder when the action matches no current reply, and sends nothing', async () => {
    // The operator edited the replies between the push and the tap. A silent
    // no-op here looks identical to a successful send - they pressed a labelled
    // button and would walk away believing the text went out.
    renderSheet('#action=qr-7');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no longer set up, so nothing was sent/i,
    );
    expect(screen.getByRole('button', { name: 'Please text me' })).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends nothing when the deep link carries no action at all', async () => {
    renderSheet();
    await screen.findByRole('button', { name: 'Please text me' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('QuickReply - honest dead ends', () => {
  it('points at Settings when no quick replies are configured', async () => {
    getSettings.mockResolvedValue(settingsWith([]));
    renderSheet();
    expect(await screen.findByText(/No quick replies are set up yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up quick replies' })).toHaveAttribute(
      'href',
      '/settings/templates',
    );
  });

  it('offers a retry when the load fails', async () => {
    // mockRejectedValue, not ...Once: StrictMode double-invokes the load effect
    // (the first pass is aborted and discarded), so a one-shot rejection would
    // be spent before the pass whose result actually renders.
    getSettings.mockRejectedValue(new ApiError(500, 'server_error', 'settings exploded'));
    renderSheet();
    expect(await screen.findByRole('alert')).toHaveTextContent(/settings exploded/);

    getSettings.mockResolvedValue(settingsWith(REPLIES));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Please text me' })).toBeInTheDocument();
  });
});
