import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api/index.js';
import { buildFacets, NONE_KEY, type TenantSelection } from './tenantFacets.js';
import { TenantFilters } from './TenantFilters.js';

// Structure + behavior only. jsdom does NO layout (no container queries, no
// ellipsis, zeroed rects), so nothing here asserts sizing - that is live QA's
// job (spec section 6).

const EMPTY: TenantSelection = {
  voucher: new Set<string>(),
  ha: new Set<string>(),
  porting: false,
};

let seq = 0;
function tenant(over: Partial<Contact>): Contact {
  seq += 1;
  return { contactId: `t${seq}`, type: 'tenant', ...over };
}

/** No search query active. */
const ALL = (): boolean => true;

// Models always come from the REAL buildFacets - never a hand-assembled shape,
// so a contract change fails here instead of drifting silently.
const TENANTS: Contact[] = [
  tenant({ voucherSize: 0, housingAuthority: 'DCA' }),
  tenant({ voucherSize: 2, housingAuthority: 'DCA', porting: true }),
  tenant({}),
];
const MODEL = buildFacets(TENANTS, EMPTY, ALL);

describe('TenantFilters', () => {
  it('renders the three labelled groups with their chips and counts', () => {
    render(<TenantFilters model={MODEL} selection={EMPTY} onChange={vi.fn()} />);

    const voucher = screen.getByRole('group', { name: 'Voucher size' });
    const authority = screen.getByRole('group', { name: 'Housing authority' });
    const porting = screen.getByRole('group', { name: 'Porting' });

    // The FIXED five buckets plus Not recorded, counts from the loaded set.
    expect(within(voucher).getByRole('button', { name: 'Studio (1)' })).toBeInTheDocument();
    expect(within(voucher).getByRole('button', { name: '1-BR (0)' })).toBeInTheDocument();
    expect(within(voucher).getByRole('button', { name: '2-BR (1)' })).toBeInTheDocument();
    expect(within(voucher).getByRole('button', { name: '3-BR (0)' })).toBeInTheDocument();
    expect(within(voucher).getByRole('button', { name: '4+ BR (0)' })).toBeInTheDocument();
    expect(within(voucher).getByRole('button', { name: 'Not recorded (1)' })).toBeInTheDocument();

    // Derived authority options, merged on the normalized key.
    expect(within(authority).getByRole('button', { name: 'DCA (2)' })).toBeInTheDocument();
    expect(within(authority).getByRole('button', { name: 'Not recorded (1)' })).toBeInTheDocument();

    expect(within(porting).getByRole('button', { name: 'Porting (1)' })).toBeInTheDocument();
  });

  it('gives each group its OWN accessible name (one useId per group)', () => {
    render(<TenantFilters model={MODEL} selection={EMPTY} onChange={vi.fn()} />);
    // Three distinct groups - a single shared label id would collapse them and
    // void every group-scoped query in this file.
    expect(screen.getAllByRole('group')).toHaveLength(3);
    const voucher = screen.getByRole('group', { name: 'Voucher size' });
    const authority = screen.getByRole('group', { name: 'Housing authority' });
    expect(voucher).not.toBe(authority);
    // The voucher group must not reach the authority chips.
    expect(within(voucher).queryByRole('button', { name: /DCA/ })).toBeNull();
    expect(within(authority).queryByRole('button', { name: /Studio/ })).toBeNull();
  });

  it('renders NO list markup (the rows list owns listitem counts)', () => {
    render(<TenantFilters model={MODEL} selection={EMPTY} onChange={vi.fn()} />);
    expect(screen.queryAllByRole('list')).toHaveLength(0);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('toggles an authority chip ON through onChange (normalized key)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TenantFilters model={MODEL} selection={EMPTY} onChange={onChange} />);
    const chip = screen.getByRole('button', { name: 'DCA (2)' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ha: new Set(['dca']) }));
  });

  it('toggles a selected chip back OFF and marks it pressed while on', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sel: TenantSelection = { ...EMPTY, ha: new Set(['dca']) };
    const model = buildFacets(TENANTS, sel, ALL);
    render(<TenantFilters model={model} selection={sel} onChange={onChange} />);
    const chip = screen.getByRole('button', { name: 'DCA (2)' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await user.click(chip);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ha: new Set<string>() }));
  });

  it('selects the Not-recorded sentinel in the voucher facet', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TenantFilters model={MODEL} selection={EMPTY} onChange={onChange} />);
    const voucher = screen.getByRole('group', { name: 'Voucher size' });
    await user.click(within(voucher).getByRole('button', { name: 'Not recorded (1)' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ voucher: new Set([NONE_KEY]) }),
    );
  });

  it('toggles Porting through onChange and keeps the placement-chip title', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TenantFilters model={MODEL} selection={EMPTY} onChange={onChange} />);
    const chip = screen.getByRole('button', { name: 'Porting (1)' });
    expect(chip).toHaveAttribute('title', 'Tenant is porting');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ porting: true }));
  });

  it('hides the Porting group when no tenant is porting (a dead toggle)', () => {
    const model = buildFacets([tenant({ voucherSize: 1, porting: false })], EMPTY, ALL);
    render(<TenantFilters model={model} selection={EMPTY} onChange={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Porting' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Porting/ })).toBeNull();
  });

  it('a zero-count UNSELECTED chip is aria-disabled, focusable, and inert', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TenantFilters model={MODEL} selection={EMPTY} onChange={onChange} />);
    const chip = screen.getByRole('button', { name: '1-BR (0)' });
    expect(chip).toHaveAttribute('aria-disabled', 'true');
    // ENABLED so keyboard/screen-reader users can still reach the explanation.
    expect(chip).not.toBeDisabled();
    chip.focus();
    expect(chip).toHaveFocus();
    await user.click(chip);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a SELECTED chip with contextual count 0 is STILL clickable - no deselection deadlock', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // '2' is selected AND its contextual count is 0: the only 2-BR tenant is
    // excluded by the OTHER facet.
    const sel: TenantSelection = { voucher: new Set(['2']), ha: new Set(['dca']), porting: false };
    const tenants = [tenant({ voucherSize: 2 }), tenant({ voucherSize: 3, housingAuthority: 'DCA' })];
    const model = buildFacets(tenants, sel, ALL);
    expect(model.voucher.find((o) => o.key === '2')?.count).toBe(0);
    render(<TenantFilters model={model} selection={sel} onChange={onChange} />);
    const chip = screen.getByRole('button', { name: '2-BR (0)' });
    expect(chip).not.toHaveAttribute('aria-disabled');
    await user.click(chip);
    expect(onChange).toHaveBeenCalled();
  });

  it('renders a per-facet Clear only for a non-empty facet, and clears only that facet', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sel: TenantSelection = { voucher: new Set(['0']), ha: new Set(['dca']), porting: false };
    const model = buildFacets(TENANTS, sel, ALL);
    render(<TenantFilters model={model} selection={sel} onChange={onChange} />);
    const voucher = screen.getByRole('group', { name: 'Voucher size' });
    await user.click(within(voucher).getByRole('button', { name: /clear/i }));
    // Only the voucher facet resets; the authority selection survives.
    expect(onChange).toHaveBeenCalledWith({
      voucher: new Set<string>(),
      ha: new Set(['dca']),
      porting: false,
    });
  });

  it('hides a facet Clear while that facet is empty', () => {
    const sel: TenantSelection = { ...EMPTY, ha: new Set(['dca']) };
    const model = buildFacets(TENANTS, sel, ALL);
    render(<TenantFilters model={model} selection={sel} onChange={vi.fn()} />);
    const voucher = screen.getByRole('group', { name: 'Voucher size' });
    const authority = screen.getByRole('group', { name: 'Housing authority' });
    expect(within(voucher).queryByRole('button', { name: /clear/i })).toBeNull();
    expect(within(authority).getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('renders the muted line instead of chips when no authority is recorded', () => {
    const model = buildFacets([tenant({ voucherSize: 1 })], EMPTY, ALL);
    render(<TenantFilters model={model} selection={EMPTY} onChange={vi.fn()} />);
    // The promised control does not silently vanish: the label + an explanation.
    expect(screen.getByText('No housing authorities recorded yet')).toBeInTheDocument();
    const authority = screen.getByRole('group', { name: 'Housing authority' });
    expect(within(authority).queryAllByRole('button')).toHaveLength(0);
  });

  it('renders the muted line instead of chips when no voucher size is recorded', () => {
    const model = buildFacets([tenant({ housingAuthority: 'DCA' })], EMPTY, ALL);
    render(<TenantFilters model={model} selection={EMPTY} onChange={vi.fn()} />);
    expect(screen.getByText('No voucher sizes recorded yet')).toBeInTheDocument();
    const voucher = screen.getByRole('group', { name: 'Voucher size' });
    expect(within(voucher).queryAllByRole('button')).toHaveLength(0);
    // The other facet still renders its chips.
    expect(screen.getByRole('button', { name: 'DCA (1)' })).toBeInTheDocument();
  });
});
