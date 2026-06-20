import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LostReasonModal, buildLostReason } from './LostReasonModal.js';

afterEach(() => vi.restoreAllMocks());

describe('buildLostReason', () => {
  it('includes only the non-empty parts', () => {
    expect(buildLostReason('', '')).toEqual({});
    expect(buildLostReason('stalled', '')).toEqual({ category: 'stalled' });
    expect(buildLostReason('', '  note  ')).toEqual({ text: 'note' });
    expect(buildLostReason('other', 'detail')).toEqual({ category: 'other', text: 'detail' });
  });
});

describe('LostReasonModal', () => {
  it('disables confirm until a category OR non-empty text is provided', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<LostReasonModal onClose={() => {}} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Mark lost' });
    expect(confirm).toBeDisabled();

    // Picking a category enables it.
    await user.click(screen.getByRole('radio', { name: 'Stalled out' }));
    expect(confirm).toBeEnabled();
  });

  it('enables via free text alone and builds the right reason', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<LostReasonModal onClose={() => {}} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Mark lost' });
    await user.type(screen.getByRole('textbox'), 'moved away');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ text: 'moved away' });
  });

  it('builds a category+text reason on confirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<LostReasonModal onClose={() => {}} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('radio', { name: 'Voucher expired' }));
    await user.type(screen.getByRole('textbox'), 'expired in May');
    await user.click(screen.getByRole('button', { name: 'Mark lost' }));
    expect(onConfirm).toHaveBeenCalledWith({ category: 'voucher_expired', text: 'expired in May' });
  });
});
