// ToursPage.walks.test.tsx - the page split's load contract (spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md section 4.2), with the
// REAL data hooks (useTours, useContacts, useListings, useClosedTours,
// usePastTours) over a mocked api barrel that only counts calls:
//   - Active, Past and Closed share ONE mounted component, so switching among
//     them never re-runs the contact and unit walks (perf:pages cannot pin
//     this - its warm mode treats the walks as conditional);
//   - the All view loads none of them;
//   - leaving All for a named view mounts that component fresh, so the walks
//     run again - exactly one more round (the documented price of leaving the
//     named views).
// One round = useContacts('all') + useContacts('deleted'), four contact types
// each (8 getAllContacts calls), + useListings() + useListings(true) (2
// getAllUnits calls).
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TourListPage } from '../../api/index.js';

const getAllContacts = vi.fn(() => Promise.resolve([]));
const getAllUnits = vi.fn(() => Promise.resolve([]));
const getTours = vi.fn(() => Promise.resolve([]));
const listTours = vi.fn(
  (): Promise<TourListPage> => Promise.resolve({ tours: [], contacts: {}, units: {}, nextCursor: null }),
);
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllContacts: (...a: unknown[]) => getAllContacts(...(a as [])),
    getAllUnits: (...a: unknown[]) => getAllUnits(...(a as [])),
    getTours: (...a: unknown[]) => getTours(...(a as [])),
    listTours: (...a: unknown[]) => listTours(...(a as [])),
  };
});

import { ToursPage } from './ToursPage.js';

function renderPage(initialPath: string): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/tours" element={<ToursPage />} />
        <Route path="/tours/all" element={<ToursPage view="all" />} />
        <Route path="/tours/past" element={<ToursPage view="past" />} />
        <Route path="/tours/closed" element={<ToursPage view="closed" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function tab(name: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Tours view' })).getByRole('link', { name });
}

function expectWalks(contacts: number, units: number): void {
  expect(getAllContacts).toHaveBeenCalledTimes(contacts);
  expect(getAllUnits).toHaveBeenCalledTimes(units);
}

beforeEach(() => {
  getAllContacts.mockClear();
  getAllUnits.mockClear();
  getTours.mockClear();
  listTours.mockClear();
});

describe('ToursPage - the contact and unit walks across the views', () => {
  it('Active -> Past -> Closed never re-runs them; All runs none; back to Active runs exactly one more round', async () => {
    const user = userEvent.setup();
    renderPage('/tours');
    await screen.findByRole('region', { name: 'Upcoming tours' });
    expectWalks(8, 2);

    await user.click(tab('Past'));
    await screen.findByRole('region', { name: 'Past tours' });
    expectWalks(8, 2);

    await user.click(tab('Closed'));
    await screen.findByRole('region', { name: 'Closed tours' });
    expectWalks(8, 2);

    // The All view mounts in place of the named views' component and loads
    // none of their reads - only its own first page, once.
    expect(listTours).not.toHaveBeenCalled();
    await user.click(tab('All'));
    await screen.findByRole('heading', { level: 1, name: 'All tours' });
    expect(screen.queryByRole('region', { name: 'Closed tours' })).not.toBeInTheDocument();
    await screen.findByText('No tours match these filters.');
    expect(listTours).toHaveBeenCalledTimes(1);
    expect(listTours).toHaveBeenCalledWith({ when: 'any', sort: 'latest' }, { limit: 50 }, expect.any(AbortSignal));
    expectWalks(8, 2);

    // Leaving All mounts the named views' component fresh: one more round.
    await user.click(tab('Active'));
    await screen.findByRole('region', { name: 'Upcoming tours' });
    expectWalks(16, 4);
  });
});
