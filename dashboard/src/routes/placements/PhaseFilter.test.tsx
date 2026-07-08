import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PhaseFilter } from './PhaseFilter.js';
import type { LedgerCounts } from './pageModel.js';

const counts: LedgerCounts = {
  all: 3,
  byPhase: {
    Application: 1,
    RTA: 2,
    Inspection: 0,
    'Rent Determination': 0,
    Contract: 0,
    Administrative: 0,
    Closure: 0,
  },
  closed: 4,
};

function renderFilter(filter: Parameters<typeof PhaseFilter>[0]['filter']): void {
  render(
    <MemoryRouter>
      <PhaseFilter counts={counts} filter={filter} />
    </MemoryRouter>,
  );
}

describe('PhaseFilter', () => {
  it('renders all entries with counts inside a labeled nav', () => {
    renderFilter({ kind: 'all' });
    const nav = screen.getByRole('navigation', { name: 'Placement phases' });
    expect(within(nav).getByRole('link', { name: /All active.*3/ })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /RTA.*2/ })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /Closed.*4/ })).toBeInTheDocument();
  });

  it('marks the selected entry with aria-current and targets the right URLs', () => {
    renderFilter({ kind: 'phase', phase: 'RTA' });
    const rta = screen.getByRole('link', { name: /RTA.*2/ });
    expect(rta).toHaveAttribute('aria-current', 'true');
    expect(rta).toHaveAttribute('href', '/placements?phase=rta');
    expect(screen.getByRole('link', { name: /All active/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: /Closed/ })).toHaveAttribute('href', '/placements?view=closed');
  });
});
