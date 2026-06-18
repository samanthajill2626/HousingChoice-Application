import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CallMenu } from './CallMenu.js';
import type { ContactPhone } from '../../api/index.js';

const A = '+14040100001';
const B = '+14040100002';
const PHONES: ContactPhone[] = [
  { phone: A, primary: true, label: 'cell' },
  { phone: B, primary: false, label: 'work' },
];

describe('CallMenu', () => {
  it('is disabled when the contact has no number', () => {
    render(<CallMenu phones={[]} />);
    expect(screen.getByRole('button', { name: /Call/i })).toBeDisabled();
  });

  it('opens a popover with a tel: dial link per number', async () => {
    const user = userEvent.setup();
    render(<CallMenu phones={PHONES} defaultPhone={PHONES[0]} />);
    await user.click(screen.getByRole('button', { name: /Call/i }));
    const links = screen.getAllByRole('menuitem');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', `tel:${A}`);
    expect(links[1]).toHaveAttribute('href', `tel:${B}`);
  });

  it('is honest that dialing is device-side until masked calling lands', async () => {
    const user = userEvent.setup();
    render(<CallMenu phones={PHONES} defaultPhone={PHONES[0]} />);
    await user.click(screen.getByRole('button', { name: /Call/i }));
    expect(screen.getByText(/Dials from your device/i)).toBeInTheDocument();
  });
});
