import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Contact, Relationship } from '../../api/index.js';
import { RelationshipsEditor } from './RelationshipsEditor.js';

const CANDIDATES: Contact[] = [
  { contactId: 'c1', type: 'tenant', firstName: 'Alice', lastName: 'Smith', phone: '+14040100001' },
  { contactId: 'c2', type: 'landlord', firstName: 'Bob', lastName: 'Jones', phone: '+14040100002' },
];

const ROW: Relationship = { role: 'Spouse', name: 'Alice Smith', contactId: 'c1' };

function setup(
  rows: Relationship[] = [ROW],
  onChange = vi.fn(),
  candidates: Contact[] = CANDIDATES,
) {
  render(
    <RelationshipsEditor
      rows={rows}
      onChange={onChange}
      candidates={candidates}
      roleSuggestions={['Spouse', 'Employer', 'Case Manager']}
    />,
  );
  return { onChange };
}

describe('RelationshipsEditor', () => {
  it('renders one row per relationship', () => {
    setup([ROW, { role: 'Employer', name: 'Bob Jones', contactId: 'c2' }]);
    expect(screen.getByLabelText('Relationship role 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Relationship role 2')).toBeInTheDocument();
  });

  it('clicking "+ Add relationship" fires onChange with an extra { role:"", name:"" } row', () => {
    const onChange = vi.fn();
    render(<RelationshipsEditor rows={[]} onChange={onChange} candidates={CANDIDATES} />);
    const addBtn = screen.getByRole('button', { name: /\+ Add relationship/i });
    fireEvent.click(addBtn);
    expect(onChange).toHaveBeenCalledWith([{ role: '', name: '' }]);
  });

  it('editing the role input fires onChange with the new role on that row', () => {
    const onChange = vi.fn();
    setup([ROW], onChange);
    const roleInput = screen.getByLabelText('Relationship role 1');
    fireEvent.change(roleInput, { target: { value: 'Friend' } });
    expect(onChange).toHaveBeenCalledWith([{ ...ROW, role: 'Friend' }]);
  });

  it('clicking Remove fires onChange with the row gone', () => {
    const onChange = vi.fn();
    setup([ROW], onChange);
    const removeBtn = screen.getByRole('button', { name: 'Remove relationship 1' });
    fireEvent.click(removeBtn);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('Remove works correctly when there are multiple rows', () => {
    const ROW2: Relationship = { role: 'Employer', name: 'Bob Jones', contactId: 'c2' };
    const onChange = vi.fn();
    setup([ROW, ROW2], onChange);
    const removeBtn = screen.getByRole('button', { name: 'Remove relationship 1' });
    fireEvent.click(removeBtn);
    expect(onChange).toHaveBeenCalledWith([ROW2]);
  });

  it('picking a candidate in a row fires onChange with updated contactId and name on that row', () => {
    const onChange = vi.fn();
    // Start with a row that has partial text matching Bob
    render(
      <RelationshipsEditor
        rows={[{ role: 'Employer', name: 'Bob' }]}
        onChange={onChange}
        candidates={CANDIDATES}
      />,
    );
    // The candidate list should show Bob Jones
    const option = screen.getByRole('option', { name: /Bob Jones/i });
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith([
      { role: 'Employer', name: 'Bob Jones', contactId: 'c2' },
    ]);
  });

  it('renders accessible labels for all inputs and buttons', () => {
    setup([ROW]);
    expect(screen.getByLabelText('Relationship role 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Contact search 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove relationship 1' })).toBeInTheDocument();
  });

  it('roleSuggestions appear in a datalist', () => {
    setup([ROW]);
    const datalist = document.querySelector('datalist');
    expect(datalist).not.toBeNull();
    const values = Array.from(datalist?.querySelectorAll('option') ?? []).map((o) => o.value);
    expect(values).toContain('Spouse');
    expect(values).toContain('Employer');
  });

  // Fix 4: free-typing after a pick must drop the contactId key entirely
  it('free-typing after a pick emits a row with NO contactId key', () => {
    const onChange = vi.fn();
    // Start with a linked row (has contactId)
    render(
      <RelationshipsEditor
        rows={[{ role: 'Spouse', name: 'Alice Smith', contactId: 'c1' }]}
        onChange={onChange}
        candidates={CANDIDATES}
      />,
    );

    // Type something free-form in the contact search input (not a candidate pick)
    const searchInput = screen.getByLabelText('Contact search 1');
    fireEvent.change(searchInput, { target: { value: 'Someone Else' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const emittedRows = onChange.mock.calls[0]?.[0] as Relationship[];
    const emittedRow = emittedRows?.[0];
    expect(emittedRow).toBeDefined();
    expect(emittedRow!.name).toBe('Someone Else');
    expect('contactId' in emittedRow!).toBe(false);
  });
});
