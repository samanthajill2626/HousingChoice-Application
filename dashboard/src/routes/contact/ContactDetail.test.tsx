import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CasesPage, Contact, UnitsPage } from '../../api/index.js';

const getContact = vi.fn();
const getContactTimeline = vi.fn();
const getConversations = vi.fn();
const getConversationMessages = vi.fn();
const getCases = vi.fn();
const getUnits = vi.fn();
const getContactListingsSent = vi.fn();
const getContactMedia = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContact: (...a: unknown[]) => getContact(...a),
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getCases: (...a: unknown[]) => getCases(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getContactListingsSent: (...a: unknown[]) => getContactListingsSent(...a),
    getContactMedia: (...a: unknown[]) => getContactMedia(...a),
    useEventStream: () => {},
  };
});

import { ContactDetail } from './ContactDetail.js';

function renderAt(contactId: string) {
  return render(
    <MemoryRouter initialEntries={[`/contacts/${contactId}`]}>
      <Routes>
        <Route path="/contacts/:contactId" element={<ContactDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const TENANT: Contact = {
  contactId: 'k1',
  type: 'tenant',
  firstName: 'Tasha',
  lastName: 'Williams',
  voucherSize: 2,
  status: 'Active',
  phone: '+14040100007',
};

const LANDLORD: Contact = {
  contactId: 'L1',
  type: 'landlord',
  firstName: 'James',
  lastName: 'Porter',
  status: 'Active',
  phone: '+14042220190',
  company: 'Porter Properties',
};

const CASES: CasesPage = {
  nextCursor: null,
  cases: [{ caseId: 'c1', tenantId: 'k1', unitId: 'u1', stage: 'touring' }],
};
const UNITS: UnitsPage = {
  nextCursor: null,
  units: [{ unitId: 'u1', landlordId: 'L1', status: 'available', beds: 2, address: '1450 Joseph Blvd' }],
};

beforeEach(() => {
  getContact.mockReset();
  getContactTimeline.mockReset();
  getConversations.mockReset();
  getConversationMessages.mockReset();
  getCases.mockReset();
  getUnits.mockReset();
  getContactListingsSent.mockReset();
  getContactMedia.mockReset();
  getCases.mockResolvedValue(CASES);
  getUnits.mockResolvedValue(UNITS);
  getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
  getConversations.mockResolvedValue({ nextCursor: null, conversations: [] });
  getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
  getContactMedia.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
});
afterEach(() => vi.restoreAllMocks());

describe('ContactDetail', () => {
  it('renders the tenant header band with name, tenant pill, and facts', async () => {
    getContact.mockResolvedValue(TENANT);
    renderAt('k1');
    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());
    expect(screen.getByText('Tenant')).toBeInTheDocument();
    expect(screen.getByText(/Voucher 2BR/)).toBeInTheDocument();
    // The comms pane + reply box render.
    expect(screen.getByRole('region', { name: /Communications and activity/i })).toBeInTheDocument();
  });

  it('renders the landlord file (Listings card) for a landlord', async () => {
    getContact.mockResolvedValue(LANDLORD);
    renderAt('L1');
    await waitFor(() => expect(screen.getByText('James Porter')).toBeInTheDocument());
    // The teal type pill (one of the two "Landlord" labels — header + Details).
    expect(screen.getAllByText('Landlord').length).toBeGreaterThanOrEqual(1);
    // The landlord's own unit shows in the Listings card.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /1450 Joseph Blvd · 2BR/ })).toBeInTheDocument(),
    );
  });

  it('shows an error state when the contact fails to load', async () => {
    getContact.mockRejectedValue(new ApiError(500, 'boom', 'x'));
    renderAt('k1');
    await waitFor(() =>
      expect(screen.getByText(/couldn.t load this contact/i)).toBeInTheDocument(),
    );
  });
});
