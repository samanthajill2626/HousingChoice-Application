import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

  it('renders "No" when lifEligible is false (a recorded value, not empty)', () => {
    render(<EligibilityIntakeCard contact={{ lifEligible: false }} />);
    expect(screen.getByText('LIF eligible')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('omits fields that are empty/undefined', () => {
    render(<EligibilityIntakeCard contact={{ pets: '2 dogs' }} />);
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('2 dogs')).toBeInTheDocument();
    expect(screen.queryByText('Evictions')).not.toBeInTheDocument();
    expect(screen.queryByText('Time at current address')).not.toBeInTheDocument();
    expect(screen.queryByText('LIF eligible')).not.toBeInTheDocument();
  });

  it('renders nothing when no intake is recorded', () => {
    const { container } = render(<EligibilityIntakeCard contact={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it('treats an empty-string field as not recorded', () => {
    const { container } = render(
      <EligibilityIntakeCard contact={{ pets: '', evictions: '' }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
