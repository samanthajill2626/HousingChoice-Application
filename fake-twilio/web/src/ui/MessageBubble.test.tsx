import { render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble.js';
import { cannedAssets } from '../assets/canned/index.js';
import type { ThreadMessage } from '../api/types.js';

function msg(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    sid: 'SM1',
    direction: 'inbound',
    from: '+15550100001',
    to: '+15550199999',
    body: 'Hello there',
    state: 'delivered',
    createdAt: '2026-06-15T17:04:00.000Z',
    updatedAt: '2026-06-15T17:04:00.000Z',
    ...overrides,
  };
}

test('renders the body as escaped text (no HTML injection)', () => {
  const body = '<img src=x onerror=alert(1)>';
  render(<MessageBubble message={msg({ body })} />);
  // The literal text is present; no <img> was injected from the body.
  expect(screen.getByText(body)).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

// PARTY-CENTRIC: the UI is a fake phone for the selected party. An engine
// `outbound` message is the APP texting the party — i.e. what the party RECEIVES
// — so it sits LEFT (incoming) and carries the app→party delivery StatusChip.
test('an app message (engine outbound) shows a StatusChip', () => {
  render(<MessageBubble message={msg({ direction: 'outbound', state: 'sent' })} />);
  expect(screen.getByText(/sent/i)).toBeInTheDocument();
});

test('an app failed message (engine outbound) surfaces its errorCode via the status chip', () => {
  render(
    <MessageBubble
      message={msg({ direction: 'outbound', state: 'failed', errorCode: '30005' })}
    />,
  );
  const chip = screen.getByText(/failed/i);
  // The error code is exposed via the chip's accessible name / title.
  expect(chip).toHaveAccessibleName(/30005/);
});

// The party's OWN message (engine `inbound`, from = the party) is a sent text —
// it has no app→party delivery chip.
test("the party's own message (engine inbound) shows no StatusChip", () => {
  render(<MessageBubble message={msg({ direction: 'inbound', state: 'delivered' })} />);
  // No app→party delivery-state chip is rendered for the party's own message.
  expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
});

test('maps engine direction to a party-centric side', () => {
  // Engine inbound = the party's OWN message → outgoing (right) side, no chip.
  const { rerender } = render(<MessageBubble message={msg({ direction: 'inbound' })} />);
  const incoming = screen.getByTestId('message-bubble');
  expect(incoming).toHaveAttribute('data-party-side', 'outgoing');
  expect(incoming).toHaveAttribute('data-direction', 'inbound');

  // Engine outbound = the APP's message to the party → incoming (left) side.
  rerender(<MessageBubble message={msg({ direction: 'outbound' })} />);
  const appMsg = screen.getByTestId('message-bubble');
  expect(appMsg).toHaveAttribute('data-party-side', 'incoming');
  expect(appMsg).toHaveAttribute('data-direction', 'outbound');
});

test('renders a media thumbnail for each mediaUrl', () => {
  const url = cannedAssets[0]!.url;
  render(<MessageBubble message={msg({ body: undefined, mediaUrls: [url] })} />);
  const img = screen.getByRole('img', { name: cannedAssets[0]!.label });
  expect(img).toHaveAttribute('src', url);
});

test('renders a timestamp', () => {
  render(<MessageBubble message={msg()} />);
  expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument();
});

// Relay-pool origin: an app message sent FROM a pool number (a relay fan-out
// leg scattered into this persona's 1:1 thread) gets a small "via ‹pool›"
// badge linking it to the group. Ordinary business-number traffic must not.
test('an app message from a relay pool shows a "via ‹formatted pool›" badge', () => {
  render(
    <MessageBubble
      message={msg({ direction: 'outbound', from: '+15550160001', to: '+15550100001' })}
    />,
  );
  expect(screen.getByText('via (555) 016-0001')).toBeInTheDocument();
});

test('no via badge on ordinary business-number traffic (from = APP_NUMBER)', () => {
  render(
    <MessageBubble
      message={msg({ direction: 'outbound', from: '+15550009999', to: '+15550100001' })}
    />,
  );
  expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
});

test("no via badge on the party's own message (engine inbound)", () => {
  render(<MessageBubble message={msg({ direction: 'inbound', from: '+15550100001' })} />);
  expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
});
