import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PlacementsPage, Contact, UnitsPage } from '../../api/index.js';

const getContact = vi.fn();
const getContactTimeline = vi.fn();
const getConversations = vi.fn();
const getConversationMessages = vi.fn();
const getPlacements = vi.fn();
const getUnits = vi.fn();
const getContactListingsSent = vi.fn();
const getContactMedia = vi.fn();
const updateContact = vi.fn();
const getContacts = vi.fn();
const deleteContact = vi.fn();
const restoreContact = vi.fn();
const sendMessage = vi.fn();
// Used by the "Start placement" dialog (PlacementCreateForm) when opened.
const getPlacementsBy = vi.fn();
const createPlacement = vi.fn();
// Used by the contact file's Tours card + the "Schedule a tour" dialog.
const getTours = vi.fn();
const createTour = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContact: (...a: unknown[]) => getContact(...a),
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getPlacements: (...a: unknown[]) => getPlacements(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getContactListingsSent: (...a: unknown[]) => getContactListingsSent(...a),
    getContactMedia: (...a: unknown[]) => getContactMedia(...a),
    updateContact: (...a: unknown[]) => updateContact(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    deleteContact: (...a: unknown[]) => deleteContact(...a),
    restoreContact: (...a: unknown[]) => restoreContact(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    getPlacementsBy: (...a: unknown[]) => getPlacementsBy(...a),
    createPlacement: (...a: unknown[]) => createPlacement(...a),
    getTours: (...a: unknown[]) => getTours(...a),
    createTour: (...a: unknown[]) => createTour(...a),
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

const CASES: PlacementsPage = {
  nextCursor: null,
  placements: [{ placementId: 'c1', tenantId: 'k1', unitId: 'u1', stage: 'schedule_inspection' }],
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
  getPlacements.mockReset();
  getUnits.mockReset();
  getContactListingsSent.mockReset();
  getContactMedia.mockReset();
  getContacts.mockReset();
  sendMessage.mockReset();
  updateContact.mockReset();
  getPlacementsBy.mockReset();
  getPlacementsBy.mockResolvedValue([]);
  getTours.mockReset();
  getTours.mockResolvedValue([]);
  createTour.mockReset();
  getPlacements.mockResolvedValue(CASES);
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

  it('renders the landlord file (Properties card) for a landlord', async () => {
    getContact.mockResolvedValue(LANDLORD);
    renderAt('L1');
    await waitFor(() => expect(screen.getByText('James Porter')).toBeInTheDocument());
    // The teal type pill (one of the two "Landlord" labels — header + Details).
    expect(screen.getAllByText('Landlord').length).toBeGreaterThanOrEqual(1);
    // The landlord's own unit shows in the Properties card.
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
    expect(screen.queryByText('Properties sent')).not.toBeInTheDocument();
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

  it('the Placements-card "Start placement" action opens the create dialog pre-filled+locked to this tenant', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(TENANT);
    renderAt('k1');

    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());

    // The action lives on the Placements card (tenant view only).
    await user.click(screen.getByRole('button', { name: 'Start a placement' }));

    const dialog = await screen.findByRole('dialog', { name: 'New placement' });
    // Tenant side is LOCKED (read-only label, NOT a combobox); the label resolves
    // to the contact's name. The Unit side stays an editable picker.
    expect(within(dialog).queryByRole('combobox', { name: 'Tenant' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Tenant')).toHaveTextContent('Tasha Williams'),
    );
    expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toBeInTheDocument();
  });

  it('the Tours-card "+ Schedule" action opens the Schedule-a-tour dialog locked to this tenant', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(TENANT);
    renderAt('k1');

    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());

    // The action lives on the Tours card (tenant view only) — it only renders
    // when ContactDetail wires onScheduleTour through to TenantFile.
    await user.click(screen.getByRole('button', { name: 'Schedule a tour' }));

    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    // Tenant side is LOCKED (read-only label, NOT a combobox); the label resolves
    // to the contact's name. The Unit side stays an editable picker.
    expect(within(dialog).queryByRole('combobox', { name: 'Tenant' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole('group', { name: 'Tenant' })).toHaveTextContent('Tasha Williams'),
    );
    expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Tour type' })).toBeInTheDocument();
  });

  it('the "Schedule a tour" action is NOT shown for a landlord contact', async () => {
    getContact.mockResolvedValue(LANDLORD);
    renderAt('L1');
    await waitFor(() => expect(screen.getByText('James Porter')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Schedule a tour' })).not.toBeInTheDocument();
  });

  it('the "Start placement" action is NOT shown for a landlord contact', async () => {
    getContact.mockResolvedValue(LANDLORD);
    renderAt('L1');
    await waitFor(() => expect(screen.getByText('James Porter')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Start a placement' })).not.toBeInTheDocument();
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

  // ── Just-in-time consent gate (§3.4) ────────────────────────────────────────
  describe('just-in-time consent gate', () => {
    // A server timeline with one prior outbound to the contact's number, so the
    // reply box resolves a conversation (canSend === true) and a send fires.
    const TIMELINE = {
      nextCursor: null,
      items: [
        {
          kind: 'message',
          id: 'm0',
          at: '2026-06-01T10:00:00.000Z',
          conversationId: 'conv-k1',
          tsMsgId: '2026-06-01T10:00:00.000Z#SM0',
          direction: 'outbound',
          author: 'teammate',
          type: 'sms',
          body: 'Hi',
          delivery_status: 'delivered',
          toPhone: '+14040100007',
        },
      ],
    };

    async function typeAndSend(user: ReturnType<typeof import('@testing-library/user-event').default.setup>, text: string): Promise<void> {
      const box = screen.getByLabelText('Reply message');
      await user.type(box, text);
      await user.click(screen.getByRole('button', { name: /^Send$/i }));
    }

    it('opens the consent modal on a 409 contact_no_consent, PATCHes consent, then retries the send', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      getContact.mockResolvedValue(TENANT);
      getContactTimeline.mockResolvedValue(TIMELINE);
      // First send is refused for no consent; after consent is recorded the retry succeeds.
      sendMessage
        .mockRejectedValueOnce(new ApiError(409, 'contact_no_consent', 'contact_no_consent'))
        .mockResolvedValueOnce({
          conversationId: 'conv-k1',
          providerSid: 'SM1',
          tsMsgId: '2026-06-02T10:00:00.000Z#SM1',
          status: 'sent',
        });
      updateContact.mockResolvedValue({ ...TENANT, consent_method: 'verbal_phone' });

      renderAt('k1');
      await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());

      await typeAndSend(user, 'Property that fits your voucher');

      // The hard-block modal appears.
      const dialog = await screen.findByRole('dialog', { name: /Record consent before texting/i });
      // Confirm is disabled until a method is chosen.
      const confirm = within(dialog).getByRole('button', { name: /Record consent & send/i });
      expect(confirm).toBeDisabled();

      await user.selectOptions(within(dialog).getByLabelText(/How did they consent/i), 'verbal_phone');
      expect(confirm).toBeEnabled();
      await user.click(confirm);

      // PATCH carried the human consent method + a consent_at.
      await waitFor(() => expect(updateContact).toHaveBeenCalled());
      const [id, patch] = updateContact.mock.calls[0]! as [string, Record<string, unknown>];
      expect(id).toBe('k1');
      expect(patch['consent_method']).toBe('verbal_phone');
      expect(typeof patch['consent_at']).toBe('string');

      // The original send was retried (sendMessage called twice) and the modal closed.
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
      expect(sendMessage.mock.calls[1]![0]).toBe('conv-k1');
      expect(sendMessage.mock.calls[1]![1]).toEqual({ body: 'Property that fits your voucher' });
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: /Record consent before texting/i })).not.toBeInTheDocument(),
      );
    });

    it('Cancel aborts the send (no PATCH, no retry) and the message stays in the box', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      getContact.mockResolvedValue(TENANT);
      getContactTimeline.mockResolvedValue(TIMELINE);
      sendMessage.mockRejectedValueOnce(new ApiError(409, 'contact_no_consent', 'contact_no_consent'));

      renderAt('k1');
      await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());

      await typeAndSend(user, 'A first proactive text');

      const dialog = await screen.findByRole('dialog', { name: /Record consent before texting/i });
      await user.click(within(dialog).getByRole('button', { name: /^Cancel$/i }));

      // No consent recorded, no retry; the drafted message is restored to the box.
      expect(updateContact).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: /Record consent before texting/i })).not.toBeInTheDocument(),
      );
      expect(screen.getByLabelText('Reply message')).toHaveValue('A first proactive text');
    });

    it('a normal successful send does NOT open the consent modal', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      getContact.mockResolvedValue(TENANT);
      getContactTimeline.mockResolvedValue(TIMELINE);
      sendMessage.mockResolvedValue({
        conversationId: 'conv-k1',
        providerSid: 'SM2',
        tsMsgId: '2026-06-03T10:00:00.000Z#SM2',
        status: 'sent',
      });

      renderAt('k1');
      await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());

      await typeAndSend(user, 'A consented reply');

      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(
        screen.queryByRole('dialog', { name: /Record consent before texting/i }),
      ).not.toBeInTheDocument();
      expect(updateContact).not.toHaveBeenCalled();
    });
  });
});
