// CallMenu tests — the masked-originate control (Voice Phase 1 §5). The API layer
// is MOCKED (originateCall) so these don't depend on the backend. Covers: POSTs
// the originate on click + shows the "calling your cell" state; disabled (with a
// note) for a voice_opt_out contact; prompts to set a cell when the navigator has
// none (both the local gate AND a 409 cell_not_verified from the server).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { ContactPhone } from '../../api/index.js';

const originateCall = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    originateCall: (...a: unknown[]) => originateCall(...a),
  };
});

import { CallMenu } from './CallMenu.js';

const A = '+14040100001';
const B = '+14040100002';
const PHONES: ContactPhone[] = [
  { phone: A, primary: true, label: 'cell' },
  { phone: B, primary: false, label: 'work' },
];

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('CallMenu — masked originate', () => {
  it('is disabled when the contact has no number', () => {
    render(<CallMenu contactId="c1" phones={[]} />);
    expect(screen.getByRole('button', { name: /Call/i })).toBeDisabled();
  });

  it('POSTs the originate on click and shows the calling state', async () => {
    const user = userEvent.setup();
    originateCall.mockResolvedValue({ callSid: 'CA123' });
    render(<CallMenu contactId="c1" phones={PHONES} defaultPhone={PHONES[0]} />);

    await user.click(screen.getByRole('button', { name: /Call/i }));
    // One dial button per number (real buttons, not tel: links now).
    const dialButtons = screen.getAllByRole('menuitem');
    expect(dialButtons).toHaveLength(2);

    await user.click(dialButtons[0]!);
    expect(originateCall).toHaveBeenCalledWith('c1', { phone: A });
    expect(await screen.findByText(/Calling your cell/i)).toBeInTheDocument();
  });

  it('passes the chosen number when a non-primary is dialed', async () => {
    const user = userEvent.setup();
    originateCall.mockResolvedValue({ callSid: 'CA124' });
    render(<CallMenu contactId="c1" phones={PHONES} defaultPhone={PHONES[0]} />);
    await user.click(screen.getByRole('button', { name: /Call/i }));
    await user.click(screen.getAllByRole('menuitem')[1]!);
    expect(originateCall).toHaveBeenCalledWith('c1', { phone: B });
  });

  it('is disabled with a "do not call" note for a voice_opt_out contact', () => {
    render(<CallMenu contactId="c1" phones={PHONES} defaultPhone={PHONES[0]} voiceOptOut />);
    const callBtn = screen.getByRole('button', { name: /Call/i });
    expect(callBtn).toBeDisabled();
    const dncNote = screen.getByText(/Do not call/i);
    expect(dncNote).toBeInTheDocument();
    // The disabled button must be programmatically linked to the DNC note so
    // AT users know WHY it is disabled (spec §5 / review finding I-2).
    expect(callBtn).toHaveAttribute('aria-describedby', dncNote.id);
    expect(dncNote.id).toBe('call-dnc-note');
    expect(originateCall).not.toHaveBeenCalled();
  });

  it('Copy buttons each have a distinguishing aria-label (M-1)', async () => {
    const user = userEvent.setup();
    originateCall.mockResolvedValue({ callSid: 'CA123' });
    render(<CallMenu contactId="c1" phones={PHONES} defaultPhone={PHONES[0]} />);
    await user.click(screen.getByRole('button', { name: /Call/i }));
    // Each Copy button is labelled with the formatted phone so AT users can
    // tell them apart when multiple numbers are listed.
    expect(
      screen.getByRole('button', { name: /Copy \(404\) 010-0001/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Copy \(404\) 010-0002/i }),
    ).toBeInTheDocument();
  });

  it('prompts to set a cell (no dial) when the navigator has no verified cell', async () => {
    const user = userEvent.setup();
    const onSetUpCell = vi.fn();
    render(
      <CallMenu
        contactId="c1"
        phones={PHONES}
        defaultPhone={PHONES[0]}
        navigatorHasVerifiedCell={false}
        onSetUpCell={onSetUpCell}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Call/i }));
    await user.click(screen.getAllByRole('menuitem')[0]!);

    // No originate attempted; a set-cell prompt appears with a deep-link.
    expect(originateCall).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Set up your cell/i);
    await user.click(screen.getByRole('button', { name: /Set up my cell/i }));
    expect(onSetUpCell).toHaveBeenCalledTimes(1);
  });

  it('prompts to set a cell on a 409 cell_not_verified from the server', async () => {
    const user = userEvent.setup();
    originateCall.mockRejectedValue(new ApiError(409, 'cell_not_verified', 'no verified cell'));
    render(<CallMenu contactId="c1" phones={PHONES} defaultPhone={PHONES[0]} onSetUpCell={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Call/i }));
    await user.click(screen.getAllByRole('menuitem')[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Set up your cell/i);
  });

  it('handles a 409 contact_voice_opted_out gracefully', async () => {
    const user = userEvent.setup();
    originateCall.mockRejectedValue(
      new ApiError(409, 'contact_voice_opted_out', 'do not call'),
    );
    render(<CallMenu contactId="c1" phones={PHONES} defaultPhone={PHONES[0]} />);
    await user.click(screen.getByRole('button', { name: /Call/i }));
    await user.click(screen.getAllByRole('menuitem')[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/do not call/i);
  });
});
