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
  getPlacement,
  getContactVocabulary,
  getPlacementHistory,
  setListingStatus,
  setTenantStatus,
  transitionPlacement,
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
