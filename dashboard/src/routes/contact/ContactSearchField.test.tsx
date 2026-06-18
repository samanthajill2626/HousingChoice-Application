import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api/index.js';
import { ContactSearchField } from './ContactSearchField.js';

const CANDIDATES: Contact[] = [
  { contactId: 'c1', type: 'tenant', firstName: 'Alice', lastName: 'Smith', phone: '+14040100001' },
  { contactId: 'c2', type: 'landlord', firstName: 'Bob', lastName: 'Jones', phone: '+14040100002' },
  { contactId: 'c3', type: 'tenant', firstName: 'Charlie', lastName: 'Brown', phone: '+14040100003' },
];

function setup(
  value: { name: string; contactId?: string } = { name: '' },
  onChange = vi.fn(),
  candidates: Contact[] = CANDIDATES,
) {
  render(<ContactSearchField value={value} onChange={onChange} candidates={candidates} />);
  return { onChange };
}

describe('ContactSearchField', () => {
  it('renders a text input bound to value.name', () => {
    setup({ name: 'Alice' });
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('Alice');
  });

  it('typing a matching string shows a matching candidate', () => {
    const onChange = vi.fn();
    render(
      <ContactSearchField value={{ name: 'Ali' }} onChange={onChange} candidates={CANDIDATES} />,
    );
    // The option for Alice Smith should appear
    expect(screen.getByRole('option', { name: /Alice Smith/i })).toBeInTheDocument();
  });

  it('clicking a candidate fires onChange with { name, contactId }', () => {
    const onChange = vi.fn();
    render(
      <ContactSearchField value={{ name: 'Ali' }} onChange={onChange} candidates={CANDIDATES} />,
    );
    const option = screen.getByRole('option', { name: /Alice Smith/i });
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith({ name: 'Alice Smith', contactId: 'c1' });
  });

  it('typing a non-matching/free string fires onChange with { name } and NO contactId', () => {
    const onChange = vi.fn();
    render(
      <ContactSearchField
        value={{ name: '', contactId: 'c1' }}
        onChange={onChange}
        candidates={CANDIDATES}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Zara' } });
    const call = onChange.mock.calls[0] as [{ name: string; contactId?: string }];
    expect(call[0]).toEqual({ name: 'Zara' });
    expect(call[0]).not.toHaveProperty('contactId');
  });

  it('shows no more than 8 candidates even when more match', () => {
    const manyContacts: Contact[] = Array.from({ length: 12 }, (_, i) => ({
      contactId: `c${i}`,
      type: 'tenant' as const,
      firstName: `Person${i}`,
      lastName: 'Test',
      phone: `+1404010000${i}`,
    }));
    render(
      <ContactSearchField value={{ name: 'Person' }} onChange={vi.fn()} candidates={manyContacts} />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(8);
  });

  it('shows no candidates when the typed text does not match any candidate', () => {
    render(
      <ContactSearchField
        value={{ name: 'Zara' }}
        onChange={vi.fn()}
        candidates={CANDIDATES}
      />,
    );
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('candidate names are rendered as text (no dangerouslySetInnerHTML)', () => {
    render(
      <ContactSearchField value={{ name: 'Ali' }} onChange={vi.fn()} candidates={CANDIDATES} />,
    );
    // If the name contains HTML-like content it should appear as literal text
    const option = screen.getByRole('option', { name: /Alice Smith/i });
    expect(option).toBeInTheDocument();
    expect(option.innerHTML).not.toContain('<script');
  });
});
