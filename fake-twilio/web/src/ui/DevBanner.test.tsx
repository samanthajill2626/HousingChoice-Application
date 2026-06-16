import { render, screen } from '@testing-library/react';
import { DevBanner } from './DevBanner.js';

test('renders the dev warning text', () => {
  render(<DevBanner />);
  expect(screen.getByText(/no real messages are sent/i)).toBeInTheDocument();
  expect(screen.getByText(/fake twilio/i)).toBeInTheDocument();
});

test('is announced as a status region', () => {
  render(<DevBanner />);
  expect(screen.getByRole('status')).toHaveTextContent(/DEV/);
});
