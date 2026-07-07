import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupPanel } from './GroupPanel.js';
import { cannedAssets } from '../assets/canned/index.js';
import type { GroupEntry, GroupSnapshot } from '../api/types.js';

const members = [
  { number: '+15550170001', label: 'Diana Osei' },
  { number: '+15550170003', label: 'Gloria Mensah' },
];

function group(over: Partial<GroupSnapshot> = {}): GroupSnapshot {
  return {
    poolNumber: '+15550160001',
    members,
    entries: [],
    lastActivityAt: '2026-06-15T17:04:00.000Z',
    ...over,
  };
}

const inboundEntry: GroupEntry = {
  kind: 'inbound',
  id: 'SMin1',
  from: '+15550170001',
  fromLabel: 'Diana Osei',
  body: 'Is the unit still available?',
  at: '2026-06-15T17:04:00.000Z',
};

// Relayed bodies arrive with the app's own "Name: …" prefix — displayed VERBATIM.
const outboundEntry: GroupEntry = {
  kind: 'outbound',
  id: 'SMleg1',
  body: 'Diana O.: Is the unit still available?',
  at: '2026-06-15T17:04:05.000Z',
  recipients: [
    { number: '+15550170003', sid: 'SMleg1', state: 'delivered' },
    { number: '+15550170001', sid: 'SMleg2', state: 'failed', errorCode: '30005' },
  ],
};

function noop(): void {}

test('header shows the formatted pool number and a roster strip of member labels', () => {
  render(<GroupPanel group={group()} onSend={noop} onSetDeliveryProfile={noop} />);
  expect(screen.getByText('(555) 016-0001')).toBeInTheDocument();
  const roster = screen.getByRole('list', { name: /members/i });
  expect(within(roster).getByText('Diana Osei')).toBeInTheDocument();
  expect(within(roster).getByText('Gloria Mensah')).toBeInTheDocument();
});

test('renders an inbound entry with its sender label and the body VERBATIM', () => {
  render(
    <GroupPanel
      group={group({ entries: [inboundEntry] })}
      onSend={noop}
      onSetDeliveryProfile={noop}
    />,
  );
  const entry = screen.getByTestId('group-entry');
  expect(entry).toHaveAttribute('data-kind', 'inbound');
  expect(within(entry).getByText('Diana Osei')).toBeInTheDocument();
  expect(within(entry).getByText('Is the unit still available?')).toBeInTheDocument();
});

test('an outbound entry keeps its "Name: …" body prefix verbatim (no name parsing)', () => {
  render(
    <GroupPanel
      group={group({ entries: [outboundEntry] })}
      onSend={noop}
      onSetDeliveryProfile={noop}
    />,
  );
  expect(screen.getByText('Diana O.: Is the unit still available?')).toBeInTheDocument();
});

test('an outbound entry renders one StatusChip per recipient slot, labeled by member', () => {
  render(
    <GroupPanel
      group={group({ entries: [outboundEntry] })}
      onSend={noop}
      onSetDeliveryProfile={noop}
    />,
  );
  const delivery = screen.getByRole('list', { name: /delivery/i });
  const slots = within(delivery).getAllByRole('listitem');
  expect(slots).toHaveLength(2);
  // Gloria's leg delivered…
  expect(within(slots[0]!).getByText('Gloria Mensah')).toBeInTheDocument();
  expect(within(slots[0]!).getByText('Delivered')).toBeInTheDocument();
  // …Diana's leg failed, errorCode surfaced through the chip's accessible name.
  expect(within(slots[1]!).getByText('Diana Osei')).toBeInTheDocument();
  expect(within(slots[1]!).getByText('Failed')).toHaveAccessibleName(/30005/);
});

test('renders media thumbnails like the 1:1 view does', () => {
  const url = cannedAssets[0]!.url;
  const withMedia: GroupEntry = { ...inboundEntry, body: undefined, mediaUrls: [url] };
  render(
    <GroupPanel
      group={group({ entries: [withMedia] })}
      onSend={noop}
      onSetDeliveryProfile={noop}
    />,
  );
  const img = screen.getByRole('img', { name: cannedAssets[0]!.label });
  expect(img).toHaveAttribute('src', url);
});

test('sending uses the DEFAULT picked member (the first) as from', async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<GroupPanel group={group()} onSend={onSend} onSetDeliveryProfile={noop} />);
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi all');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  expect(onSend).toHaveBeenCalledWith({ from: '+15550170001', body: 'hi all', mediaUrls: [] });
});

test('picking another member sends AS that member', async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<GroupPanel group={group()} onSend={onSend} onSetDeliveryProfile={noop} />);
  await user.selectOptions(screen.getByRole('combobox', { name: /reply as/i }), '+15550170003');
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello from Gloria');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  expect(onSend).toHaveBeenCalledWith({
    from: '+15550170003',
    body: 'hello from Gloria',
    mediaUrls: [],
  });
});

test('the delivery-profile radiogroup arms the PICKED member', async () => {
  const user = userEvent.setup();
  const onSetDeliveryProfile = vi.fn();
  render(<GroupPanel group={group()} onSend={noop} onSetDeliveryProfile={onSetDeliveryProfile} />);
  await user.selectOptions(screen.getByRole('combobox', { name: /reply as/i }), '+15550170003');
  await user.click(screen.getByRole('radio', { name: /fail/i }));
  expect(onSetDeliveryProfile).toHaveBeenCalledWith('+15550170003', { kind: 'fail' });
});

test('shows an empty-transcript hint and surfaces a send error via role=alert', () => {
  render(
    <GroupPanel group={group()} onSend={noop} onSetDeliveryProfile={noop} sendError="nope" />,
  );
  expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('nope');
});
