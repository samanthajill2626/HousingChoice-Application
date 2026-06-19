import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { CaseItem } from '../../api/index.js';
import { ClosedArea } from './ClosedArea.js';

function mkCase(over: Partial<CaseItem> & Pick<CaseItem, 'caseId' | 'stage'>): CaseItem {
  return { tenantId: 't1', unitId: 'u1', ...over } as CaseItem;
}

function renderClosed(cases: CaseItem[]): void {
  render(
    <MemoryRouter>
      <ClosedArea cases={cases} tenantName={() => 'Tasha Nguyen'} listingAddress={() => '12 Oak St'} />
    </MemoryRouter>,
  );
}

describe('ClosedArea (M5 — category only, never free text)', () => {
  it('shows the lost-reason CATEGORY label and NEVER the free text (PII)', () => {
    renderClosed([
      mkCase({
        caseId: 'cl',
        stage: 'lost',
        lost_reason: { category: 'tenant_withdrew', text: 'moved to live with her sister Jane Doe' },
      }),
    ]);
    const list = screen.getByRole('list', { name: /Closed placements/i });
    // The category label is shown...
    expect(within(list).getByText(/Tenant withdrew/)).toBeInTheDocument();
    // ...and the free text (PII) is NOT anywhere in the rendered list.
    expect(within(list).queryByText(/Jane Doe/)).not.toBeInTheDocument();
    expect(within(list).queryByText(/sister/)).not.toBeInTheDocument();
  });

  it('shows the terminal stage label with no reason when there is no category', () => {
    renderClosed([
      mkCase({ caseId: 'cl', stage: 'lost', lost_reason: { text: 'free text only secret note' } }),
    ]);
    const list = screen.getByRole('list', { name: /Closed placements/i });
    expect(within(list).getByText('Lost')).toBeInTheDocument();
    expect(within(list).queryByText(/secret note/)).not.toBeInTheDocument();
  });
});
