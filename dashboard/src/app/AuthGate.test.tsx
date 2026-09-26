// The store clear must run AFTER the Inbox's unmount save. React runs every
// LAYOUT cleanup of a deleted subtree before any PASSIVE cleanup or effect, so
// a passive effect in the surviving AuthGate runs after that save (a layout
// cleanup). Only a LAYOUT cleanup in a deleted parent would run before it
// (layout cleanups run parent-first), and the save would then repopulate the
// store. Proven here with a child that saves from a LAYOUT-effect cleanup, the
// same phase useInbox saves in.
import { act, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from './AuthContext.js';
import { clearInboxLists, loadInboxList, saveInboxList } from '../routes/inbox/inboxListStore.js';

let auth: AuthState;
vi.mock('./AuthContext.js', async () => {
  const actual = await vi.importActual<typeof import('./AuthContext.js')>('./AuthContext.js');
  return { ...actual, useAuth: () => auth };
});
vi.mock('../routes/Login.js', () => ({ default: () => <div>login screen</div> }));

import { AuthGate } from './AuthGate.js';

function SavesOnUnmount(): React.JSX.Element {
  useLayoutEffect(
    () => () => {
      saveInboxList('u1:all:100', {
        head: [],
        tail: [],
        cursor: null,
        groupsTruncated: false,
        truncated: false,
        scrollTop: 7,
      });
    },
    [],
  );
  return <div>app</div>;
}

beforeEach(() => {
  clearInboxLists();
  auth = { status: 'authenticated', me: { userId: 'u1', email: 'a@b.c', role: 'admin' }, isAdmin: true, refresh: async () => {} };
});
afterEach(() => vi.restoreAllMocks());

describe('AuthGate', () => {
  it('clears the inbox list store after the authenticated subtree unmounts on sign-out', () => {
    const { rerender } = render(
      <AuthGate>
        <SavesOnUnmount />
      </AuthGate>,
    );
    expect(screen.getByText('app')).toBeInTheDocument();
    auth = { ...auth, status: 'anonymous', me: undefined, isAdmin: false };
    act(() => {
      rerender(
        <AuthGate>
          <SavesOnUnmount />
        </AuthGate>,
      );
    });
    expect(screen.getByText('login screen')).toBeInTheDocument();
    // The child's unmount save ran (layout cleanup) and the gate's passive
    // effect cleared it afterwards.
    expect(loadInboxList('u1:all:100')).toBeUndefined();
  });

  it('does not clear the store while authenticated', () => {
    saveInboxList('u1:all:100', { head: [], tail: [], cursor: null, groupsTruncated: false, truncated: false, scrollTop: 1 });
    render(
      <AuthGate>
        <div>app</div>
      </AuthGate>,
    );
    expect(loadInboxList('u1:all:100')?.scrollTop).toBe(1);
  });
});
