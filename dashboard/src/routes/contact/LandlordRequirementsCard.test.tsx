import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api/index.js';
import { BLANK } from './Card.js';
import { LandlordRequirementsCard } from './LandlordRequirementsCard.js';

const LANDLORD: Contact = {
  contactId: 'L1',
  type: 'landlord',
  req_no_pets: true,
  req_pet_fee: '$300',
  req_deposit_one_month: true,
  req_deposit_flexible: true,
  req_tour_type: 'self_guided',
  req_tour_process: 'Lockbox code by text',
  // Tenant answers sharing the contacts table are never requirements.
  evictions: 'none',
};
// Worklist OR-21: an item's group is queried inside its card - the landlord
// edit dialog's RequirementsFields holds fieldsets with the same names.
const card = (): HTMLElement =>
  screen.getByRole('heading', { name: /^Requirements \/ Qualifications/ }).closest('section') as HTMLElement;
const item = (name: string): HTMLElement => within(card()).getByRole('group', { name });

describe('LandlordRequirementsCard', () => {
  it('shows the eight items in their groups, a blank item as the blank marker', () => {
    render(<LandlordRequirementsCard contact={LANDLORD} hasProperties />);
    expect(screen.getByRole('heading', { name: /^Requirements \/ Qualifications/ })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Screening',
      'Pets',
      'Move-in costs',
      'Touring',
    ]);
    expect(item('Pets')).toHaveTextContent('No pets; pet fee $300');
    expect(item('Deposit')).toHaveTextContent("One month's rent; flexible");
    expect(item('Touring')).toHaveTextContent('Self-guided; Lockbox code by text');
    expect(item('Evictions')).toHaveTextContent(BLANK);
    expect(item('Credit score')).toHaveTextContent(BLANK);
    expect(item('Application fee')).toHaveTextContent(BLANK);
  });

  it('Apply to properties and Edit call their handlers', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onEdit = vi.fn();
    render(<LandlordRequirementsCard contact={LANDLORD} hasProperties onApply={onApply} onEdit={onEdit} />);
    await user.click(screen.getByRole('button', { name: 'Apply to properties' }));
    await user.click(screen.getByRole('button', { name: 'Edit requirements' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('This landlord has no properties yet.')).toBeNull();
  });

  it('Apply to properties is disabled, with its reason, when the landlord has no properties', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<LandlordRequirementsCard contact={LANDLORD} hasProperties={false} onApply={onApply} />);
    const apply = screen.getByRole('button', { name: 'Apply to properties' });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAccessibleDescription('This landlord has no properties yet.');
    await user.click(apply);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('shows the last Apply result: the count, then each skipped property with a plain reason', () => {
    render(
      <LandlordRequirementsCard
        contact={LANDLORD}
        hasProperties
        notice={{
          updated: 2,
          skipped: [{ unitId: 'u3', address: '3 Own St', reason: 'changed since you opened this - review it again' }],
        }}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Updated 2 properties');
    expect(status).toHaveTextContent('1 skipped');
    expect(within(status).getByText('3 Own St - changed since you opened this - review it again')).toBeInTheDocument();
  });

  it('a result with nothing skipped shows the count only, singular for one', () => {
    render(<LandlordRequirementsCard contact={LANDLORD} hasProperties notice={{ updated: 1, skipped: [] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Updated 1 property');
    expect(screen.queryByText(/skipped/)).toBeNull();
  });
});
