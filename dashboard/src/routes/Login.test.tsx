import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Login from './Login.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Login', () => {
  it('always offers Google sign-in', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, {})));
    render(<Login />);
    const link = screen.getByRole('link', { name: /Sign in with Google/i });
    expect(link).toHaveAttribute('href', '/auth/login');
  });

  it('hides the dev-login button when /__dev/ping is absent (fails closed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: 'not_found' })));
    render(<Login />);
    // Give the probe a tick to resolve; the dev button must NOT appear.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Sign in with Google/i })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: /Continue as dev user/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the dev-login button when /__dev/ping reports { dev: true }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: unknown[]) => {
        const url = String(args[0]);
        if (url.includes('/__dev/ping')) return json(200, { dev: true });
        return json(404, {});
      }),
    );
    render(<Login />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Continue as dev user/i }),
      ).toBeInTheDocument(),
    );
  });
});
