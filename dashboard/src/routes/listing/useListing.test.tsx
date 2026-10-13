import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/index.js';
import type { Contact, PlacementItem, UnitItem } from '../../api/index.js';

// The property page's writes (the FW2-5 cases at the end render ListingDetail
// with this real hook): the restore and the restore dialog's landlord list.
const restoreUnit = vi.fn();
const getAllContacts = vi.fn();
// ListingDetail's contact lists (placement and tour names, the Add contact picker).
const useContacts = vi.fn();
vi.mock('../contacts/useContacts.js', () => ({ useContacts: (filter: string) => useContacts(filter) }));

const getUnit = vi.fn();
const getAllUnits = vi.fn();
const getAllPlacements = vi.fn();
const getContact = vi.fn();
const getUnitRelated = vi.fn();
const getUnitRecipients = vi.fn();
const getUnitSimilar = vi.fn();
const getUnitActivity = vi.fn();
const getTours = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnit: (...a: unknown[]) => getUnit(...a),
    getAllUnits: (...a: unknown[]) => getAllUnits(...a),
    getAllPlacements: (...a: unknown[]) => getAllPlacements(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    getUnitRelated: (...a: unknown[]) => getUnitRelated(...a),
    getUnitRecipients: (...a: unknown[]) => getUnitRecipients(...a),
    getUnitSimilar: (...a: unknown[]) => getUnitSimilar(...a),
    getUnitActivity: (...a: unknown[]) => getUnitActivity(...a),
    getTours: (...a: unknown[]) => getTours(...a),
    restoreUnit: (...a: unknown[]) => restoreUnit(...a),
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
  };
});

import { sortToursForPanel, useListing } from './useListing.js';
import { ListingDetail } from './ListingDetail.js';

function Probe({ unitId }: { unitId: string }): React.JSX.Element {
  const s = useListing(unitId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="roster">{s.roster.length}</span>
      <span data-testid="placements">{s.placementsOnUnit.length}</span>
      <span data-testid="related-status">{s.related.status}</span>
      <span data-testid="related-rows">
        {s.related.status === 'ready' ? s.related.rows.length : -1}
      </span>
      <span data-testid="recipients">{s.recipients.status}</span>
      <span data-testid="similar">{s.similar.status}</span>
      <span data-testid="activity">{s.activity.status}</span>
      <span data-testid="activity-rows">
        {s.activity.status === 'ready' ? s.activity.rows.length : -1}
      </span>
      <span data-testid="tours">{s.tours.status}</span>
      <span data-testid="tours-rows">{s.tours.status === 'ready' ? s.tours.rows.length : -1}</span>
    </div>
  );
}

const UNIT: UnitItem = { unitId: 'u1', landlordId: 'll1', status: 'available' };
const UNITS: UnitItem[] = [UNIT, { unitId: 'u2', landlordId: 'll1', status: 'occupied' }];
const CASES: PlacementItem[] = [{ placementId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'awaiting_approval' }];
const LANDLORD: Contact = { contactId: 'll1', type: 'landlord', firstName: 'James' } as Contact;

