import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const markInboxRead = vi.fn(() => Promise.resolve());
const noteRowsCleared = vi.fn();
const rollbackRowsCleared = vi.fn();
let capturedOnMessage: (() => void) | undefined;

// This auto-mark is DELIBERATELY unwired from the nav badge's optimistic layer:
// it fires BLIND on mount / tab-visibility / new message, with no unread
// knowledge at all, so an optimistic decrement here would subtract rows the badge
// may never have counted. It reconciles through the cheap count refetch instead.
vi.mock('../../app/UnreadContext.js', () => ({
  useUnread: () => ({ unread: null, unmatchedUnread: null, noteRowsCleared, rollbackRowsCleared }),
}));

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    markInboxRead: (...a: unknown[]) => markInboxRead(...(a as [])),
    useEventStream: (h: { onMessagePersisted?: () => void }) => {
      capturedOnMessage = h.onMessagePersisted;
    },
  };
});

import { useMarkContactRead } from './useMarkContactRead.js';

function Probe({ id }: { id: string }): null {
  useMarkContactRead(id);
  return null;
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

afterEach(() => {
  vi.clearAllMocks();
  capturedOnMessage = undefined;
  setVisibility('visible');
});

describe('useMarkContactRead', () => {
  it('marks the contact read on open (while visible)', async () => {
    render(<Probe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));
  });

  it('marks read again when a new message lands while looking', async () => {
    render(<Probe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    // Let the first call settle so the in-flight guard releases.
    await act(async () => {});
    act(() => capturedOnMessage?.());
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(2));
  });

  it('does NOT mark read when the tab is hidden (background tab)', () => {
    setVisibility('hidden');
    render(<Probe id="k1" />);
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it('does nothing without a contactId', () => {
    render(<Probe id="" />);
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it('marks read when the tab becomes visible again while on the page', async () => {
    setVisibility('hidden');
    render(<Probe id="k1" />);
    expect(markInboxRead).not.toHaveBeenCalled();
    setVisibility('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));
  });

  it('does NOT touch the nav badge context (it fires blind, with no unread knowledge)', async () => {
    render(<Probe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));
    act(() => capturedOnMessage?.());
    expect(noteRowsCleared).not.toHaveBeenCalled();
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });
});
