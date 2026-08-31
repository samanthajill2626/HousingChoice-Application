import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the heavy detail pages so these tests exercise ROUTING only (each detail
// page has its own dedicated render tests). The stubs read the dynamic segment
// so we can assert the right :param resolved into the right route.
vi.mock('./routes/contact/ContactDetail.js', async () => {
  const { useLocation } = await import('react-router-dom');
  const { useImageViewer } = await import('./ui/imageViewer/ImageViewerProvider.js');

  function AuthViewerProof(): React.JSX.Element {
    const { openImage } = useImageViewer();
    return (
      <button
        type="button"
        onClick={(event) =>
          openImage(
            {
              src: '/api/messages/MMAUTH1/media/0',
              alt: 'Principal A secret.jpg',
              title: 'Principal A secret.jpg',
            },
            event.currentTarget,
          )
        }
      >
        View Principal A secret.jpg
      </button>
    );
  }

  function ContactDetail(): React.JSX.Element {
    const location = useLocation();
    return location.pathname === '/contacts/viewer-auth-proof' ? (
      <AuthViewerProof />
    ) : (
      <div data-testid="contact-detail" />
    );
  }

  return { ContactDetail };
});
vi.mock('./routes/listing/ListingDetail.js', () => ({
  ListingDetail: () => <div data-testid="listing-detail" />,
}));

import App from './App.js';
import {
  createEnvironmentIdentityLoader,
  type EnvironmentIdentityLoader,
} from './app/EnvironmentIdentity.js';
import { getAppIdentityRaw } from './api/index.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// A by-URL fetch stub: /auth/me authenticates; the list/detail endpoints return
// minimal valid shapes so the real pages render. Anything else 404s (the list
// hooks degrade gracefully). This lets the routing tests drive the actual pages.
function mockApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/app-identity/config.json')) {
        return Promise.resolve(
          json({ variant: 'non-production', themeColor: '#f4c542' }),
        );
      }
      if (url.includes('/auth/me')) {
        return Promise.resolve(json({ userId: 'u1', email: 'va@example.com', role: 'va' }));
      }
      if (url.includes('/api/contacts/')) {
        return Promise.resolve(
          json({ contact: { contactId: 'c1', type: 'tenant', firstName: 'Tasha', lastName: 'Williams' } }),
        );
      }
      if (url.includes('/api/contacts')) {
        return Promise.resolve(
          json({ contacts: [{ contactId: 'c1', type: 'tenant', firstName: 'Tasha', lastName: 'Williams' }], nextCursor: null }),
        );
      }
      if (url.includes('/api/units/')) {
        return Promise.resolve(json({ unit: { unitId: 'u1', landlordId: 'l1', status: 'available' } }));
      }
      if (url.includes('/api/units')) {
        return Promise.resolve(json({ units: [{ unitId: 'u1', landlordId: 'l1', status: 'available' }], nextCursor: null }));
      }
      return Promise.resolve(json({ error: 'not_found' }, 404));
    }),
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

afterEach(() => {
  document.querySelectorAll('meta[name="theme-color"]').forEach((node) => node.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function freshIdentityLoader(): EnvironmentIdentityLoader {
  return createEnvironmentIdentityLoader(getAppIdentityRaw);
}

function fetchCalls(): string[] {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

function renderAt(path: string, loadIdentity = freshIdentityLoader()): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App loadIdentity={loadIdentity} />
    </MemoryRouter>,
  );
}

async function traverseBrowserHistory(direction: 'back' | 'forward'): Promise<void> {
  await act(async () => {
    const popped = new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
    });
    window.history[direction]();
    await popped;
  });
}

