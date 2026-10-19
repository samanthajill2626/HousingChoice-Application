// AudienceFilters tests - the extensible audience-filter framework: the
// voucher-size chips (with the "matches property" tag pre-filled from the voucher
// size the unit takes), the "Housing authorities" multi-picker over the
// organization list (matching-blast-rules D2), the property prefill's notes
// (D3), the caption (D8), the disabled "+ Add filter" seam, the always-excluded
// note, and the live reach count + incomplete-list suffix (D7).
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AudienceFilter, OrgEntry } from '../../api/index.js';
import type { OrgListView } from '../orgs/orgCopy.js';
import { AudienceFilters, type PrefillNotice } from './AudienceFilters.js';

function entry(orgId: string, name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId,
    kind: 'housing_authority',
    name,
    spellings,
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}
const ATLANTA = entry('o-atl', 'Atlanta Housing Authority', ['AHA']);
const DEKALB = entry('o-dek', 'DeKalb County Housing Authority', ['HADC']);
// The picker's list (spec 2026-10-06 D7) now comes from the composer as a
// prop (matching-blast-rules D3): each test passes its own list state.
const LOADED: OrgListView = { entries: [ATLANTA, DEKALB], loading: false, error: false };
const FAILED: OrgListView = { entries: [], loading: false, error: true };

const CAPTION_SHORT =
  'Only tenants in Onboarding or Searching are included. Add any other tenant by hand when you review recipients.';
const CAPTION_LONG =
  'Only tenants in Onboarding or Searching are included. While a housing authority is selected, tenants whose ' +
  'housing authority is missing or not on the organization list are left out. Add any other tenant by hand when ' +
  'you review recipients.';

/** Controlled harness - mirrors the composer owning the filter state so chip
 *  toggles round-trip through onChange. */
function Harness({
  authorityError,
  propertyVoucherSize,
  reachCount,
  reachPending = false,
  truncated = false,
  onChangeSpy,
  onAuthorityTextChange,
  initialFilter = { contact_type: 'tenant' },
  disabled,
  orgList = LOADED,
  unusedAuthorities,
  noAuthorityMapped,
  prefillNotices,
}: {
  propertyVoucherSize?: number;
  reachCount?: number;
  reachPending?: boolean;
  truncated?: boolean;
  onChangeSpy?: (f: AudienceFilter) => void;
  authorityError?: string;
  onAuthorityTextChange?: (text: string) => void;
  initialFilter?: AudienceFilter;
  disabled?: boolean;
  orgList?: OrgListView;
  unusedAuthorities?: string[];
  noAuthorityMapped?: boolean;
  prefillNotices?: PrefillNotice[];
}): React.JSX.Element {
  const [filter, setFilter] = useState<AudienceFilter>(initialFilter);
  return (
    <AudienceFilters
      filter={filter}
      onChange={(next) => {
        onChangeSpy?.(next);
        setFilter(next);
      }}
      orgList={orgList}
      {...(disabled !== undefined && { disabled })}
      {...(propertyVoucherSize !== undefined && { propertyVoucherSize })}
      {...(reachCount !== undefined && { reachCount })}
      reachPending={reachPending}
      truncated={truncated}
      {...(authorityError !== undefined && { authorityError })}
      {...(onAuthorityTextChange !== undefined && { onAuthorityTextChange })}
      {...(unusedAuthorities !== undefined && { unusedAuthorities })}
      {...(noAuthorityMapped !== undefined && { noAuthorityMapped })}
      {...(prefillNotices !== undefined && { prefillNotices })}
    />
  );
}

describe('AudienceFilters - voucher size pre-fill + override', () => {
  it('shows the "matches property" tag + note on the chip matching the voucher size the unit takes', () => {
    render(<Harness propertyVoucherSize={2} />);
    const chips = screen.getByRole('group', { name: 'Voucher size' });
    const twoBr = within2(chips, '2-BR');
    expect(twoBr).toHaveTextContent(/matches property/i);
    // The note names the voucher size (not the bedrooms) and says it is overridable.
    expect(
      screen.getByText(/Pre-filled to the 2-bedroom voucher this property takes - change it/i),
    ).toBeInTheDocument();
  });

  it('lets the operator override the voucher size (pick a different chip)', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness propertyVoucherSize={2} onChangeSpy={onChangeSpy} />);
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
    // Re-click: bedroomSize cleared.
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant' });
  });

  it('a voucher chip keeps the housing authority list as it is', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(
      <Harness
        onChangeSpy={onChangeSpy}
        initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'] }}
      />,
    );
    await u.click(screen.getByRole('button', { name: '3-BR' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'],
      bedroomSize: 3,
    });
  });
});

