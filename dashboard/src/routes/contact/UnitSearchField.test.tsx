import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { UnitItem } from '../../api/index.js';
import { UnitSearchField } from './UnitSearchField.js';

const CANDIDATES: UnitItem[] = [
  {
    unitId: 'unit-0001',
    landlordId: 'c-ll-1',
    status: 'under_application',
    address: { line1: '1450 Joseph E. Boone Blvd NW', city: 'Atlanta', state: 'GA', zip: '30314' },
  },
  {
    unitId: 'unit-0002',
    landlordId: 'c-ll-1',
    status: 'occupied',
    address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA', zip: '30030' },
  },
  {
    unitId: 'unit-0003',
    landlordId: 'c-ll-2',
    status: 'available',
    // No address — exercises the unitId fallback label.
  },
];

function setup(
  value: { label: string; unitId?: string } = { label: '' },
  onChange = vi.fn(),
  candidates: UnitItem[] = CANDIDATES,
) {
  render(<UnitSearchField value={value} onChange={onChange} candidates={candidates} />);
  return { onChange };
}

describe('UnitSearchField', () => {
  it('renders a combobox bound to value.label', () => {
    setup({ label: '88 Sycamore St, Decatur, GA, 30030' });
    const input = screen.getByRole('combobox');
    expect(input).toHaveValue('88 Sycamore St, Decatur, GA, 30030');
  });

  it('typing a matching address shows a matching option', () => {
    const onChange = vi.fn();
    render(
      <UnitSearchField value={{ label: 'Sycamore' }} onChange={onChange} candidates={CANDIDATES} />,
    );
    expect(screen.getByRole('option', { name: /88 Sycamore St/i })).toBeInTheDocument();
  });

  it('clicking an option fires onChange with { label, unitId }', () => {
    const onChange = vi.fn();
    render(
      <UnitSearchField value={{ label: 'Sycamore' }} onChange={onChange} candidates={CANDIDATES} />,
    );
    const option = screen.getByRole('option', { name: /88 Sycamore St/i });
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith({
      label: '88 Sycamore St, Decatur, GA, 30030',
      unitId: 'unit-0002',
    });
  });

  it('free typing fires onChange with { label } and NO unitId', () => {
    const onChange = vi.fn();
    render(
      <UnitSearchField
        value={{ label: '', unitId: 'unit-0001' }}
        onChange={onChange}
        candidates={CANDIDATES}
      />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '500 Nowhere Ave' } });
    const call = onChange.mock.calls[0] as [{ label: string; unitId?: string }];
    expect(call[0]).toEqual({ label: '500 Nowhere Ave' });
    expect(call[0]).not.toHaveProperty('unitId');
  });

  it('falls back to unitId as the label when a unit has no address', () => {
    const onChange = vi.fn();
    render(
      <UnitSearchField value={{ label: 'unit-0003' }} onChange={onChange} candidates={CANDIDATES} />,
    );
    const option = screen.getByRole('option', { name: 'unit-0003' });
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith({ label: 'unit-0003', unitId: 'unit-0003' });
  });

  it('shows no more than 8 options even when more match', () => {
    const manyUnits: UnitItem[] = Array.from({ length: 12 }, (_, i) => ({
      unitId: `unit-${i}`,
      landlordId: 'c-ll-1',
      status: 'available' as const,
      address: { line1: `${i} Maple Street`, city: 'Atlanta', state: 'GA' },
    }));
    render(
      <UnitSearchField value={{ label: 'Maple' }} onChange={vi.fn()} candidates={manyUnits} />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(8);
  });

  it('shows no options when the typed text does not match any candidate', () => {
    render(
      <UnitSearchField value={{ label: 'Nowhere' }} onChange={vi.fn()} candidates={CANDIDATES} />,
    );
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('option labels are rendered as text (no dangerouslySetInnerHTML)', () => {
    render(
      <UnitSearchField value={{ label: 'Sycamore' }} onChange={vi.fn()} candidates={CANDIDATES} />,
    );
    const option = screen.getByRole('option', { name: /88 Sycamore St/i });
    expect(option).toBeInTheDocument();
    expect(option.innerHTML).not.toContain('<script');
  });

  // a11y: Escape collapses the suggestion list; typing reopens it
  it('Escape hides the listbox; typing a character reopens it', () => {
    function Wrapper(): React.JSX.Element {
      const [value, setValue] = useState({ label: 'Sycamore' });
      return <UnitSearchField value={value} onChange={setValue} candidates={CANDIDATES} />;
    }
    render(<Wrapper />);

    const input = screen.getByRole('combobox');

    // "Sycamore" matches unit-0002 — listbox should be visible
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /88 Sycamore St/i })).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'true');

    // Press Escape — listbox must disappear and aria-expanded must be false
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveAttribute('aria-expanded', 'false');

    // Typing a character reopens the list (still matching)
    act(() => {
      fireEvent.change(input, { target: { value: 'Sycamore S' } });
    });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  // keyboard navigation — ArrowDown then Enter selects the active candidate
  it('ArrowDown then Enter selects the active candidate via onChange', () => {
    const onChange = vi.fn();
    render(
      <UnitSearchField value={{ label: 'Sycamore' }} onChange={onChange} candidates={CANDIDATES} />,
    );

    const input = screen.getByRole('combobox');
    expect(screen.getByRole('option', { name: /88 Sycamore St/i })).toBeInTheDocument();

    // ArrowDown moves activeIndex from -1 → 0
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Enter should pick the active option (88 Sycamore St)
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith({
      label: '88 Sycamore St, Decatur, GA, 30030',
      unitId: 'unit-0002',
    });
  });
});
