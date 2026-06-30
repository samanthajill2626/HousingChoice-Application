import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    // The admin button is gated the same way — also hidden.
    expect(
      screen.queryByRole('button', { name: /Continue as dev admin/i }),
    ).not.toBeInTheDocument();
  });

  it('shows BOTH dev-login buttons (VA + admin) when /__dev/ping reports { dev: true }', async () => {
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
    expect(
      screen.getByRole('button', { name: /Continue as dev admin/i }),
    ).toBeInTheDocument();
  });

  it('clicking "Continue as dev admin" logs in as the founder (admin) persona', async () => {
    // jsdom has no real navigation — capture window.location.assign so the
    // post-login reload doesn't throw. (vi.unstubAllGlobals restores it.)
    const assignMock = vi.fn();
    vi.stubGlobal('location', { assign: assignMock });

    const devLoginBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: unknown[]) => {
        const url = String(args[0]);
        const init = args[1] as RequestInit | undefined;
        if (url.includes('/__dev/ping')) return json(200, { dev: true });
        if (url.includes('/auth/dev-login')) {
          if (typeof init?.body === 'string') devLoginBodies.push(init.body);
          return json(200, { userId: 'u', email: 'founder@example.com', role: 'admin' });
        }
        return json(404, {});
      }),
    );

    const user = userEvent.setup();
    render(<Login />);
    const adminBtn = await screen.findByRole('button', { name: /Continue as dev admin/i });
    await user.click(adminBtn);

    // It POSTs the founder email and reloads into / so AuthProvider re-probes.
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith('/'));
    expect(devLoginBodies.some((b) => b.includes('founder@example.com'))).toBe(true);
    // It must NOT have submitted the VA persona.
    expect(devLoginBodies.some((b) => b.includes('va@example.com'))).toBe(false);
  });
});
