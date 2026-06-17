import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { CasesPage, UnitsPage } from '../../api/index.js';

const getCases = vi.fn();
const getUnits = vi.fn();
const getContactListingsSent = vi.fn();
const getContactMedia = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getCases: (...a: unknown[]) => getCases(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getContactListingsSent: (...a: unknown[]) => getContactListingsSent(...a),
    getContactMedia: (...a: unknown[]) => getContactMedia(...a),
  };
});

import { useContactFile } from './useContactFile.js';

function Probe({ contactId }: { contactId: string }): React.JSX.Element {
  const f = useContactFile(contactId);
  return (
    <div>
      <span data-testid="status">{f.status}</span>
      <span data-testid="cases">{f.cases.length}</span>
      <span data-testid="units">{f.units.length}</span>
      <span data-testid="sent">{f.listingsSent.status}</span>
      <span data-testid="media">{f.media.status}</span>
    </div>
  );
}

const CASES: CasesPage = {
  nextCursor: null,
  cases: [{ caseId: 'a', tenantId: 'k1', unitId: 'u1', stage: 'touring' }],
};
const UNITS: UnitsPage = {
  nextCursor: null,
  units: [{ unitId: 'u1', landlordId: 'k1', status: 'available' }],
};

beforeEach(() => {
  getCases.mockReset();
  getUnits.mockReset();
  getContactListingsSent.mockReset();
  getContactMedia.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('useContactFile', () => {
  it('loads cases + units and marks C4/C5 pending on a 404', async () => {
    getCases.mockResolvedValue(CASES);
    getUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactMedia.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('cases').textContent).toBe('1');
    expect(screen.getByTestId('units').textContent).toBe('1');
    expect(screen.getByTestId('sent').textContent).toBe('pending');
    expect(screen.getByTestId('media').textContent).toBe('pending');
  });

  it('marks C4/C5 ready when those endpoints answer', async () => {
    getCases.mockResolvedValue(CASES);
    getUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockResolvedValue([]);
    getContactMedia.mockResolvedValue([]);

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('sent').textContent).toBe('ready');
    expect(screen.getByTestId('media').textContent).toBe('ready');
  });

  it('surfaces an error when cases fail', async () => {
    getCases.mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactMedia.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });
});
