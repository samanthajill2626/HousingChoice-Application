// Smoke tests for endpoint functions — mock the transport layer (client.js) so
// these verify call shape and unwrapping only, never a real network.
import { vi, it, expect, beforeEach } from 'vitest';

vi.mock('./client.js', () => ({
  request: vi.fn(() => Promise.resolve({ contact: { contactId: 'c9', type: 'tenant' } })),
}));

import { request } from './client.js';
import {
  buildTransitionBody,
  createContact,
  createPlacementFromTour,
  createTour,
  createTourRelay,
  getTours,
  getPlacement,
  getContactVocabulary,
  getPlacementHistory,
  setListingStatus,
  setTenantStatus,
  transitionPlacement,
  updatePlacement,
  validateLostReason,
} from './endpoints.js';

beforeEach(() => {
  vi.mocked(request).mockReset();
});

it('createContact posts and unwraps', async () => {
  vi.mocked(request).mockResolvedValueOnce({ contact: { contactId: 'c9', type: 'tenant' } });
  const c = await createContact({ type: 'tenant', firstName: 'A' });
  expect(request).toHaveBeenCalledWith('/api/contacts', {
    method: 'POST',
    body: { type: 'tenant', firstName: 'A' },
  });
  expect(c).toEqual({ contactId: 'c9', type: 'tenant' });
});

it('getContactVocabulary GETs and unwraps vocabulary', async () => {
  const vocab = { roles: ['case_manager'], relationshipRoles: ['spouse'], fieldLabels: ['Notes'] };
  vi.mocked(request).mockResolvedValueOnce({ vocabulary: vocab });
  const result = await getContactVocabulary();
  expect(request).toHaveBeenCalledWith('/api/contacts/vocabulary', {});
  expect(result).toEqual(vocab);
});

it('getContactVocabulary forwards signal when provided', async () => {
  const vocab = { roles: [], relationshipRoles: [], fieldLabels: [] };
  vi.mocked(request).mockResolvedValueOnce({ vocabulary: vocab });
  const controller = new AbortController();
  await getContactVocabulary(controller.signal);
  expect(request).toHaveBeenCalledWith('/api/contacts/vocabulary', {
    signal: controller.signal,
  });
});

// --- Status-model transition endpoints --------------------------------------

it('getPlacement GETs and unwraps { placement }', async () => {
  vi.mocked(request).mockResolvedValueOnce({ placement: { placementId: 'k1', stage: 'collect_rta' } });
  const c = await getPlacement('k1');
  expect(request).toHaveBeenCalledWith('/api/placements/k1', {});
  expect(c).toEqual({ placementId: 'k1', stage: 'collect_rta' });
});

it('transitionPlacement POSTs the body and unwraps { placement }', async () => {
  vi.mocked(request).mockResolvedValueOnce({ placement: { placementId: 'k1', stage: 'review_rta' } });
  const c = await transitionPlacement('k1', { toStage: 'review_rta', source: 'manual' });
  expect(request).toHaveBeenCalledWith('/api/placements/k1/transition', {
    method: 'POST',
    body: { toStage: 'review_rta', source: 'manual' },
  });
  expect(c).toEqual({ placementId: 'k1', stage: 'review_rta' });
});

it('transitionPlacement carries finalRent/inspectionOutcome/lostReason only when set', async () => {
  vi.mocked(request).mockResolvedValueOnce({ placement: { placementId: 'k1' } });
  await transitionPlacement('k1', {
    toStage: 'awaiting_hap_contract',
    source: 'manual',
    finalRent: 1550,
    inspectionOutcome: 'pass',
  });
  expect(request).toHaveBeenCalledWith('/api/placements/k1/transition', {
    method: 'POST',
    body: { toStage: 'awaiting_hap_contract', source: 'manual', finalRent: 1550, inspectionOutcome: 'pass' },
  });
});

it('transitionPlacement throws (no request) when a lost move has no reason', async () => {
  await expect(
    transitionPlacement('k1', { toStage: 'lost', source: 'manual' }),
  ).rejects.toThrow(/reason/i);
  expect(request).not.toHaveBeenCalled();
});

