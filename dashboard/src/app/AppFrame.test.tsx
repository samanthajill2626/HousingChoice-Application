import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App.js';

vi.mock('./UnreadContext.js', () => ({
  UnreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUnread: () => ({ unread: 4 }),
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AppFrame', () => {
  it('renders the two nav groups with every destination as a link', async () => {
    renderAuthedApp();
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeInTheDocument(),
    );

    const workspace = screen.getByRole('navigation', { name: 'Workspace' });
    for (const label of ['Today', 'Cases', 'Contacts', 'Tenants', 'Landlords', 'Unknown', 'Listings']) {
      expect(within(workspace).getByRole('link', { name: label })).toBeInTheDocument();
    }

    const comms = screen.getByRole('navigation', { name: 'Communications' });
    for (const label of ['Inbox', 'Broadcasts']) {
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

  it('shows the Inbox unread badge from the unread provider', async () => {
    renderAuthedApp();
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Communications' })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('4 unread')).toBeInTheDocument();
  });
});
