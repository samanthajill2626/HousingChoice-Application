import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ContactType } from '../../api/index.js';
import { KindPicker } from './KindPicker.js';

interface KindValue {
  type: ContactType | null;
  role: string;
}

/** Stateful wrapper — mirrors how a form parent would wire up a controlled KindPicker. */
function StatefulKindPicker({
  initial,
  onChange,
  roleSuggestions,
}: {
  initial: KindValue;
  onChange: (v: KindValue) => void;
  roleSuggestions?: string[];
}) {
  const [value, setValue] = useState<KindValue>(initial);
  return (
    <KindPicker
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
      roleSuggestions={roleSuggestions}
    />
  );
}

function setup(initial: KindValue = { type: null, role: '' }, roleSuggestions?: string[]) {
  const onChange = vi.fn();
  render(<StatefulKindPicker initial={initial} onChange={onChange} roleSuggestions={roleSuggestions} />);
  return { onChange };
}

describe('KindPicker', () => {
  it('clicking Tenant calls onChange with {type:"tenant", role:""} and shows no role input', () => {
    const { onChange } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'Tenant' }));

    expect(onChange).toHaveBeenCalledWith({ type: 'tenant', role: '' });
    expect(screen.queryByLabelText(/role/i)).toBeNull();
  });

  it('clicking Other reveals a role input and base-type sub-choices', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: 'Other' }));

    // Role input should be visible
    expect(screen.getByLabelText(/role/i)).toBeInTheDocument();
    // Base-type sub-choices should appear — use getAllByRole since both the segment bar
    // and the sub-choice panel share the "Tenant"/"Landlord"/"Property mgr" labels.
    expect(screen.getAllByRole('button', { name: 'Tenant' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Landlord' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Property mgr' })).toHaveLength(2);
  });

  it('in Other mode, typing a role then clicking base Tenant calls onChange with both', () => {
    const { onChange } = setup();

    // Enter Other mode
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));

    // Type a role
    const roleInput = screen.getByLabelText(/role/i);
    act(() => {
      fireEvent.change(roleInput, { target: { value: 'Case worker' } });
    });

    // Find and click the base-type Tenant button — it's the second "Tenant" button
    // (first is in the segment bar, second is in the sub-choice panel).
    const tenantButtons = screen.getAllByRole('button', { name: 'Tenant' });
    const subTenant = tenantButtons[tenantButtons.length - 1];
    fireEvent.click(subTenant!);

    // The final call (after picking base type) must carry both type and role
    const calls = onChange.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toEqual({ type: 'tenant', role: 'Case worker' });
  });

  it('rendering with a non-empty role shows Other mode (role input visible)', () => {
    setup({ type: 'tenant', role: 'Case worker' });

    // Should see the role input because role is non-empty
    expect(screen.getByLabelText(/role/i)).toBeInTheDocument();
    // The role input should have the right value
    expect(screen.getByLabelText(/role/i)).toHaveValue('Case worker');
  });
});
