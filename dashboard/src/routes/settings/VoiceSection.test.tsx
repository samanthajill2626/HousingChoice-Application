// VoiceSection tests — self-service cell verification (Voice Phase 1 §7). The API
// layer is MOCKED (getVoiceMe / startCellVerify / confirmCellVerify) so these
// don't touch the backend. Covers: the send-code → verify → verified happy path,
// and an error path (invalid_code) surfaced inline.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { MeUser } from '../../api/index.js';

const getVoiceMe = vi.fn();
const startCellVerify = vi.fn();
const confirmCellVerify = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getVoiceMe: (...a: unknown[]) => getVoiceMe(...a),
    startCellVerify: (...a: unknown[]) => startCellVerify(...a),
    confirmCellVerify: (...a: unknown[]) => confirmCellVerify(...a),
  };
});

import { VoiceSection } from './VoiceSection.js';

function me(overrides: Partial<MeUser> = {}): MeUser {
  return { userId: 'u1', email: 'va@example.com', name: 'VA', role: 'va', ...overrides };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('VoiceSection — cell verification', () => {
  it('shows "Not set" when the navigator has no cell', async () => {
    getVoiceMe.mockResolvedValue(me());
    render(<VoiceSection />);
    expect(await screen.findByText('Not set')).toBeInTheDocument();
  });

  it('shows the verified cell + timestamp when already verified', async () => {
    getVoiceMe.mockResolvedValue(
      me({ cell: '+14040100001', cell_verified_at: '2026-06-01T00:00:00.000Z' }),
    );
    render(<VoiceSection />);
    expect(await screen.findByText(/\(404\) 010-0001 — Verified ✓/)).toBeInTheDocument();
  });

  it('runs the full flow: send code → verify → verified', async () => {
    const user = userEvent.setup();
    getVoiceMe.mockResolvedValue(me());
    startCellVerify.mockResolvedValue({ ok: true });
    confirmCellVerify.mockResolvedValue({ ok: true, cell_verified_at: '2026-07-01T00:00:00.000Z' });
    render(<VoiceSection />);

    // Enter a valid E.164 cell directly — normalizes identically, submit sends E.164.
    const cellInput = await screen.findByLabelText(/Your mobile number/i);
    await user.type(cellInput, '+14040100001');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(startCellVerify).toHaveBeenCalledWith('+14040100001');
    // The code step appears.
    const codeInput = await screen.findByLabelText(/Verification code/i);
    await user.type(codeInput, '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(confirmCellVerify).toHaveBeenCalledWith('123456');
    expect(await screen.findByText(/You can now place masked calls/i)).toBeInTheDocument();
  });

  it('accepts a bare 10-digit number: blur snaps to display form, submit POSTs E.164', async () => {
    const user = userEvent.setup();
    getVoiceMe.mockResolvedValue(me());
    startCellVerify.mockResolvedValue({ ok: true });
    render(<VoiceSection />);

    const cellInput = await screen.findByLabelText(/Your mobile number/i);
    // Type a bare 10-digit number and blur — the field should snap to the display form.
    await user.type(cellInput, '4049824978');
    await user.tab(); // trigger blur
    expect(cellInput).toHaveValue('(404) 982-4978');

    // Submit → API receives E.164, not the display string.
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(startCellVerify).toHaveBeenCalledWith('+14049824978');
  });

  it('shows inline error and blocks POST when an invalid number is submitted', async () => {
    const user = userEvent.setup();
    getVoiceMe.mockResolvedValue(me());
    render(<VoiceSection />);

    const cellInput = await screen.findByLabelText(/Your mobile number/i);
    // Type a short/garbage number (only 3 digits — unambiguously invalid).
    await user.type(cellInput, '404');
    await user.tab(); // trigger blur → inline error shown
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Enter a 10-digit US number/i);

    // Submit should also be blocked (no API call).
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(startCellVerify).not.toHaveBeenCalled();
  });

  it('passes explicit +44 international number through unchanged', async () => {
    const user = userEvent.setup();
    getVoiceMe.mockResolvedValue(me());
    startCellVerify.mockResolvedValue({ ok: true });
    render(<VoiceSection />);

    const cellInput = await screen.findByLabelText(/Your mobile number/i);
    await user.type(cellInput, '+442079460958');
    await user.tab(); // blur — should stay as-is (non-NANP pass-through)
    expect(cellInput).toHaveValue('+442079460958');

    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(startCellVerify).toHaveBeenCalledWith('+442079460958');
  });

  it('surfaces an invalid_code error inline (role=alert) without advancing', async () => {
    const user = userEvent.setup();
    getVoiceMe.mockResolvedValue(me());
    startCellVerify.mockResolvedValue({ ok: true });
    confirmCellVerify.mockRejectedValue(new ApiError(400, 'invalid_code', 'bad code'));
    render(<VoiceSection />);

    await user.type(await screen.findByLabelText(/Your mobile number/i), '+14040100001');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText(/Verification code/i), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/isn't right/i);
    // Still on the code step (not the verified success message).
    expect(screen.queryByText(/You can now place masked calls/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
  });

  it('surfaces sms_unavailable from verify-start inline', async () => {
    const user = userEvent.setup();
    getVoiceMe.mockResolvedValue(me());
    startCellVerify.mockRejectedValue(new ApiError(503, 'sms_unavailable', 'down'));
    render(<VoiceSection />);

    await user.type(await screen.findByLabelText(/Your mobile number/i), '+14040100001');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
  });

  it('surfaces a 429 rate_limited from verify-start inline (and Send code is not stuck)', async () => {
    const user = userEvent.setup();
    getVoiceMe.mockResolvedValue(me());
    startCellVerify.mockRejectedValue(new ApiError(429, 'rate_limited', 'rate limited'));
    render(<VoiceSection />);

    await user.type(await screen.findByLabelText(/Your mobile number/i), '+14040100001');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many codes requested — wait a few minutes and try again.',
    );
    // busy reset by the finally — the Send code control is back and enabled.
    expect(screen.getByRole('button', { name: 'Send code' })).toBeEnabled();
  });
});
