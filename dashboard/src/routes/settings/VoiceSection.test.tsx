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

    // Enter a cell and send the code.
    const cellInput = await screen.findByLabelText(/Your mobile number/i);
    await user.type(cellInput, '4040100001');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(startCellVerify).toHaveBeenCalledWith('4040100001');
    // The code step appears.
    const codeInput = await screen.findByLabelText(/Verification code/i);
    await user.type(codeInput, '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(confirmCellVerify).toHaveBeenCalledWith('123456');
    expect(await screen.findByText(/You can now place masked calls/i)).toBeInTheDocument();
  });

  it('surfaces an invalid_code error inline (role=alert) without advancing', async () => {
    const user = userEvent.setup();
    getVoiceMe.mockResolvedValue(me());
    startCellVerify.mockResolvedValue({ ok: true });
    confirmCellVerify.mockRejectedValue(new ApiError(400, 'invalid_code', 'bad code'));
    render(<VoiceSection />);

    await user.type(await screen.findByLabelText(/Your mobile number/i), '4040100001');
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

    await user.type(await screen.findByLabelText(/Your mobile number/i), '4040100001');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
  });
});