describe('App', () => {
  it.each(['/join', '/p/missing-unit'])('%s stays public and never requests auth', async (path) => {
    mockApi();
    renderAt(path, freshIdentityLoader());

    await waitFor(() =>
      expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
        'content',
        '#f4c542',
      ),
    );
    expect(fetchCalls().some((url) => url.includes('/app-identity/config.json'))).toBe(true);
    expect(fetchCalls().some((url) => url.includes('/auth/me'))).toBe(false);
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
  });

  it('retains the catch-all auth probe before rendering Login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/app-identity/config.json')) {
          return Promise.resolve(
            json({ variant: 'non-production', themeColor: '#f4c542' }),
          );
        }
        if (url.includes('/auth/me')) return Promise.resolve(json({ error: 'unauthorized' }, 401));
        if (url.includes('/__dev/ping')) return Promise.resolve(json({ error: 'not_found' }, 404));
        return Promise.resolve(json({ error: 'not_found' }, 404));
      }),
    );

    renderAt('/', freshIdentityLoader());

    expect(await screen.findByRole('link', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(fetchCalls().some((url) => url.includes('/auth/me'))).toBe(true);
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
  });

  it('renders the HousingChoice shell once authenticated', async () => {
    mockApi();
    renderAt('/');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'HousingChoice' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });

  it('drops retained viewer descriptors on signout so Forward cannot cover Login', async () => {
    let authenticated = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/app-identity/config.json')) {
          return Promise.resolve(
            json({ variant: 'non-production', themeColor: '#f4c542' }),
          );
        }
        if (url.includes('/auth/logout')) {
          authenticated = false;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.includes('/auth/me')) {
          return authenticated
            ? Promise.resolve(json({ userId: 'u1', email: 'va@example.com', role: 'va' }))
            : Promise.resolve(json({ error: 'unauthorized' }, 401));
        }
        if (url.includes('/__dev/ping')) {
          return Promise.resolve(json({ error: 'not_found' }, 404));
        }
        return Promise.resolve(json({ error: 'not_found' }, 404));
      }),
    );
    window.history.replaceState(
      { usr: null, key: 'auth-viewer-entry', idx: 0 },
      '',
      '/contacts/viewer-auth-proof',
    );
    const user = userEvent.setup();

    render(
      <BrowserRouter>
        <App loadIdentity={freshIdentityLoader()} />
      </BrowserRouter>,
    );

    await user.click(
      await screen.findByRole('button', { name: 'View Principal A secret.jpg' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Principal A secret.jpg' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.history.state.idx).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(
      within(screen.getByRole('menu')).getByRole('button', { name: 'Sign out' }),
    );
    expect(await screen.findByRole('link', { name: 'Sign in with Google' })).toBeInTheDocument();

    await traverseBrowserHistory('forward');

    expect(screen.getByRole('link', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Principal A secret.jpg')).not.toBeInTheDocument();
    expect(
      document.body.querySelector('[data-image-viewer-portal="true"]'),
    ).not.toBeInTheDocument();
  });

  it('resolves the Contacts list at /contacts', async () => {
    mockApi();
    renderAt('/contacts');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Contacts' })).toBeInTheDocument(),
    );
  });

  it('resolves the filtered Tenants list at /contacts/tenants', async () => {
    mockApi();
    renderAt('/contacts/tenants');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Tenants' })).toBeInTheDocument(),
    );
  });

  it('still resolves the contact DETAIL page at /contacts/:contactId', async () => {
    mockApi();
    renderAt('/contacts/c1');
    // The dynamic detail route resolves (not the static Contacts list).
    await waitFor(() => expect(screen.getByTestId('contact-detail')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { level: 1, name: 'Contacts' })).not.toBeInTheDocument();
  });

  it('resolves the Properties list at /listings', async () => {
    mockApi();
    renderAt('/listings');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Properties' })).toBeInTheDocument(),
    );
  });

  it('still resolves the property DETAIL page at /listings/:unitId', async () => {
    mockApi();
    renderAt('/listings/u1');
    // The dynamic detail route resolves (not the static Properties list).
    await waitFor(() => expect(screen.getByTestId('listing-detail')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { level: 1, name: 'Properties' })).not.toBeInTheDocument();
  });
});
