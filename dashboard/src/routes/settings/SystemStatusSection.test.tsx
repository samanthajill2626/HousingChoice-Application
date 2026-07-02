// SystemStatusSection tests — the admin-only panel composes the three blocks
// (FlagPills, AlarmGrid, RecentErrors). Asserts all three render together, each
// loads independently, and the section heading/structure is present. Mocks all
// three api reads.
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemAlarmsResult, SystemErrorsResult, SystemFlags } from '../../api/index.js';

const getSystemFlags = vi.fn();
const getSystemAlarms = vi.fn();
const getSystemErrors = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSystemFlags: (...a: unknown[]) => getSystemFlags(...a),
    getSystemAlarms: (...a: unknown[]) => getSystemAlarms(...a),
    getSystemErrors: (...a: unknown[]) => getSystemErrors(...a),
  };
});

import { SystemStatusSection } from './SystemStatusSection.js';

const flags: SystemFlags = {
  env: 'local',
  smsSendingEnabled: true,
  relayLiveProvisioning: true,
  pushConfigured: false,
  messagingDriver: 'console',
};
const degradedAlarms: SystemAlarmsResult = { available: false, reason: 'unavailable_local' };
const degradedErrors: SystemErrorsResult = { available: false, reason: 'unavailable_local' };

beforeEach(() => {
  vi.clearAllMocks();
  getSystemFlags.mockResolvedValue(flags);
  getSystemAlarms.mockResolvedValue(degradedAlarms);
  getSystemErrors.mockResolvedValue(degradedErrors);
});
afterEach(() => vi.restoreAllMocks());

describe('SystemStatusSection', () => {
  it('renders the section + all three block headings', async () => {
    render(<SystemStatusSection />);
    expect(screen.getByRole('heading', { name: 'System status', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Go-live flags', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Alarms', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent errors', level: 3 })).toBeInTheDocument();
    // All three reads fire.
    await waitFor(() => {
      expect(getSystemFlags).toHaveBeenCalled();
      expect(getSystemAlarms).toHaveBeenCalled();
      expect(getSystemErrors).toHaveBeenCalled();
    });
  });

  it('flags load while alarms + errors degrade gracefully (the local-stack shape)', async () => {
    render(<SystemStatusSection />);
    // Flags loaded (the Environment pill is present in every env).
    expect(await screen.findByText('Environment')).toBeInTheDocument();
    expect(screen.getByText('local')).toBeInTheDocument();
    // Alarms + errors show the degraded notice (two copies).
    await waitFor(() => expect(screen.getAllByText('Available in deployed environments.')).toHaveLength(2));
  });

  it('each block loads independently — an alarms error does not break flags/errors', async () => {
    const { ApiError } = await import('../../api/index.js');
    getSystemAlarms.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    render(<SystemStatusSection />);

    // Flags still render…
    expect(await screen.findByText('Environment')).toBeInTheDocument();
    // …errors block still degrades gracefully…
    await waitFor(() => expect(screen.getByText('Available in deployed environments.')).toBeInTheDocument());
    // …and the alarms block shows its own error.
    await waitFor(() => expect(screen.getByText(/Couldn't load alarms/i)).toBeInTheDocument());
  });

  it('unmounting mid-flight does not throw (abort/cancel safety)', async () => {
    // A never-resolving fetch — unmounting must abort cleanly with no state-update warning.
    getSystemFlags.mockReturnValue(new Promise(() => {}));
    getSystemAlarms.mockReturnValue(new Promise(() => {}));
    getSystemErrors.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<SystemStatusSection />);
    expect(() => unmount()).not.toThrow();
  });
});
