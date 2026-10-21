import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Contact, UnitItem } from '../../api/index.js';
import { BLANK } from '../contact/Card.js';
import { PropertyRequirementsCard } from './PropertyRequirementsCard.js';
import styles from './PropertyRequirementsCard.module.css';

const LANDLORD: Contact = {
  contactId: 'L1',
  type: 'landlord',
  firstName: 'James',
  lastName: 'Porter',
  req_no_pets: true,
  req_pet_fee: '$300',
  req_deposit_one_month: true,
  req_qualifications: 'Two references',
};
const NO_REQUIREMENTS: Contact = { contactId: 'L1', type: 'landlord', firstName: 'James', lastName: 'Porter' };

const UNIT: UnitItem = {
  unitId: 'u1',
  landlordId: 'L1',
  status: 'available',
  pets: 'Cats OK', // never touched, an own value -> purple
  deposit: 1400, // copied, the landlord moved to one month -> orange
  credit_requirements: '600+', // the landlord has none -> purple + "Landlord: blank"
  application_fee: 25,
  tour_type: 'self_guided',
  tour_process: 'Lockbox',
  requirement_sources: { deposit: 'copied' },
};

const item = (name: string): HTMLElement => screen.getByRole('group', { name });
const TAG = /^(Set on this property|Landlord updated)$/;
const LINE = /^Landlord( now)?: /;

describe('PropertyRequirementsCard', () => {
  it('shows the eight items under the four group headings, a blank item as the blank marker', () => {
    render(<PropertyRequirementsCard unit={UNIT} landlord={undefined} />);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Screening',
      'Pets',
      'Move-in costs',
      'Touring',
    ]);
    expect(item('Pets')).toHaveTextContent('Cats OK');
    expect(item('Deposit')).toHaveTextContent('$1,400');
    expect(item('Credit score')).toHaveTextContent('600+');
    expect(item('Application fee')).toHaveTextContent('$25');
    expect(item('Touring')).toHaveTextContent('Self-guided; Lockbox');
    expect(item('Income requirements')).toHaveTextContent(BLANK);
    expect(item('Evictions')).toHaveTextContent(BLANK);
  });

  it('tags each differing item once, with its landlord line (the D6 table)', () => {
    render(<PropertyRequirementsCard unit={UNIT} landlord={LANDLORD} />);
    // Pets: never touched, own value -> purple, the whole landlord item.
    const pets = item('Pets');
    expect(within(pets).getByText('Set on this property')).toHaveClass(styles.tagSetHere!);
    expect(within(pets).getByText('Landlord: No pets; pet fee $300')).toBeInTheDocument();
    expect(within(pets).getAllByText(TAG)).toHaveLength(1);
    expect(within(pets).getAllByText(LINE)).toHaveLength(1);
    // Deposit: copied, the landlord changed -> orange.
    const deposit = item('Deposit');
    expect(within(deposit).getByText('Landlord updated')).toHaveClass(styles.tagLandlordUpdated!);
    expect(within(deposit).getByText("Landlord now: One month's rent")).toBeInTheDocument();
    // An own value against a blank landlord item -> purple + "Landlord: blank".
    const credit = item('Credit score');
    expect(within(credit).getByText('Set on this property')).toBeInTheDocument();
    expect(within(credit).getByText('Landlord: blank')).toBeInTheDocument();
    // Property blank, never touched, landlord value -> the line only.
    const qualifications = item('Qualifications');
    expect(within(qualifications).queryByText(TAG)).toBeNull();
    expect(within(qualifications).getByText('Landlord: Two references')).toBeInTheDocument();
    // Equal (both blank) -> nothing.
    expect(within(item('Income requirements')).queryByText(LINE)).toBeNull();
    expect(within(item('Evictions')).queryByText(TAG)).toBeNull();
  });

  it('no landlord (or a failed load): no tags and no landlord lines anywhere', () => {
    render(<PropertyRequirementsCard unit={UNIT} landlord={undefined} />);
    expect(screen.queryAllByText(TAG)).toHaveLength(0);
    expect(screen.queryAllByText(LINE)).toHaveLength(0);
    expect(screen.queryByText(/has no requirements recorded yet/)).toBeNull();
  });

  it('says when the landlord of record has no requirements recorded at all', () => {
    const { unmount } = render(<PropertyRequirementsCard unit={UNIT} landlord={NO_REQUIREMENTS} />);
    expect(screen.getByText('James Porter has no requirements recorded yet.')).toBeInTheDocument();
    // Every existing value then reads as set on this property (spec section 4).
    expect(within(item('Pets')).getByText('Landlord: blank')).toBeInTheDocument();
    unmount();

    render(<PropertyRequirementsCard unit={UNIT} landlord={LANDLORD} />);
    expect(screen.queryByText(/has no requirements recorded yet/)).toBeNull();
  });

  it('Edit opens the property edit form; no Edit without a handler', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const { unmount } = render(<PropertyRequirementsCard unit={UNIT} landlord={LANDLORD} onEdit={onEdit} />);
    await user.click(screen.getByRole('button', { name: 'Edit property requirements' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    unmount();

    render(<PropertyRequirementsCard unit={UNIT} landlord={LANDLORD} />);
    expect(screen.queryByRole('button', { name: 'Edit property requirements' })).toBeNull();
  });
});