describe('AudienceFilters - housing authorities (matching-blast-rules D2)', () => {
  it('is a multi-picker labeled "Housing authorities": each pick ADDS a list name (names and spellings match)', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    const box = screen.getByRole('combobox', { name: 'Housing authorities' });
    await u.type(box, 'AHA');
    // Typing never commits (each filter change recreates the draft).
    expect(onChangeSpy).not.toHaveBeenCalled();
    await u.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
    });
    await u.type(box, 'HADC');
    await u.click(screen.getByRole('option', { name: /^DeKalb County Housing Authority/ }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'],
    });
    // Removing one chip keeps the other; removing the last clears the filter.
    await u.click(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority'],
    });
    await u.click(screen.getByRole('button', { name: 'Remove DeKalb County Housing Authority' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant' });
  });

  it('a chosen name is no longer offered (multi mode hides members)', async () => {
    const u = userEvent.setup();
    render(<Harness initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority'] }} />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'Housing');
    expect(screen.queryByRole('option', { name: /^Atlanta Housing Authority/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^DeKalb County Housing Authority/ })).toBeInTheDocument();
  });

  it('a field left holding typed text says it is no filter - even a full list name (R2-FE-6)', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: 'Housing authorities' });
    await u.type(box, 'Atlanta Housing Authority');
    await u.tab();
    expect(box).toHaveAccessibleDescription('Not used as a filter - pick a name from the list, or clear the text.');
  });

  it('never offers to add a name (spec D7)', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'Nowhere Board');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('a list that fails to load says so and the filter cannot be set; voucher size still works', async () => {
    const u = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} orgList={FAILED} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(screen.getByRole('combobox', { name: 'Housing authorities' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: '2-BR' }));
    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant', bedroomSize: 2 });
  });

  it('tells the composer what is typed in the picker - and nothing once a name is picked (R2-FE-3)', async () => {
    const u = userEvent.setup();
    const onAuthorityTextChange = vi.fn();
    render(<Harness onAuthorityTextChange={onAuthorityTextChange} />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'AHA');
    expect(onAuthorityTextChange).toHaveBeenLastCalledWith('AHA');
    await u.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(onAuthorityTextChange).toHaveBeenLastCalledWith('');
  });

  it('a list that fails to load marks no picked filter "Not on the list" - nothing is known about it (R3-FE-5)', () => {
    render(
      <Harness orgList={FAILED} initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority'] }} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(screen.getByText('Atlanta Housing Authority')).toBeInTheDocument();
    expect(screen.queryByText('Not on the list')).not.toBeInTheDocument();
  });

  it('a list that fails while text is typed keeps the field clearable - that text holds Preview back', async () => {
    const u = userEvent.setup();
    const onAuthorityTextChange = vi.fn();
    const { rerender } = render(<Harness onAuthorityTextChange={onAuthorityTextChange} />);
    const box = screen.getByRole('combobox', { name: 'Housing authorities' });
    await u.type(box, 'Atl');
    rerender(<Harness onAuthorityTextChange={onAuthorityTextChange} orgList={FAILED} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load housing authorities");
    expect(box).toBeEnabled();
    await u.clear(box);
    expect(onAuthorityTextChange).toHaveBeenLastCalledWith('');
    expect(box).toBeDisabled();
  });

  it('disabled (a preview is loading): no voucher chip, pick or chip removal can change the audience (R3-FE-1)', () => {
    render(
      <Harness
        disabled
        initialFilter={{ contact_type: 'tenant', bedroomSize: 2, housing_authorities: ['Atlanta Housing Authority'] }}
      />,
    );
    const chips = screen.getByRole('group', { name: 'Voucher size' });
    for (const chip of Array.from(chips.querySelectorAll('button'))) expect(chip).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Housing authorities' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeDisabled();
  });

  it("shows the composer's message under the picker", () => {
    render(
      <Harness authorityError="Atlanta Housing Authority is no longer on the organization list, so it was removed from the filter." />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Atlanta Housing Authority is no longer on the organization list, so it was removed from the filter.',
    );
  });
});

