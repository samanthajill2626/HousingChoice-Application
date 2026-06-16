import { render, screen } from '@testing-library/react';
import { StatusChip } from './StatusChip.js';
import type { DeliveryState } from '../api/types.js';

const cases: ReadonlyArray<[DeliveryState, string]> = [
  ['queued', 'Queued'],
  ['sent', 'Sent'],
  ['delivered', 'Delivered'],
  ['undelivered', 'Undelivered'],
  ['failed', 'Failed'],
];

test.each(cases)('renders the %s state with its human label and accessible name', (state, label) => {
  render(<StatusChip state={state} />);
  // Not a live region anymore (the conversation log announces updates); reach it by
  // its visible text, then assert its accessible name carries the label.
  const chip = screen.getByText(label);
  expect(chip).toHaveAccessibleName(new RegExp(label, 'i'));
  expect(chip).toHaveTextContent(label);
});

test('exposes an error code via its accessible name + title for failures', () => {
  render(<StatusChip state="failed" errorCode="30008" />);
  const chip = screen.getByText('Failed');
  expect(chip).toHaveAccessibleName(/30008/);
  expect(chip).toHaveAttribute('title', expect.stringContaining('30008'));
});

test('does not show an error code for non-failure states', () => {
  render(<StatusChip state="delivered" errorCode="30008" />);
  const chip = screen.getByText('Delivered');
  expect(chip).not.toHaveTextContent('30008');
  expect(chip).not.toHaveAccessibleName(/30008/);
});

test('is not a live region (no role=status)', () => {
  render(<StatusChip state="sent" />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
