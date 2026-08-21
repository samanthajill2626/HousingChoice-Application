import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Contact, PlacementItem, PlacementsPage, UnitItem, UnitsPage } from '../../api/index.js';

const getContact = vi.fn();
const getContactTimeline = vi.fn();
const getAllConversations = vi.fn();
const getConversationMessages = vi.fn();
const getAllPlacements = vi.fn();
const getAllUnits = vi.fn();
const getContactListingsSent = vi.fn();
const getContactMedia = vi.fn();
const updateContact = vi.fn();
const setTenantStatus = vi.fn();
const getAllContacts = vi.fn();
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
// Manual extraction trigger (Task 6): the press endpoint.
const runExtraction = vi.fn();
// The contact file's "Relay groups" card slice + the standalone create flow it
// launches (CreateRelayGroupModal).
const getContactRelayGroups = vi.fn();
const previewRelayGroup = vi.fn();
const createRelayGroup = vi.fn();
// The contact fan-out pair. `markInboxRead` used to be an anonymous vi.fn minted
// inside the mock factory, so no test could assert on it - S7's ordering test
// needs it hoisted, and `markInboxUnread` is its new sibling.
const markInboxRead = vi.fn();
const markInboxUnread = vi.fn();
// The nav badge's optimistic layer, spied so S7 can pin that NEITHER direction
// of the header toggle touches it: neither auto-read records a clear, so there
// is nothing to roll back. This file had no UnreadContext mock at all before.
const noteRowsCleared = vi.fn();
const rollbackRowsCleared = vi.fn();

vi.mock('../../app/UnreadContext.js', () => ({
  useUnread: () => ({ unread: null, unmatchedUnread: null, noteRowsCleared, rollbackRowsCleared }),
}));

// The handlers every useEventStream caller in this tree registers, MERGED.
// ContactDetail's subtree has five callers (useContact, useSuggestions,
// useContactTimeline, useMarkContactRead and the page's own ai_run.completed
// listener), so a stub that ASSIGNS is last-writer-wins and would leave
// onAiRunCompleted undefined - every resolution test would then silently no-op
// rather than fail loudly. Merging keeps one live handler per event name, each
// refreshed on every render.
let capturedHandlers: Record<string, ((e: unknown) => void) | undefined> = {};
// conversation.updated has TWO listeners here now (useContactTimeline's refetch
// tick and S7's derived unread state), and the merge above is still one slot per
// event NAME. Production registers each caller separately with the provider, so
// the fan-out below is what actually models it; handlers are useCallback-stable,
// so this Set holds one entry per caller.
const conversationUpdatedHandlers = new Set<(e: unknown) => void>();
// message.persisted likewise has several listeners (the timeline refetch, S7's
// mark-read, and useContactMedia's gallery refetch since 2026-08-18) - fanned
// out the same way so a test can deliver ONE event to all of them.
const messagePersistedHandlers = new Set<(e: unknown) => void>();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContact: (...a: unknown[]) => getContact(...a),
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getAllConversations: (...a: unknown[]) => getAllConversations(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getAllPlacements: (...a: unknown[]) => getAllPlacements(...a),
    getAllUnits: (...a: unknown[]) => getAllUnits(...a),
    getContactListingsSent: (...a: unknown[]) => getContactListingsSent(...a),
    getContactMedia: (...a: unknown[]) => getContactMedia(...a),
    updateContact: (...a: unknown[]) => updateContact(...a),
    setTenantStatus: (...a: unknown[]) => setTenantStatus(...a),
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
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
    runExtraction: (...a: unknown[]) => runExtraction(...a),
    getContactRelayGroups: (...a: unknown[]) => getContactRelayGroups(...a),
    previewRelayGroup: (...a: unknown[]) => previewRelayGroup(...a),
    createRelayGroup: (...a: unknown[]) => createRelayGroup(...a),
    // The page marks the contact read on view (useMarkContactRead) — stub it so
    // the tests don't fire a real fetch.
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
    markInboxUnread: (...a: unknown[]) => markInboxUnread(...a),
    useEventStream: (handlers: Record<string, ((e: unknown) => void) | undefined>) => {
      Object.assign(capturedHandlers, handlers);
      if (handlers['onConversationUpdated'] !== undefined) {
        conversationUpdatedHandlers.add(handlers['onConversationUpdated']);
      }
      if (handlers['onMessagePersisted'] !== undefined) {
        messagePersistedHandlers.add(handlers['onMessagePersisted']);
      }
    },
  };
});

import {
  ContactDetail,
  MARK_UNREAD_NO_THREAD,
  RUN_INDICATOR_TIMEOUT_MS,
} from './ContactDetail.js';

