// Address pieces — formatAddress (pure), AddressDisplay (read view), and
// AddressFields (controlled edit). Covers the structured shape, omitted empty
// parts, and the legacy plain-string back-compat path.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Address } from '../../api/index.js';
import { AddressDisplay, AddressFields, formatAddress } from './Address.js';

describe('formatAddress', () => {
  it('formats a full address with the street · locality layout', () => {
    expect(
      formatAddress({ line1: '123 Main St', line2: 'Apt 4', city: 'Atlanta', state: 'GA', zip: '30303' }),
    ).toBe('123 Main St, Apt 4 · Atlanta, GA 30303');
  });

  it('omits empty parts', () => {
    expect(formatAddress({ line1: '123 Main St', city: 'Atlanta', state: 'GA' })).toBe(
      '123 Main St · Atlanta, GA',
    );
    expect(formatAddress({ city: 'Atlanta' })).toBe('Atlanta');
    expect(formatAddress({ zip: '30303' })).toBe('30303');
  });

  it('returns undefined when there is nothing to show', () => {
    expect(formatAddress(undefined)).toBeUndefined();
    expect(formatAddress({})).toBeUndefined();
    expect(formatAddress({ line1: '   ' })).toBeUndefined();
  });

  it('renders a legacy plain string as-is (back-compat)', () => {
    expect(formatAddress('1 Old Rd, Atlanta')).toBe('1 Old Rd, Atlanta');
    expect(formatAddress('   ')).toBeUndefined();
  });
});

describe('<AddressDisplay>', () => {
  it('renders the formatted address', () => {
    render(<AddressDisplay address={{ line1: '5 Oak Ave', city: 'Decatur', state: 'GA' }} />);
    expect(screen.getByText('5 Oak Ave · Decatur, GA')).toBeInTheDocument();
  });

  it('renders nothing for an empty address', () => {
    const { container } = render(<AddressDisplay address={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('<AddressFields>', () => {
  it('renders the 5 labelled inputs seeded from the value', () => {
    const value: Address = { line1: '123 Main St', line2: 'Apt 4', city: 'Atlanta', state: 'GA', zip: '30303' };
    render(<AddressFields value={value} onChange={() => {}} />);
    expect((screen.getByLabelText('Address line 1') as HTMLInputElement).value).toBe('123 Main St');
    expect((screen.getByLabelText('Unit / Apt #') as HTMLInputElement).value).toBe('Apt 4');
    expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Atlanta');
    expect((screen.getByLabelText('State') as HTMLInputElement).value).toBe('GA');
    expect((screen.getByLabelText('ZIP') as HTMLInputElement).value).toBe('30303');
  });

  it('emits a merged Address on change', () => {
    const onChange = vi.fn();
    render(<AddressFields value={{ line1: '123 Main St' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Atlanta' } });
    expect(onChange).toHaveBeenCalledWith({ line1: '123 Main St', city: 'Atlanta' });
  });
});
