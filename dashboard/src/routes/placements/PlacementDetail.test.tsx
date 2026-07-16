// PlacementDetail component tests - the rebuilt two-pane placement hub. Verifies:
//   - the header: title ("Placement - <tenant> -> <property>"), stage pill,
//     date-vocabulary facts line, the "Advance to <next stage>" primary CTA
//     (next ladder rung; absent at the terminal stages), and the kebab actions
//     (Move to... / Set follow-up / Open group text [group-gated] / Mark lost)
//   - the existing gated transition pipeline still fires from the kebab's
//     "Move to..." picker (outcome / final rent / inspection date / determined
//     rent / move-in ready gates) + the in-place StageData/Paperwork recorders
//     (KEPT this task; absorbed by the Now card in Task 9)
//   - the People + provenance and Placement facts right-pane cards + History
//   - live placement.updated refetch; the mobile Details|Conversation toggle
//
// The header is now the two-pane shell's dark band, so "page loaded" waits on the
// stable "Back to placements" crumb (not a stage heading) and stage moves go
// through the kebab -> "Move to..." StatusMenu (see chooseStage).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PlacementItem, PlacementUpdatedEvent, EventStreamHandlers, HistoryRow, UnitItem, PlacementStage } from '../../api/index.js';
import { STAGE_LABELS } from '../../api/index.js';

const getPlacement = vi.fn();
const getUnit = vi.fn();
const getContact = vi.fn();
const transitionPlacement = vi.fn();
const updatePlacement = vi.fn();
const updateUnit = vi.fn();
const getPlacementHistory = vi.fn();
// Left-pane comms deps (usePlacementChannels + PlacementConversation). Mocked to
// keep the conversation pane quiet + deterministic; this suite exercises the
// header + right pane (the comms hub has its own tests in Task 6).
const getConversations = vi.fn();
const markConversationRead = vi.fn();
const provisionPlacementRelay = vi.fn();
// Deadlines-and-nudges card deps: quiet the nudge fetch so the card renders its
// empty ladder (this suite exercises the header + right-pane structure; the card
// has its own tests in DeadlinesNudgesCard.test.tsx).
const getPlacementNudges = vi.fn();
const setPlacementFollowUp = vi.fn();
const clearPlacementFollowUp = vi.fn();
// Capture the SSE handlers the page (and its History panel) register so a test
// can fire a placement.updated event.
let streamHandlers: EventStreamHandlers[] = [];

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getPlacement: (...a: unknown[]) => getPlacement(...a),
    getUnit: (...a: unknown[]) => getUnit(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    transitionPlacement: (...a: unknown[]) => transitionPlacement(...a),
    updatePlacement: (...a: unknown[]) => updatePlacement(...a),
    updateUnit: (...a: unknown[]) => updateUnit(...a),
    getPlacementHistory: (...a: unknown[]) => getPlacementHistory(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    provisionPlacementRelay: (...a: unknown[]) => provisionPlacementRelay(...a),
    getPlacementNudges: (...a: unknown[]) => getPlacementNudges(...a),
    setPlacementFollowUp: (...a: unknown[]) => setPlacementFollowUp(...a),
    clearPlacementFollowUp: (...a: unknown[]) => clearPlacementFollowUp(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers.push(h);
    },
  };
});

import { PlacementDetail } from './PlacementDetail.js';

const CASE: PlacementItem = {
  placementId: 'c1',
  tenantId: 't1',
  unitId: 'u1',
  stage: 'awaiting_inspection',
  stage_entered_at: '2026-06-18T13:02:00Z',
};

const UNIT: UnitItem = {
  unitId: 'u1',
  landlordId: 'l1',
  status: 'under_application',
  address: { line1: '12 Oak St' },
  final_rent: 1550,
};

const TENANT = {
  contactId: 't1',
  type: 'tenant' as const,
  firstName: 'Tasha',
  lastName: 'Nguyen',
  voucher_expiration_date: '2026-08-02',
};
const LANDLORD = { contactId: 'l1', type: 'landlord' as const, firstName: 'Larry', lastName: 'Owens' };

