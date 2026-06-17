import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.js';

// Helper: stub fetch so /auth/me resolves to an authenticated principal — the
// app then renders its authenticated shell (the AppFrame).
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
  it('renders the HousingChoice shell once authenticated', async () => {
    mockMe();
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    // The shell brand + the Today landing page render once /auth/me resolves.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'HousingChoice' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });
});
