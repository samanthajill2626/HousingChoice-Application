import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
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

  // Fix 2: stable per-row keys — ContactSearchField internal state (activeIndex /
  // dropdown) must survive a MIDDLE removal and stay with the correct row.
  //
  // Setup: 3 rows [R0, R1, R2].  Open the suggestion dropdown in R2's
  // ContactSearchField by typing "Ali" (matches Alice Smith) then pressing
  // ArrowDown to move activeIndex to 0.  Remove R0.  After the re-render:
  //   • R1 is now at position 0, R2 is now at position 1.
  //   • R2's ContactSearchField MUST still have its dropdown open (the option
  //     "Alice Smith" visible) and aria-activedescendant pointing at index 0.
  //   With <li key={i}> React recycles the instance at position 1 from the OLD
  //   R1 slot — that instance had activeIndex=-1, so the dropdown is gone.
  //   With stable keys the R2 instance is preserved at its new position.
  it('ContactSearchField internal dropdown state survives a middle-row removal (stable keys)', () => {
    const R0: Relationship = { role: 'Sibling', name: 'Bob Jones', contactId: 'c2' };
    const R1: Relationship = { role: 'Employer', name: 'Charlie', contactId: 'c3' };
    const R2: Relationship = { role: 'Friend', name: '' };

    const EXTRA_CANDIDATES: Contact[] = [
      ...CANDIDATES,
      { contactId: 'c3', type: 'tenant', firstName: 'Charlie', lastName: 'Brown', phone: '+14040100003' },
    ];

    // Stateful wrapper so the controlled component fully re-renders after remove.
    function Wrapper(): React.JSX.Element {
      const [rows, setRows] = useState<Relationship[]>([R0, R1, R2]);
      return (
        <RelationshipsEditor
          rows={rows}
          onChange={setRows}
          candidates={EXTRA_CANDIDATES}
          roleSuggestions={['Sibling', 'Employer', 'Friend']}
        />
      );
    }

    render(<Wrapper />);

    // Type "Ali" in row 3's contact-search to open the dropdown
    const row3Search = screen.getByLabelText('Contact search 3');
    act(() => {
      fireEvent.change(row3Search, { target: { value: 'Ali' } });
    });

    // The dropdown for row 3 should be visible with Alice Smith
    expect(screen.getByRole('option', { name: /Alice Smith/i })).toBeInTheDocument();

    // Press ArrowDown to set activeIndex=0 on that ContactSearchField instance
    act(() => {
      fireEvent.keyDown(row3Search, { key: 'ArrowDown' });
    });

    // Confirm aria-selected is set on Alice Smith (activeIndex=0 → aria-selected=true)
    const aliceOption = screen.getByRole('option', { name: /Alice Smith/i });
    expect(aliceOption).toHaveAttribute('aria-selected', 'true');

    // Remove row 1 — rows become [R1, R2]; R2 shifts to position 2→1 in the list.
    const removeRow1Btn = screen.getByRole('button', { name: 'Remove relationship 1' });
    act(() => {
      fireEvent.click(removeRow1Btn);
    });

    // After removal: row at position 2 (now position 1) was R2 — its dropdown
    // should still be open (same instance → same internal state)
    // The "Alice Smith" option must STILL be visible in the list
    expect(screen.getByRole('option', { name: /Alice Smith/i })).toBeInTheDocument();

    // And its activeIndex should still be 0 (aria-selected=true on Alice Smith)
    const aliceOptionAfter = screen.getByRole('option', { name: /Alice Smith/i });
    expect(aliceOptionAfter).toHaveAttribute('aria-selected', 'true');
  });

  // A linked row is COMMITTED: read-only, unlinked only via its Clear button
  // (which must drop the contactId key entirely).
  it('a linked row is read-only; its Clear button emits a row with NO contactId key', () => {
    const onChange = vi.fn();
    // Start with a linked row (has contactId)
    render(
      <RelationshipsEditor
        rows={[{ role: 'Spouse', name: 'Alice Smith', contactId: 'c1' }]}
        onChange={onChange}
        candidates={CANDIDATES}
      />,
    );

    // The linked row's search input is committed — typing is not possible.
    const searchInput = screen.getByLabelText('Contact search 1');
    expect(searchInput).toHaveAttribute('readonly');

    // Clear unlinks: empty name, contactId key absent.
    fireEvent.click(screen.getByRole('button', { name: 'Clear Contact search 1' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const emittedRows = onChange.mock.calls[0]?.[0] as Relationship[];
    const emittedRow = emittedRows?.[0];
    expect(emittedRow).toBeDefined();
    expect(emittedRow!.name).toBe('');
    expect('contactId' in emittedRow!).toBe(false);
  });

  // An unlinked row still accepts free typing (the pre-pick contract holds).
  it('free-typing in an UNLINKED row emits the typed name with NO contactId key', () => {
    const onChange = vi.fn();
    render(
      <RelationshipsEditor
        rows={[{ role: 'Spouse', name: 'Ali' }]}
        onChange={onChange}
        candidates={CANDIDATES}
      />,
    );

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
