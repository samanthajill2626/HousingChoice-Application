// RosterConfirmDialog component tests (contact-rosters spec 6.3 / 6.4, Task 11).
// The dialog is the last thing an operator reads before a REAL relay group goes
// out, so every assertion here is about honesty:
//   - the body is the SERVER-composed one, rendered verbatim (never re-built in
//     the browser - the template is founder-editable and a client copy drifts)
//   - every recipient is listed, receiving or not, WITH the reason - a bare
//     "3 recipients" over a suppressed leg is the exact lie goal 3 forbids
//   - the count is the server's distinct-reachable-numbers count
//   - INSIDE quiet hours the dialog is the REAL three-button layout (Task 14):
//     [Cancel] [Send now anyway] [<verb> at 8:00 AM] with the DEFERRAL as the
//     default. The plain confirm now DEFERS server-side (202), so "Send now
//     anyway" is the only path that sends immediately - and it is the only one
//     that passes force
//   - a failed confirm keeps the dialog open with the server's own copy
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type RosterPreview } from '../../api/index.js';
import { RosterConfirmDialog, type RosterConfirmDialogProps } from './RosterConfirmDialog.js';

function preview(over: Partial<RosterPreview> = {}): RosterPreview {
  return {
    body: 'Hi Tasha and Alicia - this is Housing Choice connecting you about 1428 Oak St SE.',
    recipients: [
      { name: 'Tasha Nguyen', reachability: 'reachable' },
      { name: 'Alicia Grant', reachability: 'reachable' },
    ],
    recipientCount: 2,
    deferred: false,
    ...over,
  };
}

function renderDialog(over: Partial<RosterConfirmDialogProps> = {}): {
  onConfirm: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const props: RosterConfirmDialogProps = {
    title: 'Open the relay group?',
    preview: preview(),
    confirmLabel: 'Open relay group',
    deferLabel: 'Open',
    onConfirm,
    onClose,
    ...over,
  };
  render(<RosterConfirmDialog {...props} />);
  return { onConfirm, onClose };
}

