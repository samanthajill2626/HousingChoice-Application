import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitsPage } from '../../api/index.js';

const getUnits = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnits: (...a: unknown[]) => getUnits(...a),
  };
});

import { useListings } from './useListings.js';

function Probe(): React.JSX.Element {
  const s = useListings();
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.units.length}</span>
    </div>
  );
}

const UNITS: UnitsPage = {
  nextCursor: null,
  units: [{ unitId: 'u1', landlordId: 'l1', status: 'available' }],
};

beforeEach(() => {
  getUnits.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('useListings', () => {
  it('loads the unit records into a ready state', async () => {
    getUnits.mockResolvedValue(UNITS);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('goes to the error state when the fetch fails', async () => {
    getUnits.mockRejectedValue(new Error('boom'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });
});
