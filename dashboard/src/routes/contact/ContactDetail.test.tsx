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
const setTenantStatus = vi.fn();
const getContacts = vi.fn();
const deleteContact = vi.fn();
const restoreContact = vi.fn();
const sendMessage = vi.fn();
const ensureContactConversation = vi.fn();
const ensureEmailConversation = vi.fn();
const sendEmail = vi.fn();
// Used by the "Start placement" dialog (PlacementCreateForm) when opened.
const getPlacementsBy = vi.fn();
const createPlacement = vi.fn();
// Used by the contact file's Tours card + the "Schedule a tour" dialog.
const getTours = vi.fn();
const createTour = vi.fn();
// Conversation-fact-extraction (T9): the review-UI endpoints.
const getSuggestions = vi.fn();
const acceptSuggestion = vi.fn();
const dismissSuggestion = vi.fn();

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
    setTenantStatus: (...a: unknown[]) => setTenantStatus(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    deleteContact: (...a: unknown[]) => deleteContact(...a),
    restoreContact: (...a: unknown[]) => restoreContact(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    ensureContactConversation: (...a: unknown[]) => ensureContactConversation(...a),
    ensureEmailConversation: (...a: unknown[]) => ensureEmailConversation(...a),
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    getPlacementsBy: (...a: unknown[]) => getPlacementsBy(...a),
    createPlacement: (...a: unknown[]) => createPlacement(...a),
    getTours: (...a: unknown[]) => getTours(...a),
    createTour: (...a: unknown[]) => createTour(...a),
    getSuggestions: (...a: unknown[]) => getSuggestions(...a),
    acceptSuggestion: (...a: unknown[]) => acceptSuggestion(...a),
    dismissSuggestion: (...a: unknown[]) => dismissSuggestion(...a),
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
  ensureContactConversation.mockReset();
  ensureEmailConversation.mockReset();
  sendEmail.mockReset();
  updateContact.mockReset();
  setTenantStatus.mockReset();
  getPlacementsBy.mockReset();
  getPlacementsBy.mockResolvedValue([]);
  getTours.mockReset();
  getTours.mockResolvedValue([]);
  createTour.mockReset();
  getSuggestions.mockReset();
  getSuggestions.mockResolvedValue([]);
  acceptSuggestion.mockReset();
  dismissSuggestion.mockReset();
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

  it('tenant status pill: lists the tenant lifecycle and changes it via the transition service', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue({ ...TENANT, status: 'searching' });
    setTenantStatus.mockResolvedValue({ ...TENANT, status: 'on_hold' });
    renderAt('k1');

    const pill = await screen.findByRole('button', { name: 'Contact status: Searching' });
    await user.click(pill);
    // The menu lists the TENANT lifecycle (7 values), current one checked.
    for (const label of ['Needs review', 'Onboarding', 'Searching', 'Placing', 'Placed', 'On hold', 'Inactive']) {
      expect(screen.getByRole('menuitemradio', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('menuitemradio', { name: 'Searching' })).toHaveAttribute('aria-checked', 'true');

    // Capture the timeline fetch count BEFORE the change lands so the debounced
    // post-change refetch can't race the baseline.
    const fetchesBeforeChange = getContactTimeline.mock.calls.length;
    await user.click(screen.getByRole('menuitemradio', { name: 'On hold' }));
    // The change goes through the transition service (NEVER a plain PATCH), and
    // the returned contact is applied in place — the pill re-labels.
    expect(setTenantStatus).toHaveBeenCalledWith('k1', { toStatus: 'on_hold', source: 'manual' });
    await screen.findByRole('button', { name: 'Contact status: On hold' });
    expect(updateContact).not.toHaveBeenCalled();

    // The transition wrote a contact_status_changed milestone server-side and no
    // SSE event covers it — the page must refetch the timeline ITSELF so the pin
    // appears immediately (behind the hook's 300ms debounce).
    await waitFor(() =>
      expect(getContactTimeline.mock.calls.length).toBeGreaterThan(fetchesBeforeChange),
    );
  });

  it('landlord status pill: lists the landlord lead lifecycle (never tenant values)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue({ ...LANDLORD, status: 'active' });
    renderAt('L1');

    const pill = await screen.findByRole('button', { name: 'Contact status: Active' });
    await user.click(pill);
    for (const label of ['Needs review', 'Interested', 'Onboarding', 'Active', 'Parked']) {
      expect(screen.getByRole('menuitemradio', { name: label })).toBeInTheDocument();
    }
    // Tenant-only values never leak into a landlord's menu.
    expect(screen.queryByRole('menuitemradio', { name: 'Searching' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'Placed' })).not.toBeInTheDocument();
  });

  it('landlord status pill: changing it PATCHes through the transition service and applies the result', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue({ ...LANDLORD, status: 'active' });
    setTenantStatus.mockResolvedValue({ ...LANDLORD, status: 'parked' });
    renderAt('L1');

    await user.click(await screen.findByRole('button', { name: 'Contact status: Active' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Parked' }));

    // The landlord value rides the SAME transition-service endpoint (it is
    // type-scoped server-side), never a plain contact PATCH.
    expect(setTenantStatus).toHaveBeenCalledWith('L1', { toStatus: 'parked', source: 'manual' });
    await screen.findByRole('button', { name: 'Contact status: Parked' });
    expect(updateContact).not.toHaveBeenCalled();
  });

  it('a soft-DELETED contact keeps the display-only status badge — no pill', async () => {
    getContact.mockResolvedValue({
      ...TENANT,
      status: 'placed',
      deleted_at: '2026-06-19T00:00:00.000Z',
    });
    renderAt('k1');
    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Contact status/i })).not.toBeInTheDocument();
    // The status still reads as a plain badge (header; may also echo in the
    // Details card, hence getAllByText).
    expect(screen.getAllByText('Placed').length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces an inline error when the status transition fails (pill keeps the stored status)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue({ ...TENANT, status: 'searching' });
    setTenantStatus.mockRejectedValue(new ApiError(400, 'bad_transition', 'nope'));
    renderAt('k1');

    await user.click(await screen.findByRole('button', { name: 'Contact status: Searching' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Inactive' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't update the status/i),
    );
    // Unchanged — the pill still shows the stored status.
    expect(screen.getByRole('button', { name: 'Contact status: Searching' })).toBeInTheDocument();
  });

  it('an untriaged (unknown) contact keeps the display-only status badge — no pill', async () => {
    getContact.mockResolvedValue(UNKNOWN);
    renderAt('u9');
    await waitFor(() => expect(screen.getByText('Unknown')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Contact status/i })).not.toBeInTheDocument();
    // The status still reads (display badge in the header + the Details row).
    expect(screen.getAllByText('Needs review').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the landlord file (Properties card) for a landlord', async () => {
    getContact.mockResolvedValue(LANDLORD);
    renderAt('L1');
    await waitFor(() => expect(screen.getByText('James Porter')).toBeInTheDocument());
    // The teal type pill (one of the two "Landlord" labels — header + Details).
    expect(screen.getAllByText('Landlord').length).toBeGreaterThanOrEqual(1);
    // The landlord's own unit shows in the Properties card.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /1450 Joseph Blvd - 2BR/ })).toBeInTheDocument(),
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

  it('accepts a voucher-size AI suggestion: applies the returned contact in place (value + Auto badge, chip gone)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue({ ...TENANT, voucherSize: 2 });
    getSuggestions.mockResolvedValue([
      {
        itemId: 'sugg#k1#voucherSize',
        ownerContactId: 'k1',
        target: 'voucherSize',
        currentValue: '2',
        suggestedValue: '3',
        reason: 'said a 3BR',
        conversationId: 'conv-1',
        createdAt: '2026-07-16T10:00:00.000Z',
      },
    ]);
    acceptSuggestion.mockResolvedValue({
      contact: { ...TENANT, voucherSize: 3, voucherSize_source: { source: 'ai', at: '2026-07-16T10:00:00.000Z' } },
      suggestions: [],
    });
    renderAt('k1');

    // Switch to the Profile pane so the file card (chips) is visible on narrow test widths.
    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());
    const chip = await screen.findByRole('group', { name: 'AI suggestion for voucher size' });
    expect(within(chip).getByText('AI heard "3"')).toBeInTheDocument();

    await user.click(within(chip).getByRole('button', { name: 'Accept' }));
    expect(acceptSuggestion).toHaveBeenCalledWith('k1', 'voucherSize');
    // The returned contact is applied in place: value shows 3 with the Auto badge; chip gone.
    await waitFor(() => expect(screen.getByText('3 BR')).toBeInTheDocument());
    expect(screen.getByRole('img', { name: 'Auto' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'AI suggestion for voucher size' })).not.toBeInTheDocument(),
    );
  });

  it('shows the Auto badge on the Current address row when address_source is ai', async () => {
    getContact.mockResolvedValue({
      ...TENANT,
      address: { line1: '1 Main St', city: 'Atlanta' },
      address_source: { source: 'ai', at: '2026-07-16T10:00:00.000Z' },
    });
    renderAt('k1');

    // The Current address row renders the formatted address + the Auto badge.
    expect(await screen.findByText('1 Main St, Atlanta')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Auto' })).toBeInTheDocument();
  });

  it('renders the current-address SuggestionChip and accepts it (forwards target "address")', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue({ ...TENANT, address: { line1: '9 Old Rd', city: 'Macon' } });
    getSuggestions.mockResolvedValue([
      {
        itemId: 'sugg#k1#address',
        ownerContactId: 'k1',
        target: 'address',
        currentValue: '9 Old Rd, Macon',
        suggestedValue: '1 Main St, Atlanta',
        reason: 'stated a new current address',
        conversationId: 'conv-1',
        createdAt: '2026-07-16T10:00:00.000Z',
      },
    ]);
    acceptSuggestion.mockResolvedValue({
      contact: {
        ...TENANT,
        address: { line1: '1 Main St', city: 'Atlanta' },
        address_source: { source: 'ai', at: '2026-07-16T10:00:00.000Z' },
      },
      suggestions: [],
    });
    renderAt('k1');

    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());
    const chip = await screen.findByRole('group', { name: 'AI suggestion for current address' });
    expect(within(chip).getByText('AI heard "1 Main St, Atlanta"')).toBeInTheDocument();

    await user.click(within(chip).getByRole('button', { name: 'Accept' }));
    expect(acceptSuggestion).toHaveBeenCalledWith('k1', 'address');
    // The returned contact applies in place: the row shows the new address + Auto badge; chip gone.
    await waitFor(() => expect(screen.getByText('1 Main St, Atlanta')).toBeInTheDocument());
    expect(screen.getByRole('img', { name: 'Auto' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'AI suggestion for current address' })).not.toBeInTheDocument(),
    );
  });

  it('renders a name SuggestionChip in the header and accepts it (firstName, tenant)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue({ ...TENANT, firstName: 'Tash' });
    getSuggestions.mockResolvedValue([
      {
        itemId: 'sugg#k1#firstName',
        ownerContactId: 'k1',
        target: 'firstName',
        currentValue: 'Tash',
        suggestedValue: 'Tasha',
        reason: 'gave full name',
        conversationId: 'conv-1',
        createdAt: '2026-07-16T10:00:00.000Z',
      },
    ]);
    acceptSuggestion.mockResolvedValue({
      contact: { ...TENANT, firstName: 'Tasha', firstName_source: { source: 'ai', at: '2026-07-16T10:00:00.000Z' } },
      suggestions: [],
    });
    renderAt('k1');

    // The chip surfaces under the header name (not a file-pane row), labelled "first name".
    const chip = await screen.findByRole('group', { name: 'AI suggestion for first name' });
    expect(within(chip).getByText('AI heard "Tasha"')).toBeInTheDocument();

    await user.click(within(chip).getByRole('button', { name: 'Accept' }));
    expect(acceptSuggestion).toHaveBeenCalledWith('k1', 'firstName');
    // The returned contact applies in place: the chip drops.
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'AI suggestion for first name' })).not.toBeInTheDocument(),
    );
  });

  it('renders name SuggestionChips for an UNKNOWN contact too (lastName)', async () => {
    getContact.mockResolvedValue(UNKNOWN);
    getSuggestions.mockResolvedValue([
      {
        itemId: 'sugg#u9#lastName',
        ownerContactId: 'u9',
        target: 'lastName',
        suggestedValue: 'Rivera',
        reason: 'signed off with a surname',
        conversationId: 'conv-2',
        createdAt: '2026-07-16T10:00:00.000Z',
      },
    ]);
    renderAt('u9');
    const chip = await screen.findByRole('group', { name: 'AI suggestion for last name' });
    expect(within(chip).getByText('AI heard "Rivera"')).toBeInTheDocument();
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

  it('the Schedule-a-tour dialog pre-commits the Unit to the LAST property sent', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(TENANT);
    getUnits.mockResolvedValue({
      nextCursor: null,
      units: [
        { unitId: 'u1', landlordId: 'L1', status: 'available', beds: 2, address: '1450 Joseph Blvd' },
        { unitId: 'u2', landlordId: 'L1', status: 'available', beds: 1, address: '88 Sycamore St' },
      ],
    });
    // The listings-sent wire order is newest-first by sentAt: u2 is the most
    // recent send, so the dialog should pre-commit to u2's address.
    getContactListingsSent.mockResolvedValue([
      { contactId: 'k1', unitId: 'u2', sentAt: '2026-07-13T15:00:00.000Z', via: 'broadcast' },
      { contactId: 'k1', unitId: 'u1', sentAt: '2026-07-01T15:00:00.000Z', via: 'broadcast' },
    ]);
    renderAt('k1');

    await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Schedule a tour' }));

    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toHaveValue('88 Sycamore St'),
    );
    // Committed like a hand pick — one Clear click returns to free search.
    expect(within(dialog).getByRole('button', { name: 'Clear Unit' })).toBeInTheDocument();
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

  // ── Texting a brand-new contact (no conversation yet) ───────────────────────
  describe('texting a brand-new contact', () => {
    it('Send is ENABLED with no thread; the first send creates the conversation, then POSTs into it', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      // Default beforeEach state: the timeline 404s and there are NO conversations
      // — exactly a just-created contact. The contact HAS a phone.
      getContact.mockResolvedValue(TENANT);
      ensureContactConversation.mockResolvedValue('conv-new');
      sendMessage.mockResolvedValue({
        conversationId: 'conv-new',
        providerSid: 'SM9',
        tsMsgId: '2026-07-02T10:00:00.000Z#SM9',
        status: 'sent',
      });

      renderAt('k1');
      await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());

      // The regression: with no resolvable conversation the Send button stayed
      // disabled forever. It must be ENABLED (the contact has a number).
      const box = screen.getByLabelText('Reply message');
      await user.type(box, 'Welcome aboard!');
      const send = screen.getByRole('button', { name: /^Send$/i });
      expect(send).toBeEnabled();

      await user.click(send);

      // The thread is created first, then the message goes into it.
      await waitFor(() => expect(ensureContactConversation).toHaveBeenCalledWith('k1'));
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(sendMessage.mock.calls[0]![0]).toBe('conv-new');
      expect(sendMessage.mock.calls[0]![1]).toEqual({ body: 'Welcome aboard!' });
    });

    it('does NOT create a thread when one already resolves from the timeline', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      getContact.mockResolvedValue(TENANT);
      getContactTimeline.mockResolvedValue({
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
      });
      sendMessage.mockResolvedValue({
        conversationId: 'conv-k1',
        providerSid: 'SM1',
        tsMsgId: '2026-06-02T10:00:00.000Z#SM1',
        status: 'sent',
      });

      renderAt('k1');
      await waitFor(() => expect(screen.getByText('Tasha Williams')).toBeInTheDocument());
      await user.type(screen.getByLabelText('Reply message'), 'Hello again');
      await user.click(screen.getByRole('button', { name: /^Send$/i }));

      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(sendMessage.mock.calls[0]![0]).toBe('conv-k1');
      expect(ensureContactConversation).not.toHaveBeenCalled();
    });
  });

  // ── Emailing an email-ONLY contact (M1) ─────────────────────────────────────
  describe('emailing an email-only contact', () => {
    it('a phoneless contact emails via ensureEmailConversation, NOT the phone ensure route', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      // An email-only PARTNER: no phone, one address on file, no existing thread.
      getContact.mockResolvedValue({
        contactId: 'p1',
        type: 'partner',
        firstName: 'Ed',
        lastName: 'Only',
        status: 'Active',
        emails: [{ email: 'ed@partner.example', primary: true }],
      });
      ensureEmailConversation.mockResolvedValue('conv-email');
      sendEmail.mockResolvedValue({
        conversationId: 'conv-email',
        tsMsgId: '2026-07-20T10:00:00.000Z#hc-x@mail.test',
        providerSid: 'hc-x@mail.test',
        sesMessageId: 'ses-1',
        emailMessageId: '<hc-x@mail.test>',
        status: 'sent',
        redirected: false,
      });

      renderAt('p1');
      await waitFor(() => expect(screen.getByText('Ed Only')).toBeInTheDocument());

      // Switch the composer to Email, fill Subject + Message, send.
      await user.click(screen.getByRole('button', { name: 'Email' }));
      await user.type(screen.getByLabelText('Subject'), 'Your documents');
      await user.type(screen.getByLabelText('Message'), 'Please see the info below.');
      await user.click(screen.getByRole('button', { name: 'Send email' }));

      // M1 fix: the email-conversation route creates the thread (the phone ensure
      // route is NOT used - it would 400 for a phoneless contact), then the send runs.
      await waitFor(() => expect(ensureEmailConversation).toHaveBeenCalledWith('p1'));
      expect(ensureContactConversation).not.toHaveBeenCalled();
      await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
      expect(sendEmail.mock.calls[0]![0]).toBe('conv-email');
      expect(sendEmail.mock.calls[0]![1]).toMatchObject({
        to: 'ed@partner.example',
        subject: 'Your documents',
      });
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
      // Regression: once the retry SENDS, the composer must clear — the draft was
      // restored on the 409 refusal, and the out-of-band retry has to re-clear it
      // (a plain successful send clears the box; this deferred one must too).
      await waitFor(() => expect(screen.getByLabelText('Reply message')).toHaveValue(''));
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

// Wrong-recipient guard (outbound MMS review finding, 2026-07-09): the
// /contacts/:contactId route re-renders the SAME ContactDetail instance on a
// contact-to-contact param change (no remount), so the composer's LOCAL state
// (the text draft AND the uploaded attachment chips) would leak into the next
// contact's composer - a Send would deliver contact A's media to contact B.
// The fix keys the Timeline by contactId; this pins the remount.
describe('composer isolation across contact-to-contact navigation', () => {
  it('clears the composer draft (and with it attachment chips) when the route param changes', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const { Link } = await import('react-router-dom');
    const user = userEvent.setup();
    getContact.mockImplementation((id: unknown) =>
      id === 'z99' ? Promise.resolve(OTHER) : Promise.resolve(TENANT),
    );
    render(
      <MemoryRouter initialEntries={['/contacts/k1']}>
        <Routes>
          <Route
            path="/contacts/:contactId"
            element={
              <>
                <Link to="/contacts/z99">NAV-TO-OTHER</Link>
                <ContactDetail />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Tasha Williams');
    const box = screen.getByRole('textbox', { name: 'Reply message' });
    await user.type(box, 'private note meant only for Tasha');
    expect(box).toHaveValue('private note meant only for Tasha');

    await user.click(screen.getByText('NAV-TO-OTHER'));
    await screen.findByText('Bob Other');

    // The keyed remount cleared the composer-local state; contact A's draft
    // (and any attachment chips, which ride the same local state) can never be
    // sent into contact B's conversation.
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');
  });
});
