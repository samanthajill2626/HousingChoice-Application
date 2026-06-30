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

  it('preserves an edit made while a save is in flight (no lost concurrent edit)', async () => {
    const u = userEvent.setup();
    // A deferred save: resolve it AFTER the user edits a second field.
    let resolveSave: (s: OrgSettings) => void = () => {};
    putSettings.mockImplementation(
      () =>
        new Promise<OrgSettings>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<TemplatesSection />);

    // Edit field A (auto-text), then click Save (the PUT is now in flight).
    const autoText = await screen.findByLabelText(/^Missed-call auto-text/i);
    await u.clear(autoText);
    await u.type(autoText, 'Edit A');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));

    // BEFORE the save resolves, edit field B (welcome text).
    const welcome = screen.getByLabelText(/Housing-fair welcome text/i);
    await u.type(welcome, 'Edit B');

    // The save resolves with the merged record (which has A but not B).
    resolveSave({ ...SETTINGS, missedCallAutoText: 'Edit A' });

    // The in-flight edit to field B must SURVIVE — the post-save re-hydrate must
    // not clobber it.
    await waitFor(() =>
      expect(screen.getByLabelText(/Housing-fair welcome text/i)).toHaveValue('Edit B'),
    );
  });
});

describe('TemplatesSection — welcomeText clear (revert to default)', () => {
  it('clearing a previously-SET welcomeText sends welcomeText: null', async () => {
    const u = userEvent.setup();
    getSettings.mockResolvedValue({ ...SETTINGS, welcomeText: 'Custom welcome {firstName}' });
    putSettings.mockResolvedValue({ ...SETTINGS });
    render(<TemplatesSection />);

    const welcome = await screen.findByLabelText(/Housing-fair welcome text/i);
    expect(welcome).toHaveValue('Custom welcome {firstName}');
    await u.clear(welcome);
    await u.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));
    expect(putSettings).toHaveBeenCalledWith({ welcomeText: null });
  });

  it('a never-set welcomeText that stays empty sends NO welcomeText key', async () => {
    const u = userEvent.setup();
    // welcomeText absent on the baseline (the field renders empty).
    putSettings.mockResolvedValue({ ...SETTINGS, missedCallAutoText: 'Other change' });
    render(<TemplatesSection />);

    // Change an unrelated field so there IS something to save…
    const autoText = await screen.findByLabelText(/^Missed-call auto-text/i);
    await u.clear(autoText);
    await u.type(autoText, 'Other change');
    // …leave welcome empty (it was never set).
    await u.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));
    const sent = putSettings.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('welcomeText' in sent).toBe(false);
    expect(sent).toEqual({ missedCallAutoText: 'Other change' });
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
