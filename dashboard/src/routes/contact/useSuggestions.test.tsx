import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSuggestions = vi.fn();
const acceptSuggestion = vi.fn();
const dismissSuggestion = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSuggestions: (...a: unknown[]) => getSuggestions(...a),
    acceptSuggestion: (...a: unknown[]) => acceptSuggestion(...a),
    dismissSuggestion: (...a: unknown[]) => dismissSuggestion(...a),
    useEventStream: () => {},
  };
});

import { useSuggestions, type SuggestionsState } from './useSuggestions.js';

let latest: SuggestionsState | undefined;

function Probe(): React.JSX.Element {
  latest = useSuggestions('k1');
  return <div />;
}

beforeEach(() => {
  latest = undefined;
  getSuggestions.mockReset();
  acceptSuggestion.mockReset();
  dismissSuggestion.mockReset();
});

describe('useSuggestions', () => {
  it('rejects accept and dismiss with the not-pending sentinel when the target is not in its list', async () => {
    getSuggestions.mockResolvedValue([]);
    render(<Probe />);
    await waitFor(() => expect(getSuggestions).toHaveBeenCalled());

    // ContactDetail matches this EXACT message to show its own honest copy and
    // refetch the list, so the wording is a contract, not an implementation
    // detail. Nothing is sent to the server.
    await expect(latest!.accept('pets')).rejects.toThrow('Suggestion is no longer pending');
    await expect(latest!.dismiss('pets')).rejects.toThrow('Suggestion is no longer pending');
    expect(acceptSuggestion).not.toHaveBeenCalled();
    expect(dismissSuggestion).not.toHaveBeenCalled();
  });

  it('passes a chosen value through, and keeps the three-argument call without one', async () => {
    const at = '2026-07-16T10:00:00.000Z';
    const ha = {
      itemId: 'sugg#k1#housingAuthority',
      ownerContactId: 'k1',
      target: 'housingAuthority',
      suggestedValue: 'AHA',
      conversationId: 'conv-1',
      revision: 'rev-ha',
      runId: 'run-ha',
      createdAt: at,
    };
    const pets = { ...ha, itemId: 'sugg#k1#pets', target: 'pets', suggestedValue: 'a cat', revision: 'rev-pets', runId: 'run-pets' };
    getSuggestions.mockResolvedValue([ha, pets]);
    acceptSuggestion
      .mockResolvedValueOnce({ contact: { contactId: 'k1', type: 'tenant' }, suggestions: [ha] })
      .mockResolvedValueOnce({ contact: { contactId: 'k1', type: 'tenant' }, suggestions: [] });
    render(<Probe />);
    await waitFor(() => expect(latest!.suggestions).toHaveLength(2));

    await act(async () => {
      await latest!.accept('pets');
    });
    // No value: exactly three arguments (ContactDetail's accept tests pin it).
    expect(acceptSuggestion.mock.calls[0]).toHaveLength(3);
    expect(acceptSuggestion.mock.calls[0]).toStrictEqual([
      'k1',
      'pets',
      { revision: 'rev-pets', createdAt: at, runId: 'run-pets' },
    ]);

    await act(async () => {
      await latest!.accept('housingAuthority', 'Atlanta Housing Authority');
    });
    expect(acceptSuggestion.mock.calls[1]).toStrictEqual([
      'k1',
      'housingAuthority',
      { revision: 'rev-ha', createdAt: at, runId: 'run-ha' },
      'Atlanta Housing Authority',
    ]);
  });
});
