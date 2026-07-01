import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LandlordOnboardingCard } from './LandlordOnboardingCard.js';

describe('LandlordOnboardingCard', () => {
  it('renders recorded onboarding values as label→value rows under "Landlord onboarding"', () => {
    render(
      <LandlordOnboardingCard
        contact={{
          contract_status: 'signed',
          expected_rent: 1450,
          registered_landlord: true,
          rta_within_48h: true,
          pass_inspection_first_try: false,
          income_includes_voucher: true,
        }}
      />,
    );
    expect(screen.getByText('Landlord onboarding')).toBeInTheDocument();
    expect(screen.getByText('Contract status')).toBeInTheDocument();
    expect(screen.getByText('Signed')).toBeInTheDocument();
    expect(screen.getByText('Expected rent')).toBeInTheDocument();
    expect(screen.getByText('1450')).toBeInTheDocument();
    expect(screen.getByText('Registered landlord')).toBeInTheDocument();
    expect(screen.getByText('Submits RTA within 48h')).toBeInTheDocument();
    expect(screen.getByText('Passes inspection first try')).toBeInTheDocument();
    expect(screen.getByText('Voucher counts as income')).toBeInTheDocument();
    // Booleans render Yes/No: three Yes (registered, rta, income), one No (inspection).
    expect(screen.getAllByText('Yes')).toHaveLength(3);
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders "Unsigned" for contract_status unsigned', () => {
    render(<LandlordOnboardingCard contact={{ contract_status: 'unsigned' }} />);
    expect(screen.getByText('Contract status')).toBeInTheDocument();
    expect(screen.getByText('Unsigned')).toBeInTheDocument();
  });

  it('shows the "Park reason" row only when the landlord is parked', () => {
    render(
      <LandlordOnboardingCard
        contact={{ status: 'parked', park_reason: 'Declined the program' }}
      />,
    );
    expect(screen.getByText('Park reason')).toBeInTheDocument();
    expect(screen.getByText('Declined the program')).toBeInTheDocument();
  });

  it('hides the "Park reason" row when the landlord is not parked (even with a stored reason)', () => {
    render(
      <LandlordOnboardingCard
        contact={{ status: 'active', park_reason: 'stale', contract_status: 'signed' }}
      />,
    );
    expect(screen.queryByText('Park reason')).not.toBeInTheDocument();
  });

  it('omits fields that are unset', () => {
    render(<LandlordOnboardingCard contact={{ expected_rent: 1200 }} />);
    expect(screen.getByText('Expected rent')).toBeInTheDocument();
    expect(screen.getByText('1200')).toBeInTheDocument();
    expect(screen.queryByText('Contract status')).not.toBeInTheDocument();
    expect(screen.queryByText('Registered landlord')).not.toBeInTheDocument();
  });

  it('renders nothing when no onboarding data is recorded', () => {
    const { container } = render(<LandlordOnboardingCard contact={{}} />);
    expect(container.firstChild).toBeNull();
  });
});
