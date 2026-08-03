// QuietHoursSection tests - the org quiet-hours window editor on the System tab.
// Covers rendering the stored window, saving ONLY the changed fields, and
// surfacing a server 400 inline. There is deliberately NO VA read-only case:
// the System tab is adminOnly + <AdminRoute>-guarded, so a VA can never reach
// this section at all (worklist A2) - the section itself carries no role gate.
// Harness mirrors TemplatesSection.test.tsx: mock the api barrel by spreading
// importActual (so ApiError and every type stay real), import after mocking,
// assert accessibility-first.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { OrgSettings, SettingsResponse } from '../../api/index.js';

const getSettings = vi.fn();
const putSettings = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSettings: (...a: unknown[]) => getSettings(...a),
    putSettings: (...a: unknown[]) => putSettings(...a),
  };
});

import { QuietHoursSection } from './QuietHoursSection.js';

const SETTINGS: OrgSettings = {
  missedCallAutoText: 'Sorry I missed you.',
  missedCallAutoTextEnabled: true,
  quickReplies: ['Please text me'],
  preRingPauseSeconds: 2,
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  timezone: 'America/New_York',
};

/** The read-only built-in welcome body served alongside the settings. */
const DEFAULT_WELCOME = 'Welcome to Tenant Place! Reply STOP to unsubscribe, HELP for help.';

/** Wrap a settings record in the GET/PUT wire shape. */
function wrap(settings: OrgSettings): SettingsResponse {
  return { settings, welcomeTextDefault: DEFAULT_WELCOME };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(wrap({ ...SETTINGS }));
});

describe('QuietHoursSection - rendering the stored window', () => {
  it('shows the toggle, the start/end times, and the fixed timezone line', async () => {
    render(<QuietHoursSection />);

    const toggle = await screen.findByLabelText('Pause automated messages overnight');
    expect(toggle).toBeChecked();
    expect(screen.getByLabelText('Start')).toHaveValue('21:00');
    expect(screen.getByLabelText('End')).toHaveValue('08:00');
    expect(
      screen.getByRole('heading', { name: 'Quiet hours', level: 2 }),
    ).toBeInTheDocument();

    // The timezone is FIXED copy this phase - shown, never edited.
    expect(screen.getByText('Eastern - America/New_York')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Timezone/i)).toBeNull();
  });

  it('renders a stored window that is turned off with the toggle unchecked', async () => {
    getSettings.mockResolvedValue(wrap({ ...SETTINGS, quietHoursEnabled: false }));
    render(<QuietHoursSection />);

    expect(await screen.findByLabelText('Pause automated messages overnight')).not.toBeChecked();
  });
});

describe('QuietHoursSection - saving', () => {
  it('Save sends ONLY the changed field', async () => {
    const u = userEvent.setup();
    putSettings.mockResolvedValue(wrap({ ...SETTINGS, quietHoursEnd: '09:00' }));
    render(<QuietHoursSection />);

    const end = await screen.findByLabelText('End');
    fireEvent.change(end, { target: { value: '09:00' } });
    await u.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));
    expect(putSettings).toHaveBeenCalledWith({ quietHoursEnd: '09:00' });
  });

  it('turning the window off sends { quietHoursEnabled: false } and nothing else', async () => {
    const u = userEvent.setup();
    putSettings.mockResolvedValue(wrap({ ...SETTINGS, quietHoursEnabled: false }));
    render(<QuietHoursSection />);

    const toggle = await screen.findByLabelText('Pause automated messages overnight');
    await u.click(toggle);
    await u.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));
    expect(putSettings).toHaveBeenCalledWith({ quietHoursEnabled: false });
  });

  it('Save is disabled until something changes', async () => {
    render(<QuietHoursSection />);
    await screen.findByLabelText('Start');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('QuietHoursSection - server errors', () => {
  it('surfaces a quiet_hours_zero_length 400 as readable inline copy', async () => {
    const u = userEvent.setup();
    putSettings.mockRejectedValue(
      new ApiError(400, 'quiet_hours_zero_length', 'quiet_hours_zero_length', {
        error: 'quiet_hours_zero_length',
      }),
    );
    render(<QuietHoursSection />);

    // A merged start === end is what the server rejects (stored end is 08:00).
    const start = await screen.findByLabelText('Start');
    fireEvent.change(start, { target: { value: '08:00' } });
    await u.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    // The raw code is never shown to a navigator.
    expect(alert).toHaveTextContent(/same time/i);
    expect(alert).not.toHaveTextContent(/quiet_hours_zero_length/);
    // The form survives - the edit is still there and Save is usable again.
    expect(screen.getByLabelText('Start')).toHaveValue('08:00');
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('shows the server prose for a field-validation 400', async () => {
    const u = userEvent.setup();
    putSettings.mockRejectedValue(
      new ApiError(400, 'bad_request', 'quietHoursStart must be "HH:MM" (24-hour)'),
    );
    render(<QuietHoursSection />);

    const start = await screen.findByLabelText('Start');
    fireEvent.change(start, { target: { value: '22:30' } });
    await u.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/quietHoursStart must be/i);
  });

  it('a non-400 failure shows a generic retry message', async () => {
    const u = userEvent.setup();
    putSettings.mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    render(<QuietHoursSection />);

    const end = await screen.findByLabelText('End');
    fireEvent.change(end, { target: { value: '07:30' } });
    await u.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/please try again/i);
  });
});
