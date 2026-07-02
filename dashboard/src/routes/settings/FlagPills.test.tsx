// FlagPills tests — the go-live readiness pills (doc §6). State is conveyed by
// TEXT (queryable), never colour alone: the two A2P kill-switches show an amber
// "Off · pre-A2P" pill when OFF; push reads on/off; env + driver
// are info pills. Mocks the api layer's getSystemFlags.
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { SystemFlags } from '../../api/index.js';

const getSystemFlags = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSystemFlags: (...a: unknown[]) => getSystemFlags(...a),
  };
});

import { FlagPills } from './FlagPills.js';

function flags(overrides: Partial<SystemFlags> = {}): SystemFlags {
  return {
    env: 'dev',
    smsSendingEnabled: true,
    relayLiveProvisioning: true,
    pushConfigured: true,
    messagingDriver: 'twilio',
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('FlagPills', () => {
  it('renders both A2P kill-switches as "Off · pre-A2P" when OFF (by accessible TEXT, not colour)', async () => {
    getSystemFlags.mockResolvedValue(flags({ smsSendingEnabled: false, relayLiveProvisioning: false }));
    render(<FlagPills />);

    // Each disabled kill-switch surfaces the pre-A2P text — TWO of them.
    await waitFor(() => expect(screen.getAllByText('Off · pre-A2P')).toHaveLength(2));
    // The label/value pairing is legible (SMS sending + Relay provisioning present).
    expect(screen.getByText('SMS sending')).toBeInTheDocument();
    expect(screen.getByText('Relay provisioning')).toBeInTheDocument();
  });

  it('renders the A2P kill-switches as "On" when enabled', async () => {
    getSystemFlags.mockResolvedValue(flags({ smsSendingEnabled: true, relayLiveProvisioning: true }));
    render(<FlagPills />);
    await waitFor(() => expect(screen.getAllByText('On')).toHaveLength(2));
    expect(screen.queryByText('Off · pre-A2P')).not.toBeInTheDocument();
  });

  it('shows push Configured/Not configured by text', async () => {
    getSystemFlags.mockResolvedValue(flags({ pushConfigured: false }));
    render(<FlagPills />);
    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());
    expect(screen.getByText('Push notifications')).toBeInTheDocument();
  });

  it('renders env + messaging driver as info pills', async () => {
    getSystemFlags.mockResolvedValue(flags({ env: 'prod', messagingDriver: 'console' }));
    render(<FlagPills />);
    await waitFor(() => expect(screen.getByText('Environment')).toBeInTheDocument());
    expect(screen.getByText('prod')).toBeInTheDocument();
    expect(screen.getByText('Messaging driver')).toBeInTheDocument();
    expect(screen.getByText('console')).toBeInTheDocument();
  });

  it('shows the driver as "mock" when the twilio driver is redirected to a fake host (--mock)', async () => {
    getSystemFlags.mockResolvedValue(flags({ env: 'local', messagingDriver: 'mock' }));
    render(<FlagPills />);
    await waitFor(() => expect(screen.getByText('Messaging driver')).toBeInTheDocument());
    expect(screen.getByText('mock')).toBeInTheDocument();
    expect(screen.queryByText('twilio')).not.toBeInTheDocument();
  });

  it('shows an error block + Retry when the fetch fails, and retries on click', async () => {
    getSystemFlags.mockRejectedValueOnce(new ApiError(500, 'server_error', 'boom'));
    render(<FlagPills />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load the go-live flags/i);

    // A successful retry clears the error.
    getSystemFlags.mockResolvedValueOnce(flags());
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('Environment')).toBeInTheDocument();
  });
});
