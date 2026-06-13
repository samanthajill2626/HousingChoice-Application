// Tests for the QuickReply screen (M1.4). No network: the api endpoint
// functions (getSettings / getConversation / sendMessage) are mocked while the
// real useApi hook, ApiError, and the design-system primitives run. The Sheet
// portals to document.body, which Testing Library queries by default.
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, OrgSettings, SendMessageResult } from '../../api/index.js';
import { ToastProvider } from '../../ui/index.js';

// --- Mock only the endpoint functions; keep useApi/ApiError/types real. ------
const { getSettings, getConversation, sendMessage } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getConversation: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../../api/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/index.js')>();
  return { ...actual, getSettings, getConversation, sendMessage };
});

// Imported AFTER the mock is registered.
const { default: QuickReply } = await import('../QuickReply.js');

const FAKE_CONVERSATION_ID = 'conv-123';
const FAKE_CALL_ID = 'call-abc';

const SETTINGS: OrgSettings = {
  missedCallAutoText: "Sorry I missed you — I'll call back soon; you can also text me here.",
  missedCallAutoTextEnabled: true,
  quickReplies: ['Please text me', "I'll call you back soon"],
};

const CONVERSATION: Conversation = {
  conversationId: FAKE_CONVERSATION_ID,
  participant_phone: '+15555550123',
  status: 'open',
  last_activity_at: '2026-06-13T00:00:00.000Z',
  type: 'tenant_1to1',
  ai_mode: 'manual',
  created_at: '2026-06-13T00:00:00.000Z',
};

const SEND_RESULT: SendMessageResult = {
  conversationId: FAKE_CONVERSATION_ID,
  providerSid: 'SM123',
  tsMsgId: '1718000000000#SM123',
  status: 'queued',
};

/** Render QuickReply at a given URL, inside a router + toast provider. */
function renderAt(initialEntry: string): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/quick-reply/:callId" element={<QuickReply />} />
          <Route path="/" element={<div>Inbox</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue(SETTINGS);
  getConversation.mockReset().mockResolvedValue(CONVERSATION);
  sendMessage.mockReset().mockResolvedValue(SEND_RESULT);
  // Default: opened without an #action hash.
  window.location.hash = '';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<QuickReply> — canned replies', () => {
  it('renders the quick replies (and the auto-text) from settings', async () => {
    renderAt(`/quick-reply/${FAKE_CALL_ID}?conversationId=${FAKE_CONVERSATION_ID}`);

    // Auto-text is surfaced as the leading "Default reply" option.
    expect(await screen.findByText(/Sorry I missed you/)).toBeInTheDocument();
    expect(screen.getByText('Default reply')).toBeInTheDocument();
    // Each configured quick reply is a tap target.
    expect(screen.getByText('Please text me')).toBeInTheDocument();
    expect(screen.getByText("I'll call you back soon")).toBeInTheDocument();
    // The target conversation's phone is shown.
    expect(screen.getByText('+15555550123')).toBeInTheDocument();
  });

  it('sends a tapped quick reply to the conversation and confirms', async () => {
    renderAt(`/quick-reply/${FAKE_CALL_ID}?conversationId=${FAKE_CONVERSATION_ID}`);

    const reply = await screen.findByText('Please text me');
    fireEvent.click(reply);

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(FAKE_CONVERSATION_ID, { body: 'Please text me' });

    // Sent confirmation appears (the confirmation body is unique; "Reply sent"
    // appears in both the sheet title and the confirmation heading).
    expect(await screen.findByText(/Sent from your business number/)).toBeInTheDocument();
  });
});

describe('<QuickReply> — interim (callId only, no conversation)', () => {
  it('renders the honest no-call-API state and does NOT send', async () => {
    renderAt(`/quick-reply/${FAKE_CALL_ID}`);

    expect(await screen.findByText(/Call details aren't available yet/)).toBeInTheDocument();
    // No conversation was fetched and nothing was sent — no fake send.
    expect(getConversation).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('<QuickReply> — Android #action auto-send', () => {
  it('auto-sends the matching reply exactly once, even across re-renders', async () => {
    // qr-0 = the first configured quick reply ('Please text me').
    window.location.hash = '#action=qr-0';
    renderAt(`/quick-reply/${FAKE_CALL_ID}?conversationId=${FAKE_CONVERSATION_ID}`);

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(FAKE_CONVERSATION_ID, { body: 'Please text me' });

    // Confirmation shows; a re-render (toast/SW message) must not re-send.
    expect(await screen.findByText(/Sent from your business number/)).toBeInTheDocument();

    // Simulate a stray SW message arriving after the auto-send latch is set.
    await act(async () => {
      navigator.serviceWorker?.dispatchEvent?.(
        new MessageEvent('message', { data: { type: 'notificationclick', action: 'qr-0' } }),
      );
    });

    // Still exactly one send.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('auto-sends the auto-text for the "auto" action id', async () => {
    window.location.hash = '#action=auto';
    renderAt(`/quick-reply/${FAKE_CALL_ID}?conversationId=${FAKE_CONVERSATION_ID}`);

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(FAKE_CONVERSATION_ID, {
      body: SETTINGS.missedCallAutoText,
    });
  });

  it('does not auto-send for an unknown action id (falls back to manual)', async () => {
    window.location.hash = '#action=does-not-exist';
    renderAt(`/quick-reply/${FAKE_CALL_ID}?conversationId=${FAKE_CONVERSATION_ID}`);

    // The replies render (manual path) and nothing auto-sent.
    expect(await screen.findByText('Please text me')).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('<QuickReply> — custom reply + open conversation', () => {
  it('sends a custom reply', async () => {
    renderAt(`/quick-reply/${FAKE_CALL_ID}?conversationId=${FAKE_CONVERSATION_ID}`);

    fireEvent.click(await screen.findByText('Write a custom reply'));
    const textarea = await screen.findByLabelText('Custom reply');
    fireEvent.change(textarea, { target: { value: 'On my way' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(FAKE_CONVERSATION_ID, { body: 'On my way' });
    expect(await screen.findByText(/Sent from your business number/)).toBeInTheDocument();
  });

  it('offers an "Open full conversation" link to the thread', async () => {
    renderAt(`/quick-reply/${FAKE_CALL_ID}?conversationId=${FAKE_CONVERSATION_ID}`);

    const link = await screen.findByRole('link', { name: 'Open full conversation' });
    expect(link).toHaveAttribute('href', `/conversations/${FAKE_CONVERSATION_ID}`);
  });
});
