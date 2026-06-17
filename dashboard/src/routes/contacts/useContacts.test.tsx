import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactsPage, ContactType } from '../../api/index.js';

const getContacts = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContacts: (...a: unknown[]) => getContacts(...a),
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

function page(...contacts: Contact[]): ContactsPage {
  return { contacts, nextCursor: null };
}

beforeEach(() => {
  getContacts.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('useContacts', () => {
  it('fetches just the tenant type for the tenant filter', async () => {
    getContacts.mockResolvedValue(page({ contactId: 't1', type: 'tenant' }));
    render(<Probe filter="tenant" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getContacts).toHaveBeenCalledTimes(1);
    expect((getContacts.mock.calls[0]?.[0] as { type: ContactType }).type).toBe('tenant');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('fans out across landlord + pm for the landlord filter and merges', async () => {
    getContacts.mockImplementation((params: { type: ContactType }) =>
      Promise.resolve(
        params.type === 'landlord'
          ? page({ contactId: 'l1', type: 'landlord' })
          : page({ contactId: 'p1', type: 'pm' }),
      ),
    );
    render(<Probe filter="landlord" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getContacts).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('count')).toHaveTextContent('2');
  });

  it('fans out across all audience types for the all filter', async () => {
    getContacts.mockImplementation((params: { type: ContactType }) =>
      Promise.resolve(page({ contactId: params.type, type: params.type })),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getContacts).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('count')).toHaveTextContent('4');
  });

  it('goes to the error state when a fetch fails', async () => {
    getContacts.mockRejectedValue(new Error('boom'));
    render(<Probe filter="tenant" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });
});
