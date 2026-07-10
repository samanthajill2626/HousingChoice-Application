import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow as InboxRowData } from '../../api/index.js';
import { InboxRow } from './InboxRow.js';

function mkRow(over: Partial<InboxRowData> = {}): InboxRowData {
  return {
    kind: 'contact',
    contactId: 'c1',
    name: 'Tasha Williams',
    unreadCount: 2,
    preview: 'Is the 2BR still open?',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
    ...over,
  };
}

const onOpen = vi.fn();
const onMarkRead = vi.fn();

function renderRow(row: InboxRowData): void {
  render(
    <MemoryRouter>
      <ul>
        <InboxRow row={row} onOpen={onOpen} onMarkRead={onMarkRead} />
      </ul>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  onOpen.mockReset();
  onMarkRead.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('InboxRow', () => {
  it('links a contact row to its contact page and shows name + preview', () => {
    renderRow(mkRow());
    const link = screen.getByRole('link', { name: /Tasha Williams/ });
    expect(link).toHaveAttribute('href', '/contacts/c1');
    expect(within(link).getByText(/Is the 2BR still open\?/)).toBeInTheDocument();
  });

  it('marks read when the row is opened (tap)', () => {
    renderRow(mkRow());
    fireEvent.click(screen.getByRole('link', { name: /Tasha Williams/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('prefixes outbound previews with "You:"', () => {
    renderRow(mkRow({ direction: 'outbound', preview: 'Sent you the flyer' }));
    expect(screen.getByText(/^You:/)).toBeInTheDocument();
  });

  it('shows an amber "Needs triage" chip on an unknown row and links to the triage list with the phone', () => {
    renderRow(
      mkRow({ kind: 'unknown', contactId: undefined, phone: '+15555550123', name: '(555) 555-0123', role: 'unknown', needsTriage: true }),
    );
    expect(screen.getByText(/Needs triage/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /555.*0123/ })).toHaveAttribute(
      'href',
      '/contacts/unknown?phone=%2B15555550123',
    );
  });

  it('shows the unread count and a Mark read action for unread rows', () => {
    renderRow(mkRow({ unreadCount: 3 }));
    expect(screen.getByText('3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /mark .* read/i }));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it('omits the Mark read action for already-read rows', () => {
    renderRow(mkRow({ unreadCount: 0 }));
    expect(screen.queryByRole('button', { name: /mark .* read/i })).not.toBeInTheDocument();
  });

  it('shows a call channel label for call rows', () => {
    renderRow(mkRow({ channel: 'call', preview: 'Missed call' }));
    expect(screen.getByText('Call')).toBeInTheDocument();
  });

  it('renders a relay_group row with a Group text chip, linking to the conversation view', () => {
    renderRow(
      mkRow({
        kind: 'relay_group',
        contactId: undefined,
        channel: undefined,
        direction: undefined,
        role: undefined,
        name: 'With Keisha & Lars',
        preview: 'See you at 3',
        conversationId: 'conv-g1',
        status: 'open',
      }),
    );
    const link = screen.getByRole('link', { name: /With Keisha & Lars/ });
    expect(link).toHaveAttribute('href', '/conversations/conv-g1');
    expect(screen.getByText('Group text')).toBeInTheDocument();
    expect(within(link).getByText(/See you at 3/)).toBeInTheDocument();
  });

  it('flags a closed relay_group row', () => {
    renderRow(
      mkRow({
        kind: 'relay_group',
        contactId: undefined,
        channel: undefined,
        direction: undefined,
        role: undefined,
        name: 'With Keisha & Lars',
        conversationId: 'conv-g1',
        status: 'closed',
      }),
    );
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });
});
