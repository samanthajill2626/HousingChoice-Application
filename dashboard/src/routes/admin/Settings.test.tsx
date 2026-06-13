// Settings screen tests — mock the api client + src/push, no network.
// Covers: settings load + PUT save; quick-reply add/remove edits the array;
// the auto-text toggle; push-enable handles each typed state (subscribed /
// denied / unsupported / not-configured); test-notification reports counts.
// (Uses fireEvent — @testing-library/user-event is not a project dependency.)
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import type { OrgSettings, PushTestResult } from '../../api/types.js';
import type { SubscribeResult } from '../../push/index.js';
import { ToastProvider } from '../../ui/index.js';
import Settings from '../Settings.js';

// --- Mocks -----------------------------------------------------------------

const getSettings = vi.fn();
const updateSettings = vi.fn();
const sendPushTest = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSettings: (...args: unknown[]) => getSettings(...args),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
    sendPushTest: (...args: unknown[]) => sendPushTest(...args),
  };
});

const isPushSupported = vi.fn();
const subscribeToPush = vi.fn();
const unsubscribeFromPush = vi.fn();

vi.mock('../../push/index.js', () => ({
  isPushSupported: () => isPushSupported(),
  subscribeToPush: () => subscribeToPush(),
  unsubscribeFromPush: () => unsubscribeFromPush(),
}));

// usePushControl's mount probe reads Notification.permission + the SW
// registration directly; stub both so the hook resolves to a known state.
function stubBrowserPush(opts: {
  permission?: NotificationPermission;
  existingSubscription?: boolean;
} = {}): void {
  vi.stubGlobal('Notification', {
    permission: opts.permission ?? 'default',
    requestPermission: vi.fn().mockResolvedValue('granted'),
  });
  const subscription = opts.existingSubscription ? {} : null;
  vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
      }),
    },
  });
}

function makeSettings(over: Partial<OrgSettings> = {}): OrgSettings {
  return {
    missedCallAutoText: 'Sorry I missed you — I will call back soon.',
    missedCallAutoTextEnabled: true,
    quickReplies: ['Please text me', "I'll call you back soon"],
    ...over,
  };
}

function makeTestResult(over: Partial<PushTestResult> = {}): PushTestResult {
  return { configured: true, attempted: 2, sent: 2, pruned: 0, failed: 0, ...over };
}

