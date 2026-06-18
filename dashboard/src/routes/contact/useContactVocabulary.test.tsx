import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getContactVocabulary = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContactVocabulary: (...a: unknown[]) => getContactVocabulary(...a),
  };
});

import { useContactVocabulary } from './useContactVocabulary.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('useContactVocabulary', () => {
  it('returns the vocabulary lists after successful fetch', async () => {
    getContactVocabulary.mockResolvedValue({
      roles: ['Case worker'],
      relationshipRoles: ['Client'],
      fieldLabels: ['Agency'],
    });

    const { result } = renderHook(() => useContactVocabulary());

    await waitFor(() => {
      expect(result.current.roles).toEqual(['Case worker']);
    });
    expect(result.current.relationshipRoles).toEqual(['Client']);
    expect(result.current.fieldLabels).toEqual(['Agency']);
  });

  it('stays as empty lists on fetch error (best-effort, no throw)', async () => {
    getContactVocabulary.mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() => useContactVocabulary());

    // Give the async effect time to run and fail
    await waitFor(() => {
      expect(getContactVocabulary).toHaveBeenCalled();
    });

    // Wait a tick for the promise rejection to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(result.current).toEqual({
      roles: [],
      relationshipRoles: [],
      fieldLabels: [],
    });
  });
});
