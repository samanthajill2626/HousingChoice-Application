import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PlacementItem } from '../../api/index.js';
import { PlacementRow } from './PlacementRow.js';
import type { LedgerRow } from './pageModel.js';

function mkRow(over: Partial<LedgerRow> = {}, placement: Partial<PlacementItem> = {}): LedgerRow {
  return {
    placement: {
      placementId: 'p1',
      tenantId: 't1',
      unitId: 'u1',
      stage: 'collect_rta',
      ...placement,
    } as PlacementItem,
    tenant: 'Tasha Nguyen',
    listing: '12 Oak St',
    porting: false,
    ...over,
  };
}

function renderRow(row: LedgerRow, menu?: React.ReactNode): void {
  render(
    <MemoryRouter>
      <ul>
        <PlacementRow row={row} {...(menu !== undefined && { menu })} />
      </ul>
    </MemoryRouter>,
  );
}

describe('PlacementRow', () => {
  it('renders the row link named "<tenant> - <stage>", address, and stage label', () => {
    renderRow(mkRow());
    const link = screen.getByRole('link', { name: 'Tasha Nguyen - Collect RTA' });
    expect(link).toHaveAttribute('href', '/placements/p1');
    expect(screen.getByText('12 Oak St')).toBeInTheDocument();
    expect(screen.getByText('Collect RTA')).toBeInTheDocument();
  });

  it('flags attention with sr-only text (the stripe is CSS)', () => {
    renderRow(mkRow({}, { attention: { reason: 'flagged', at: '2026-07-08T00:00:00Z' } }));
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('no attention -> no sr text; porting renders its chip; menu slot renders', () => {
    renderRow(mkRow({ porting: true }), <button type="button">kebab</button>);
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
    expect(screen.getByText('Porting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'kebab' })).toBeInTheDocument();
  });

  it('shows tenant status badge and tour date when present', () => {
    renderRow(mkRow({ tenantStatus: 'placing' }, { tour_date: '2026-07-16' }));
    expect(screen.getByText(/Tour Jul 16/)).toBeInTheDocument();
  });
});