describe('RosterConfirmDialog - what the group will actually receive', () => {
  it('renders the SERVER-composed body verbatim in the message preview', () => {
    renderDialog();
    const bubble = screen.getByRole('region', { name: 'Message preview' });
    expect(
      within(bubble).getByText(
        'Hi Tasha and Alicia - this is Housing Choice connecting you about 1428 Oak St SE.',
      ),
    ).toBeInTheDocument();
  });

  it('lists EVERY recipient with the reason their leg is suppressed', () => {
    renderDialog({
      preview: preview({
        recipients: [
          { name: 'Tasha Nguyen', reachability: 'reachable' },
          { name: 'Alicia Grant', reachability: 'opted_out' },
          { name: 'Marcus Webb', reachability: 'no_phone' },
        ],
        recipientCount: 1,
      }),
    });
    const rows = within(screen.getByRole('list', { name: 'Recipients' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).queryByText(/not receiving/)).not.toBeInTheDocument();
    expect(within(rows[1]!).getByText('not receiving - opted out')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('not receiving - no mobile number')).toBeInTheDocument();
  });

  it("uses the SERVER's recipient count, not the number of rows", () => {
    renderDialog({
      preview: preview({
        recipients: [
          { name: 'Tasha Nguyen', reachability: 'reachable' },
          { name: 'Alicia Grant', reachability: 'opted_out' },
          { name: 'Marcus Webb', reachability: 'no_phone' },
        ],
        recipientCount: 1,
      }),
    });
    expect(screen.getByText('1 recipient will receive this.')).toBeInTheDocument();
  });

  it('names a bare-phone recipient without ever printing a phone number', () => {
    renderDialog({
      preview: preview({
        recipients: [{ reachability: 'reachable' }],
        recipientCount: 1,
      }),
    });
    const rows = within(screen.getByRole('list', { name: 'Recipients' })).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Unnamed number')).toBeInTheDocument();
    expect(screen.queryByText(/\+1\d{10}/)).not.toBeInTheDocument();
  });
});

describe('RosterConfirmDialog - quiet hours: the REAL three-button layout (spec 6.3/6.4)', () => {
  /** The quiet-end instant every case below defers to. */
  const QUIET = { deferred: true, quietEndsAt: '2026-08-05T12:00:00.000Z' } as const;

  /** The clock label the dialog renders for QUIET, in the VIEWER's zone (the
   *  dialog formats the server's instant - it never re-derives it). */
  const CLOCK = new Date(QUIET.quietEndsAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  it('names the window end and says the send waits for it', () => {
    renderDialog({ preview: preview(QUIET) });
    expect(
      screen.getByText(`Quiet hours until ${CLOCK} - this goes out then unless you send it now.`),
    ).toBeInTheDocument();
  });

  it('offers THREE buttons, with the deferral as the default action', () => {
    renderDialog({ preview: preview(QUIET) });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send now anyway' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Open at ${CLOCK}` })).toBeInTheDocument();
    // The interim two-button copy is GONE - it promised an immediate send.
    expect(screen.queryByText(/still send now/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open relay group' })).not.toBeInTheDocument();
  });

  it('renders the ADD dialog verb: "Add and notify at <time>" (spec 6.4)', () => {
    renderDialog({
      preview: preview(QUIET),
      title: 'Add Alicia Grant to the relay group?',
      confirmLabel: 'Add and notify',
      deferLabel: 'Add and notify',
    });
    expect(screen.getByRole('button', { name: `Add and notify at ${CLOCK}` })).toBeInTheDocument();
  });

  it('the DEFAULT defers: it confirms WITHOUT force (the server answers 202)', async () => {
    const { onConfirm, onClose } = renderDialog({ preview: preview(QUIET) });
    await userEvent.click(screen.getByRole('button', { name: `Open at ${CLOCK}` }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('"Send now anyway" is the ONLY path that forces an immediate send', async () => {
    const { onConfirm, onClose } = renderDialog({ preview: preview(QUIET) });
    await userEvent.click(screen.getByRole('button', { name: 'Send now anyway' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('falls back to a time-less deferral label when the server sent no quietEndsAt', () => {
    renderDialog({ preview: preview({ deferred: true }) });
    expect(screen.getByRole('button', { name: 'Open when quiet hours end' })).toBeInTheDocument();
    expect(screen.getByText('Quiet hours - this goes out when they end unless you send it now.'))
      .toBeInTheDocument();
  });

  it('says nothing about quiet hours - and stays TWO buttons - outside the window', async () => {
    const { onConfirm } = renderDialog();
    expect(screen.queryByText(/Quiet hours/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send now anyway' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open relay group' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(false));
  });
});

describe('RosterConfirmDialog - allowDefer={false} (an endpoint that CANNOT defer)', () => {
  /** The same quiet-end instant the three-button suite above defers to. */
  const QUIET = { deferred: true, quietEndsAt: '2026-08-05T12:00:00.000Z' } as const;

  const CLOCK = new Date(QUIET.quietEndsAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  it('drops BOTH deferral affordances but KEEPS the quiet-hours warning', () => {
    // POST /api/relay-groups has no pending-action row to hold a deferral, so a
    // "Open at 8:00 AM" button would be the exact lie this dialog exists to
    // prevent. The warning still renders: the operator is told it is quiet
    // hours, they just cannot schedule around it here.
    renderDialog({ preview: preview(QUIET), allowDefer: false });
    expect(
      screen.getByText(`Quiet hours until ${CLOCK} - this goes out then unless you send it now.`),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send now anyway' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Open at ${CLOCK}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open when quiet hours end/ })).not.toBeInTheDocument();
  });

  it('offers exactly Cancel and the confirmLabel in the footer', () => {
    renderDialog({ preview: preview(QUIET), allowDefer: false });
    const footer = screen.getByRole('button', { name: 'Open relay group' }).parentElement!;
    expect(footer.className).toContain('actions');
    const inFooter = screen
      .getAllByRole('button')
      .filter((b) => b.parentElement === footer && b.textContent !== '');
    expect(inFooter).toHaveLength(2);
    expect(inFooter[0]).toHaveAccessibleName('Cancel');
    expect(inFooter[1]).toHaveAccessibleName('Open relay group');
  });

  it('confirms WITHOUT force - the endpoint has no force parameter', async () => {
    const { onConfirm, onClose } = renderDialog({ preview: preview(QUIET), allowDefer: false });
    await userEvent.click(screen.getByRole('button', { name: 'Open relay group' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('DEFAULTS to true: an unset prop still renders the three-button quiet layout', () => {
    // Tour, placement, and PeopleCard pass no allowDefer at all. If the default
    // ever flipped, all three would silently lose their deferral.
    renderDialog({ preview: preview(QUIET) });
    expect(screen.getByRole('button', { name: 'Send now anyway' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Open at ${CLOCK}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open relay group' })).not.toBeInTheDocument();
  });
});

describe('RosterConfirmDialog - actions', () => {
  it('confirms once, then closes', async () => {
    const { onConfirm, onClose } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Open relay group' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels WITHOUT running the action', async () => {
    const { onConfirm, onClose } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the server's own refusal copy inline and STAYS OPEN", async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, 'phone_conflict_on_number', 'phone_conflict_on_number', {
          error: 'phone_conflict_on_number',
          message: 'That number is already in another relay group on this pool number.',
        }),
      );
    const onClose = vi.fn();
    render(
      <RosterConfirmDialog
        title="Add Alicia Grant to the relay group?"
        preview={preview()}
        confirmLabel="Add and notify"
        deferLabel="Add and notify"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add and notify' }));
    expect(
      await screen.findByText(
        'That number is already in another relay group on this pool number.',
      ),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('RosterConfirmDialog - narrow viewport (spec 6.7)', () => {
  it('stacks the footer buttons full-width with the DEFAULT on top below 860px', () => {
    renderDialog();
    // The default action is authored LAST (desktop puts it rightmost); the
    // narrow rule reverses the column so it lands on TOP. jsdom evaluates no
    // CSS, so assert the hook AND the rule that targets it (the s3c idiom).
    const actions = screen.getByRole('button', { name: 'Open relay group' }).parentElement!;
    expect(actions.className).toContain('actions');
    const css = readFileSync(
      join(process.cwd(), 'src/routes/shared/RosterConfirmDialog.module.css'),
      'utf8',
    );
    expect(css).toContain('@media (max-width: 860px)');
    expect(css).toMatch(/\.actions\s*\{[^}]*flex-direction:\s*column-reverse/);
    expect(css).toMatch(/\.actions\s*>\s*\*\s*\{[^}]*width:\s*100%/);
  });

  it('stacks ALL THREE quiet-hours buttons in one row container (360px rule)', () => {
    renderDialog({ preview: preview({ deferred: true, quietEndsAt: '2026-08-05T12:00:00.000Z' }) });
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent !== '');
    // Cancel, Send now anyway, and the deferral default - all three share ONE
    // .actions container, so the single column-reverse rule stacks the whole
    // footer (default on top) instead of leaving a stray button inline.
    const footer = screen.getByRole('button', { name: 'Send now anyway' }).parentElement!;
    expect(footer.className).toContain('actions');
    const inFooter = buttons.filter((b) => b.parentElement === footer);
    expect(inFooter).toHaveLength(3);
    // Authored order is Cancel -> Send now anyway -> default (reversed to put
    // the default on TOP below 860px).
    expect(inFooter[0]).toHaveAccessibleName('Cancel');
    expect(inFooter[1]).toHaveAccessibleName('Send now anyway');
    expect(inFooter[2]!.textContent).toMatch(/^Open at /);
  });
});
