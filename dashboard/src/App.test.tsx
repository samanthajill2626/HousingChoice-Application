import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.js';

// Helper: stub fetch so /auth/me resolves to an authenticated principal — the
// app then renders its authenticated shell (the HousingChoice brand heading).
function mockMe(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ userId: 'u1', email: 'va@example.com', role: 'va' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('renders the HousingChoice brand heading once authenticated', async () => {
    mockMe();
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /HousingChoice/i })).toBeInTheDocument(),
    );
  });
});
