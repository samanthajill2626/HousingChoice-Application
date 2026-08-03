import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BLANK } from './Card.js';
import { LandlordOnboardingCard } from './LandlordOnboardingCard.js';

describe('LandlordOnboardingCard', () => {
  it('renders recorded onboarding values as label→value rows under "Landlord onboarding"', () => {
    render(
      <LandlordOnboardingCard
        contact={{
          contract_status: 'signed',
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
    // Expected rent moved to the UNIT (2026-07-10) — never a row here.
    expect(screen.queryByText('Expected rent')).not.toBeInTheDocument();
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

  it('renders unset fields as the blank placeholder instead of omitting them', () => {
    render(<LandlordOnboardingCard contact={{ registered_landlord: true }} />);
    expect(screen.getByText('Registered landlord')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    // The four unanswered rows are PRESENT, each reading the placeholder: a gap a
    // navigator can SEE, not a row that silently disappears.
    expect(screen.getByText('Contract status')).toBeInTheDocument();
    expect(screen.getByText('Submits RTA within 48h')).toBeInTheDocument();
    expect(screen.getByText('Passes inspection first try')).toBeInTheDocument();
    expect(screen.getByText('Voucher counts as income')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(4);
  });

  it('renders every checklist row as a blank when nothing is recorded', () => {
    render(<LandlordOnboardingCard contact={{}} />);
    expect(screen.getByText('Landlord onboarding')).toBeInTheDocument();
    expect(screen.getByText('Contract status')).toBeInTheDocument();
    expect(screen.getByText('Registered landlord')).toBeInTheDocument();
    expect(screen.getByText('Submits RTA within 48h')).toBeInTheDocument();
    expect(screen.getByText('Passes inspection first try')).toBeInTheDocument();
    expect(screen.getByText('Voucher counts as income')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(5);
    // Park reason is status-scoped, not a checklist item: absent when not parked.
    expect(screen.queryByText('Park reason')).not.toBeInTheDocument();
  });

  it('renders the Park reason row as a blank when parked with no reason recorded', () => {
    render(<LandlordOnboardingCard contact={{ status: 'parked' }} />);
    expect(screen.getByText('Park reason')).toBeInTheDocument();
    // Five checklist blanks + the parked-but-unexplained Park reason blank.
    expect(screen.getAllByText(BLANK)).toHaveLength(6);
  });
});