describe('AudienceFilters - the property prefill notes (matching-blast-rules D3)', () => {
  it('names the property authorities that are not on the organization list', () => {
    render(
      <Harness
        unusedAuthorities={['Nowhere Board', 'Old Name HA']}
        initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority'] }}
      />,
    );
    expect(screen.getByText('Not used (not on the organization list): Nowhere Board, Old Name HA.')).toBeInTheDocument();
    expect(screen.queryByText(/This blast is not limited by housing authority/)).not.toBeInTheDocument();
  });

  it('when NONE of them mapped, says the blast is not limited by housing authority', () => {
    render(<Harness unusedAuthorities={['Nowhere Board']} noAuthorityMapped />);
    expect(
      screen.getByText(
        'Not used (not on the organization list): Nowhere Board. This blast is not limited by housing authority.',
      ),
    ).toBeInTheDocument();
  });

  it('drops the not-limited sentence once staff pick an authority', async () => {
    const u = userEvent.setup();
    render(<Harness unusedAuthorities={['Nowhere Board']} noAuthorityMapped />);
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'AHA');
    await u.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    expect(screen.getByText('Not used (not on the organization list): Nowhere Board.')).toBeInTheDocument();
  });

  it('shows each hold notice the composer passes with a Try again that re-runs only its own read (AR44)', async () => {
    const u = userEvent.setup();
    const PROPERTY_HOLD =
      "Couldn't load the property, so its housing authorities and voucher size can't be filled in yet.";
    const LIST_HOLD =
      "Couldn't load the organization list, so housing authorities can't be filled in from the property yet.";
    const retryProperty = vi.fn();
    const retryList = vi.fn();
    render(
      <Harness
        prefillNotices={[
          { text: PROPERTY_HOLD, onRetry: retryProperty },
          { text: LIST_HOLD, onRetry: retryList },
        ]}
      />,
    );
    await u.click(within(screen.getByText(PROPERTY_HOLD)).getByRole('button', { name: 'Try again' }));
    expect(retryProperty).toHaveBeenCalledTimes(1);
    expect(retryList).not.toHaveBeenCalled();
    await u.click(within(screen.getByText(LIST_HOLD)).getByRole('button', { name: 'Try again' }));
    expect(retryList).toHaveBeenCalledTimes(1);
    expect(retryProperty).toHaveBeenCalledTimes(1);
  });

  it('no notes without a prefill', () => {
    render(<Harness />);
    expect(screen.queryByText(/Not used \(not on the organization list\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load the/)).not.toBeInTheDocument();
  });
});

describe('AudienceFilters - caption (matching-blast-rules D8)', () => {
  it('says who is included - without the housing authority sentence while none is selected', () => {
    render(<Harness />);
    expect(screen.getByText(CAPTION_SHORT)).toBeInTheDocument();
    expect(screen.queryByText(/While a housing authority is selected/)).not.toBeInTheDocument();
  });

  it('adds the housing authority sentence while the list is non-empty', () => {
    render(<Harness initialFilter={{ contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority'] }} />);
    expect(screen.getByText(CAPTION_LONG)).toBeInTheDocument();
  });
});

describe('AudienceFilters - seam + excluded note', () => {
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

describe('AudienceFilters - live reach', () => {
  it('shows "Estimating reach" while pending', () => {
    render(<Harness reachPending />);
    expect(screen.getByText(/Estimating reach/i)).toBeInTheDocument();
  });

  it('shows the reach count when resolved', () => {
    render(<Harness reachCount={7} />);
    const reach = screen.getByRole('status');
    expect(reach).toHaveTextContent(/Reaches\s*7\s*recipients/);
  });

  it('says the list is incomplete when truncated - and never asks to narrow a filter (D7)', () => {
    render(<Harness reachCount={500} truncated />);
    expect(screen.getByRole('status')).toHaveTextContent('Reaches 500 recipients - the list is incomplete');
    expect(screen.queryByText(/narrow/i)).not.toBeInTheDocument();
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
