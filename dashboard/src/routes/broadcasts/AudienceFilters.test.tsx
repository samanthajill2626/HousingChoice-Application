// AudienceFilters tests (§8) — the extensible audience-filter framework: the
// voucher-size chips (with the "matches property" tag pre-filled from the unit's
// beds), the housing-authority input, the disabled "+ Add filter" seam, the
// always-excluded note, and the live reach count + truncated warning.
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudienceFilter } from '../../api/index.js';
import { AudienceFilters } from './AudienceFilters.js';

// The picker's list (spec 2026-10-06 D7) - the hook is mocked so each test
// picks its own list state.
const useOrgList = vi.fn();
vi.mock('../orgs/useOrgList.js', () => ({ useOrgList: () => useOrgList() }));

const ATLANTA = {
  orgId: 'o-atl',
  kind: 'housing_authority',
  name: 'Atlanta Housing Authority',
  spellings: ['AHA'],
  createdAt: '2026-10-06T00:00:00.000Z',
  createdBy: 'system',
  updatedAt: '2026-10-06T00:00:00.000Z',
  updatedBy: 'system',
};
const LOADED = {
  entries: [ATLANTA],
  version: 1,
  lastRewrite: undefined,
  loading: false,
  error: false,
  reload: vi.fn(),
};

beforeEach(() => {
  useOrgList.mockReset();
  useOrgList.mockReturnValue(LOADED);
});

/** Controlled harness — mirrors the composer owning the filter state so chip
 *  toggles round-trip through onChange. */
function Harness({
  authorityError,
  propertyBeds,
  reachCount,
  reachPending = false,
  truncated = false,
  onChangeSpy,
  onAuthorityTextChange,
  initialFilter = { contact_type: 'tenant' },
}: {
  propertyBeds?: number;
  reachCount?: number;
  reachPending?: boolean;
  truncated?: boolean;
  onChangeSpy?: (f: AudienceFilter) => void;
  authorityError?: string;
  onAuthorityTextChange?: (text: string) => void;
  initialFilter?: AudienceFilter;
}): React.JSX.Element {
  const [filter, setFilter] = useState<AudienceFilter>(initialFilter);
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
      {...(authorityError !== undefined && { authorityError })}
      {...(onAuthorityTextChange !== undefined && { onAuthorityTextChange })}
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

  it('sets the housing authority only by picking a list name (names and spellings match)', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authority' }), 'AHA');
    // Typing never commits (each filter change recreates the draft).
    expect(onChangeSpy).not.toHaveBeenCalled();
    await u.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      contact_type: 'tenant',
      housing_authority: 'Atlanta Housing Authority',
    });
    await u.click(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant' });
  });

  it('a field left holding typed text says it is no filter - even a full list name (R2-FE-6)', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: 'Housing authority' });
    await u.type(box, 'Atlanta Housing Authority');
    await u.tab();
    expect(box).toHaveAccessibleDescription('Not used as a filter - pick a name from the list, or clear the text.');
  });

  it('never offers to add a name (spec D7)', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authority' }), 'Nowhere Board');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('a list that fails to load says so and the filter cannot be set; voucher size still works', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    useOrgList.mockReturnValue({ ...LOADED, entries: [], version: null, error: true });
    render(<Harness onChangeSpy={onChangeSpy} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(screen.getByRole('combobox', { name: 'Housing authority' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: '2-BR' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant', bedroomSize: 2 });
  });

  it('tells the composer what is typed in the picker - and nothing once a name is picked (R2-FE-3)', async () => {
    const u = userEvent.setup();
    const onAuthorityTextChange = vi.fn();
    render(<Harness onAuthorityTextChange={onAuthorityTextChange} />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authority' }), 'AHA');
    expect(onAuthorityTextChange).toHaveBeenLastCalledWith('AHA');
    await u.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(onAuthorityTextChange).toHaveBeenLastCalledWith('');
  });

  it('a list that fails to load marks no picked filter "Not on the list" - nothing is known about it (R3-FE-5)', () => {
    useOrgList.mockReturnValue({ ...LOADED, entries: [], version: null, error: true });
    render(<Harness initialFilter={{ contact_type: 'tenant', housing_authority: 'Atlanta Housing Authority' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(screen.getByText('Atlanta Housing Authority')).toBeInTheDocument();
    expect(screen.queryByText('Not on the list')).not.toBeInTheDocument();
  });

  it('a list that fails while text is typed keeps the field clearable - that text holds Preview back', async () => {
    const u = userEvent.setup();
    const onAuthorityTextChange = vi.fn();
    const { rerender } = render(<Harness onAuthorityTextChange={onAuthorityTextChange} />);
    const box = screen.getByRole('combobox', { name: 'Housing authority' });
    await u.type(box, 'Atl');
    useOrgList.mockReturnValue({ ...LOADED, entries: [], version: null, error: true });
    rerender(<Harness onAuthorityTextChange={onAuthorityTextChange} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(box).toBeEnabled();
    await u.clear(box);
    expect(onAuthorityTextChange).toHaveBeenLastCalledWith('');
    expect(box).toBeDisabled();
  });

  it("shows the composer's message under the picker", () => {
    render(<Harness authorityError="That housing authority is no longer on the list - pick it again" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That housing authority is no longer on the list - pick it again',
    );
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
