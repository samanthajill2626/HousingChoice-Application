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

test('outbound message shows a StatusChip', () => {
  render(<MessageBubble message={msg({ direction: 'outbound', state: 'sent' })} />);
  expect(screen.getByText(/sent/i)).toBeInTheDocument();
});

test('outbound failed message surfaces its errorCode via the status chip', () => {
  render(
    <MessageBubble
      message={msg({ direction: 'outbound', state: 'failed', errorCode: '30005' })}
    />,
  );
  const chip = screen.getByText(/failed/i);
  // The error code is exposed via the chip's accessible name / title.
  expect(chip).toHaveAccessibleName(/30005/);
});

test('inbound message shows no StatusChip', () => {
  render(<MessageBubble message={msg({ direction: 'inbound', state: 'delivered' })} />);
  // No outbound delivery-state chip is rendered for an inbound message.
  expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
});

test('distinguishes inbound vs outbound for layout', () => {
  const { rerender } = render(<MessageBubble message={msg({ direction: 'inbound' })} />);
  expect(screen.getByTestId('message-bubble')).toHaveAttribute('data-direction', 'inbound');
  rerender(<MessageBubble message={msg({ direction: 'outbound' })} />);
  expect(screen.getByTestId('message-bubble')).toHaveAttribute('data-direction', 'outbound');
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