function renderAt(contactId: string) {
  return render(
    <MemoryRouter initialEntries={[`/contacts/${contactId}`]}>
      <Routes>
        <Route path="/contacts/:contactId" element={<ContactDetail />} />
        {/* D2's destination - "Mark unread" leaves for the inbox. */}
        <Route path="/inbox" element={<div>INBOX</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Deliver one conversation.updated to EVERY registered listener. */
function emitConversationUpdated(event: Record<string, unknown>): void {
  act(() => {
    for (const handler of [...conversationUpdatedHandlers]) handler(event);
  });
}

/** Deliver one message.persisted to EVERY registered listener. */
function emitMessagePersisted(event: Record<string, unknown>): void {
  act(() => {
    for (const handler of [...messagePersistedHandlers]) handler(event);
  });
}

/** Deliver one ai_run.completed to the page. The dispatch originates outside
 *  React's event system, so it is act-wrapped here: the resolution tests assert
 *  SYNCHRONOUSLY right after emitting. */
function emitRunCompleted(payload: Record<string, unknown>): void {
  act(() => {
    capturedHandlers['onAiRunCompleted']?.(payload);
  });
}

/** Open the kebab and press "Run AI extraction".
 *
 *  `fakeTimers` swaps user-event for the synchronous fireEvent. user-event is
 *  unusable under vitest's fake clock here: every one of its awaits goes through
 *  RTL's asyncWrapper, which flushes with a real-looking `setTimeout(resolve, 0)`
 *  and only knows how to nudge JEST fake timers past it - under vitest's the
 *  timer is faked, never advanced, and the click never returns. Passing
 *  user-event an `advanceTimers` option does not help, because the stuck await
 *  is RTL's, not user-event's. fireEvent is act-wrapped and synchronous, and
 *  these two buttons need no typing or pointer sequence. */
async function pressRun(opts: { fakeTimers?: boolean } = {}): Promise<void> {
  if (opts.fakeTimers === true) {
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /run ai extraction/i }));
    return;
  }
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  // The kebab does not exist during the loading early return (the page renders
  // only a Spinner), so every kebab test in this file waits for the contact
  // first.
  await screen.findByText('Tasha Williams');
  await user.click(screen.getByRole('button', { name: /more actions/i }));
  await user.click(screen.getByRole('menuitem', { name: /run ai extraction/i }));
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

const CASES: PlacementItem[] = [{ placementId: 'c1', tenantId: 'k1', unitId: 'u1', stage: 'schedule_inspection' }];
const UNITS: UnitItem[] = [{ unitId: 'u1', landlordId: 'L1', status: 'available', beds: 2, address: '1450 Joseph Blvd' }];

// One pending suggestion - the fixture the accept/dismiss FAILURE tests drive.
const PETS_SUGGESTION = {
  itemId: 'sugg#k1#pets',
  ownerContactId: 'k1',
  target: 'pets',
  suggestedValue: 'two cats',
  conversationId: 'conv-1',
  revision: 'rev-pets',
  runId: 'run-pets',
  createdAt: '2026-07-16T11:00:00.000Z',
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
  conversationUpdatedHandlers.clear();
  messagePersistedHandlers.clear();
  noteRowsCleared.mockReset();
  rollbackRowsCleared.mockReset();
  markInboxRead.mockReset().mockResolvedValue(undefined);
  markInboxUnread.mockReset().mockResolvedValue(undefined);
  getContact.mockReset();
  getContactTimeline.mockReset();
  getAllConversations.mockReset();
  getConversationMessages.mockReset();
  getAllPlacements.mockReset();
  getAllUnits.mockReset();
  getContactListingsSent.mockReset();
  getContactMedia.mockReset();
  getAllContacts.mockReset();
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
  getAllPlacements.mockResolvedValue(CASES);
  getAllUnits.mockResolvedValue(UNITS);
  getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
  getAllConversations.mockResolvedValue([]);
  getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
  // The gallery reads the media index (2026-08-18): an empty first page by default.
  getContactMedia.mockResolvedValue({ media: [] });
  // Same degrade-on-404 default as the sibling slices: the "Relay groups" card
  // renders its pending panel, exactly as it did before this slice was mocked.
  getContactRelayGroups.mockReset();
  getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
  previewRelayGroup.mockReset();
  createRelayGroup.mockReset();
  // Default: return a roster containing the current contact + OTHER so tests
  // that don't override still work (useContacts fans out to
  // tenant/landlord/partner/unknown).
  getAllContacts.mockResolvedValue([TENANT, OTHER]);
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
        revision: 'rev-voucher',
        runId: 'run-voucher',
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
    expect(acceptSuggestion).toHaveBeenCalledWith('k1', 'voucherSize', {
      revision: 'rev-voucher',
      createdAt: '2026-07-16T10:00:00.000Z',
      runId: 'run-voucher',
    });
    // The returned contact is applied in place: value shows 3 with the Auto badge; chip gone.
    await waitFor(() => expect(screen.getByText('3 BR')).toBeInTheDocument());
    expect(screen.getByRole('img', { name: 'Auto' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'AI suggestion for voucher size' })).not.toBeInTheDocument(),
    );
  });

  it('dismisses using the current suggestion immutable identity', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContact.mockResolvedValue(TENANT);
    getSuggestions.mockResolvedValue([{
      itemId: 'sugg#k1#pets',
      ownerContactId: 'k1',
      target: 'pets',
      suggestedValue: 'two cats',
      conversationId: 'conv-1',
      revision: 'rev-pets',
      runId: 'run-pets',
      createdAt: '2026-07-16T11:00:00.000Z',
    }]);
    dismissSuggestion.mockResolvedValue([]);
    renderAt('k1');

    const chip = await screen.findByRole('group', { name: 'AI suggestion for pets' });
    await user.click(within(chip).getByRole('button', { name: 'Dismiss' }));

    expect(dismissSuggestion).toHaveBeenCalledWith('k1', 'pets', {
      revision: 'rev-pets',
      createdAt: '2026-07-16T11:00:00.000Z',
      runId: 'run-pets',
    });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'AI suggestion for pets' })).not.toBeInTheDocument());
  });

  // The resolution routes answer with a whole vocabulary of codes (400/404/409),
  // and ApiError.message is the RAW code - every failure must reach the chip the
  // navigator clicked as its own honest sentence, never the phone-conflict copy
  // and never silence.
  describe('suggestion accept/dismiss failures', () => {
    async function clickChip(action: 'Accept' | 'Dismiss'): Promise<HTMLElement> {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      getContact.mockResolvedValue(TENANT);
      getSuggestions.mockResolvedValue([PETS_SUGGESTION]);
      renderAt('k1');
      const chip = await screen.findByRole('group', { name: 'AI suggestion for pets' });
      await user.click(within(chip).getByRole('button', { name: action }));
      return chip;
    }

    it('shows the replaced-suggestion copy on a 409 suggestion_replaced accept, not the phone sentence', async () => {
      acceptSuggestion.mockRejectedValue(new ApiError(409, 'suggestion_replaced', 'suggestion_replaced'));
      const chip = await clickChip('Accept');

      const alert = await within(chip).findByRole('alert');
      expect(alert).toHaveTextContent(
        'That suggestion changed since this page loaded - refresh and review the new one.',
      );
      expect(alert).not.toHaveTextContent('That number already belongs to another contact.');
      // The chip stays put and re-enables for a retry.
      expect(within(chip).getByRole('button', { name: 'Accept' })).toBeEnabled();
    });

    it('surfaces a failed DISMISS instead of swallowing it', async () => {
      dismissSuggestion.mockRejectedValue(
        new ApiError(409, 'suggestion_already_resolved', 'suggestion_already_resolved'),
      );
      const chip = await clickChip('Dismiss');

      const alert = await within(chip).findByRole('alert');
      expect(alert).toHaveTextContent('That suggestion was already accepted or dismissed');
      expect(within(chip).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    });

    it('surfaces a 400 accept refusal instead of re-enabling the chip in silence', async () => {
      acceptSuggestion.mockRejectedValue(
        new ApiError(400, 'invalid_suggestion_value', 'invalid_suggestion_value'),
      );
      const chip = await clickChip('Accept');

      const alert = await within(chip).findByRole('alert');
      expect(alert).toHaveTextContent('could not be used');
      expect(alert.textContent ?? '').not.toContain('invalid_suggestion_value');
    });

    it('falls back to the generic sentence for a code this build has never heard of', async () => {
      acceptSuggestion.mockRejectedValue(new ApiError(409, 'a_brand_new_server_code', 'a_brand_new_server_code'));
      const chip = await clickChip('Accept');

      const alert = await within(chip).findByRole('alert');
      expect(alert).toHaveTextContent('Something went wrong - please try again.');
      expect(alert.textContent ?? '').not.toContain('a_brand_new_server_code');
    });

    it('answers the not-pending rejection with copy AND refetches so the stale chip corrects itself', async () => {
      // useSuggestions rejects with this exact plain Error (not an ApiError) when
      // the target is no longer in its list; the value reaching this catch is the
      // same whether the hook or the request produced it.
      acceptSuggestion.mockRejectedValue(new Error('Suggestion is no longer pending'));
      const chip = await clickChip('Accept');

      const alert = await within(chip).findByRole('alert');
      expect(alert).toHaveTextContent('That suggestion is no longer pending');
      // One fetch on mount, one from the refetch this failure triggers.
      await waitFor(() => expect(getSuggestions).toHaveBeenCalledTimes(2));
    });

    // The SERVER answers these three with a list that has genuinely moved on:
    // two of them PROMISE "the list now shows its real state", and a refused
    // accept has already deleted the row. The server does emit
    // `suggestion.updated` for a helped commit and for the refused accept (the
    // helped-or-refused emit in the suggestions router's shared error path),
    // but an SSE is asynchronous and not guaranteed to reach THIS tab before
    // the operator looks - the refetch is what makes the answer true here.
    it.each([
      ['no_pending_suggestion', 404],
      ['suggestion_already_resolved', 409],
      ['suggestion_field_edited', 409],
    ])('refetches on a SERVER %s so the list really does show its real state', async (code, httpStatus) => {
      acceptSuggestion.mockRejectedValue(new ApiError(httpStatus, code, code));
      const chip = await clickChip('Accept');

      // The message is state on this page, not a field of the refetched list, so
      // it is still there after the correction lands.
      const alert = await within(chip).findByRole('alert');
      expect(alert.textContent ?? '').not.toContain('_');
      // One fetch on mount, one from the refetch this failure must trigger.
      await waitFor(() => expect(getSuggestions).toHaveBeenCalledTimes(2));
      expect(await within(chip).findByRole('alert')).toBeInTheDocument();
    });

    it('does NOT refetch on the in-flight codes, whose copy promises nothing about the list', async () => {
      acceptSuggestion.mockRejectedValue(
        new ApiError(409, 'suggestion_resolution_in_progress', 'suggestion_resolution_in_progress'),
      );
      const chip = await clickChip('Accept');

      const alert = await within(chip).findByRole('alert');
      expect(alert).toHaveTextContent('try again in a moment');
      expect(getSuggestions).toHaveBeenCalledTimes(1);
    });
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
    expect(acceptSuggestion).toHaveBeenCalledWith('k1', 'address', {
      revision: undefined,
      createdAt: '2026-07-16T10:00:00.000Z',
      runId: undefined,
    });
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
    expect(acceptSuggestion).toHaveBeenCalledWith('k1', 'firstName', {
      revision: undefined,
      createdAt: '2026-07-16T10:00:00.000Z',
      runId: undefined,
    });
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
    getAllUnits.mockResolvedValue([
        { unitId: 'u1', landlordId: 'L1', status: 'available', beds: 2, address: '1450 Joseph Blvd' },
        { unitId: 'u2', landlordId: 'L1', status: 'available', beds: 1, address: '88 Sycamore St' },
      ]);
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
      getAllContacts.mockResolvedValue([TENANT, OTHER]);
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
      getAllContacts.mockResolvedValue([TENANT, OTHER]);
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

  // --- The standalone relay-group create, from the Relay groups card --------
  describe('creating a relay group from the Relay groups card', () => {
    const NEW_GROUP = {
      conversationId: 'conv-new',
      status: 'open' as const,
      poolNumber: '+15550190002',
      memberCount: 2,
      lastActivityAt: '2026-08-17T10:00:00.000Z',
      owner: { type: null },
      otherMemberNames: ['Bob Other'],
    };

    it('a CONNECTING create refreshes the card behind the panel', async () => {
      // The connecting branch deliberately does not navigate, so the operator is
      // left on this page. The card fetched its rows once, on mount, and no SSE
      // handler here listens for conversation.updated - so without the refetch
      // it still reads "No relay groups yet." over a group that exists, and a
      // retry buys a second pool number.
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      getContact.mockResolvedValue(TENANT);
      // What the SERVER holds right now. The card's own fetch runs more than
      // once on mount anyway (contactType arrives after the contact does), so a
      // call COUNT proves nothing on its own - the row is added to the server's
      // answer only when the create lands, and the card can then show it only
      // if something asks again.
      let serverGroups: (typeof NEW_GROUP)[] = [];
      getContactRelayGroups.mockImplementation(() => Promise.resolve(serverGroups));
      previewRelayGroup.mockResolvedValue({
        body: 'You are connected on this number. Reply STOP to opt out.',
        recipients: [
          { name: 'Tasha Williams', reachability: 'reachable' },
          { name: 'Bob Other', reachability: 'reachable' },
        ],
        recipientCount: 2,
        deferred: false,
      });
      createRelayGroup.mockResolvedValue({
        conversation: { conversationId: 'conv-new', type: 'relay_group', status: 'connecting' },
      });

      renderAt('k1');
      await screen.findByText('Tasha Williams');
      await screen.findByText('No relay groups yet.');

      await user.click(screen.getByRole('button', { name: 'Create a relay group' }));
      await user.type(screen.getByRole('combobox', { name: 'Add member' }), 'Bob');
      await user.click(screen.getByRole('option', { name: /Bob Other/i }));
      await user.click(screen.getByRole('button', { name: 'Create group' }));

      // The create is about to succeed: from here the server has the row.
      serverGroups = [NEW_GROUP];
      const callsBeforeCreate = getContactRelayGroups.mock.calls.length;
      await user.click(await screen.findByRole('button', { name: 'Open relay group' }));

      // The panel says the intro has not gone out...
      expect(await screen.findByText(/The intro text has not been sent yet/)).toBeInTheDocument();
      // ...and the card BEHIND it now lists the group instead of denying it.
      expect(await screen.findByText('With Bob Other')).toBeInTheDocument();
      expect(screen.queryByText('No relay groups yet.')).not.toBeInTheDocument();
      expect(getContactRelayGroups.mock.calls.length).toBeGreaterThan(callsBeforeCreate);
    });

    it('offers the Create action on a live contact and NOT on a soft-deleted one', async () => {
      // The comms pane deliberately locks its composer for a deleted contact
      // (the server refuses with 409 contact_deleted), so a card action that
      // texts them anyway is the same page contradicting itself - and the relay
      // send path has no deleted-contact gate of its own: `isMemberSuppressed`
      // tests sms_opt_out and per-phone STOP only. Native group sends refuse for
      // exactly this reason.
      getContact.mockResolvedValue(TENANT);
      getContactRelayGroups.mockResolvedValue([]);
      const { unmount } = renderAt('k1');
      await screen.findByText('Tasha Williams');
      expect(
        await screen.findByRole('button', { name: 'Create a relay group' }),
      ).toBeInTheDocument();
      unmount();

      getContact.mockResolvedValue({ ...TENANT, deleted_at: '2026-06-19T00:00:00.000Z' });
      renderAt('k1');
      await screen.findByText('Tasha Williams');
      // The card itself still renders - only the action is withheld.
      await screen.findByText('No relay groups yet.');
      expect(screen.queryByRole('button', { name: 'Create a relay group' })).toBeNull();
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

  // --- Emailing an email-only contact (M1) ---
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

  // Manual extraction trigger (spec 4.6). The status region is the operator's
  // ONLY feedback that the press did anything, so all three of its states -
  // pressed, resolved, timed out - are pinned here. It carries
  // aria-label="AI extraction" so these queries can never match a Spinner
  // (ui/Spinner.tsx also uses role="status").
  describe('Run AI extraction', () => {
    beforeEach(() => {
      // The outer beforeEach resets ~20 mocks but never seeds getContact, and it
      // does not know about runExtraction at all - without the reset a
      // mockRejectedValue from the refusal rows leaks into the next test.
      getContact.mockResolvedValue(TENANT);
      runExtraction.mockReset();
      runExtraction.mockResolvedValue({ requestId: 'req-1', scheduled: ['conv-a'], failed: [] });
      capturedHandlers = {};
    });

    // A test that TIMES OUT never reaches its own `finally`, so fake timers
    // would leak into every later test and wedge waitFor. Belt and braces.
    afterEach(() => {
      vi.useRealTimers();
    });

    it('enters a running state on press', async () => {
      renderAt('k1');
      await pressRun();
      expect(await screen.findByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /running ai extraction/i,
      );
      expect(runExtraction).toHaveBeenCalledWith('k1');
    });

    it('names the thread count when more than one was scheduled', async () => {
      runExtraction.mockResolvedValue({
        requestId: 'req-1',
        scheduled: ['conv-a', 'conv-b'],
        failed: [],
      });
      renderAt('k1');
      await pressRun();
      expect(await screen.findByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /running ai extraction on 2 threads/i,
      );
    });

    it('keeps naming the SCHEDULED count after some threads have reported', async () => {
      // The count names `scheduled` (4.6 state 1), not what is left: reading it
      // off the pending set would drop "on 3 threads" back to a bare "Running
      // AI extraction..." as soon as one thread reported, which reads to the
      // operator as the run having shrunk.
      runExtraction.mockResolvedValue({
        requestId: 'req-1',
        scheduled: ['conv-a', 'conv-b', 'conv-c'],
        failed: [],
      });
      renderAt('k1');
      await pressRun();
      expect(await screen.findByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /running ai extraction on 3 threads/i,
      );
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 1,
        suggested: 0,
        notedLines: 0,
      });
      expect(screen.getByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /running ai extraction on 3 threads/i,
      );
    });

    it('disables the item against a second press', async () => {
      renderAt('k1');
      await pressRun();
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /more actions/i }));
      expect(screen.getByRole('menuitem', { name: /run ai extraction/i })).toBeDisabled();
      expect(runExtraction).toHaveBeenCalledTimes(1);
    });

    it('times out to the still-running copy when no event arrives', async () => {
      // Fake-timer idiom per RemindersPanel.test.tsx:293-306 and test/setup.ts:
      // the global Date pin must be released BEFORE useFakeTimers (vitest throws
      // a self-explanatory error otherwise) and every flush goes through
      // advanceTimersByTimeAsync inside act. The press itself drops user-event
      // for fireEvent - see pressRun for why user-event cannot survive vitest's
      // fake clock under RTL.
      vi.useRealTimers();
      vi.useFakeTimers();
      try {
        renderAt('k1');
        // Flush the mount fetches so the kebab exists (the contact fetch and the
        // file/timeline fan-out are chained promises, hence more than one tick).
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        await pressRun({ fakeTimers: true });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(RUN_INDICATOR_TIMEOUT_MS + 1);
        });
        // Synchronous assert: the state change already flushed inside act, and
        // findByRole's polling is itself timer-based under fake timers.
        expect(screen.getByRole('status', { name: /ai extraction/i })).toHaveTextContent(
          /still running/i,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves to the applied copy', async () => {
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 2,
        suggested: 1,
        notedLines: 0,
      });
      expect(await screen.findByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /updated 2 fields, 1 suggestion/i,
      );
    });

    // Handback review (adversarial, MEDIUM): the job counts notedLines toward
    // `applied`, so a note-only run is a REAL outcome and "nothing new to
    // extract" would contradict the run log the banner points people at.
    it('a note-only run says notes were added, not nothing-new', async () => {
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 0,
        suggested: 0,
        notedLines: 3,
      });
      const resolved = await screen.findByRole('status', { name: /ai extraction/i });
      expect(resolved).toHaveTextContent(/added 3 note lines/i);
      expect(resolved).not.toHaveTextContent(/nothing new/i);
    });

    // Handback review R2 (adversarial): the first fix named notes ONLY when
    // nothing else landed, so the success banner reported less than the
    // failure banner about the same run. Notes ride every branch.
    it('names the note lines even when fields also changed', async () => {
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 2,
        suggested: 0,
        notedLines: 3,
      });
      expect(await screen.findByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /updated 2 fields, 3 note lines added\./i,
      );
    });

    // Handback review (adversarial, MEDIUM): one thread failing must not erase
    // what the other threads already did - those writes are committed and
    // billed whether or not the banner mentions them.
    it('a failed thread does not erase the other threads results', async () => {
      runExtraction.mockResolvedValue({
        requestId: 'req-1',
        scheduled: ['conv-a', 'conv-b'],
        failed: [],
      });
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 2,
        suggested: 1,
        notedLines: 0,
      });
      emitRunCompleted({
        conversationId: 'conv-b',
        runId: 'r2',
        requestId: 'req-1',
        outcome: 'failed',
        errorKind: 'driver',
        wrote: 0,
        suggested: 0,
        notedLines: 0,
      });
      const resolved = await screen.findByRole('alert', { name: /ai extraction/i });
      expect(resolved).toHaveTextContent(/extraction failed/i);
      expect(resolved).toHaveTextContent(/2 fields updated/i);
      expect(resolved).toHaveTextContent(/1 suggestion to review/i);
    });

    // Handback review (adversarial, MEDIUM): an event that beats the POST
    // response used to be dropped - the state machine ignores events while
    // requestId is '' - leaving the 180s timeout as the only resolution. The
    // handler now records recent events and the press replays the ones carrying
    // its requestId once the response names it.
    it('an event that beats the POST response still resolves the indicator', async () => {
      let resolvePost!: (v: { requestId: string; scheduled: string[]; failed: string[] }) => void;
      runExtraction.mockImplementation(
        () => new Promise((resolve) => { resolvePost = resolve; }),
      );
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      // The run's event arrives while the POST is still in flight.
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 1,
        suggested: 0,
        notedLines: 0,
      });
      await act(async () => {
        resolvePost({ requestId: 'req-1', scheduled: ['conv-a'], failed: [] });
      });
      expect(await screen.findByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /updated 1 field\./i,
      );
    });

    // Found by live self-QA, not by a unit test: this is the COMMON success
    // shape for this feature's target data, because a manual run waives the age
    // floor and one unknown-speaker line demotes every write to a suggestion
    // (design 8). It must not read "Updated 0 fields, 1 suggestion."
    it('never claims it updated 0 fields when everything was suggested', async () => {
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 0,
        suggested: 1,
        notedLines: 0,
      });
      const resolved = await screen.findByRole('status', { name: /ai extraction/i });
      expect(resolved).toHaveTextContent(/1 suggestion to review\./i);
      expect(resolved).not.toHaveTextContent(/updated 0 fields/i);
    });

    it('says nothing-new for a skipped run', async () => {
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'skipped',
        skipReason: 'no_new_client',
        wrote: 0,
        suggested: 0,
        notedLines: 0,
      });
      expect(await screen.findByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /nothing new to extract/i,
      );
    });

    it('gives a truncated failure its own actionable copy', async () => {
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'failed',
        errorKind: 'truncated',
        wrote: 0,
        suggested: 0,
        notedLines: 0,
      });
      expect(await screen.findByRole('alert', { name: /ai extraction/i })).toHaveTextContent(
        /ran out of room/i,
      );
    });

    it('waits for EVERY scheduled thread, including when one fails', async () => {
      runExtraction.mockResolvedValue({
        requestId: 'req-1',
        scheduled: ['conv-a', 'conv-b'],
        failed: [],
      });
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'failed',
        errorKind: 'driver',
        wrote: 0,
        suggested: 0,
        notedLines: 0,
      });
      expect(screen.getByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /running ai extraction/i,
      );
      emitRunCompleted({
        conversationId: 'conv-b',
        runId: 'r2',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 1,
        suggested: 0,
        notedLines: 0,
      });
      expect(await screen.findByRole('alert', { name: /ai extraction/i })).toHaveTextContent(
        /extraction failed/i,
      );
    });

    it('IGNORES an event carrying a different requestId', async () => {
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'someone-else',
        outcome: 'applied',
        wrote: 9,
        suggested: 9,
        notedLines: 0,
      });
      expect(screen.getByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /running ai extraction/i,
      );
    });

    // Handback review R2 (adversarial): a matching requestId with a different
    // contactId is THIS press's run, resolved by the job to another contact -
    // the conversation's participant pointer diverges from the phone roster,
    // a reachable state under the documented phone-curation flow. The facts
    // landed on that record and billed; the old behavior (ignore, spin, 180s
    // timeout) hid a committed write. It must resolve and say where they went,
    // and must NOT report the counts as if they landed on this record.
    it('resolves a mismatched-contact event as misfiled instead of spinning', async () => {
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        contactId: 'someone-else',
        outcome: 'applied',
        wrote: 9,
        suggested: 9,
        notedLines: 0,
      });
      const resolved = await screen.findByRole('alert', { name: /ai extraction/i });
      expect(resolved).toHaveTextContent(/filed under a different contact/i);
      expect(resolved).not.toHaveTextContent(/9 field/i);
      expect(resolved).not.toHaveTextContent(/9 suggestion/i);
    });

    it('IGNORES an event for a thread the server could not queue', async () => {
      // A thread in `failed[]` has no run coming, so counting its event would
      // let the resolved banner report results from a thread the same sentence
      // says was never queued.
      runExtraction.mockResolvedValue({
        requestId: 'req-1',
        scheduled: ['conv-a'],
        failed: ['conv-b'],
      });
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-b',
        runId: 'r-unqueued',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 7,
        suggested: 7,
        notedLines: 0,
      });
      expect(screen.getByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /running ai extraction/i,
      );
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 1,
        suggested: 0,
        notedLines: 0,
      });
      const resolved = await screen.findByRole('status', { name: /ai extraction/i });
      // 1 field, not 8: the unqueued thread's counts never joined the total.
      expect(resolved).toHaveTextContent(/updated 1 field\./i);
      expect(resolved).toHaveTextContent(/1 thread could not be queued/i);
    });

    it('reports threads that could not be queued', async () => {
      runExtraction.mockResolvedValue({
        requestId: 'req-1',
        scheduled: ['conv-a'],
        failed: ['conv-b'],
      });
      renderAt('k1');
      await pressRun();
      expect(await screen.findByRole('status', { name: /ai extraction/i })).toHaveTextContent(
        /1 thread could not be queued/i,
      );
    });

    it('still reports the unqueued threads once the run RESOLVES', async () => {
      // A thread that was never queued is one no run is coming for. Dropping it
      // at resolution would leave the operator with an outcome that silently
      // omits a thread the running banner had already told them about.
      runExtraction.mockResolvedValue({
        requestId: 'req-1',
        scheduled: ['conv-a'],
        failed: ['conv-b'],
      });
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 1,
        suggested: 0,
        notedLines: 0,
      });
      const resolved = await screen.findByRole('status', { name: /ai extraction/i });
      expect(resolved).toHaveTextContent(/updated 1 field/i);
      expect(resolved).toHaveTextContent(/1 thread could not be queued/i);
    });

    it('carries the unqueued threads into a FAILED resolution too', async () => {
      runExtraction.mockResolvedValue({
        requestId: 'req-1',
        scheduled: ['conv-a'],
        failed: ['conv-b', 'conv-c'],
      });
      renderAt('k1');
      await pressRun();
      await screen.findByRole('status', { name: /ai extraction/i });
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'failed',
        errorKind: 'driver',
        wrote: 0,
        suggested: 0,
        notedLines: 0,
      });
      const resolved = await screen.findByRole('alert', { name: /ai extraction/i });
      expect(resolved).toHaveTextContent(/extraction failed/i);
      expect(resolved).toHaveTextContent(/2 threads could not be queued/i);
    });

    it('a press that RESOLVES after the operator navigated away leaves the next contact alone', async () => {
      // The /contacts/:contactId route re-renders the SAME instance on a param
      // change, and the POST resolves on its own clock. Without the press guard
      // contact A's response writes contact B's page: B's banner reads "Running
      // AI extraction...", B's kebab item is disabled, and A's outcome later
      // renders on B - a money-spending action reporting an update to a record
      // it never touched.
      const { default: userEvent } = await import('@testing-library/user-event');
      const { Link } = await import('react-router-dom');
      const user = userEvent.setup();
      getContact.mockImplementation((id: unknown) =>
        id === 'z99' ? Promise.resolve(OTHER) : Promise.resolve(TENANT),
      );
      let settle: ((v: { requestId: string; scheduled: string[]; failed: string[] }) => void) | undefined;
      runExtraction.mockReturnValue(
        new Promise<{ requestId: string; scheduled: string[]; failed: string[] }>((resolve) => {
          settle = resolve;
        }),
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
      await pressRun();
      expect(screen.getByRole('status', { name: /ai extraction/i })).toBeInTheDocument();

      await user.click(screen.getByText('NAV-TO-OTHER'));
      await screen.findByText('Bob Other');

      // A's POST answers now, on B's page.
      await act(async () => {
        settle?.({ requestId: 'req-1', scheduled: ['conv-a'], failed: [] });
        await Promise.resolve();
      });
      expect(screen.queryByRole('status', { name: /ai extraction/i })).not.toBeInTheDocument();

      // ...and A's completion cannot resolve anything on B either.
      emitRunCompleted({
        conversationId: 'conv-a',
        runId: 'r1',
        requestId: 'req-1',
        outcome: 'applied',
        wrote: 2,
        suggested: 1,
        notedLines: 0,
      });
      expect(screen.queryByRole('status', { name: /ai extraction/i })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /more actions/i }));
      expect(screen.getByRole('menuitem', { name: /run ai extraction/i })).toBeEnabled();
    });

    it.each([
      ['extraction_disabled', /turned off/i],
      ['ineligible_contact_type', /only tenants and untriaged/i],
      ['contact_deleted', /deleted contact/i],
      ['contact_not_found', /could not be found/i],
      ['no_conversations', /no conversations/i],
      ['no_eligible_conversations', /no eligible conversations/i],
      ['schedule_failed', /could not be started/i],
    ])('renders its own copy for %s', async (code, copy) => {
      // A REAL ApiError: the copy helper gates on `instanceof ApiError`
      // (dashboard/src/api/client.ts:11), so a plain Error carrying a `code`
      // property falls through to the default and five of these six rows fail.
      runExtraction.mockRejectedValue(new ApiError(409, code, 'refused'));
      renderAt('k1');
      await pressRun();
      expect(await screen.findByRole('alert', { name: /ai extraction/i })).toHaveTextContent(copy);
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

// --- S7: the contact page mark-read / mark-unread toggle (D6) ---------------
//
// NO UNREAD DATUM EXISTS ON THIS PAGE AND NONE IS ADDED, so the state is
// DERIVED. The mount fan-out marks EVERY thread of the contact read, so it
// starts from "read" and only a conversation.updated carrying a positive count
// for one of THIS contact's timeline threads can flip it. A skipped (background
// tab) or failed fan-out therefore leaves it showing "Mark unread", which is the
// safe default: the server refuses if that turns out to be wrong.
describe('ContactDetail - the kebab unread toggle (S7)', () => {
  const MARK_UNREAD = 'Mark Tasha Williams as unread';
  const MARK_READ = 'Mark Tasha Williams read';

  /** One 1:1 message on `conv-1`, so the contact's timeline owns that thread. */
  const TIMELINE_PAGE = {
    nextCursor: null,
    items: [
      {
        kind: 'message',
        id: 'm1',
        at: '2026-08-17T10:00:00.000Z',
        conversationId: 'conv-1',
        tsMsgId: '2026-08-17T10:00:00.000Z#SM1',
        direction: 'inbound',
        author: 'contact',
        type: 'sms',
        body: 'is the place still open',
        delivery_status: 'received',
      },
    ],
  };

  function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  }

  async function openKebab(): Promise<void> {
    await screen.findByText('Tasha Williams');
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
  }

  beforeEach(() => {
    getContact.mockResolvedValue(TENANT);
    getContactTimeline.mockReset().mockResolvedValue(TIMELINE_PAGE);
  });
  afterEach(() => setVisibility('visible'));

  it('offers Mark unread after a successful mount fan-out', async () => {
    renderAt('k1');
    await openKebab();
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));
    expect(screen.getByRole('menuitem', { name: MARK_UNREAD })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: MARK_READ })).toBeNull();
  });

  it('offers Mark unread when the fan-out was SKIPPED (background tab)', async () => {
    setVisibility('hidden');
    renderAt('k1');
    await openKebab();
    expect(markInboxRead).not.toHaveBeenCalled();
    // UNKNOWN, not read - and unknown shows the safe default.
    expect(screen.getByRole('menuitem', { name: MARK_UNREAD })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: MARK_READ })).toBeNull();
  });

  it('offers Mark unread when the fan-out FAILED', async () => {
    markInboxRead.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    renderAt('k1');
    await openKebab();
    await waitFor(() => expect(markInboxRead).toHaveBeenCalled());
    expect(screen.getByRole('menuitem', { name: MARK_UNREAD })).toBeInTheDocument();
  });

  it('flips to Mark read on a conversation.updated with a POSITIVE count for a timeline thread', async () => {
    renderAt('k1');
    await screen.findByText('Tasha Williams');
    await waitFor(() => expect(getContactTimeline).toHaveBeenCalled());
    emitConversationUpdated({
      conversationId: 'conv-1',
      last_activity_at: '2026-08-17T11:00:00.000Z',
      unread_count: 2,
    });
    await openKebab();
    expect(screen.getByRole('menuitem', { name: MARK_READ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: MARK_UNREAD })).toBeNull();
  });

  it('ignores a conversation.updated for a thread that is NOT in this contact timeline', async () => {
    renderAt('k1');
    await screen.findByText('Tasha Williams');
    await waitFor(() => expect(getContactTimeline).toHaveBeenCalled());
    emitConversationUpdated({
      conversationId: 'someone-elses-thread',
      last_activity_at: '2026-08-17T11:00:00.000Z',
      unread_count: 5,
    });
    await openKebab();
    expect(screen.getByRole('menuitem', { name: MARK_UNREAD })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: MARK_READ })).toBeNull();
  });

  it('awaits the auto-read drain BEFORE issuing the mark-unread POST', async () => {
    // THE ordering test. The page's own fan-out is held open, so a toggle that
    // POSTs without awaiting suppressAndDrain() is caught here and nowhere else.
    let releaseAutoRead: (() => void) | undefined;
    markInboxRead.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAutoRead = resolve;
        }),
    );
    renderAt('k1');
    await openKebab();
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));

    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(markInboxUnread).not.toHaveBeenCalled();

    await act(async () => {
      releaseAutoRead?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(markInboxUnread).toHaveBeenCalledWith({ contactId: 'k1' }));
  });

  it('navigates to /inbox once the mark-unread POST succeeds', async () => {
    renderAt('k1');
    await openKebab();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    await waitFor(() => expect(screen.getByText('INBOX')).toBeInTheDocument());
  });

  it('does NOT navigate on Mark read - reading is not a departure', async () => {
    renderAt('k1');
    await screen.findByText('Tasha Williams');
    await waitFor(() => expect(getContactTimeline).toHaveBeenCalled());
    emitConversationUpdated({
      conversationId: 'conv-1',
      last_activity_at: '2026-08-17T11:00:00.000Z',
      unread_count: 2,
    });
    await openKebab();
    markInboxRead.mockClear();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_READ }));
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));
    expect(screen.queryByText('INBOX')).toBeNull();
    expect(screen.getByText('Tasha Williams')).toBeInTheDocument();
  });

  it('stays put when the mark-unread POST rejects', async () => {
    markInboxUnread.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    renderAt('k1');
    await openKebab();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    await waitFor(() => expect(markInboxUnread).toHaveBeenCalled());
    expect(screen.queryByText('INBOX')).toBeNull();
    expect(screen.getByText('Tasha Williams')).toBeInTheDocument();
  });

  it('renders a pending state while the mark-unread request is outstanding', async () => {
    let releasePost: (() => void) | undefined;
    markInboxUnread.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releasePost = resolve;
        }),
    );
    renderAt('k1');
    await openKebab();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    // The menu closes on the press (every item does), so the pending state has
    // to live on the page, not in the menu.
    await waitFor(() => expect(screen.getByText('Marking unread...')).toBeInTheDocument());
    await openKebab();
    expect(screen.getByRole('menuitem', { name: MARK_UNREAD })).toBeDisabled();
    await act(async () => {
      releasePost?.();
      await Promise.resolve();
    });
  });

  it('renders the RETRYABLE copy on a 409 and leaves the action available', async () => {
    markInboxUnread.mockRejectedValue(
      new ApiError(409, 'thread_closed', 'thread_closed', { error: 'thread_closed' }),
    );
    renderAt('k1');
    await openKebab();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    // Queried by TEXT, never by role alone and never by an accessible name: an
    // aria-label on a live region REPLACES the announced content, so the banner
    // carries none - and this page renders several other role="status" nodes
    // (the deleted banner, the extraction banner, every Spinner), so a bare role
    // query is a strict-mode multiple-match waiting to happen.
    await waitFor(() =>
      expect(screen.getByText('Could not mark unread - try again')).toBeInTheDocument(),
    );
    await openKebab();
    const item = screen.getByRole('menuitem', { name: MARK_UNREAD });
    expect(item).toBeInTheDocument();
    expect(item).toBeEnabled();
  });

  // Fix wave 1. The kebab offers "Mark unread" on every non-deleted contact, and
  // the route 404s `no_conversation_for_contact` for a large ordinary class - an
  // imported landlord, a contact with no messages, a contact whose only threads
  // are closed or relay-only. Telling those operators to retry a condition that
  // can never clear is the bug. The item is NOT hidden: this page cannot know,
  // and a hidden-but-available action is worse than an honest refusal.
  it('renders TERMINAL copy on a 404 - the contact has no thread to mark unread', async () => {
    markInboxUnread.mockRejectedValue(
      new ApiError(404, 'no_conversation_for_contact', 'no_conversation_for_contact', {
        error: 'no_conversation_for_contact',
      }),
    );
    renderAt('k1');
    await openKebab();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    await waitFor(() =>
      expect(screen.getByText(MARK_UNREAD_NO_THREAD)).toBeInTheDocument(),
    );
    // The copy carries BOTH causes (human ruling 2026-08-18): this 404 is
    // usually permanent - no eligible thread - but the SAME status covers the
    // participant-GSI lag, where a retry does clear it. So it names the common
    // cause AND leaves the retry door open, rather than asserting either alone.
    expect(screen.getByText(/no thread to mark unread yet/i)).toBeInTheDocument();
    expect(screen.getByText(/try again/i)).toBeInTheDocument();
  });

  // Fix wave 1. An aria-label on a live region REPLACES the announced content,
  // so the shipped `aria-label="Unread status"` made a screen-reader user hear
  // "Unread status" instead of the message that is the entire point of the
  // announcement. Neither region carries one.
  //
  // Fix wave 2: the banners are reached by their TEXT and the live region is
  // then read off that node. A bare getByRole('status') would be ambiguous by
  // construction - Spinner, the deleted banner and the extraction banner all
  // carry role="status" on this page - so it would fail as "found multiple
  // elements" rather than as the assertion it is making.
  it('announces the MESSAGE, not a region label, on both unread banners', async () => {
    let rejectPost: (() => void) | undefined;
    markInboxUnread.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPost = () => reject(new ApiError(500, 'server_error', 'boom'));
        }),
    );
    renderAt('k1');
    await openKebab();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));

    const pending = (await screen.findByText('Marking unread...')).closest('[role="status"]');
    expect(pending).not.toBeNull();
    expect(pending).not.toHaveAttribute('aria-label');

    await act(async () => {
      rejectPost?.();
      await Promise.resolve();
    });
    const alert = (await screen.findByText('Could not mark unread - try again')).closest(
      '[role="alert"]',
    );
    expect(alert).not.toBeNull();
    expect(alert).not.toHaveAttribute('aria-label');
  });

  // Fix wave 1. ContactDetail deliberately STAYS on the page when mark-unread
  // fails, but suppressAndDrain's latch used to clear ONLY on an actual contact
  // change - so one failure killed this page's auto-read for the rest of the
  // visit and a new inbound stayed unread while the operator watched it land.
  it('a FAILED mark-unread does not latch the auto-read off for the rest of the visit', async () => {
    markInboxUnread.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    renderAt('k1');
    await openKebab();
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    await waitFor(() =>
      expect(screen.getByText('Could not mark unread - try again')).toBeInTheDocument(),
    );

    // Still on the contact page, still looking at it: a new inbound must be
    // marked read exactly as it was before the failed attempt.
    markInboxRead.mockClear();
    emitMessagePersisted({});
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));
  });

  // --- Fix wave 2: the in-flight toggle belongs to ONE contact ---------------
  //
  // ContactDetail is RE-RENDERED, not remounted, when the route param changes
  // (the composer-isolation describe above drives exactly that navigation and
  // proves the instance survives). The toggle awaits a drain bounded at 2s plus
  // a round trip, so contact A's resolution can land while contact B is on
  // screen. Every write it makes then speaks about the wrong contact.
  //
  // Both cases render a <Link> to a second contact alongside the page, which is
  // how the operator really leaves: the relay-groups card, a timeline link, the
  // Back button.
  function renderWithNavToOther() {
    getContact.mockImplementation((id: unknown) =>
      id === 'z99' ? Promise.resolve(OTHER) : Promise.resolve(TENANT),
    );
    return render(
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
          <Route path="/inbox" element={<div>INBOX</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('does NOT navigate to /inbox when the mark-unread resolves after the operator left the contact', async () => {
    let releasePost: (() => void) | undefined;
    markInboxUnread.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releasePost = resolve;
        }),
    );
    renderWithNavToOther();
    await openKebab();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    await waitFor(() => expect(markInboxUnread).toHaveBeenCalledWith({ contactId: 'k1' }));

    fireEvent.click(screen.getByText('NAV-TO-OTHER'));
    await screen.findByText('Bob Other');

    await act(async () => {
      releasePost?.();
      await Promise.resolve();
    });
    // The write stands - it was right for Tasha - but the operator is reading
    // Bob, and yanking them to the inbox for a press they made on another page
    // is the defect.
    expect(screen.queryByText('INBOX')).toBeNull();
    expect(screen.getByText('Bob Other')).toBeInTheDocument();
  });

  it('does NOT write the failed press banner onto the contact the operator moved to', async () => {
    let rejectPost: (() => void) | undefined;
    markInboxUnread.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPost = () => reject(new ApiError(404, 'no_conversation_for_contact', 'nope'));
        }),
    );
    renderWithNavToOther();
    await openKebab();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    await waitFor(() => expect(markInboxUnread).toHaveBeenCalledWith({ contactId: 'k1' }));

    fireEvent.click(screen.getByText('NAV-TO-OTHER'));
    await screen.findByText('Bob Other');

    await act(async () => {
      rejectPost?.();
      await Promise.resolve();
    });
    // Neither failure copy: Tasha's 404 says nothing about Bob's threads.
    expect(screen.queryByText(MARK_UNREAD_NO_THREAD)).toBeNull();
    expect(screen.queryByText('Could not mark unread - try again')).toBeNull();
  });

  it('hides the toggle ENTIRELY for a soft-deleted contact (MU-2)', async () => {
    getContact.mockResolvedValue({ ...TENANT, deleted_at: '2026-08-10T00:00:00.000Z' });
    renderAt('k1');
    await openKebab();
    expect(screen.getByRole('menuitem', { name: /Restore contact/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: MARK_UNREAD })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: MARK_READ })).toBeNull();
  });

  it('never touches the nav badge optimistic layer, in either direction', async () => {
    renderAt('k1');
    await screen.findByText('Tasha Williams');
    await waitFor(() => expect(getContactTimeline).toHaveBeenCalled());
    emitConversationUpdated({
      conversationId: 'conv-1',
      last_activity_at: '2026-08-17T11:00:00.000Z',
      unread_count: 2,
    });
    await openKebab();
    markInboxRead.mockClear();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_READ }));
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));

    await openKebab();
    fireEvent.click(screen.getByRole('menuitem', { name: MARK_UNREAD }));
    await waitFor(() => expect(markInboxUnread).toHaveBeenCalled());

    expect(noteRowsCleared).not.toHaveBeenCalled();
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });
});
