import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ListingSendRow } from '../../api/index.js';
import { formatHeardFrom } from '../../lib/heardFrom.js';
import { interestedModeOf, SendRosterList, SendRosterRow, type SendRosterRowProps } from './Card.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ROW: ListingSendRow = {
  contactId: 'c-1',
  tenantName: 'Tia Moss',
  unitId: 'u1',
  sentAt: '2026-10-03T15:00:00.000Z',
  via: 'broadcast',
  outcome: 'no_reply',
  interestedSupported: true,
};

function renderRow(row: Partial<ListingSendRow> = {}, props: Partial<SendRosterRowProps> = {}) {
  const onOutcome = props.onOutcome ?? vi.fn(() => Promise.resolve());
  render(
    <MemoryRouter>
      <SendRosterList label="Properties sent">
        <SendRosterRow
          to="/contacts/c-1"
          identity="Tia Moss"
          row={{ ...ROW, ...row }}
          address="12 Oak St"
          name="Tia Moss"
          interestedMode="route"
          now={NOW}
          {...props}
          onOutcome={onOutcome}
        />
      </SendRosterList>
    </MemoryRouter>,
  );
  return { onOutcome };
}

describe('SendRosterRow - markup R1 (plan head 3.4 #10)', () => {
  it('the row root is ONE listitem inside the named list, and nothing inside it is another listitem', () => {
    renderRow({ outcome: 'not_interested', declined: { at: '2026-10-05T10:00:00.000Z', by: 'staff' } });
    const list = screen.getByRole('list', { name: 'Properties sent' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]!.tagName).toBe('LI');
    expect(within(items[0]!).getByRole('link', { name: 'Tia Moss' })).toBeInTheDocument();
    expect(within(items[0]!).getByText('Not interested', { exact: true })).toBeInTheDocument();
  });

  it('three rows in one list are exactly three listitems', () => {
    render(
      <MemoryRouter>
        <SendRosterList label="Waiting">
          {['c-1', 'c-2', 'c-3'].map((id) => (
            <SendRosterRow
              key={id}
              to={`/contacts/${id}`}
              identity={id}
              row={{ ...ROW, contactId: id }}
              address="12 Oak St"
              name={id}
              interestedMode="route"
              onOutcome={() => Promise.resolve()}
              now={NOW}
            />
          ))}
        </SendRosterList>
      </MemoryRouter>,
    );
    expect(within(screen.getByRole('list', { name: 'Waiting' })).getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('SendRosterRow - outcome rendering', () => {
  it('no_reply: the chip, both dates, Interested + Not interested with their names', () => {
    renderRow();
    expect(screen.getByText('No reply yet')).toBeInTheDocument();
    expect(screen.getByText(`Sent ${formatHeardFrom(ROW.sentAt, NOW).label}`)).toBeInTheDocument();
    expect(screen.getByText(`Last heard from ${formatHeardFrom(undefined, NOW).label}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' })).toHaveTextContent('Interested');
    expect(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toHaveTextContent('Not interested');
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
  });

  // Contract N1 (adjudication outcome-F3): an EMPTY formatHeardFrom title means
  // "render no title attribute" - never title="".
  it('a never-heard row renders NO title attribute on its Last heard from span; the Sent span carries its stamp', () => {
    renderRow();
    const heard = screen.getByText(`Last heard from ${formatHeardFrom(undefined, NOW).label}`);
    expect(heard).not.toHaveAttribute('title');
    const sent = formatHeardFrom(ROW.sentAt, NOW);
    expect(sent.title).not.toBe('');
    expect(screen.getByText(`Sent ${sent.label}`)).toHaveAttribute('title', sent.title);
  });

  it('replied: the Replied chip and the last-heard date', () => {
    renderRow({ outcome: 'replied', lastHeardFromAt: '2026-10-10T09:00:00.000Z' });
    expect(screen.getByText('Replied')).toBeInTheDocument();
    expect(screen.getByText(`Last heard from ${formatHeardFrom('2026-10-10T09:00:00.000Z', NOW).label}`)).toBeInTheDocument();
  });

  it('interested: the TourChip IS the signal, and there are no buttons', () => {
    renderRow({ outcome: 'interested', tour: { tourId: 't-9', state: 'scheduled' } });
    expect(screen.getByRole('link', { name: 'Tour scheduled' })).toHaveAttribute('href', '/tours/t-9');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('not_interested (staff): the muted chip with the date in its title, and Undo only', () => {
    renderRow({ outcome: 'not_interested', declined: { at: '2026-10-05T10:00:00.000Z', by: 'staff' } });
    const chip = screen.getByText('Not interested');
    expect(chip).toHaveAttribute('title', formatHeardFrom('2026-10-05T10:00:00.000Z', NOW).title);
    expect(screen.getByRole('button', { name: 'Undo not interested for Tia Moss' })).toHaveTextContent('Undo');
    expect(screen.queryByRole('button', { name: /^Mark / })).not.toBeInTheDocument();
  });

  it('not_interested by the engine reads "(auto)"', () => {
    renderRow({ outcome: 'not_interested', declined: { at: '2026-10-05T10:00:00.000Z', by: 'engine' } });
    expect(screen.getByText('Not interested (auto)')).toBeInTheDocument();
  });

  it('a partner row shows the Request a tour LINK in place of Interested', () => {
    renderRow({ interestedSupported: false }, { name: 'Cora Reyes', requestTourTo: '/listings/u1?tour=new' });
    expect(screen.getByRole('link', { name: 'Request a tour for Cora Reyes at 12 Oak St' })).toHaveAttribute('href', '/listings/u1?tour=new');
    // Anchored on the Interested name ONLY (adjudication outcome-F2): an
    // unanchored /interested in/ also matches the required Not interested button.
    expect(screen.queryByRole('button', { name: /^Mark Cora Reyes interested in/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark Cora Reyes not interested in 12 Oak St' })).toBeInTheDocument();
  });

  // B8: the HOST passes requestTourTo only for a partner recipient, so a
  // landlord / team-member row (interestedSupported false, no requestTourTo)
  // renders neither - the host-level landlord negatives are in 5.3 / 5.4.
  it('a non-tenant row without requestTourTo (a landlord row) shows neither Interested nor the link', () => {
    renderRow({ interestedSupported: false });
    expect(screen.queryByRole('link', { name: /^Request a tour/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Mark Tia Moss interested/ })).not.toBeInTheDocument();
  });

  it('actionsDisabled (a deleted property) and recipientMissing keep the chip but drop every action', () => {
    renderRow({}, { actionsDisabled: true });
    expect(screen.getByText('No reply yet')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('a missing recipient has no actions', () => {
    renderRow({ recipientMissing: true, interestedSupported: false }, { requestTourTo: '/listings/u1?tour=new' });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /^Request a tour/ })).not.toBeInTheDocument();
  });

  it('the kind label sits OUTSIDE the identity link', () => {
    renderRow({}, { kind: 'Caseworker' });
    expect(screen.getByRole('link', { name: 'Tia Moss' })).toHaveAttribute('href', '/contacts/c-1');
    expect(screen.getByText('Caseworker')).toBeInTheDocument();
  });
});

// flyer-leads D8: a pair whose latest counted entry is a flyer sign-up.
describe('SendRosterRow - signed_up (flyer-leads D8)', () => {
  const SIGNED_UP_AT = '2026-10-11T16:30:00.000Z';
  const SIGNED_UP: Partial<ListingSendRow> = { outcome: 'signed_up', sentAt: SIGNED_UP_AT };

  it('reads "Signed up from the flyer <date>" in place of "Sent <date>" - the same date label and title', () => {
    renderRow(SIGNED_UP);
    const sent = formatHeardFrom(SIGNED_UP_AT, NOW);
    expect(sent.title).not.toBe('');
    expect(screen.getByText(`Signed up from the flyer ${sent.label}`)).toHaveAttribute('title', sent.title);
    expect(screen.queryByText(/^Sent /)).not.toBeInTheDocument();
    // The Last heard from half is unchanged.
    expect(screen.getByText(`Last heard from ${formatHeardFrom(undefined, NOW).label}`)).toBeInTheDocument();
  });

  it('the outcome chip reads "Signed up", in the positive chip colour', () => {
    renderRow(SIGNED_UP);
    expect(screen.getByText('Signed up', { exact: true }).className).toContain('chipPositive');
  });

  it('offers the waiting actions - Interested and Not interested - and no Undo', () => {
    renderRow(SIGNED_UP);
    expect(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' })).toHaveTextContent('Interested');
    expect(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toHaveTextContent('Not interested');
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
  });

  it('Not interested calls the outcome route', async () => {
    const { onOutcome } = renderRow(SIGNED_UP);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' }));
    expect(onOutcome).toHaveBeenCalledWith('not_interested');
  });

  // An unknown contact's flyer row (interestedSupported false; the hosts pass
  // requestTourTo for a PARTNER only): Not interested alone.
  it('an unknown-contact row offers Not interested only - no Interested, no Request a tour', () => {
    renderRow({ ...SIGNED_UP, interestedSupported: false });
    expect(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Mark Tia Moss interested in/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Request a tour/ })).not.toBeInTheDocument();
  });

  it('a deleted property keeps the words and the chip but drops every action', () => {
    renderRow(SIGNED_UP, { actionsDisabled: true });
    expect(screen.getByText(`Signed up from the flyer ${formatHeardFrom(SIGNED_UP_AT, NOW).label}`)).toBeInTheDocument();
    expect(screen.getByText('Signed up', { exact: true })).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('SendRosterRow - actions', () => {
  it('Not interested calls onOutcome and disables itself while in flight', async () => {
    let resolve!: () => void;
    const onOutcome = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    renderRow({}, { onOutcome });
    const button = screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' });
    await userEvent.click(button);
    expect(onOutcome).toHaveBeenCalledWith('not_interested');
    expect(button).toBeDisabled();
    resolve();
    await vi.waitFor(() => expect(button).toBeEnabled());
  });

  it("Interested in 'route' mode calls the route", async () => {
    const { onOutcome } = renderRow();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    expect(onOutcome).toHaveBeenCalledWith('interested');
  });

  it("'form' mode: onOpenTourForm, never onOutcome", async () => {
    const onOpenTourForm = vi.fn();
    const { onOutcome } = renderRow({}, { interestedMode: 'form', onOpenTourForm });
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    expect(onOpenTourForm).toHaveBeenCalledTimes(1);
    expect(onOutcome).not.toHaveBeenCalled();
  });

  // Review B R2-5: the property lost its tour_type since the page loaded, so
  // the route answers 409 tour_type_required - fall through to the form path.
  it("'route' mode answered 409 tour_type_required opens the tour form (no error line)", async () => {
    const onOpenTourForm = vi.fn();
    const onOutcome = vi.fn(() => Promise.reject(new ApiError(409, 'tour_type_required', 'tour_type_required', { error: 'tour_type_required' })));
    renderRow({}, { onOutcome, onOpenTourForm });
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    expect(onOutcome).toHaveBeenCalledWith('interested');
    await vi.waitFor(() => expect(onOpenTourForm).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("'route' mode answered 409 tour_type_required with no form host shows the existing error", async () => {
    const onOutcome = vi.fn(() => Promise.reject(new ApiError(409, 'tour_type_required', 'tour_type_required', { error: 'tour_type_required' })));
    renderRow({}, { onOutcome });
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save - try again.");
  });

  it("'form' mode with no form host shows Not interested but no Interested button", () => {
    renderRow({}, { interestedMode: 'form' });
    expect(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' })).not.toBeInTheDocument();
  });

  it('Undo calls clear', async () => {
    const { onOutcome } = renderRow({ outcome: 'not_interested', declined: { at: '2026-10-05T10:00:00.000Z', by: 'staff' } });
    await userEvent.click(screen.getByRole('button', { name: 'Undo not interested for Tia Moss' }));
    expect(onOutcome).toHaveBeenCalledWith('clear');
  });

  it('a failure shows the inline error; a 503 saved shows the saved line; the next attempt clears it', async () => {
    const onOutcome = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new ApiError(503, 'outcome_unavailable', 'x', { error: 'outcome_unavailable', saved: true }))
      .mockResolvedValueOnce(undefined);
    renderRow({}, { onOutcome });
    const button = screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' });
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save - try again.");
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved - reload to see the change.');
    await userEvent.click(button);
    await vi.waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('interestedModeOf', () => {
  it("'route' for a unit with a tour_type, else 'form' (absent unit included)", () => {
    expect(interestedModeOf({ tour_type: 'self_guided' })).toBe('route');
    expect(interestedModeOf({})).toBe('form');
    expect(interestedModeOf(undefined)).toBe('form');
  });
});
