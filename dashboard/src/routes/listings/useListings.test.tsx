import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitItem, UnitsPage } from '../../api/index.js';

const getAllUnits = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllUnits: (...a: unknown[]) => getAllUnits(...a),
  };
});

import { useListings } from './useListings.js';

function Probe({ deleted }: { deleted?: boolean } = {}): React.JSX.Element {
  const s = useListings(deleted);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.units.length}</span>
    </div>
  );
}

const UNITS: UnitItem[] = [{ unitId: 'u1', landlordId: 'l1', status: 'available' }];

beforeEach(() => {
  getAllUnits.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('useListings', () => {
  it('loads the unit records into a ready state', async () => {
    getAllUnits.mockResolvedValue(UNITS);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('goes to the error state when the fetch fails', async () => {
    getAllUnits.mockRejectedValue(new Error('boom'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('requests only deleted listings in the deleted view', async () => {
    getAllUnits.mockResolvedValue(UNITS);
    render(<Probe deleted />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect((getAllUnits.mock.calls[0]?.[0] as { deleted?: boolean }).deleted).toBe(true);
  });

  it('does NOT request deleted listings in the normal view', async () => {
    getAllUnits.mockResolvedValue(UNITS);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect((getAllUnits.mock.calls[0]?.[0] as { deleted?: boolean }).deleted).toBe(false);
  });
});