beforeEach(() => {
  getUnit.mockReset();
  getAllUnits.mockReset();
  getAllPlacements.mockReset();
  getContact.mockReset();
  getUnitRelated.mockReset();
  getUnitRecipients.mockReset();
  getUnitSimilar.mockReset();
  getUnitActivity.mockReset();
  // Default: no tours (individual tests override with rows / a 404).
  getTours.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('useListing', () => {
  it('assembles real panels and degrades C4/C6 to pending; related falls back', async () => {
    getUnit.mockResolvedValue(UNIT);
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    // single landlord fallback row
    expect(screen.getByTestId('roster').textContent).toBe('1');
    expect(screen.getByTestId('placements').textContent).toBe('1');
    // related fell back to same-landlord (u2), ready not pending
    expect(screen.getByTestId('related-status').textContent).toBe('ready');
    expect(screen.getByTestId('related-rows').textContent).toBe('1');
    // C4/C6 stay pending
    expect(screen.getByTestId('recipients').textContent).toBe('pending');
    expect(screen.getByTestId('similar').textContent).toBe('pending');
    // activity degrades the same way on an older deployed backend
    expect(screen.getByTestId('activity').textContent).toBe('pending');
  });

  it('derives Related from the WHOLE portfolio, not just the first server page', async () => {
    // getAllUnits arrives already walked (api/lists.test.ts proves the walk). A
    // sibling property that only a paged read could supply used to be invisible
    // to the derived Related list, so a landlord with a large portfolio saw an
    // empty "Related properties" card.
    getUnit.mockResolvedValue(UNIT);
    getAllUnits.mockResolvedValue([UNIT, { unitId: 'u-sibling', landlordId: 'll1', status: 'available' }]);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('related-status').textContent).toBe('ready');
    expect(screen.getByTestId('related-rows').textContent).toBe('1');
  });

  it('uses the live /related endpoint when it answers', async () => {
    getUnit.mockResolvedValue(UNIT);
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockResolvedValue([
      { unitId: 'u9', status: 'available', relation: 'same_property', label: 'Duplex' },
    ]);
    getUnitRecipients.mockResolvedValue([]);
    getUnitSimilar.mockResolvedValue([]);
    getUnitActivity.mockResolvedValue([
      { id: '2026-07-01T09:00:00.000Z#000001', at: '2026-07-01T09:00:00.000Z', type: 'unit_created' },
    ]);

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('related-status').textContent).toBe('ready');
    expect(screen.getByTestId('related-rows').textContent).toBe('1');
    expect(screen.getByTestId('recipients').textContent).toBe('ready');
    expect(screen.getByTestId('similar').textContent).toBe('ready');
    expect(screen.getByTestId('activity').textContent).toBe('ready');
    expect(screen.getByTestId('activity-rows').textContent).toBe('1');
  });

  it('loads tours by unitId, unbooked first then newest; a 404 degrades to pending', async () => {
    getUnit.mockResolvedValue(UNIT);
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getTours.mockResolvedValue([
      { tourId: 'tour-old', tenantId: 't1', unitId: 'u1', status: 'toured', scheduledAt: '2026-07-01T15:00:00.000Z' },
      { tourId: 'tour-new', tenantId: 't2', unitId: 'u1', status: 'scheduled', scheduledAt: '2026-07-20T15:00:00.000Z' },
    ]);

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(getTours).toHaveBeenCalledWith({ unitId: 'u1' }, expect.anything());
    expect(screen.getByTestId('tours').textContent).toBe('ready');
    expect(screen.getByTestId('tours-rows').textContent).toBe('2');
  });

  it('setUnit preserves the prior mediaDisplay when a mutation response omits it (media unchanged)', async () => {
    // REGRESSION (2026-07-16): the listing-status + generic-PATCH routes return
    // the unit WITHOUT mediaDisplay. Applying such a response raw blanked the
    // gallery until the next photo action re-resolved it (add photos -> flip to
    // Available -> photos vanish; a cover change brought them back). setUnit now
    // keeps the prior resolved URLs when the incoming unit omits mediaDisplay
    // AND its media array is unchanged.
    const withPhotos: UnitItem = {
      unitId: 'u1',
      landlordId: 'll1',
      status: 'available',
      media: ['unit-media/u1/a', 'unit-media/u1/b'],
      mediaDisplay: [
        { entry: 'unit-media/u1/a', url: 'https://s3.local/a?sig=1' },
        { entry: 'unit-media/u1/b', url: 'https://s3.local/b?sig=2' },
      ],
    };
    getUnit.mockResolvedValue(withPhotos);
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    const { result } = renderHook(() => useListing('u1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.unit?.mediaDisplay).toHaveLength(2);

    // A status-change / edit-form response: SAME media, NO mediaDisplay.
    act(() =>
      result.current.setUnit({
        unitId: 'u1',
        landlordId: 'll1',
        status: 'occupied',
        media: ['unit-media/u1/a', 'unit-media/u1/b'],
      }),
    );
    // Preserved - the gallery keeps its resolved URLs (no blank-out); the
    // status change still applied.
    expect(result.current.unit?.mediaDisplay).toEqual(withPhotos.mediaDisplay);
    expect(result.current.unit?.status).toBe('occupied');

    // But when media CHANGES and mediaDisplay is omitted, the prior URLs are
    // stale - do NOT preserve them (falls to the tile fallback, self-heals).
    act(() =>
      result.current.setUnit({
        unitId: 'u1',
        landlordId: 'll1',
        status: 'occupied',
        media: ['unit-media/u1/a'],
      }),
    );
    expect(result.current.unit?.mediaDisplay).toBeUndefined();
  });

  it('sortToursForPanel: unbooked requests lead, then booked tours newest-first', () => {
    const sorted = sortToursForPanel([
      { tourId: 'a', tenantId: 't', unitId: 'u', status: 'toured', scheduledAt: '2026-07-01T15:00:00.000Z' },
      { tourId: 'b', tenantId: 't', unitId: 'u', status: 'requested' },
      { tourId: 'c', tenantId: 't', unitId: 'u', status: 'scheduled', scheduledAt: '2026-07-20T15:00:00.000Z' },
    ] as Parameters<typeof sortToursForPanel>[0]);
    expect(sorted.map((t) => t.tourId)).toEqual(['b', 'c', 'a']);
  });

  it('sortToursForPanel: only a REQUEST leads - an undated toured or canceled tour is dateless history, after every dated tour', () => {
    // Ruling D-1: an undated non-request reads "Undated", not "Needs booking",
    // so it must not sit among the requests at the top of the card.
    const sorted = sortToursForPanel([
      { tourId: 'undated-toured', tenantId: 't', unitId: 'u', status: 'toured' },
      { tourId: 'old', tenantId: 't', unitId: 'u', status: 'toured', scheduledAt: '2026-07-01T15:00:00.000Z' },
      { tourId: 'undated-canceled', tenantId: 't', unitId: 'u', status: 'canceled' },
      { tourId: 'request', tenantId: 't', unitId: 'u', status: 'requested' },
      { tourId: 'new', tenantId: 't', unitId: 'u', status: 'scheduled', scheduledAt: '2026-07-20T15:00:00.000Z' },
    ] as Parameters<typeof sortToursForPanel>[0]);
    expect(sorted.map((t) => t.tourId)).toEqual(['request', 'new', 'old', 'undated-toured', 'undated-canceled']);
  });

  it('exposes the load-time propertyContact block (primary-contact-integrity spec 7.5), and setUnit keeps it', async () => {
    const block = { contactId: null, reason: 'none' as const, heirIfPrimaryRemoved: null };
    getUnit.mockResolvedValue({ ...UNIT, propertyContact: block });
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    const { result } = renderHook(() => useListing('u1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.propertyContact).toEqual(block);
    // A status / edit-form / photo response carries no block - it never
    // clears the load-time one (only a roster source supersedes it, in the page).
    act(() => result.current.setUnit({ ...UNIT, status: 'occupied' }));
    expect(result.current.propertyContact).toEqual(block);
  });

  it('leaves propertyContact absent when the GET carried no block (the server could not tell)', async () => {
    getUnit.mockResolvedValue(UNIT);
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    const { result } = renderHook(() => useListing('u1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.propertyContact).toBeUndefined();
  });

  it('errors when the unit itself fails to load', async () => {
    getUnit.mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });

  it('tolerates a 404 on the landlord contact (roster still falls back id-only)', async () => {
    getUnit.mockResolvedValue(UNIT);
    getAllUnits.mockResolvedValue(UNITS);
    getAllPlacements.mockResolvedValue(CASES);
    getContact.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('roster').textContent).toBe('1');
  });
});

// R2 code review, dashboard finding A1 (fix wave 2 FW2-5): the /listings/:unitId
// element is not keyed, so a history move from property A to property B
// re-renders the SAME page and this hook moves to B in place. A write started
// on A (a restore, a status change, a roster write) that answers after the move
// calls the setUnit it got for A. Bound to A, that setter must leave B's state
// alone: stamping A's id over it left B deriving "loading" forever (the fetch
// effect is keyed on the unitId and never re-runs) - the contact page's
// useContact.setContact precedent.
describe('useListing - a write that answers after a move to another property', () => {
  const UNIT_A: UnitItem = { unitId: 'uA', landlordId: 'll1', status: 'available', address: { line1: '11 Oak Ave' } };
  const UNIT_B: UnitItem = { unitId: 'uB', landlordId: 'll1', status: 'available', address: { line1: '22 Elm St' } };

  /** Every read the hook makes, answered per property: `a` is A as stored. */
  function answerReads(a: UnitItem): void {
    getUnit.mockImplementation((id: string) => Promise.resolve(id === 'uB' ? UNIT_B : a));
    getAllUnits.mockResolvedValue([a, UNIT_B]);
    getAllPlacements.mockResolvedValue([]);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));
  }

  beforeEach(() => {
    restoreUnit.mockReset();
    getAllContacts.mockReset().mockResolvedValue([]);
    useContacts.mockReset().mockReturnValue({ status: 'ready', contacts: [] });
  });

  it("the setter held for A is a no-op once the hook has moved to B - B stays ready and B's own", async () => {
    answerReads(UNIT_A);
    const { result, rerender } = renderHook(({ id }) => useListing(id), { initialProps: { id: 'uA' } });
    await waitFor(() => expect(result.current.unit?.unitId).toBe('uA'));
    const setUnitForA = result.current.setUnit;

    rerender({ id: 'uB' });
    await waitFor(() => expect(result.current.unit?.unitId).toBe('uB'));

    // A's write answers now.
    act(() => setUnitForA({ ...UNIT_A, status: 'occupied' }));
    expect(result.current.status).toBe('ready');
    expect(result.current.unit?.unitId).toBe('uB');

    // Positive control: B's own setter still applies.
    act(() => result.current.setUnit({ ...UNIT_B, status: 'occupied' }));
    expect(result.current.status).toBe('ready');
    expect(result.current.unit).toMatchObject({ unitId: 'uB', status: 'occupied' });
  });

  it("a restore through the landlord dialog that answers after Back to B leaves B's page rendered, not a spinner", async () => {
    const user = userEvent.setup();
    answerReads({ ...UNIT_A, deleted_at: '2026-06-19T00:00:00.000Z' });
    let answerRestore: ((unit: UnitItem) => void) | undefined;
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', { error: 'restore_needs_landlord' }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<UnitItem>((resolve) => {
            answerRestore = resolve;
          }),
      );
    let go: ((delta: number) => void) | undefined;
    function HistoryProbe(): null {
      const navigate = useNavigate();
      go = (delta) => void navigate(delta);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/listings/uB', '/listings/uA']} initialIndex={1}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
        </Routes>
        <HistoryProbe />
      </MemoryRouter>,
    );

    // On deleted A: the plain restore needs a landlord, so the dialog opens;
    // "Restore without a landlord" is sent and left in flight.
    await screen.findByRole('heading', { name: /11 Oak Ave/ });
    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));
    expect(restoreUnit).toHaveBeenLastCalledWith('uA', { landlordId: null });

    // Back to B: the dialog closes (FW-11) and B loads.
    act(() => go?.(-1));
    expect(await screen.findByRole('heading', { name: /22 Elm St/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument();

    // A's restore answers now (A was restored): B's page stays.
    await act(async () => {
      answerRestore?.({ ...UNIT_A });
    });
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /22 Elm St/ })).toBeInTheDocument();
  });
});