it('transitionPlacement allows a lost move with a category', async () => {
  vi.mocked(request).mockResolvedValueOnce({ placement: { placementId: 'k1', stage: 'lost' } });
  await transitionPlacement('k1', {
    toStage: 'lost',
    source: 'manual',
    lostReason: { category: 'tenant_withdrew' },
  });
  expect(request).toHaveBeenCalledWith('/api/placements/k1/transition', {
    method: 'POST',
    body: { toStage: 'lost', source: 'manual', lostReason: { category: 'tenant_withdrew' } },
  });
});

it('getPlacementHistory GETs with query and unwraps { history }', async () => {
  vi.mocked(request).mockResolvedValueOnce({ history: [{ entityKey: 'placements#k1', event_type: 'transition', ts: 't' }] });
  const rows = await getPlacementHistory('k1', { limit: 10, before: 'cur' });
  expect(request).toHaveBeenCalledWith('/api/placements/k1/history', {
    query: { limit: 10, before: 'cur' },
  });
  expect(rows).toHaveLength(1);
});

it('setTenantStatus PATCHes tenant-status and unwraps { contact }', async () => {
  vi.mocked(request).mockResolvedValueOnce({ contact: { contactId: 'c1', status: 'searching' } });
  const c = await setTenantStatus('c1', { toStatus: 'searching', source: 'manual', porting: true });
  expect(request).toHaveBeenCalledWith('/api/contacts/c1/tenant-status', {
    method: 'PATCH',
    body: { toStatus: 'searching', source: 'manual', porting: true },
  });
  expect(c).toEqual({ contactId: 'c1', status: 'searching' });
});

it('setListingStatus PATCHes listing-status and unwraps { unit }', async () => {
  vi.mocked(request).mockResolvedValueOnce({ unit: { unitId: 'u1', status: 'off_market' } });
  const u = await setListingStatus('u1', { toStatus: 'off_market', source: 'manual' });
  expect(request).toHaveBeenCalledWith('/api/units/u1/listing-status', {
    method: 'PATCH',
    body: { toStatus: 'off_market', source: 'manual' },
  });
  expect(u).toEqual({ unitId: 'u1', status: 'off_market' });
});

it('updatePlacement PATCHes /api/placements/:id and unwraps { placement }', async () => {
  vi.mocked(request).mockResolvedValueOnce({ placement: { placementId: 'k1', lease_signed: true } });
  const p = await updatePlacement('k1', { lease_signed: true });
  expect(request).toHaveBeenCalledWith('/api/placements/k1', {
    method: 'PATCH',
    body: { lease_signed: true },
  });
  expect(p).toEqual({ placementId: 'k1', lease_signed: true });
});

it('createPlacementFromTour POSTs { tourId } and returns the { placement, tour } envelope', async () => {
  const placement = { placementId: 'k1', tenantId: 'c1', unitId: 'u1', stage: 'send_application', fromTourId: 't1' };
  const tour = { tourId: 't1', tenantId: 'c1', unitId: 'u1', tourType: 'self_guided', status: 'closed', convertedPlacementId: 'k1' };
  vi.mocked(request).mockResolvedValueOnce({ placement, tour });
  const res = await createPlacementFromTour('t1');
  expect(request).toHaveBeenCalledWith('/api/placements/from-tour', {
    method: 'POST',
    body: { tourId: 't1' },
  });
  expect(res.placement).toEqual(placement);
  expect(res.tour).toEqual(tour);
});

it('createPlacementFromTour propagates a non-2xx rejection (e.g. 409 tour_already_converted)', async () => {
  vi.mocked(request).mockRejectedValueOnce(new Error('tour_already_converted'));
  await expect(createPlacementFromTour('t1')).rejects.toThrow(/tour_already_converted/);
});

// --- Tours -------------------------------------------------------------------

it('createTour posts WITHOUT scheduledAt when absent (timeless / requested) and unwraps { tour }', async () => {
  const tour = { tourId: 't1', tenantId: 'c1', unitId: 'u1', tourType: 'self_guided', status: 'requested' };
  vi.mocked(request).mockResolvedValueOnce({ tour });
  const t = await createTour({ tenantId: 'c1', unitId: 'u1', tourType: 'self_guided' });
  expect(request).toHaveBeenCalledWith('/api/tours', {
    method: 'POST',
    body: { tenantId: 'c1', unitId: 'u1', tourType: 'self_guided' },
  });
  // The key must be OMITTED, not sent as undefined.
  const sent = vi.mocked(request).mock.calls[0]![1] as { body: Record<string, unknown> };
  expect('scheduledAt' in sent.body).toBe(false);
  expect(t).toEqual(tour);
});

