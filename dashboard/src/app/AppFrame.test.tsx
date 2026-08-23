import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.js';
import {
  createEnvironmentIdentityLoader,
  type EnvironmentIdentityLoader,
} from './EnvironmentIdentity.js';
import styles from './AppFrame.module.css';

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

// AppFrame owns the navigation event, not the async Inbox data lifecycle. Keep
// the destination inert so drawer-close assertions do not leak route effects.
vi.mock('../routes/inbox/Inbox.js', () => ({
  Inbox: () => <h1>Inbox</h1>,
}));

// Render the whole app authenticated as the seeded VA (mock /auth/me 200), so
// the AppFrame mounts with a real AuthContext + router.
function productionLoader(): EnvironmentIdentityLoader {
  return createEnvironmentIdentityLoader(async () => ({
    variant: 'production',
    themeColor: '#1f6feb',
  }));
}

function renderAuthedApp(loadIdentity = productionLoader()): void {
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
      // Sign-out succeeds (204) so a clicked Sign out never leaves an
      // unhandled rejection behind - the sign-out tests assert on the call.
      if (url.includes('/auth/logout')) {
        return new Response(null, { status: 204 });
      }
      // Push subscription POST (boot reconcile) / DELETE (sign-out) succeed.
      if (url.includes('/api/push/subscriptions')) {
        return new Response(JSON.stringify({ subscriptionCount: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  render(
    <MemoryRouter>
      <App loadIdentity={loadIdentity} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  document.querySelectorAll('meta[name="theme-color"]').forEach((node) => node.remove());
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = '#1f6feb';
  document.head.append(meta);
  expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
});

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
  document.querySelectorAll('meta[name="theme-color"]').forEach((node) => node.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('AppFrame', () => {
  it('keeps the existing shell class in production', async () => {
    renderAuthedApp(productionLoader());
    const main = await screen.findByRole('main');
    const shell = main.parentElement?.parentElement;
    expect(shell).toHaveClass(styles.shell!);
    expect(shell).not.toHaveClass(styles.nonProduction!);
  });

  it('adds only the non-production class to the existing shell without visible copy', async () => {
    const loader = createEnvironmentIdentityLoader(async () => ({
      variant: 'non-production',
      themeColor: '#f4c542',
    }));
    renderAuthedApp(loader);

    const main = await screen.findByRole('main');
    await waitFor(() =>
      expect(main.parentElement?.parentElement).toHaveClass(styles.nonProduction!),
    );
    expect(main.parentElement?.parentElement).toHaveClass(styles.shell!);
    expect(screen.queryByText(/^(DEV|LOCAL|environment)$/i)).not.toBeInTheDocument();
  });

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

  // A service-worker stub for the push tests. `.ready` NEVER settles on purpose
  // (it never resolves when nothing is registered - main.tsx says so); the app
  // must use getRegistration(), which resolves undefined in that case.
  function stubServiceWorker(subscription: unknown): void {
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: {
        ready: new Promise(() => {}),
        getRegistration: async () => ({
          pushManager: { getSubscription: async () => subscription },
        }),
      },
    });
  }

  function fetchCalls(): string[] {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    return fetchMock.mock.calls.map((c) => String(c[0]));
  }

  it('Sign out names THIS device push endpoint in the logout request and then drops the browser copy; other devices are untouched', async () => {
    // Option 2 (operator, 2026-08-17): sign-out is per-device for push. The
    // endpoint rides the logout body so the server removes it in the SAME
    // request as the revocation - nothing on the push side ever sits in front
    // of the sign-out request. The browser copy is dropped afterwards so the
    // toggle stays honest.
    const unsubscribe = vi.fn(async () => true);
    stubServiceWorker({
      endpoint: 'https://fcm.googleapis.com/send/this-device',
      unsubscribe,
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/send/this-device', keys: {} }),
    });
    renderAuthedApp();
    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Sign out/i }));

    await waitFor(() => expect(fetchCalls().some((u) => u.includes('/auth/logout'))).toBe(true));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const out = fetchMock.mock.calls.find((c) => String(c[0]).includes('/auth/logout'))!;
    const init = out[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      pushEndpoint: 'https://fcm.googleapis.com/send/this-device',
    });
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    // No separate DELETE round-trip any more.
    expect(
      fetchMock.mock.calls.some(
        (c) =>
          String(c[0]).includes('/api/push/subscriptions') &&
          (c[1] as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('Sign out still logs out when the browser unsubscribe throws', async () => {
    stubServiceWorker({
      unsubscribe: async () => {
        throw new Error('push service down');
      },
      toJSON: () => ({ endpoint: 'e', keys: {} }),
    });
    renderAuthedApp();
    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Sign out/i }));

    await waitFor(() => expect(fetchCalls().some((u) => u.includes('/auth/logout'))).toBe(true));
  });

  it('Sign out still logs out when NO service worker is registered (.ready would hang forever)', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: { ready: new Promise(() => {}), getRegistration: async () => undefined },
    });
    renderAuthedApp();
    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Sign out/i }));

    await waitFor(() => expect(fetchCalls().some((u) => u.includes('/auth/logout'))).toBe(true));
  });

  it('on boot, re-POSTs the browser push subscription so the server matches the device', async () => {
    // A server-side revocation (sign-out elsewhere, role change) drops the
    // subscriptions; the browser still holds its own. Reconciling on boot
    // makes the Settings toggle truthful by construction and re-arms push
    // without a Settings visit.
    const json = { endpoint: 'https://fcm.googleapis.com/send/x', keys: { p256dh: 'k', auth: 'a' } };
    stubServiceWorker({ toJSON: () => json, unsubscribe: async () => true });
    renderAuthedApp();
    await screen.findByRole('button', { name: 'Account menu' });
    await waitFor(() =>
      expect(fetchCalls().some((u) => u.includes('/api/push/subscriptions'))).toBe(true),
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
