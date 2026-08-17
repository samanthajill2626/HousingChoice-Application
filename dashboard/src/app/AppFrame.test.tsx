import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App.js';

// A bare factory: it replaces the WHOLE module and vitest does not type-check it
// against the real shape, so every field the context gains has to be added here
// by hand (a missing function would be a runtime TypeError, not a compile error).
vi.mock('./UnreadContext.js', () => ({
  UnreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUnread: () => ({
    unread: 4,
    unmatchedUnread: null,
    noteRowsCleared: () => {},
    rollbackRowsCleared: () => {},
  }),
}));

// Render the whole app authenticated as the seeded VA (mock /auth/me 200), so
// the AppFrame mounts with a real AuthContext + router.
function renderAuthedApp(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/auth/me')) {
        return new Response(
          JSON.stringify({ userId: 'u1', email: 'va@example.com', role: 'va' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
}

// Stub matchMedia so useNavChrome resolves the nav breakpoint. `matches` = "we're
// below 768px" → drawer mode. Without a stub matchMedia is undefined in jsdom and
// the hook defaults to desktop (sidebar) — which is what the non-mobile tests want.
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('AppFrame', () => {
  it('renders the two nav groups with every destination as a link', async () => {
    renderAuthedApp();
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeInTheDocument(),
    );

    const workspace = screen.getByRole('navigation', { name: 'Workspace' });
    for (const label of ['Today', 'Placements', 'Tours', 'Contacts', 'Tenants', 'Landlords', 'Unknown', 'Properties']) {
      expect(within(workspace).getByRole('link', { name: label })).toBeInTheDocument();
    }

    const comms = screen.getByRole('navigation', { name: 'Communications' });
    for (const label of ['Inbox', 'Matching']) {
      expect(within(comms).getByRole('link', { name: label })).toBeInTheDocument();
    }

    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('Contacts is a parent with Tenants/Landlords/Unknown children', async () => {
    renderAuthedApp();
    const tenants = await screen.findByRole('link', { name: 'Tenants' });
    expect(tenants).toHaveAttribute('href', '/contacts/tenants');
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute('href', '/contacts');
  });

  it('account menu shows the user email and a Sign out action', async () => {
    renderAuthedApp();
    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('va@example.com')).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: /Sign out/i })).toBeInTheDocument();
  });

  it('Sign out forgets the browser push subscription (best-effort) and still logs out', async () => {
    // Server-side revocation drops the user's push subscriptions; the
    // signing-out browser also unsubscribes itself so its Settings toggle
    // does not keep reading On for a subscription the server no longer has.
    const unsubscribe = vi.fn(async () => true);
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: {
        ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ unsubscribe }) } }),
      },
    });
    renderAuthedApp();
    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Sign out/i }));

    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/auth/logout'))).toBe(true),
    );
  });

  it('Sign out still logs out when the browser unsubscribe throws', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => ({
              unsubscribe: async () => {
                throw new Error('push service down');
              },
            }),
          },
        }),
      },
    });
    renderAuthedApp();
    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Sign out/i }));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/auth/logout'))).toBe(true),
    );
  });

  it('shows the Inbox unread badge from the unread provider', async () => {
    renderAuthedApp();
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Communications' })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('4 unread')).toBeInTheDocument();
  });

  it('desktop: collapses to the rail, persists the choice, and keeps links reachable by name', async () => {
    renderAuthedApp();
    const collapse = await screen.findByRole('button', { name: 'Collapse navigation' });
    expect(collapse).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(collapse);

    // The toggle flips to Expand + pressed, and the choice is persisted.
    const expand = screen.getByRole('button', { name: 'Expand navigation' });
    expect(expand).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('hc.nav.collapsed')).toBe('1');
    // Labels are visually hidden in the rail, but the accessible name survives
    // (aria-label), so navigation stays usable for AT + tests.
    expect(screen.getByRole('link', { name: 'Today' })).toBeInTheDocument();
  });

  it('desktop: starts collapsed when the saved preference is collapsed', async () => {
    window.localStorage.setItem('hc.nav.collapsed', '1');
    renderAuthedApp();
    expect(await screen.findByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
  });

  it('mobile: hamburger opens the drawer, moves focus in; Escape closes it and restores focus', async () => {
    stubMatchMedia(true);
    renderAuthedApp();
    const hamburger = await screen.findByRole('button', { name: 'Open navigation' });
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(hamburger);
    expect(hamburger).toHaveAttribute('aria-expanded', 'true');
    const drawer = document.getElementById('nav-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer).not.toHaveAttribute('aria-hidden');
    // Focus moved into the drawer.
    expect(drawer!.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    expect(drawer).toHaveAttribute('aria-hidden', 'true');
    // Focus restored to the hamburger.
    expect(document.activeElement).toBe(hamburger);
  });

  it('mobile: tapping a drawer link closes the drawer', async () => {
    stubMatchMedia(true);
    renderAuthedApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Open navigation' }));
    const drawer = document.getElementById('nav-drawer')!;
    fireEvent.click(within(drawer).getByRole('link', { name: 'Inbox' }));
    expect(drawer).toHaveAttribute('aria-hidden', 'true');
  });
});
