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
const updateContact = vi.fn();
const getContacts = vi.fn();
const deleteContact = vi.fn();
const restoreContact = vi.fn();

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
    updateContact: (...a: unknown[]) => updateContact(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    deleteContact: (...a: unknown[]) => deleteContact(...a),
    restoreContact: (...a: unknown[]) => restoreContact(...a),
    // The page marks the contact read on view (useMarkContactRead) — stub it so
    // the tests don't fire a real fetch.
    markInboxRead: vi.fn(() => Promise.resolve()),
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

const UNKNOWN: Contact = {
  contactId: 'u9',
  type: 'unknown',
  status: 'needs_review',
  phone: '+15550100001',
};

const CASES: CasesPage = {
  nextCursor: null,
  cases: [{ caseId: 'c1', tenantId: 'k1', unitId: 'u1', stage: 'schedule_inspection' }],
};
const UNITS: UnitsPage = {
  nextCursor: null,
  units: [{ unitId: 'u1', landlordId: 'L1', status: 'available', beds: 2, address: '1450 Joseph Blvd' }],
};

// A second contact used in relationship-candidate tests.
const OTHER: Contact = {
  contactId: 'z99',
  type: 'tenant',
  firstName: 'Bob',
  lastName: 'Other',
  phone: '+14045550099',
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
  getContacts.mockReset();
  getCases.mockResolvedValue(CASES);
  getUnits.mockResolvedValue(UNITS);
  getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
  getConversations.mockResolvedValue({ nextCursor: null, conversations: [] });
  getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
  getContactMedia.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
  // Default: return a roster containing the current contact + OTHER so tests
  // that don't override still work (useContacts fans out to tenant/landlord/unknown).
  getContacts.mockResolvedValue({ nextCursor: null, contacts: [TENANT, OTHER] });
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

  it('flags a Do-Not-Contact (opted-out) contact with a header badge', async () => {
    getContact.mockResolvedValue({ ...TENANT, sms_opt_out: true });
    renderAt('k1');
    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());
    expect(screen.getByText(/Do Not Contact/i)).toBeInTheDocument();
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

  it('renders the Unknown treatment (Unknown pill + enabled triage CTA, no tenant cards) for an untriaged contact', async () => {
    getContact.mockResolvedValue(UNKNOWN);
    renderAt('u9');
    // Pill reads "Unknown", NOT "Tenant".
    await waitFor(() => expect(screen.getByText('Unknown')).toBeInTheDocument());
    expect(screen.queryByText('Tenant')).not.toBeInTheDocument();
    // Triage CTA present + ENABLED (wired to PATCH /api/contacts/:id { type }).
    expect(screen.getByRole('button', { name: /Mark as Tenant/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Mark as Landlord/i })).toBeEnabled();
    // None of the tenant-specific cards/fields leak in.
    expect(screen.queryByText('Voucher size')).not.toBeInTheDocument();
    expect(screen.queryByText('Housing authority')).not.toBeInTheDocument();
    expect(screen.queryByText('Listings sent')).not.toBeInTheDocument();
  });

  it('triages an Unknown contact: clicking "Mark as Tenant" PATCHes type and switches to the Tenant view', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(UNKNOWN);
    // The PATCH returns the now-tenant contact; the page applies it in place.
    updateContact.mockResolvedValue({ ...UNKNOWN, type: 'tenant', status: 'active' });
    renderAt('u9');

    await waitFor(() => expect(screen.getByText('Unknown')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Mark as Tenant/i }));

    expect(updateContact).toHaveBeenCalledWith('u9', { type: 'tenant' });
    // The view re-derives from the returned contact: pill flips to Tenant, the
    // tenant-only "Voucher size" field now shows, and the triage CTA is gone.
    await waitFor(() => expect(screen.getByText('Tenant')).toBeInTheDocument());
    expect(screen.getByText('Voucher size')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark as Tenant/i })).not.toBeInTheDocument();
  });

  it('shows an error state when the contact fails to load', async () => {
    getContact.mockRejectedValue(new ApiError(500, 'boom', 'x'));
    renderAt('k1');
    await waitFor(() =>
      expect(screen.getByText(/couldn.t load this contact/i)).toBeInTheDocument(),
    );
  });

  it('deleting confirms first, then DELETEs and navigates back to the Contacts list', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(TENANT);
    deleteContact.mockResolvedValue({ ...TENANT, deleted_at: '2026-06-19T00:00:00.000Z' });

    // Render with a /contacts landing route so we can assert the post-delete nav.
    render(
      <MemoryRouter initialEntries={['/contacts/k1']}>
        <Routes>
          <Route path="/contacts/:contactId" element={<ContactDetail />} />
          <Route path="/contacts" element={<div>CONTACTS LIST</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete contact/i }));

    // A confirm dialog appears — nothing deleted yet.
    expect(screen.getByRole('dialog', { name: /Delete contact\?/i })).toBeInTheDocument();
    expect(deleteContact).not.toHaveBeenCalled();

    // Confirm → DELETE fires and we land on the Contacts list.
    await user.click(screen.getByRole('button', { name: /^Delete$/i }));
    expect(deleteContact).toHaveBeenCalledWith('k1');
    await waitFor(() => expect(screen.getByText('CONTACTS LIST')).toBeInTheDocument());
  });

  it('shows the Deleted banner + Restore for a soft-deleted contact, and restores in place', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue({ ...TENANT, deleted_at: '2026-06-19T00:00:00.000Z' });
    restoreContact.mockResolvedValue(TENANT); // restored (no deleted_at)
    renderAt('k1');

    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());
    // Deleted treatment: a status banner is shown.
    expect(screen.getByRole('status')).toHaveTextContent(/deleted/i);

    // Restore (the banner button) → restoreContact called; banner clears in place.
    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    expect(restoreContact).toHaveBeenCalledWith('k1');
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  describe('edit dialog relationship candidates (finding #1 + #5)', () => {
    it('shows other contacts as relationship candidates in the edit dialog', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();

      // Roster: TENANT (k1, the contact being edited) + OTHER (z99, Bob Other).
      getContacts.mockResolvedValue({ nextCursor: null, contacts: [TENANT, OTHER] });
      getContact.mockResolvedValue(TENANT);
      renderAt('k1');

      // Wait for the contact to load.
      await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());

      // Open the edit dialog via the ⋯ actions menu → "Edit contact details".
      await user.click(screen.getByRole('button', { name: /More actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /edit contact details/i }));

      // The edit dialog is now open; expand the Relationships section.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Add relationship/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /Add relationship/i }));

      // Type "Bob" into the contact-search field — should match Bob Other.
      const searchInput = screen.getByRole('combobox', { name: /Contact search/i });
      await user.type(searchInput, 'Bob');

      // Bob Other must appear as a candidate option in the listbox.
      await waitFor(() =>
        expect(screen.getByRole('option', { name: /Bob Other/i })).toBeInTheDocument(),
      );
    });

    it('does NOT show the contact being edited as its own relationship candidate', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();

      // Roster includes TENANT itself (Tasha Williams) + OTHER.
      getContacts.mockResolvedValue({ nextCursor: null, contacts: [TENANT, OTHER] });
      getContact.mockResolvedValue(TENANT);
      renderAt('k1');

      await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());

      // Open edit dialog.
      await user.click(screen.getByRole('button', { name: /More actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /edit contact details/i }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Add relationship/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /Add relationship/i }));

      // Type "Tasha" — matches TENANT (the current contact) but it should be excluded.
      const searchInput = screen.getByRole('combobox', { name: /Contact search/i });
      await user.type(searchInput, 'Tasha');

      // Allow time for any async updates.
      await waitFor(() => expect(searchInput).toHaveValue('Tasha'));

      // No option for Tasha (the contact herself) must appear — self-link guard.
      expect(screen.queryByRole('option', { name: /Tasha Williams/i })).not.toBeInTheDocument();
    });
  });
});
