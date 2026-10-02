// TourModals tests - ReopenTourModal, rendered DIRECTLY with vi.fn props: the
// tour page wires it in later (TourDetail.tsx), and that page-level wiring is
// tested in TourDetail.test.tsx with every other tour dialog. Verifies the
// dialog's name, its body per reopen target (spec 9.2), its confirm label
// ("Yes, reopen" - never "Reopen tour", the header control's name), the
// confirm-then-close order, the error copy (a 409 says reload, anything else
// says try again; the dialog stays open either way) and the Cancel button.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import buttonStyles from '../../ui/Button.module.css';
import { ReopenTourModal, TOUR_CHANGED_COPY } from './TourModals.js';
import type { ReopenTarget } from './tourReopen.js';

/** The shared 409 copy every writing tour dialog uses (spec 9.2 / D14). */
const CHANGED = 'This tour changed since the page loaded - reload and try again.';
const GENERIC = "Couldn't reopen the tour - please try again.";

const BODY: Record<ReopenTarget, string> = {
  toured: 'This tour goes back to Toured so you can record a different outcome. Nothing is sent.',
  no_show: 'This tour goes back to No show so you can reschedule it. Nothing is sent.',
  scheduled:
    'This tour goes back to Not marked so you can mark it toured or a no-show, or reschedule it. Nothing is sent.',
};

function renderReopen(
  target: ReopenTarget,
  onConfirm: () => Promise<void> = vi.fn().mockResolvedValue(undefined),
) {
  const onClose = vi.fn();
  const view = render(<ReopenTourModal target={target} onClose={onClose} onConfirm={onConfirm} />);
  return { onClose, onConfirm, view };
}

describe('ReopenTourModal', () => {
  it('is a dialog named "Reopen tour" whose body says where the tour goes, per target', () => {
    for (const target of ['toured', 'no_show', 'scheduled'] as const) {
      const { view } = renderReopen(target);
      const dialog = screen.getByRole('dialog', { name: 'Reopen tour' });
      expect(within(dialog).getByText(BODY[target])).toBeInTheDocument();
      // Only this target's body.
      for (const other of ['toured', 'no_show', 'scheduled'] as const) {
        if (other !== target) expect(within(dialog).queryByText(BODY[other])).not.toBeInTheDocument();
      }
      view.unmount();
    }
  });

  it('confirms with "Yes, reopen" (a normal, non-danger button) - never a second "Reopen tour"', () => {
    renderReopen('toured');
    const dialog = screen.getByRole('dialog', { name: 'Reopen tour' });
    const confirm = within(dialog).getByRole('button', { name: 'Yes, reopen' });
    expect(confirm).toBeEnabled();
    expect(confirm).toHaveClass(buttonStyles.primary!);
    expect(confirm).not.toHaveClass(buttonStyles.danger!);
    // The page behind the shared Modal is not inert and Playwright names match
    // by substring: no control in the dialog may be named like the header CTA.
    expect(within(dialog).queryByRole('button', { name: /reopen tour/i })).not.toBeInTheDocument();
  });

  it('"Yes, reopen" awaits onConfirm, THEN calls onClose', async () => {
    let finish: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { onClose } = renderReopen('no_show', onConfirm);
    await userEvent.click(screen.getByRole('button', { name: 'Yes, reopen' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Still in flight: nothing closed yet, and the dialog cannot be re-fired.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reopening...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a 409 ApiError (any reopen refusal) shows the reload copy and the dialog stays open', async () => {
    expect(TOUR_CHANGED_COPY).toBe(CHANGED);
    for (const code of ['tour_not_closed', 'tour_converted', 'tour_reopen_unsupported', 'tour_changed']) {
      const onConfirm = vi.fn().mockRejectedValue(new ApiError(409, code, code));
      const { onClose, view } = renderReopen('scheduled', onConfirm);
      await userEvent.click(screen.getByRole('button', { name: 'Yes, reopen' }));
      expect((await screen.findByRole('alert')).textContent).toBe(CHANGED);
      expect(screen.queryByText(GENERIC)).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Reopen tour' })).toBeInTheDocument();
      // Released for another attempt (a reload is the advice, not a lock).
      expect(screen.getByRole('button', { name: 'Yes, reopen' })).toBeEnabled();
      view.unmount();
    }
  });

  it('any other rejection shows the generic copy and the dialog stays open', async () => {
    const failures: unknown[] = [
      new ApiError(500, 'internal_error', 'internal_error'),
      new ApiError(404, 'tour_not_found', 'tour_not_found'),
      new ApiError(0, 'network_error', 'Network error'),
      new Error('boom'),
    ];
    for (const failure of failures) {
      const onConfirm = vi.fn().mockRejectedValue(failure);
      const { onClose, view } = renderReopen('toured', onConfirm);
      await userEvent.click(screen.getByRole('button', { name: 'Yes, reopen' }));
      expect((await screen.findByRole('alert')).textContent).toBe(GENERIC);
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Reopen tour' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Yes, reopen' })).toBeEnabled();
      view.unmount();
    }
  });

  it('"Cancel" calls onClose only', async () => {
    const { onClose, onConfirm } = renderReopen('toured');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
