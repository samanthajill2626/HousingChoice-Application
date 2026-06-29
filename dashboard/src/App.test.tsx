import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub the heavy detail pages so these tests exercise ROUTING only (each detail
// page has its own dedicated render tests). The stubs read the dynamic segment
// so we can assert the right :param resolved into the right route.
vi.mock('./routes/contact/ContactDetail.js', () => ({
  ContactDetail: () => <div data-testid="contact-detail" />,
}));
vi.mock('./routes/listing/ListingDetail.js', () => ({
  ListingDetail: () => <div data-testid="listing-detail" />,
}));

import App from './App.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('App', () => {
  it('renders the HousingChoice shell once authenticated', async () => {
    mockApi();
    renderAt('/');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'HousingChoice' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
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
