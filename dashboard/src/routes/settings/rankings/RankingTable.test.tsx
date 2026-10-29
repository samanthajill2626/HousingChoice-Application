import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RankingMatchView, RankingRowView } from '../../../api/index.js';
import { RankingTable } from './RankingTable.js';

const MATCH: RankingMatchView = {
  score: 82,
  band: 'strong',
  capped: false,
  capReason: null,
  for: [{ text: 'Rent fits', source: 'rent' }],
  against: [{ text: 'Far from work', source: 'area' }],
  missing: [{ key: 'payment_standard', text: 'Payment standard' }, { text: 'move-in date' }],
  failedRequirements: [],
  fairHousingFlags: [],
  outOfDate: [],
  computedAt: '2026-07-01T11:00:00.000Z',
  runId: 'run-1',
  model: 'fake',
};

const ROWS: RankingRowView[] = [
  { candidateId: 'c1', display: 'Ada Ranked', notScored: false, match: MATCH },
  {
    candidateId: 'c2',
    display: 'Bo Capped',
    notScored: false,
    match: {
      ...MATCH,
      score: 45,
      band: 'weak',
      capped: true,
      capReason: 'requirement not met',
      for: [],
      against: [{ text: 'No pets', source: 'pets' }],
      missing: [],
      failedRequirements: ['no_pets'],
      outOfDate: ['card', 'age'],
    },
  },
  { candidateId: 'c3', display: 'Cy New', notScored: false, match: null },
  { candidateId: 'c4', display: 'Di Failed', notScored: true, match: null },
];

function bodyRows(): HTMLElement[] {
  return within(screen.getByRole('table', { name: 'Ranking' })).getAllByRole('row').slice(1);
}

describe('RankingTable', () => {
  it('heads a property anchor ranking with Tenant and every spec column', () => {
    render(<RankingTable rows={ROWS} anchorKind="unit" />);
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Tenant', 'Band', 'Score', 'Capped', 'Out of date', 'Reasons', 'Missing',
    ]);
  });

  it('heads a tenant anchor ranking with Property', () => {
    render(<RankingTable rows={ROWS} anchorKind="tenant" />);
    expect(screen.getAllByRole('columnheader')[0]).toHaveTextContent('Property');
  });

  it('keeps the server order (spec D9 sorts; the table never re-sorts)', () => {
    render(<RankingTable rows={ROWS} anchorKind="unit" />);
    expect(bodyRows().map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Ada Ranked', 'Bo Capped', 'Cy New', 'Di Failed',
    ]);
  });

  it('shows a ranked pair: band, score, cap, out of date, reasons with sources, missing', () => {
    render(<RankingTable rows={ROWS} anchorKind="unit" />);
    const cells = within(bodyRows()[0] as HTMLElement).getAllByRole('cell').map((td) => td.textContent);
    expect(cells).toEqual([
      'Strong',
      '82',
      'No',
      '-',
      'For: Rent fits (rent)Against: Far from work (area)',
      'Payment standard, move-in date',
    ]);
  });

  it('shows a capped, out-of-date pair as the server derived it', () => {
    render(<RankingTable rows={ROWS} anchorKind="unit" />);
    const cells = within(bodyRows()[1] as HTMLElement).getAllByRole('cell').map((td) => td.textContent);
    expect(cells).toEqual([
      'Weak',
      '45',
      'Capped: requirement not met',
      'Out of date: a card changed, too old',
      'Against: No pets (pets)',
      '-',
    ]);
  });

  it('says not ranked yet, and not scored - retry for a failed batch', () => {
    render(<RankingTable rows={ROWS} anchorKind="unit" />);
    expect(bodyRows()[2]).toHaveTextContent('not ranked yet');
    expect(bodyRows()[3]).toHaveTextContent('not scored - retry');
  });

  it('says so when the pool is empty', () => {
    render(<RankingTable rows={[]} anchorKind="unit" />);
    expect(screen.getByText('No candidates are in this pool.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
