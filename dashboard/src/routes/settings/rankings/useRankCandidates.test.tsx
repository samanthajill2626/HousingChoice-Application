import { render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAllUnits = vi.fn();
const getAllContacts = vi.fn();

vi.mock('../../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../api/index.js')>('../../../api/index.js');
  return {
    ...actual,
    getAllUnits: (...args: unknown[]) => getAllUnits(...args),
    getAllContacts: (...args: unknown[]) => getAllContacts(...args),
  };
});

import { useRankCandidates } from './useRankCandidates.js';

function Probe(): React.JSX.Element {
  const state = useRankCandidates();
  return createElement(
    'div',
    undefined,
    createElement('span', { 'data-testid': 'status' }, state.status),
    createElement('span', { 'data-testid': 'units' }, state.units.map((u) => u.unitId).join(',')),
    createElement('span', { 'data-testid': 'tenants' }, state.tenants.map((c) => c.contactId).join(',')),
  );
}

beforeEach(() => {
  getAllUnits.mockReset();
  getAllContacts.mockReset();
});

describe('useRankCandidates', () => {
  it('loads EVERY property and EVERY tenant (any record can be the anchor)', async () => {
    getAllUnits.mockResolvedValue([{ unitId: 'unit-1', status: 'occupied' }]);
    getAllContacts.mockResolvedValue([{ contactId: 'contact-1', type: 'tenant' }]);
    render(createElement(Probe));
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('units')).toHaveTextContent('unit-1');
    expect(screen.getByTestId('tenants')).toHaveTextContent('contact-1');
    expect(getAllUnits).toHaveBeenCalledWith({}, expect.any(AbortSignal));
    expect(getAllContacts).toHaveBeenCalledWith({ type: 'tenant' }, expect.any(AbortSignal));
  });

  it('reads error when either list fails', async () => {
    getAllUnits.mockRejectedValue(new Error('down'));
    getAllContacts.mockResolvedValue([]);
    render(createElement(Probe));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });
});
