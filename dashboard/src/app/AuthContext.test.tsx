import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './AuthContext.js';
import { AuthGate } from './AuthGate.js';

// A JSON Response helper for the stubbed fetch.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(impl: () => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderGated(): void {
  render(
    <AuthProvider>
      <AuthGate>
        <div>Authenticated content</div>
      </AuthGate>
    </AuthProvider>,
  );
}

describe('AuthContext + AuthGate', () => {
  it('shows the Login screen when /auth/me is 401 (anonymous)', async () => {
    stubFetch(async () => json(401, { error: 'unauthorized' }));
    renderGated();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Sign in with Google/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText('Authenticated content')).not.toBeInTheDocument();
  });

  it('renders children when /auth/me is 200 (authenticated)', async () => {
    stubFetch(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/auth/me')) {
        return json(200, { userId: 'u1', email: 'va@example.com', role: 'va' });
      }
      return json(404, { error: 'not_found' });
    });
    renderGated();
    await waitFor(() =>
      expect(screen.getByText('Authenticated content')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /Sign in with Google/i })).not.toBeInTheDocument();
  });
});
