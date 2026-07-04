// AudienceFilters tests (§8) — the extensible audience-filter framework: the
// voucher-size chips (with the "matches property" tag pre-filled from the unit's
// beds), the housing-authority input, the disabled "+ Add filter" seam, the
// always-excluded note, and the live reach count + truncated warning.
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AudienceFilter } from '../../api/index.js';
import { AudienceFilters } from './AudienceFilters.js';

/** Controlled harness — mirrors the composer owning the filter state so chip
 *  toggles round-trip through onChange. */
function Harness({
  propertyBeds,
  reachCount,
  reachPending = false,
  truncated = false,
  onChangeSpy,
}: {
  propertyBeds?: number;
  reachCount?: number;
  reachPending?: boolean;
  truncated?: boolean;
  onChangeSpy?: (f: AudienceFilter) => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<AudienceFilter>({ contact_type: 'tenant' });
  return (
    <AudienceFilters
      filter={filter}
      onChange={(next) => {
        onChangeSpy?.(next);
        setFilter(next);
      }}
      {...(propertyBeds !== undefined && { propertyBeds })}
      {...(reachCount !== undefined && { reachCount })}
      reachPending={reachPending}
      truncated={truncated}
    />
  );
}

describe('AudienceFilters — voucher size pre-fill + override', () => {
  it('shows the "matches property" tag + note on the chip matching the unit beds', () => {
    render(<Harness propertyBeds={2} />);
    const chips = screen.getByRole('group', { name: 'Voucher size' });
    const twoBr = within2(chips, '2-BR');
    expect(twoBr).toHaveTextContent(/matches property/i);
    // The note explains the pre-fill is overridable.
    expect(screen.getByText(/Pre-filled to match this 2-bedroom property/i)).toBeInTheDocument();
  });

  it('lets the operator override the voucher size (pick a different chip)', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness propertyBeds={2} onChangeSpy={onChangeSpy} />);
    await u.click(screen.getByRole('button', { name: /^3-BR/ }));
    expect(onChangeSpy).toHaveBeenCalledWith({ contact_type: 'tenant', bedroomSize: 3 });
    // The 3-BR chip is now pressed.
    expect(screen.getByRole('button', { name: /^3-BR/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles a chip off when re-clicked (clears the size narrower)', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await u.click(screen.getByRole('button', { name: '2-BR' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant', bedroomSize: 2 });
    await u.click(screen.getByRole('button', { name: '2-BR' }));
    // Re-click → bedroomSize cleared.
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant' });
  });

  it('edits the housing authority', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await u.type(screen.getByLabelText('Housing authority'), 'A');
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant', housing_authority: 'A' });
  });
});

describe('AudienceFilters — seam + excluded note', () => {
  it('renders a DISABLED "+ Add filter" seam', () => {
    render(<Harness />);
    const add = screen.getByRole('button', { name: '+ Add filter' });
    expect(add).toBeDisabled();
  });

  it('renders the always-excluded note (opted-out - unreachable)', () => {
    render(<Harness />);
    expect(screen.getByText(/Always excluded:/i)).toBeInTheDocument();
    expect(screen.getByText('opted-out')).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
  });
});

describe('AudienceFilters — live reach', () => {
  it('shows "Estimating reach…" while pending', () => {
    render(<Harness reachPending />);
    expect(screen.getByText(/Estimating reach/i)).toBeInTheDocument();
  });

  it('shows the reach count when resolved', () => {
    render(<Harness reachCount={7} />);
    const reach = screen.getByRole('status');
    expect(reach).toHaveTextContent(/Reaches\s*7\s*tenants/);
  });

  it('shows the truncated/capped warning when truncated', () => {
    render(<Harness reachCount={500} truncated />);
    expect(screen.getByText(/list is capped/i)).toBeInTheDocument();
  });
});

/** Find a button by its leading label text within a group (chips carry an extra
 *  "- matches property" span we don't want to over-match). */
function within2(container: HTMLElement, label: string): HTMLElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim().startsWith(label),
  );
  if (!btn) throw new Error(`no chip starting with ${label}`);
  return btn as HTMLElement;
}
