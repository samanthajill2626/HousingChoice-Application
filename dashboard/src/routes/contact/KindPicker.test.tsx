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

/** Externally-controlled wrapper that lets tests drive value from outside. */
function ControlledKindPicker({
  initial,
  onChange,
}: {
  initial: KindValue;
  onChange: (v: KindValue) => void;
}) {
  const [value, setValue] = useState<KindValue>(initial);
  // expose a data attribute so tests can simulate parent rehydrating the value
  return (
    <>
      <KindPicker
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
      {/* hidden button the test clicks to simulate a parent resetting the value */}
      <button
        data-testid="rehydrate"
        onClick={() => setValue({ type: 'tenant', role: '' })}
      >
        Rehydrate
      </button>
    </>
  );
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
    // Base-type sub-choices appear; Tenant/Landlord are shared with the segment bar
    // (length 2). Property Manager is a primary segment only (no base sub-choice).
    expect(screen.getAllByRole('button', { name: 'Tenant' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Landlord' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Property Manager' })).toHaveLength(1);
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

  // Fix 1: parent rehydrating to a plain standard kind must exit Other mode
  it('parent rehydrating to {type:"tenant", role:""} clears Other mode', () => {
    const onChange = vi.fn();
    render(<ControlledKindPicker initial={{ type: null, role: '' }} onChange={onChange} />);

    // Enter Other mode
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    expect(screen.getByLabelText(/role/i)).toBeInTheDocument();

    // Simulate parent resetting the value to a plain Tenant selection
    fireEvent.click(screen.getByTestId('rehydrate'));

    // Other panel should now be hidden
    expect(screen.queryByLabelText(/role/i)).toBeNull();
  });

  it('clicking Property Manager presets landlord + role and does NOT open Other', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Property Manager' }));
    expect(onChange).toHaveBeenCalledWith({ type: 'landlord', role: 'Property Manager' });
    // It is a preset, not Other — no role input is revealed.
    expect(screen.queryByLabelText(/^role$/i)).toBeNull();
  });

  it('clicking Other after the Property Manager preset enters Other mode preserving the role', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Property Manager' }));
    // preset active — no Other panel yet
    expect(screen.queryByLabelText(/^role$/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    // Other panel now open, role carried forward from the preset
    const roleInput = screen.getByLabelText(/^role$/i);
    expect(roleInput).toBeInTheDocument();
    expect(roleInput).toHaveValue('Property Manager');
  });

  // Fix 7: Other → type "Property Manager" → pick base Landlord → PM segment lights up
  it('building PM shape via Other path lights the Property Manager preset segment and keeps panel open', () => {
    setup();

    // Step 1: click Other
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    const roleInput = screen.getByLabelText(/^role$/i);
    expect(roleInput).toBeInTheDocument();

    // Step 2: type "Property Manager" into the role input
    act(() => {
      fireEvent.change(roleInput, { target: { value: 'Property Manager' } });
    });

    // Step 3: click the base-type Landlord button inside the "Base contact type" group
    const baseGroup = screen.getByRole('group', { name: 'Base contact type' });
    const baseLandlordBtn = Array.from(baseGroup.querySelectorAll('button')).find(
      (b) => b.textContent === 'Landlord',
    )!;
    fireEvent.click(baseLandlordBtn);

    // The PRIMARY Property Manager segment should now be aria-pressed=true
    const primaryGroup = screen.getByRole('group', { name: 'Contact kind' });
    const pmButton = Array.from(primaryGroup.querySelectorAll('button')).find(
      (b) => b.textContent === 'Property Manager',
    )!;
    expect(pmButton).toHaveAttribute('aria-pressed', 'true');

    // The Other panel must remain open (no jarring close) — role input still visible
    expect(screen.getByLabelText(/^role$/i)).toBeInTheDocument();
  });

  // Fix 2: re-clicking Other when already in Other mode must NOT wipe the base type
  it('clicking Other when already in Other mode keeps type and role unchanged', () => {
    const onChange = vi.fn();
    // Start in Other mode with a base type and a role already set
    render(
      <KindPicker
        value={{ type: 'tenant', role: 'Case worker' }}
        onChange={onChange}
      />,
    );

    // Click the "Other" segment button — should be a no-op on type+role
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));

    // onChange should have been called with the same type+role (not null+role)
    expect(onChange).toHaveBeenCalledWith({ type: 'tenant', role: 'Case worker' });
  });
});