it('createTour posts WITH scheduledAt when present', async () => {
  const tour = {
    tourId: 't1',
    tenantId: 'c1',
    unitId: 'u1',
    tourType: 'pm_team',
    status: 'scheduled',
    scheduledAt: '2026-07-15T14:00:00.000Z',
  };
  vi.mocked(request).mockResolvedValueOnce({ tour });
  await createTour({
    tenantId: 'c1',
    unitId: 'u1',
    tourType: 'pm_team',
    scheduledAt: '2026-07-15T14:00:00.000Z',
  });
  expect(request).toHaveBeenCalledWith('/api/tours', {
    method: 'POST',
    body: { tenantId: 'c1', unitId: 'u1', tourType: 'pm_team', scheduledAt: '2026-07-15T14:00:00.000Z' },
  });
});

it('createTourRelay WITHOUT members posts an empty body (server auto-resolves)', async () => {
  const tour = { tourId: 't1', tenantId: 'c1', unitId: 'u1', groupThreadId: 'conv-9' };
  vi.mocked(request).mockResolvedValueOnce({ tour, conversation: { conversationId: 'conv-9' } });
  const res = await createTourRelay('t1');
  expect(request).toHaveBeenCalledWith('/api/tours/t1/relay', { method: 'POST', body: {} });
  // The members key must be OMITTED entirely, never sent as undefined.
  const sent = vi.mocked(request).mock.calls[0]![1] as { body: Record<string, unknown> };
  expect('members' in sent.body).toBe(false);
  expect(res.tour).toEqual(tour);
});

it('createTourRelay WITH explicit members posts them unchanged', async () => {
  vi.mocked(request).mockResolvedValueOnce({ tour: { tourId: 't1' }, conversation: {} });
  const members = [{ phone: '+15550001111', name: 'Tina Tenant' }];
  await createTourRelay('t1', members);
  expect(request).toHaveBeenCalledWith('/api/tours/t1/relay', {
    method: 'POST',
    body: { members },
  });
});

it('getTours forwards status as a sole query filter and unwraps { tours }', async () => {
  const tours = [{ tourId: 't1', tenantId: 'c1', unitId: 'u1', tourType: 'self_guided', status: 'requested' }];
  vi.mocked(request).mockResolvedValueOnce({ tours });
  const res = await getTours({ status: 'requested' });
  expect(request).toHaveBeenCalledWith('/api/tours', { query: { status: 'requested' } });
  // Only the status key is forwarded — the other (undefined) filters are omitted.
  const sent = vi.mocked(request).mock.calls[0]![1] as { query: Record<string, unknown> };
  expect(Object.keys(sent.query)).toEqual(['status']);
  expect(res).toEqual(tours);
});

it('getTours forwards from/to together (window query) and unwraps { tours }', async () => {
  vi.mocked(request).mockResolvedValueOnce({ tours: [] });
  await getTours({ from: '2026-07-01T00:00:00Z', to: '2026-07-02T00:00:00Z' });
  expect(request).toHaveBeenCalledWith('/api/tours', {
    query: { from: '2026-07-01T00:00:00Z', to: '2026-07-02T00:00:00Z' },
  });
});

// --- Pure helpers (no transport) --------------------------------------------

it('buildTransitionBody omits undefined fields', () => {
  expect(buildTransitionBody({ toStage: 'collect_rta', source: 'manual' })).toEqual({
    toStage: 'collect_rta',
    source: 'manual',
  });
  expect(
    buildTransitionBody({
      toStage: 'awaiting_rent_acceptance',
      source: 'ai',
      reason: 'r',
      finalRent: 1200,
    }),
  ).toEqual({ toStage: 'awaiting_rent_acceptance', source: 'ai', reason: 'r', finalRent: 1200 });
});

it('validateLostReason requires a category OR non-empty trimmed text', () => {
  expect(validateLostReason(undefined)).toBe(false);
  expect(validateLostReason({})).toBe(false);
  expect(validateLostReason({ text: '   ' })).toBe(false);
  expect(validateLostReason({ category: 'stalled' })).toBe(true);
  expect(validateLostReason({ text: 'gave up' })).toBe(true);
});
