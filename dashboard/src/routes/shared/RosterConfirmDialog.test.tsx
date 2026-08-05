// RosterConfirmDialog component tests (contact-rosters spec 6.3 / 6.4, Task 11).
// The dialog is the last thing an operator reads before a REAL group text goes
// out, so every assertion here is about honesty:
//   - the body is the SERVER-composed one, rendered verbatim (never re-built in
//     the browser - the template is founder-editable and a client copy drifts)
//   - every recipient is listed, receiving or not, WITH the reason - a bare
//     "3 recipients" over a suppressed leg is the exact lie goal 3 forbids
//   - the count is the server's distinct-reachable-numbers count
//   - the quiet-hours line is the honest INTERIM: quiet hours are informational
//     until slice 6 wires deferral, so it never promises a later send
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
    title: 'Open the group text?',
    preview: preview(),
    confirmLabel: 'Open group text',
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

describe('RosterConfirmDialog - quiet hours (honest interim)', () => {
  it('says quiet hours hold AND that this still sends now, naming the window end', () => {
    renderDialog({
      preview: preview({ deferred: true, quietEndsAt: '2026-08-05T12:00:00.000Z' }),
    });
    // The instant is formatted in the viewer's zone, so match the sentence shape
    // rather than a fixed clock label.
    expect(
      screen.getByText(/^Quiet hours until .+ - this will still send now\.$/),
    ).toBeInTheDocument();
  });

  it('says nothing about quiet hours outside the window', () => {
    renderDialog();
    expect(screen.queryByText(/Quiet hours/)).not.toBeInTheDocument();
  });
});

describe('RosterConfirmDialog - actions', () => {
  it('confirms once, then closes', async () => {
    const { onConfirm, onClose } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Open group text' }));
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
          message: 'That number is already in another group text on this pool number.',
        }),
      );
    const onClose = vi.fn();
    render(
      <RosterConfirmDialog
        title="Add Alicia Grant to the group text?"
        preview={preview()}
        confirmLabel="Add and notify"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add and notify' }));
    expect(
      await screen.findByText(
        'That number is already in another group text on this pool number.',
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
    const actions = screen.getByRole('button', { name: 'Open group text' }).parentElement!;
    expect(actions.className).toContain('actions');
    const css = readFileSync(
      join(process.cwd(), 'src/routes/shared/RosterConfirmDialog.module.css'),
      'utf8',
    );
    expect(css).toContain('@media (max-width: 860px)');
    expect(css).toMatch(/\.actions\s*\{[^}]*flex-direction:\s*column-reverse/);
    expect(css).toMatch(/\.actions\s*>\s*\*\s*\{[^}]*width:\s*100%/);
  });
});
