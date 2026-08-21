import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactType } from '../../api/index.js';

const getAllContacts = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
  };
});

import { useContacts, type ContactsFilter } from './useContacts.js';

function Probe({ filter }: { filter: ContactsFilter }): React.JSX.Element {
  const s = useContacts(filter);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.contacts.length}</span>
      <span data-testid="types">{s.contacts.map((c) => c.type).join(',')}</span>
    </div>
  );
}

function page(...contacts: Contact[]): Contact[] {
  return contacts;
}

beforeEach(() => {
  getAllContacts.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('useContacts', () => {
  it('fetches just the tenant type for the tenant filter', async () => {
    getAllContacts.mockResolvedValue(page({ contactId: 't1', type: 'tenant' }));
    render(<Probe filter="tenant" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getAllContacts).toHaveBeenCalledTimes(1);
    expect((getAllContacts.mock.calls[0]?.[0] as { type: ContactType }).type).toBe('tenant');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('fetches just the landlord type for the landlord filter', async () => {
    getAllContacts.mockResolvedValue(page({ contactId: 'l1', type: 'landlord' }));
    render(<Probe filter="landlord" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getAllContacts).toHaveBeenCalledTimes(1);
    expect((getAllContacts.mock.calls[0]?.[0] as { type: ContactType }).type).toBe('landlord');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('fans out across all audience types for the all filter', async () => {
    getAllContacts.mockImplementation((params: { type: ContactType }) =>
      Promise.resolve(page({ contactId: params.type, type: params.type })),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getAllContacts).toHaveBeenCalledTimes(4);
    const types = getAllContacts.mock.calls
      .map((c) => (c[0] as { type: ContactType }).type)
      .sort();
    expect(types).toEqual(['landlord', 'partner', 'tenant', 'unknown']);
    expect(screen.getByTestId('count')).toHaveTextContent('4');
  });

  it('fans out across audience types with deleted=true for the deleted filter', async () => {
    getAllContacts.mockImplementation((params: { type: ContactType; deleted?: boolean }) =>
      Promise.resolve(page({ contactId: params.type, type: params.type })),
    );
    render(<Probe filter="deleted" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getAllContacts).toHaveBeenCalledTimes(4);
    // Every fan-out call asks for ONLY soft-deleted records.
    for (const call of getAllContacts.mock.calls) {
      expect((call[0] as { deleted?: boolean }).deleted).toBe(true);
    }
    const types = getAllContacts.mock.calls.map((c) => (c[0] as { type: ContactType }).type).sort();
    expect(types).toEqual(['landlord', 'partner', 'tenant', 'unknown']);
  });

  it('does NOT request deleted records for the normal (all) filter', async () => {
    getAllContacts.mockImplementation((params: { type: ContactType }) =>
      Promise.resolve(page({ contactId: params.type, type: params.type })),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    for (const call of getAllContacts.mock.calls) {
      expect((call[0] as { deleted?: boolean }).deleted).toBe(false);
    }
  });

  it('goes to the error state when a fetch fails', async () => {
    getAllContacts.mockRejectedValue(new Error('boom'));
    render(<Probe filter="tenant" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });
});
