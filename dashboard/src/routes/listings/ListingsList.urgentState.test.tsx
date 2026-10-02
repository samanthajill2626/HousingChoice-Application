// The Properties list's filters must never wait for the router. react-router 7
// applies every URL change inside a transition, so a control that READ the URL
// lagged the event that changed it - a second tap before the first committed
// dropped the first (code review r1, A5). This suite freezes the URL outright:
// `useSearchParams` reports an empty query forever and only RECORDS writes. If
// the filters are urgent local state, every control still responds at once and
// each write carries every earlier choice; a URL-driven control would sit
// unchanged and the last write would hold only the last tap.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitItem } from '../../api/index.js';

const writes: string[] = [];

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const frozen = new URLSearchParams('');
  return {
    ...actual,
    useSearchParams: () => [frozen, (next: URLSearchParams) => void writes.push(next.toString())],
  };
});

const UNITS: UnitItem[] = [
  { unitId: 'a', landlordId: 'l', status: 'available', voucher_size_accepted: 2, address: { line1: '1 Two St' } },
  { unitId: 'b', landlordId: 'l', status: 'available', voucher_size_accepted: 3, address: { line1: '2 Three St' } },
  { unitId: 'c', landlordId: 'l', status: 'occupied', voucher_size_accepted: 2, address: { line1: '3 Taken St' } },
];
vi.mock('./useListings.js', () => ({ useListings: () => ({ status: 'ready', units: UNITS }) }));

import { ListingsList } from './ListingsList.js';

beforeEach(() => {
  writes.length = 0;
});

describe('ListingsList filters do not wait for the router', () => {
  it('responds to every tap at once and writes the accumulated choice each time', async () => {
    render(
      <MemoryRouter initialEntries={['/listings']}>
        <ListingsList />
      </MemoryRouter>,
    );
    const voucher = screen.getByRole('group', { name: /voucher size/i });

    await userEvent.click(within(voucher).getByRole('button', { name: '2-BR' }));
    await userEvent.click(within(voucher).getByRole('button', { name: '3-BR' }));
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'all');

    expect(within(voucher).getByRole('button', { name: '2-BR' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(voucher).getByRole('button', { name: '3-BR' })).toHaveAttribute('aria-pressed', 'true');
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('all');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(writes).toEqual(['voucher=2', 'voucher=2&voucher=3', 'status=all&voucher=2&voucher=3']);
  });

  it('typing never writes; leaving the box writes once, with the other choices', async () => {
    render(
      <MemoryRouter initialEntries={['/listings']}>
        <ListingsList />
      </MemoryRouter>,
    );
    await userEvent.click(
      within(screen.getByRole('group', { name: /voucher size/i })).getByRole('button', { name: '2-BR' }),
    );
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'Two');
    expect(writes).toEqual(['voucher=2']);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    await userEvent.tab();
    expect(writes).toEqual(['voucher=2', 'voucher=2&q=Two']);
  });
});
