import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { PlacementItem, UnitItem } from '../../api/index.js';

const getAllPlacements = vi.fn();
const getAllUnits = vi.fn();
const getContactListingsSent = vi.fn();
const getContactRelayGroups = vi.fn();
const getContactGroupThreads = vi.fn();
const getTours = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllPlacements: (...a: unknown[]) => getAllPlacements(...a),
    getAllUnits: (...a: unknown[]) => getAllUnits(...a),
    getContactListingsSent: (...a: unknown[]) => getContactListingsSent(...a),
    getContactRelayGroups: (...a: unknown[]) => getContactRelayGroups(...a),
    getContactGroupThreads: (...a: unknown[]) => getContactGroupThreads(...a),
    getTours: (...a: unknown[]) => getTours(...a),
  };
});

import { useContactFile } from './useContactFile.js';

function Probe({ contactId }: { contactId: string }): React.JSX.Element {
  const f = useContactFile(contactId);
  return (
    <div>
      <span data-testid="status">{f.status}</span>
      <span data-testid="placements">{f.placements.length}</span>
      <span data-testid="units">{f.units.length}</span>
      <span data-testid="sent">{f.listingsSent.status}</span>
      <span data-testid="groups">{f.relayGroups.status}</span>
      <span data-testid="groupCount">
        {f.relayGroups.status === 'ready' ? f.relayGroups.rows.length : ''}
      </span>
      <button type="button" onClick={f.refetch}>
        refetch file
      </button>
    </div>
  );
}

const CASES: PlacementItem[] = [{ placementId: 'a', tenantId: 'k1', unitId: 'u1', stage: 'schedule_inspection' }];
const UNITS: UnitItem[] = [{ unitId: 'u1', landlordId: 'k1', status: 'available' }];

beforeEach(() => {
  getAllPlacements.mockReset();
  getAllUnits.mockReset();
  getContactListingsSent.mockReset();
  getContactRelayGroups.mockReset();
  getContactGroupThreads.mockReset();
  getContactGroupThreads.mockResolvedValue({ groups: [], truncated: false });
  getTours.mockReset();
});

