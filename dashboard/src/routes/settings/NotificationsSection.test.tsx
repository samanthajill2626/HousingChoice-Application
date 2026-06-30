// NotificationsSection tests — this-device push, with the local-degradation
// paths that matter most in jsdom: an unsupported browser (no Notification /
// serviceWorker) degrades to a clear message WITHOUT throwing; a 503
// push_not_configured shows the "not configured" message with the controls
// disabled; and a successful self-test renders the per-call tally.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';

const getVapidPublicKey = vi.fn();
const subscribePush = vi.fn();
const unsubscribePush = vi.fn();
const sendPushTest = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getVapidPublicKey: (...a: unknown[]) => getVapidPublicKey(...a),
    subscribePush: (...a: unknown[]) => subscribePush(...a),
    unsubscribePush: (...a: unknown[]) => unsubscribePush(...a),
    sendPushTest: (...a: unknown[]) => sendPushTest(...a),
  };
});

import { NotificationsSection } from './NotificationsSection.js';

// A fake push subscription + service-worker registration, installed for the
// "supported browser" tests. The real APIs are absent in jsdom.
interface FakeSub {
  endpoint: string;
  toJSON: () => { endpoint: string };
  unsubscribe: ReturnType<typeof vi.fn>;
}
interface FakeRegistration {
  pushManager: {
    getSubscription: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
}

function installPushSupport(opts: { subscribed?: boolean } = {}): {
  fakeSub: FakeSub;
  registration: FakeRegistration;
} {
  const fakeSub: FakeSub = {
    endpoint: 'https://push.example/endpoint',
    toJSON: () => ({ endpoint: 'https://push.example/endpoint' }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const registration: FakeRegistration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(opts.subscribed ? fakeSub : null),
      subscribe: vi.fn().mockResolvedValue(fakeSub),
    },
  };
  vi.stubGlobal('navigator', {
    serviceWorker: { ready: Promise.resolve(registration) },
    userAgent: 'jsdom',
  });
  // PushManager + Notification must be present on window for detectSupport().
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    permission: 'granted',
    requestPermission: vi.fn().mockResolvedValue('granted'),
  });
  return { fakeSub, registration };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('NotificationsSection — unsupported browser', () => {
  it('degrades to a clear message and does NOT throw when push APIs are absent', () => {
    // jsdom has no serviceWorker / PushManager / Notification — render must not crash.
    expect(() => render(<NotificationsSection />)).not.toThrow();
    expect(
      screen.getByText(/This browser doesn't support push notifications/i),
    ).toBeInTheDocument();
    // No on/off toggle is offered in the unsupported state.
    expect(screen.queryByRole('button', { name: /Turn on/i })).not.toBeInTheDocument();
  });
});

describe('NotificationsSection — push not configured (503)', () => {
  it('shows the "not configured" message + disables the controls on a 503', async () => {
    installPushSupport({ subscribed: false });
    const u = userEvent.setup();
    getVapidPublicKey.mockRejectedValue(
      new ApiError(503, 'push_not_configured', 'push not configured'),
    );
    render(<NotificationsSection />);

    // The Turn-on control is present (supported browser) until we try to enable.
    const turnOn = await screen.findByRole('button', { name: /Turn on/i });
    await u.click(turnOn);

    // The 503 flips the section to "not configured".
    expect(
      await screen.findByText(/Push isn't configured in this environment/i),
    ).toBeInTheDocument();
    // And the toggle is gone (controls disabled / removed in the degraded state).
    expect(screen.queryByRole('button', { name: /Turn on/i })).not.toBeInTheDocument();
  });
});

describe('NotificationsSection — enable partial failure rollback', () => {
  it('rolls back the browser subscription when the server POST fails (no orphan)', async () => {
    const { fakeSub } = installPushSupport({ subscribed: false });
    const u = userEvent.setup();
    getVapidPublicKey.mockResolvedValue('BHk_fakeVapidKey');
    // subscribe() succeeds → the browser holds a live sub; the server POST fails.
    subscribePush.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    render(<NotificationsSection />);

    const turnOn = await screen.findByRole('button', { name: /Turn on/i });
    await u.click(turnOn);

    // The error is surfaced…
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't enable notifications/i);
    // …and the orphaned browser subscription was rolled back.
    await waitFor(() => expect(fakeSub.unsubscribe).toHaveBeenCalledTimes(1));
    // The UI stays Off (the device is not enabled).
    expect(screen.getByText(/Push on this device:/i)).toHaveTextContent(/Off/);
  });
});

describe('NotificationsSection — disable partial failure convergence', () => {
  it('converges enabled from a re-probe when the server DELETE fails but the browser unsubscribe succeeds', async () => {
    const { fakeSub, registration } = installPushSupport({ subscribed: true });
    const u = userEvent.setup();
    // The server DELETE fails, but the browser unsubscribe succeeds → after the
    // unsubscribe there is NO subscription, so enabled must converge to false.
    unsubscribePush.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    fakeSub.unsubscribe.mockResolvedValue(true);
    // The post-disable re-probe sees no subscription.
    registration.pushManager.getSubscription
      .mockResolvedValueOnce(fakeSub) // mount probe
      .mockResolvedValueOnce(fakeSub) // disable() reads the current sub
      .mockResolvedValue(null); // re-probe after unsubscribe
    render(<NotificationsSection />);

    const turnOff = await screen.findByRole('button', { name: /Turn off/i });
    await u.click(turnOff);

    // The error is surfaced (the server step genuinely failed)…
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't disable notifications/i);
    // …but the toggle converges to Off (a sub no longer exists) — not stranded On.
    await waitFor(() =>
      expect(screen.getByText(/Push on this device:/i)).toHaveTextContent(/Off/),
    );
    expect(fakeSub.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationsSection — self-test tally', () => {
  it('renders the per-call tally from sendPushTest', async () => {
    installPushSupport({ subscribed: true });
    const u = userEvent.setup();
    sendPushTest.mockResolvedValue({ sent: 2, failed: 1 });
    render(<NotificationsSection />);

    // Wait for the mount probe to flip the device to "enabled" (it has a sub).
    const testBtn = await screen.findByRole('button', { name: /Send test notification/i });
    await waitFor(() => expect(testBtn).not.toBeDisabled());
    await u.click(testBtn);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('2 sent, 1 failed.');
  });
});