/** Resolve tenant vs landlord by id so their links never collide (both would
 *  otherwise show the same mocked name and break a unique getByRole). */
function contactById(id: unknown): unknown {
  return id === 'l1' ? LANDLORD : TENANT;
}

function row(over: Partial<HistoryRow>): HistoryRow {
  return { entityKey: 'placement#c1', event_type: 'stage_changed', ts: '2026-06-18T13:02:00Z', ...over };
}

function renderAt(): void {
  render(
    <MemoryRouter initialEntries={['/placements/c1']}>
      <Routes>
        <Route path="/placements/:placementId" element={<PlacementDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getPlacement.mockReset().mockResolvedValue(CASE);
  getUnit.mockReset().mockResolvedValue(UNIT);
  getContact.mockReset().mockImplementation((id: unknown) => Promise.resolve(contactById(id)));
  transitionPlacement.mockReset();
  updatePlacement.mockReset();
  updateUnit.mockReset();
  getPlacementHistory.mockReset().mockResolvedValue([]);
  getConversations.mockReset().mockResolvedValue({ conversations: [], nextCursor: null });
  markConversationRead.mockReset().mockResolvedValue(undefined);
  provisionPlacementRelay.mockReset().mockResolvedValue({ conversationId: 'g1' });
  getPlacementNudges.mockReset().mockResolvedValue([]);
  setPlacementFollowUp.mockReset().mockResolvedValue(undefined);
  clearPlacementFollowUp.mockReset().mockResolvedValue(undefined);
  streamHandlers = [];
});
afterEach(() => vi.restoreAllMocks());

/** Wait for the loaded page (past the loading spinner): the header back crumb. */
async function waitLoaded(): Promise<void> {
  await screen.findByRole('link', { name: 'Back to placements' });
}

/** Fire a placement.updated event at each DISTINCT subscriber the page registered.
 *  The mock collects a handlers object per render; onPlacementUpdated is a stable
 *  useCallback per consumer, so dedupe by its identity to fire each consumer
 *  (the page + its History panel) exactly once - as the real provider would. */
function emitCaseUpdated(over: Partial<PlacementUpdatedEvent> & { placementId: string }): void {
  const ev: PlacementUpdatedEvent = {
    tenantId: 't1',
    unitId: 'u1',
    stage: 'awaiting_inspection',
    tour_date: null,
    next_deadline_type: null,
    next_deadline_at: null,
    group_thread: null,
    attention: false,
    lost_reason: null,
    updated_at: null,
    ...over,
  };
  const seen = new Set<NonNullable<EventStreamHandlers['onPlacementUpdated']>>();
  for (const h of streamHandlers) {
    if (h.onPlacementUpdated && !seen.has(h.onPlacementUpdated)) {
      seen.add(h.onPlacementUpdated);
      h.onPlacementUpdated(ev);
    }
  }
}

/** Move the placement via the kebab's "Move to..." picker: open the kebab, open
 *  the stage StatusMenu, then pick a stage. */
async function chooseStage(
  user: ReturnType<typeof userEvent.setup>,
  stage: PlacementStage,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  await user.click(screen.getByRole('button', { name: /Placement stage/i }));
  await user.click(screen.getByRole('menuitemradio', { name: STAGE_LABELS[stage] }));
}

/** The right-pane "Placement facts" card element (scopes the read-only rows). */
function factsCard(): HTMLElement {
  return screen.getByRole('heading', { name: 'Placement facts' }).closest('section') as HTMLElement;
}

/** The dark header band (the <header> holding the back crumb). The Now card
 *  repeats the stage label, phase, and an "Advance to <next>" button, so
 *  header-specific assertions scope here to disambiguate from the Now card's
 *  copies. (Scoped via the back crumb - the left comms pane also has a <header>.) */
function banner(): HTMLElement {
  return screen.getByRole('link', { name: 'Back to placements' }).closest('header') as HTMLElement;
}

describe('PlacementDetail - header', () => {
  it('renders the title, stage pill, and date-vocabulary facts line', async () => {
    renderAt();
    await waitLoaded();
    // Title: Placement - <tenant name> -> <property address> (one span; the
    // address also appears as the People-card property link, so match the whole
    // title string here rather than the ambiguous address alone).
    expect(screen.getByText(/Placement - Tasha Nguyen .* 12 Oak St/)).toBeInTheDocument();
    // Stage pill shows the current stage label (header band - the Now card repeats it).
    expect(within(banner()).getByText('Awaiting inspection')).toBeInTheDocument();
    // Facts line rides the date vocabulary (phase + in-stage-since + voucher).
    expect(within(banner()).getByText(/Inspection phase/)).toBeInTheDocument();
    expect(screen.getByText(/in stage since Jun 18/)).toBeInTheDocument();
    expect(screen.getByText(/voucher expires Aug 2/)).toBeInTheDocument();
  });

  it('the primary CTA advances to the NEXT ladder stage', async () => {
    // awaiting_inspection -> determine_rent is the next rung.
    renderAt();
    await waitLoaded();
    // Header CTA (the Now card also renders an Advance button - scope to the band).
    expect(within(banner()).getByRole('button', { name: 'Advance to Determine rent' })).toBeInTheDocument();
  });

  it('shows no Advance CTA at the terminal moved_in stage', async () => {
    getPlacement.mockResolvedValue({ ...CASE, stage: 'moved_in' });
    renderAt();
    await waitLoaded();
    expect(screen.queryByRole('button', { name: /^Advance to/ })).not.toBeInTheDocument();
  });

  it('shows no Advance CTA at the terminal lost stage', async () => {
    getPlacement.mockResolvedValue({ ...CASE, stage: 'lost' });
    renderAt();
    await waitLoaded();
    expect(screen.queryByRole('button', { name: /^Advance to/ })).not.toBeInTheDocument();
  });

  it('the kebab exposes Move to... + Set follow-up + Open group text + Mark lost', async () => {
    const user = userEvent.setup();
    renderAt();
    await waitLoaded();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    // "Move to..." IS the existing gated stage StatusMenu.
    expect(screen.getByRole('button', { name: /Placement stage/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Set follow-up' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open group text' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mark lost' })).toBeInTheDocument();
  });

  it('hides Open group text once a group thread exists', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, group_thread: 'g1' });
    renderAt();
    await waitLoaded();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Open group text' })).not.toBeInTheDocument();
    // The other actions still show.
    expect(screen.getByRole('menuitem', { name: 'Mark lost' })).toBeInTheDocument();
  });
});

describe('PlacementDetail', () => {
  it('renders the stage, links, inspection outcome + final rent in the facts card', async () => {
    getPlacement.mockResolvedValue({ ...CASE, inspection_outcome: 'pass' });
    renderAt();
    await waitLoaded();
    // Stage pill (header band - the Now card repeats the stage label).
    expect(within(banner()).getByText('Awaiting inspection')).toBeInTheDocument();
    // M4: the Tenant link shows the contact NAME, not the raw id.
    expect(screen.getByRole('link', { name: 'Tasha Nguyen' })).toHaveAttribute('href', '/contacts/t1');
    expect(screen.getByRole('link', { name: '12 Oak St' })).toHaveAttribute('href', '/listings/u1');
    // Scope to the "Placement facts" card - the awaiting_inspection stage also
    // renders the in-place inspection recorder, which has its own Pass control.
    expect(within(factsCard()).getByText('Pass')).toBeInTheDocument();
    expect(within(factsCard()).getByText('$1,550/mo')).toBeInTheDocument();
  });

  it('M4: degrades the Tenant link to the raw id when the contact cannot be loaded', async () => {
    getContact.mockRejectedValue(new Error('not found'));
    renderAt();
    await waitLoaded();
    expect(screen.getByRole('link', { name: 't1' })).toHaveAttribute('href', '/contacts/t1');
  });

  it('links the source tour in People + provenance when fromTourId is present', async () => {
    getPlacement.mockResolvedValue({ ...CASE, fromTourId: 'tour-9', tour_date: '2026-07-08' });
    renderAt();
    await waitLoaded();
    const link = screen.getByRole('link', { name: /converted from tour/i });
    expect(link).toHaveAttribute('href', '/tours/tour-9');
    expect(link).toHaveTextContent(/toured Jul 8/);
  });

  it('omits the source-tour line when there is no fromTourId', async () => {
    renderAt();
    await waitLoaded();
    expect(screen.queryByRole('link', { name: /converted from tour/i })).not.toBeInTheDocument();
  });

  it('renders history rows newest-first and loads more with the before cursor', async () => {
    const first = Array.from({ length: 20 }, (_, i) =>
      row({
        event_type: 'placement_stage_changed',
        ts: `2026-06-18T13:${String(20 - i).padStart(2, '0')}:00Z`,
        payload: { from: 'collect_rta', to: i === 0 ? 'review_rta' : `stage-${i}`, source: 'manual' },
      }),
    );
    getPlacementHistory.mockResolvedValueOnce(first);
    getPlacementHistory.mockResolvedValueOnce([
      row({
        event_type: 'placement_stage_changed',
        ts: '2026-06-10T00:00:00Z',
        payload: { from: 'send_application', to: 'collect_rta', source: 'import' },
      }),
    ]);
    renderAt();

    // Stages are LABELED via STAGE_LABELS, not shown as raw snake_case.
    await waitFor(() => expect(screen.getByText(/Collect RTA → Review RTA/)).toBeInTheDocument());
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    const user = userEvent.setup();
    await user.click(loadMore);

    await waitFor(() => expect(screen.getByText(/Send application → Collect RTA/)).toBeInTheDocument());
    // The second call passed the before cursor = the oldest loaded row's ts.
    expect(getPlacementHistory).toHaveBeenLastCalledWith(
      'c1',
      expect.objectContaining({ before: first[first.length - 1]!.ts }),
      expect.anything(),
    );
  });

  it('a move out of awaiting_inspection prompts for the outcome before transitioning', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue({ ...CASE, stage: 'determine_rent' });
    renderAt();
    await waitLoaded();

    await chooseStage(user, 'determine_rent');
    expect(screen.getByRole('heading', { name: 'Record inspection outcome' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    // Scope to the move dialog - the in-place recorder also has Pass/Fail radios.
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Fail' }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'determine_rent',
        source: 'manual',
        inspectionOutcome: 'fail',
      }),
    );
  });

  it('the finalRent prompt rejects <=0', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'awaiting_rent_acceptance' });
    renderAt();
    await waitLoaded();

    await chooseStage(user, 'awaiting_hap_contract');
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText(/Final contract rent/i);
    // The modal prefills the recorded final_rent (in-place stage-data); clear it
    // to exercise the <=0 rejection.
    await user.clear(input);
    await user.type(input, '0');
    expect(within(dialog).getByRole('button', { name: 'Confirm move' })).toBeDisabled();
    expect(transitionPlacement).not.toHaveBeenCalled();
  });

  it('the move into awaiting_inspection prompts for the inspection date, forwarding it', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'schedule_inspection' });
    transitionPlacement.mockResolvedValue({ ...CASE, stage: 'awaiting_inspection' });
    renderAt();
    await waitLoaded();

    await chooseStage(user, 'awaiting_inspection');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Schedule inspection' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    const input = within(dialog).getByLabelText(/Inspection date/i);
    fireEvent.change(input, { target: { value: '2026-07-20' } });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'awaiting_inspection',
        source: 'manual',
        inspectionDate: '2026-07-20',
      }),
    );
  });

  it('the move into awaiting_rent_acceptance prompts for the determined rent, forwarding it', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'determine_rent' });
    transitionPlacement.mockResolvedValue({ ...CASE, stage: 'awaiting_rent_acceptance' });
    renderAt();
    await waitLoaded();

    await chooseStage(user, 'awaiting_rent_acceptance');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Confirm determined rent' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    const input = within(dialog).getByLabelText(/Determined rent/i);
    await user.type(input, '1850');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'awaiting_rent_acceptance',
        source: 'manual',
        rentDetermined: 1850,
      }),
    );
  });

  it('live-updates the page fields when a placement.updated event for this placement arrives', async () => {
    renderAt();
    await waitLoaded();
    await waitFor(() => expect(within(banner()).getByText('Awaiting inspection')).toBeInTheDocument());
    expect(getPlacement).toHaveBeenCalledTimes(1);

    // Another tab/user (or our own transition) moved the placement -> placement.updated.
    // The refetch returns the new stage; the page reflects it without a reload.
    getPlacement.mockResolvedValue({ ...CASE, stage: 'determine_rent' });
    await act(async () => {
      emitCaseUpdated({ placementId: 'c1', stage: 'determine_rent' });
    });

    await waitFor(() => expect(within(banner()).getByText('Determine rent')).toBeInTheDocument());
    expect(getPlacement).toHaveBeenCalledTimes(2);
  });

  it('ignores a placement.updated event for a different placement', async () => {
    renderAt();
    await waitLoaded();
    await waitFor(() => expect(within(banner()).getByText('Awaiting inspection')).toBeInTheDocument());
    await act(async () => {
      emitCaseUpdated({ placementId: 'some-other-placement', stage: 'moved_in' });
    });
    // No refetch for an unrelated placement.
    expect(getPlacement).toHaveBeenCalledTimes(1);
  });

  it('renders the inspection date + determined rent rows when present', async () => {
    getPlacement.mockResolvedValue({
      ...CASE,
      inspection_date: '2026-06-20',
      rent_determined: 1450,
    });
    renderAt();
    await waitLoaded();
    expect(within(factsCard()).getByText('Inspection date')).toBeInTheDocument();
    expect(within(factsCard()).getByText('Determined rent')).toBeInTheDocument();
    expect(within(factsCard()).getByText('$1,450/mo')).toBeInTheDocument();
  });

  it('shows the paperwork checklist at complete_paperwork, with LIF only for a LIF-eligible tenant', async () => {
    getPlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork' });
    getContact.mockImplementation((id: unknown) =>
      Promise.resolve(id === 'l1' ? LANDLORD : { ...TENANT, lifEligible: true }),
    );
    renderAt();
    await waitLoaded();
    expect(screen.getByRole('checkbox', { name: 'Lease signed' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Move-in details shared' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /LIF/ })).toBeInTheDocument();
  });

  it('omits the LIF checkbox when the tenant is not LIF-eligible', async () => {
    getPlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork' });
    // tenant has no lifEligible flag (default beforeEach contact)
    renderAt();
    await waitLoaded();
    expect(screen.getByRole('checkbox', { name: 'Lease signed' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /LIF/ })).not.toBeInTheDocument();
  });

  it('does not render the paperwork checklist outside complete_paperwork', async () => {
    renderAt();
    await waitLoaded();
    expect(screen.queryByRole('checkbox', { name: 'Lease signed' })).not.toBeInTheDocument();
  });

  it('toggling a paperwork checkbox PATCHes the placement with that field', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork' });
    updatePlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork', lease_signed: true });
    renderAt();
    await waitLoaded();

    await user.click(screen.getByRole('checkbox', { name: 'Lease signed' }));
    await waitFor(() => expect(updatePlacement).toHaveBeenCalledWith('c1', { lease_signed: true }));
  });

  // --- In-place stage-data entry (StageDataCard) ---------------------------
  it('records the inspection outcome in place at awaiting_inspection (PATCH, no move)', async () => {
    const user = userEvent.setup();
    // default CASE stage is awaiting_inspection
    updatePlacement.mockResolvedValue({ ...CASE, inspection_outcome: 'fail' });
    renderAt();
    await waitLoaded();
    await user.click(screen.getByRole('radio', { name: 'Fail' }));
    await user.click(screen.getByRole('button', { name: /Record inspection outcome/ }));
    await waitFor(() => expect(updatePlacement).toHaveBeenCalledWith('c1', { inspection_outcome: 'fail' }));
    expect(transitionPlacement).not.toHaveBeenCalled();
  });

  it('records the inspection date in place at schedule_inspection (PATCH placement)', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'schedule_inspection' });
    updatePlacement.mockResolvedValue({ ...CASE, stage: 'schedule_inspection', inspection_date: '2026-07-20' });
    renderAt();
    await waitLoaded();
    await user.type(screen.getByLabelText('Inspection date'), '2026-07-20');
    await user.click(screen.getByRole('button', { name: /Record inspection date/ }));
    await waitFor(() => expect(updatePlacement).toHaveBeenCalledWith('c1', { inspection_date: '2026-07-20' }));
  });

  it('records the determined rent in place at determine_rent (PATCH placement)', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'determine_rent' });
    updatePlacement.mockResolvedValue({ ...CASE, stage: 'determine_rent', rent_determined: 1850 });
    renderAt();
    await waitLoaded();
    await user.type(screen.getByLabelText('Determined rent (monthly)'), '1850');
    await user.click(screen.getByRole('button', { name: /Record determined rent/ }));
    await waitFor(() => expect(updatePlacement).toHaveBeenCalledWith('c1', { rent_determined: 1850 }));
  });

  it('records the accepted final rent in place at awaiting_rent_acceptance (PATCH the unit)', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'awaiting_rent_acceptance' });
    updateUnit.mockResolvedValue({ ...UNIT, final_rent: 1875 });
    renderAt();
    await waitLoaded();
    const input = screen.getByLabelText('Accepted rent (monthly)');
    await user.clear(input);
    await user.type(input, '1875');
    await user.click(screen.getByRole('button', { name: /Record accepted rent/ }));
    await waitFor(() => expect(updateUnit).toHaveBeenCalledWith('u1', { final_rent: 1875 }));
  });

  it('does not render the stage-data card outside its data stages', async () => {
    getPlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork' });
    renderAt();
    await waitLoaded();
    expect(screen.queryByRole('button', { name: /Record inspection outcome/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record accepted rent/ })).not.toBeInTheDocument();
  });

  it('the moveInReady gate confirms (with the LIF-pending note) then transitions to awaiting_move_in', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork' });
    getContact.mockImplementation((id: unknown) =>
      Promise.resolve(id === 'l1' ? LANDLORD : { ...TENANT, lifEligible: true }),
    );
    transitionPlacement.mockResolvedValue({ ...CASE, stage: 'awaiting_move_in' });
    renderAt();
    await waitLoaded();

    await chooseStage(user, 'awaiting_move_in');
    expect(screen.getByRole('heading', { name: 'Confirm move-in ready' })).toBeInTheDocument();
    // LIF-eligible tenant with lif unset -> the pending note shows.
    expect(screen.getByText(/LIF is not marked/i)).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'awaiting_move_in',
        source: 'manual',
      }),
    );
  });
});

describe('PlacementDetail - mobile', () => {
  it('exposes a Details | Conversation toggle with Details pressed initially, and switches', async () => {
    const user = userEvent.setup();
    renderAt();
    await waitLoaded();
    const details = screen.getByRole('button', { name: 'Details' });
    const conversation = screen.getByRole('button', { name: 'Conversation' });
    expect(details).toHaveAttribute('aria-pressed', 'true');
    expect(conversation).toHaveAttribute('aria-pressed', 'false');

    await user.click(conversation);
    expect(conversation).toHaveAttribute('aria-pressed', 'true');
    expect(details).toHaveAttribute('aria-pressed', 'false');
  });
});
