// TemplatesSection tests — the founder-editable templates. Covers the admin edit
// path (enabled inputs + Save sends ONLY the changed fields; a 400 shows inline)
// and the VA read-only path (every input disabled, no Save button).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { OrgSettings } from '../../api/index.js';

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

let isAdmin = true;
vi.mock('../../app/AuthContext.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    me: { userId: 'u1', email: 'x@example.com', role: isAdmin ? 'admin' : 'va' },
    isAdmin,
    refresh: vi.fn(),
  }),
}));

import { TemplatesSection } from './TemplatesSection.js';

const SETTINGS: OrgSettings = {
  missedCallAutoText: 'Sorry I missed you.',
  missedCallAutoTextEnabled: true,
  quickReplies: ['Please text me'],
  preRingPauseSeconds: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  isAdmin = true;
  getSettings.mockResolvedValue({ ...SETTINGS });
});

describe('TemplatesSection — admin edit', () => {
  it('renders enabled inputs and a Save button', async () => {
    render(<TemplatesSection />);
    const autoText = await screen.findByLabelText(/^Missed-call auto-text/i);
    expect(autoText).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByText(/Read-only/i)).not.toBeInTheDocument();
  });

  it('Save sends ONLY the changed fields', async () => {
    const u = userEvent.setup();
    putSettings.mockResolvedValue({ ...SETTINGS, missedCallAutoText: 'Updated text' });
    render(<TemplatesSection />);

    const autoText = await screen.findByLabelText(/^Missed-call auto-text/i);
    await u.clear(autoText);
    await u.type(autoText, 'Updated text');
    await u.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));
    expect(putSettings).toHaveBeenCalledWith({ missedCallAutoText: 'Updated text' });
  });

  it('shows the server 400 message inline', async () => {
    const u = userEvent.setup();
    putSettings.mockRejectedValue(
      new ApiError(400, 'bad_request', 'welcomeText must be a 1..320-char string'),
    );
    render(<TemplatesSection />);

    const welcome = await screen.findByLabelText(/Housing-fair welcome text/i);
    await u.type(welcome, 'Hi {firstName}!');
    await u.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/welcomeText must be a 1\.\.320-char string/i);
  });
});

describe('TemplatesSection — VA read-only', () => {
  beforeEach(() => {
    isAdmin = false;
  });

  it('disables every input and hides Save (read-only note shown)', async () => {
    render(<TemplatesSection />);
    expect(await screen.findByText(/Read-only — admins can edit/i)).toBeInTheDocument();

    expect(await screen.findByLabelText(/^Missed-call auto-text/i)).toBeDisabled();
    expect(screen.getByLabelText(/Pre-ring pause/i)).toBeDisabled();
    expect(screen.getByLabelText(/Housing-fair welcome text/i)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