function renderScreen(): void {
  render(
    <ToastProvider>
      <Settings />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(makeSettings());
  updateSettings.mockImplementation((patch: Partial<OrgSettings>) =>
    Promise.resolve(makeSettings(patch)),
  );
  // Default: supported, not yet subscribed.
  isPushSupported.mockReturnValue(true);
  stubBrowserPush({ permission: 'default', existingSubscription: false });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// --- Settings load + save --------------------------------------------------

describe('<Settings> — missed-call templates', () => {
  it('loads the current settings into the form', async () => {
    renderScreen();
    expect(
      await screen.findByDisplayValue('Sorry I missed you — I will call back soon.'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('Please text me')).toBeInTheDocument();
  });

  it('sets honest expectations that calling goes live later', async () => {
    renderScreen();
    expect(
      await screen.findByText(/calling goes live in a later milestone/i),
    ).toBeInTheDocument();
  });

  it('saves via PUT and toasts success', async () => {
    renderScreen();
    const textarea = await screen.findByDisplayValue(
      'Sorry I missed you — I will call back soon.',
    );
    fireEvent.change(textarea, { target: { value: 'New auto-text body' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const patch = updateSettings.mock.calls[0]![0] as Partial<OrgSettings>;
    expect(patch.missedCallAutoText).toBe('New auto-text body');
    expect(patch.missedCallAutoTextEnabled).toBe(true);
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
  });

  it('adds a quick reply to the array', async () => {
    renderScreen();
    await screen.findByDisplayValue('Please text me');
    fireEvent.change(screen.getByLabelText('New quick reply'), {
      target: { value: 'On my way' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    // New reply becomes an editable row.
    expect(await screen.findByDisplayValue('On my way')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const patch = updateSettings.mock.calls[0]![0] as Partial<OrgSettings>;
    expect(patch.quickReplies).toContain('On my way');
    expect(patch.quickReplies).toHaveLength(3);
  });

  it('removes a quick reply from the array', async () => {
    renderScreen();
    await screen.findByDisplayValue('Please text me');
    fireEvent.click(screen.getByRole('button', { name: /Remove quick reply 1/i }));

    await waitFor(() =>
      expect(screen.queryByDisplayValue('Please text me')).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const patch = updateSettings.mock.calls[0]![0] as Partial<OrgSettings>;
    expect(patch.quickReplies).toEqual(["I'll call you back soon"]);
  });

  it('surfaces a friendly 403 message when a VA tries to save', async () => {
    updateSettings.mockRejectedValue(new ApiError(403, 'forbidden', 'forbidden'));
    renderScreen();
    await screen.findByDisplayValue('Please text me');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    // The message appears both inline (role=alert) and as a toast.
    expect(
      (await screen.findAllByText(/Only admins can edit these settings/i)).length,
    ).toBeGreaterThan(0);
  });

  it('blocks save and shows a char-limit error when the auto-text is too long', async () => {
    renderScreen();
    const textarea = await screen.findByDisplayValue(
      'Sorry I missed you — I will call back soon.',
    );
    fireEvent.change(textarea, { target: { value: 'x'.repeat(321) } });
    expect(await screen.findByText(/320 characters or fewer/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    // Save button is disabled while invalid → no PUT fired.
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

// --- Push / notifications --------------------------------------------------

describe('<Settings> — notifications on this device', () => {
  it('shows the iPhone home-screen guidance', async () => {
    renderScreen();
    expect(
      await screen.findByText(/add this app to your Home Screen first/i),
    ).toBeInTheDocument();
  });

  it('reflects an already-subscribed device and enables the test button', async () => {
    stubBrowserPush({ permission: 'granted', existingSubscription: true });
    renderScreen();
    expect(await screen.findByText(/get a push on this device/i)).toBeInTheDocument();
    // The "Turn off" button is shown when subscribed.
    expect(
      await screen.findByRole('button', { name: /turn off notifications/i }),
    ).toBeInTheDocument();
  });

  it('enables push successfully and flips to the subscribed state', async () => {
    subscribeToPush.mockResolvedValue({ ok: true, subscriptionCount: 1 } satisfies SubscribeResult);
    renderScreen();
    const enable = await screen.findByRole('button', { name: /enable notifications/i });
    fireEvent.click(enable);
    await waitFor(() => expect(subscribeToPush).toHaveBeenCalled());
    expect(
      await screen.findByRole('button', { name: /turn off notifications/i }),
    ).toBeInTheDocument();
  });

  it('handles the permission-denied result', async () => {
    subscribeToPush.mockResolvedValue({ ok: false, reason: 'denied' } satisfies SubscribeResult);
    renderScreen();
    const enable = await screen.findByRole('button', { name: /enable notifications/i });
    fireEvent.click(enable);
    expect(await screen.findByText(/Notifications are blocked for this site/i)).toBeInTheDocument();
  });

  it('handles the unsupported-browser state', async () => {
    isPushSupported.mockReturnValue(false);
    renderScreen();
    expect(await screen.findByText(/can't show push notifications/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enable notifications/i })).toBeDisabled();
  });

  it('handles the push_not_configured (VAPID off) result', async () => {
    subscribeToPush.mockResolvedValue({
      ok: false,
      reason: 'push_not_configured',
    } satisfies SubscribeResult);
    renderScreen();
    const enable = await screen.findByRole('button', { name: /enable notifications/i });
    fireEvent.click(enable);
    expect(await screen.findByText(/isn’t set up on the server yet/i)).toBeInTheDocument();
  });

  it('sends a test notification and reports attempted/sent counts', async () => {
    stubBrowserPush({ permission: 'granted', existingSubscription: true });
    sendPushTest.mockResolvedValue(makeTestResult({ attempted: 3, sent: 2, failed: 1 }));
    renderScreen();
    const testBtn = await screen.findByRole('button', { name: /send test notification/i });
    await waitFor(() => expect(testBtn).not.toBeDisabled());
    fireEvent.click(testBtn);

    await waitFor(() => expect(sendPushTest).toHaveBeenCalled());
    expect(await screen.findByText(/Test sent to 2 of 3 device/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/attempted 3, sent 2, failed 1/i),
    ).toBeInTheDocument();
  });

  it('disables the test button until subscribed', async () => {
    renderScreen();
    const testBtn = await screen.findByRole('button', { name: /send test notification/i });
    expect(testBtn).toBeDisabled();
  });
});
