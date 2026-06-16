// AppLayout tests — focus on M1: signing out clears THIS device's push
// subscription (shared-device PII leak) before logging out, tolerant of errors.
// We mock the api logout, the push module, and AuthContext; no network.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logout = vi.fn();
vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return { ...actual, logout: (...args: unknown[]) => logout(...args) };
});

const unsubscribeFromPush = vi.fn();
vi.mock('../push/index.js', () => ({
  unsubscribeFromPush: (...args: unknown[]) => unsubscribeFromPush(...args),
}));

const refresh = vi.fn();
const ME = { userId: 'u-1', email: 'va@hc.org', role: 'va' as const };
vi.mock('./AuthContext.js', () => ({
  useAuth: () => ({ status: 'authenticated', me: ME, isAdmin: false, refresh }),
}));

import { AppLayout } from './AppLayout.js';

function renderLayout(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppLayout />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  logout.mockResolvedValue(undefined);
  unsubscribeFromPush.mockResolvedValue(undefined);
  refresh.mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe('<AppLayout> sign out (M1)', () => {
  it('unsubscribes this device from push AND logs out on sign out', async () => {
    renderLayout();

    // Open the account menu, then click Sign out.
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(unsubscribeFromPush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('still logs out even if clearing the push subscription fails', async () => {
    unsubscribeFromPush.mockRejectedValue(new Error('no SW'));
    renderLayout();

    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    // The push failure must not block logout / refresh.
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
