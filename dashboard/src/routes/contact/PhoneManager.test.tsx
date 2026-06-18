import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, ContactPhone } from '../../api/index.js';

const addContactPhone = vi.fn();
const updateContactPhone = vi.fn();
const removeContactPhone = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    addContactPhone: (...a: unknown[]) => addContactPhone(...a),
    updateContactPhone: (...a: unknown[]) => updateContactPhone(...a),
    removeContactPhone: (...a: unknown[]) => removeContactPhone(...a),
  };
});

import { PhoneManager } from './PhoneManager.js';

const CONTACT: Contact = { contactId: 'k1', type: 'tenant', phone: '+14040100007' };
const PHONES: ContactPhone[] = [
  { phone: '+14040100007', primary: true, label: 'cell' },
  { phone: '+14045550199', primary: false, label: 'work' },
];

function setup(phones = PHONES) {
  const onChanged = vi.fn();
  render(<PhoneManager contact={CONTACT} phones={phones} onClose={vi.fn()} onChanged={onChanged} />);
  return { onChanged };
}

beforeEach(() => vi.clearAllMocks());

describe('PhoneManager', () => {
  it('lists numbers with the primary marked, and only non-primary numbers are removable/promotable', () => {
    setup();
    expect(screen.getByText('Primary')).toBeInTheDocument();
    // Exactly one "Make primary" + one "Remove" (for the single non-primary row).
    expect(screen.getAllByRole('button', { name: /Make primary/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Remove$/i })).toHaveLength(1);
  });

  it('adds a number and applies the returned contact', async () => {
    const user = userEvent.setup();
    const updated = { ...CONTACT, phones: [...PHONES, { phone: '+14041112222', primary: false }] };
    addContactPhone.mockResolvedValue(updated);
    const { onChanged } = setup();

    await user.type(screen.getByLabelText(/New phone number/i), '404-111-2222');
    await user.type(screen.getByLabelText(/Label for the new number/i), 'home');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    expect(addContactPhone).toHaveBeenCalledWith('k1', '404-111-2222', 'home');
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated));
  });

  it('promotes a non-primary number to primary', async () => {
    const user = userEvent.setup();
    const updated = { ...CONTACT };
    updateContactPhone.mockResolvedValue(updated);
    const { onChanged } = setup();
    await user.click(screen.getByRole('button', { name: /Make primary/i }));
    expect(updateContactPhone).toHaveBeenCalledWith('k1', '+14045550199', { primary: true });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated));
  });

  it('removes a non-primary number', async () => {
    const user = userEvent.setup();
    removeContactPhone.mockResolvedValue({ ...CONTACT });
    const { onChanged } = setup();
    await user.click(screen.getByRole('button', { name: /^Remove$/i }));
    expect(removeContactPhone).toHaveBeenCalledWith('k1', '+14045550199');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows a friendly message when a number already belongs to another contact', async () => {
    const user = userEvent.setup();
    addContactPhone.mockRejectedValue(new ApiError(409, 'phone_in_use', 'x'));
    setup();
    await user.type(screen.getByLabelText(/New phone number/i), '404-111-2222');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/already belongs to another contact/i),
    );
  });
});
