// Units (Listings) list tests — render rows, status filter, empty/error.
// Mock the api barrel (stub listUnits); no network.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitItem, UnitsPage } from '../../api/index.js';

const { listUnitsMock } = vi.hoisted(() => ({ listUnitsMock: vi.fn() }));

vi.mock('../../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../api/index.js')>();
  return { ...actual, listUnits: listUnitsMock };
});

const { default: Units } = await import('../Units.js');

function unit(over: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId: 'u1',
    landlordId: 'k-land',
    status: 'available',
    address: '123 Main St',
    beds: 2,
    baths: 1,
    area: 'Eastside',
    rent_min: 1200,
    rent_max: 1500,
    ...over,
  };
}

function page(units: UnitItem[], nextCursor: string | null = null): UnitsPage {
  return { units, nextCursor };
}

function renderScreen(): void {
  render(
    <MemoryRouter initialEntries={['/units']}>
      <Units />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listUnitsMock.mockReset();
  listUnitsMock.mockResolvedValue(page([]));
});

describe('<Units>', () => {
  it('renders unit rows with summary + rent + status', async () => {
    listUnitsMock.mockResolvedValue(page([unit()]));
    renderScreen();
    expect(await screen.findByText('123 Main St')).toBeInTheDocument();
    // The summary + rent render as adjacent text nodes within the row sub-line.
    expect(screen.getByText(/2 bd · 1 ba · Eastside/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,200–\$1,500/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /123 Main St/ });
    expect(link).toHaveAttribute('href', '/units/u1');
    // The status badge ("Available" also appears as a filter option, so scope
    // to the badge inside the link).
    expect(within(link).getByText('Available')).toBeInTheDocument();
  });

  it('applies the status filter and refetches', async () => {
    listUnitsMock.mockResolvedValue(page([unit({ status: 'placed' })]));
    renderScreen();
    await screen.findByText('123 Main St');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'placed' } });
    await waitFor(() =>
      expect(listUnitsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'placed' }),
        expect.anything(),
      ),
    );
  });

  it('shows the empty state when there are no units', async () => {
    listUnitsMock.mockResolvedValue(page([]));
    renderScreen();
    expect(await screen.findByText('No listings yet')).toBeInTheDocument();
  });

  it('renders an error state with retry', async () => {
    const { ApiError } = await import('../../api/index.js');
    listUnitsMock.mockRejectedValueOnce(new ApiError(500, 'boom', 'boom'));
    renderScreen();
    expect(await screen.findByText("Couldn't load listings")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
