import { render, waitFor } from '@testing-library/react';
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
});
