import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BLANK } from './Card.js';
import { EligibilityIntakeCard } from './EligibilityIntakeCard.js';

describe('EligibilityIntakeCard', () => {
  it('renders recorded intake fields as label→value rows', () => {
    render(
      <EligibilityIntakeCard
        contact={{ pets: '1 cat', evictions: 'none', tenure: '3 years', lifEligible: true }}
      />,
    );
    expect(screen.getByText('Eligibility intake')).toBeInTheDocument();
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('1 cat')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByText('Time at current address')).toBeInTheDocument();
    expect(screen.getByText('3 years')).toBeInTheDocument();
    expect(screen.getByText('LIF eligible')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('renders a "Voucher expires" row with a friendly date when set', () => {
    render(<EligibilityIntakeCard contact={{ voucher_expiration_date: '2026-08-15T00:00:00.000Z' }} />);
    expect(screen.getByText('Voucher expires')).toBeInTheDocument();
    expect(screen.getByText('Aug 15, 2026')).toBeInTheDocument();
  });

  it('renders the "Voucher expires" row as a blank when unparseable', () => {
    render(<EligibilityIntakeCard contact={{ voucher_expiration_date: 'not-a-date' }} />);
    expect(screen.getByText('Voucher expires')).toBeInTheDocument();
    // All five rows are blank: an unparseable date is no more "recorded" than an
    // absent one, but it must not silently drop the row.
    expect(screen.getAllByText(BLANK)).toHaveLength(5);
  });

  it('renders "No" when lifEligible is false (a recorded value, not empty)', () => {
    render(<EligibilityIntakeCard contact={{ lifEligible: false }} />);
    expect(screen.getByText('LIF eligible')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders empty/undefined fields as blanks instead of omitting them', () => {
    render(<EligibilityIntakeCard contact={{ pets: '2 dogs' }} />);
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('2 dogs')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(screen.getByText('Time at current address')).toBeInTheDocument();
    expect(screen.getByText('LIF eligible')).toBeInTheDocument();
    expect(screen.getByText('Voucher expires')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(4);
  });

  it('renders every intake row as a blank when nothing is recorded', () => {
    render(<EligibilityIntakeCard contact={{}} />);
    expect(screen.getByText('Eligibility intake')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(5);
  });

  it('treats an empty-string field as not recorded, rendering it as a blank', () => {
    render(<EligibilityIntakeCard contact={{ pets: '', evictions: '' }} />);
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(5);
  });

  it('shows a pending suggestion chip on a contact with NO intake recorded (regression: intake-card-hides-pending-suggestions)', () => {
    // MemoryRouter: the chip's "View conversation" action is a router Link.
    render(
      <MemoryRouter>
        <EligibilityIntakeCard
          contact={{}}
          suggestions={[
            {
              itemId: 'sug-1',
              ownerContactId: 'contact-tenant-0001',
              target: 'evictions',
              suggestedValue: 'one, 2019',
              conversationId: 'conv-1',
              createdAt: '2026-08-03T12:00:00.000Z',
            },
          ]}
        />
      </MemoryRouter>,
    );
    // The card used to vanish entirely here, swallowing the chip with it: the
    // suggestion existed in the store and counted on Today, but staff could not
    // see or act on it from the contact page.
    expect(screen.getByText('Eligibility intake')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'AI suggestion for evictions' }),
    ).toBeInTheDocument();
  });
});