/** A promise the test resolves by hand, so a read can be held in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe('useContactFile', () => {
  it('a contactType that arrives after mount does not re-read the slices (one read each)', async () => {
    // ContactDetail passes { contactType: contact?.type }, and the contact
    // header loads separately, so the type is undefined on the first render and
    // set a moment later. Only the tours fan-out needs it: the placements, units
    // and the three slice reads must not be aborted and re-sent when it arrives.
    // One full e2e run counted 585 such cancel-and-resend pairs (relay-groups
    // 209, group-threads 194, listings-sent 182) - a production double fetch,
    // not an e2e artifact (reviews/2026-10-20-e2e-connection-churn, section 4).
    const gate = deferred<void>();
    getAllPlacements.mockImplementation(() => gate.promise.then(() => CASES));
    getAllUnits.mockImplementation(() => gate.promise.then(() => UNITS));
    getContactListingsSent.mockImplementation(() => gate.promise.then(() => []));
    getContactRelayGroups.mockImplementation(() => gate.promise.then(() => []));
    getContactGroupThreads.mockImplementation(() =>
      gate.promise.then(() => ({ groups: [], truncated: false })),
    );
    getTours.mockResolvedValue([]);

    const { result, rerender } = renderHook(
      ({ contactType }: { contactType?: string }) =>
        useContactFile('k1', contactType === undefined ? {} : { contactType }),
      { initialProps: {} },
    );
    expect(getContactRelayGroups).toHaveBeenCalledTimes(1);

    // The header lands while the slice reads are still in flight.
    rerender({ contactType: 'tenant' });
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(getAllPlacements).toHaveBeenCalledTimes(1);
    expect(getAllUnits).toHaveBeenCalledTimes(1);
    expect(getContactListingsSent).toHaveBeenCalledTimes(1);
    expect(getContactRelayGroups).toHaveBeenCalledTimes(1);
    expect(getContactGroupThreads).toHaveBeenCalledTimes(1);
    // The tours fan-out still runs, once, now that the type is known.
    expect(getTours).toHaveBeenCalledTimes(1);
    expect(getTours).toHaveBeenCalledWith({ tenantId: 'k1' }, expect.anything());
  });

  it('a contactType that arrives AFTER the file committed reads tours alone, keeping the committed rows', async () => {
    // The slow-header case: the five reads landed first, so the file is ready
    // with no tours. The type then lands. Tours are read on their own and
    // patched in; the slices are not re-read, and the pane never flashes.
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockResolvedValue([]);
    getContactRelayGroups.mockResolvedValue([]);
    const tour = { tourId: 't1', tenantId: 'k1', unitId: 'u1', tourType: 'landlord_led', status: 'scheduled' };
    getTours.mockResolvedValue([tour]);

    const { result, rerender } = renderHook(
      ({ contactType }: { contactType?: string }) =>
        useContactFile('k1', contactType === undefined ? {} : { contactType }),
      { initialProps: {} },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.tours).toEqual([]);
    expect(getTours).not.toHaveBeenCalled();

    rerender({ contactType: 'tenant' });
    await waitFor(() => expect(result.current.tours).toEqual([tour]));

    expect(result.current.status).toBe('ready');
    expect(result.current.placements).toEqual(CASES);
    expect(getTours).toHaveBeenCalledTimes(1);
    expect(getAllPlacements).toHaveBeenCalledTimes(1);
    expect(getContactListingsSent).toHaveBeenCalledTimes(1);
    expect(getContactRelayGroups).toHaveBeenCalledTimes(1);
    expect(getContactGroupThreads).toHaveBeenCalledTimes(1);
  });

  it('a landlord type that arrives in flight fans tours out per owned unit, once, from the units just read', async () => {
    const gate = deferred<void>();
    getAllPlacements.mockImplementation(() => gate.promise.then(() => CASES));
    getAllUnits.mockImplementation(() =>
      gate.promise.then(() => [
        { unitId: 'u1', landlordId: 'k1', status: 'available' },
        { unitId: 'u2', landlordId: 'k1', status: 'available' },
        { unitId: 'u9', landlordId: 'someone-else', status: 'available' },
      ]),
    );
    getContactListingsSent.mockImplementation(() => gate.promise.then(() => []));
    getContactRelayGroups.mockImplementation(() => gate.promise.then(() => []));
    getTours.mockImplementation((q: { unitId: string }) =>
      Promise.resolve([{ tourId: `t-${q.unitId}`, tenantId: 'x', unitId: q.unitId, tourType: 'landlord_led', status: 'scheduled' }]),
    );

    const { result, rerender } = renderHook(
      ({ contactType }: { contactType?: string }) =>
        useContactFile('k1', contactType === undefined ? {} : { contactType }),
      { initialProps: {} },
    );
    rerender({ contactType: 'landlord' });
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.tours.map((t) => t.tourId)).toEqual(['t-u1', 't-u2']);
    expect(getTours).toHaveBeenCalledTimes(2);
    expect(getAllUnits).toHaveBeenCalledTimes(1);
    expect(getContactRelayGroups).toHaveBeenCalledTimes(1);
  });

  it('loads placements + units and marks C4/C5 + relay-groups pending on a 404', async () => {
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('placements').textContent).toBe('1');
    expect(screen.getByTestId('units').textContent).toBe('1');
    expect(screen.getByTestId('sent').textContent).toBe('pending');
    expect(screen.getByTestId('groups').textContent).toBe('pending');
  });

  it('keeps every property a landlord owns, not just the first server page', async () => {
    // The contact file's units back the landlord's "Properties" panel AND the
    // per-unit tours fan-out, so a first-page-only read dropped both for anyone
    // whose properties sat later in the scan. getAllUnits now hands over the
    // whole walked roster (api/lists.test.ts proves the walk).
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue([
        { unitId: 'u1', landlordId: 'k1', status: 'available' },
        { unitId: 'u2', landlordId: 'k1', status: 'available' },
      ]);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('units').textContent).toBe('2');
  });

  it('marks C4/C5 + relay-groups ready when those endpoints answer', async () => {
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockResolvedValue([]);
    getContactRelayGroups.mockResolvedValue([
      {
        conversationId: 'conv-g1',
        status: 'open',
        poolNumber: '+15550190001',
        memberCount: 2,
        lastActivityAt: '2026-07-01T10:00:00Z',
        owner: { type: null },
        otherMemberNames: [],
      },
    ]);

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('sent').textContent).toBe('ready');
    expect(screen.getByTestId('groups').textContent).toBe('ready');
    expect(screen.getByTestId('groupCount').textContent).toBe('1');
  });

  it('refetch() re-reads the slices for the SAME contact, without flashing loading', async () => {
    // The file fetched once, on mount. A write made elsewhere on the page (the
    // standalone relay-group create) has no SSE handler here, so the page needs
    // a way to ask for the rows again - and the panes must keep rendering the
    // rows they already have while it is in flight.
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockResolvedValueOnce([]).mockResolvedValue([
      {
        conversationId: 'conv-new',
        status: 'open',
        poolNumber: '+15550190002',
        memberCount: 2,
        lastActivityAt: '2026-08-17T10:00:00Z',
        owner: { type: null },
        otherMemberNames: ['Marcus Bell'],
      },
    ]);

    render(<Probe contactId="k1" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('groupCount').textContent).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: 'refetch file' }));

    await waitFor(() => expect(screen.getByTestId('groupCount').textContent).toBe('1'));
    expect(screen.getByTestId('status').textContent).toBe('ready');
    expect(getContactRelayGroups).toHaveBeenCalledTimes(2);
  });

  it('a FAILED refetch keeps the committed rows on screen instead of wiping the pane', async () => {
    // A reload is not a load. The pane's only error copy replaces EVERY card
    // (placements, tours, properties, relay groups, group threads, media) with
    // one sentence and no retry affordance - an honest answer on mount, and a
    // wipe of good rows when the refetch fired by a SUCCESSFUL create happens to
    // fail. Its failure surface is wide (placements + every /api/units page +,
    // on a landlord file, one getTours per owned unit), so this is not exotic.
    // A stale card is what the card was before the refetch existed.
    getAllPlacements.mockResolvedValueOnce(CASES).mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockResolvedValue([
      {
        conversationId: 'conv-g1',
        status: 'open',
        poolNumber: '+15550190001',
        memberCount: 2,
        lastActivityAt: '2026-07-01T10:00:00Z',
        owner: { type: null },
        otherMemberNames: ['Marcus Bell'],
      },
    ]);

    render(<Probe contactId="k1" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));

    fireEvent.click(screen.getByRole('button', { name: 'refetch file' }));
    await waitFor(() => expect(getAllPlacements).toHaveBeenCalledTimes(2));

    // The refetch failed and the file is merely STALE: same status, same rows.
    expect(screen.getByTestId('status').textContent).toBe('ready');
    expect(screen.getByTestId('placements').textContent).toBe('1');
    expect(screen.getByTestId('groups').textContent).toBe('ready');
    expect(screen.getByTestId('groupCount').textContent).toBe('1');
  });

  it('surfaces an error when placements fail', async () => {
    getAllPlacements.mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });

  it('setListingSentRow replaces ONE Properties-sent row, bound to the contact it was called for', async () => {
    const r1 = { contactId: 'k1', unitId: 'u1', sentAt: '2026-10-01T10:00:00.000Z', via: 'broadcast' as const, outcome: 'no_reply' as const, interestedSupported: true };
    const r2 = { ...r1, unitId: 'u2' };
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockResolvedValue([r1, r2]);
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    const { result } = renderHook(() => useContactFile('k1'));
    await waitFor(() => expect(result.current.listingsSent.status).toBe('ready'));

    const replied = { ...r2, outcome: 'replied' as const };
    act(() => result.current.setListingSentRow('k1', 'u2', replied));
    expect(result.current.listingsSent).toEqual({ status: 'ready', rows: [r1, replied] });
    act(() => result.current.setListingSentRow('someone-else', 'u1', { ...r1, outcome: 'replied' }));
    expect(result.current.listingsSent).toEqual({ status: 'ready', rows: [r1, replied] });
  });
});
