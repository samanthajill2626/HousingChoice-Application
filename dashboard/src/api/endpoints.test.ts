// Smoke tests for endpoint functions — mock the transport layer (client.js) so
// these verify call shape and unwrapping only, never a real network.
import { vi, it, expect, beforeEach } from 'vitest';

vi.mock('./client.js', () => ({
  request: vi.fn(() => Promise.resolve({ contact: { contactId: 'c9', type: 'tenant' } })),
}));

import { request } from './client.js';
import { createContact, getContactVocabulary } from './endpoints.js';

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
