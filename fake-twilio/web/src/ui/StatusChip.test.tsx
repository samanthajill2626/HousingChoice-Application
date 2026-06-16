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

test.each(cases)('renders the %s state with a status accessible name', (state, label) => {
  render(<StatusChip state={state} />);
  // Reachable as a status region with the human label in its accessible name.
  const chip = screen.getByRole('status');
  expect(chip).toHaveAccessibleName(new RegExp(label, 'i'));
  expect(chip).toHaveTextContent(label);
});

test('appends an error code to the accessible name for failures', () => {
  render(<StatusChip state="failed" errorCode="30008" />);
  const chip = screen.getByRole('status');
  expect(chip).toHaveAccessibleName(/30008/);
});

test('does not show an error code for non-failure states', () => {
  render(<StatusChip state="delivered" errorCode="30008" />);
  expect(screen.getByRole('status')).not.toHaveTextContent('30008');
});
