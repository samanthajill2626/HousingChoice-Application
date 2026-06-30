// AdminRoute tests — the route guard for admin-only Settings sections. Security,
// not just hidden chrome: a VA who navigates directly to a guarded path is
// redirected to the VA default tab (Templates); an admin sees the guarded child.
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let isAdmin = false;
vi.mock('../../app/AuthContext.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    me: { userId: 'u1', email: 'x@example.com', role: isAdmin ? 'admin' : 'va' },
    isAdmin,
    refresh: vi.fn(),
  }),
}));

import { AdminRoute } from './AdminRoute.js';

function renderGuarded(): void {
  render(
    <MemoryRouter initialEntries={['/settings/team']}>
      <Routes>
        <Route
          path="/settings/team"
          element={
            <AdminRoute>
              <div>ADMIN TEAM PANEL</div>
            </AdminRoute>
          }
        />
        <Route path="/settings/templates" element={<div>TEMPLATES PANEL</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  isAdmin = false;
});

describe('AdminRoute', () => {
  it('redirects a VA away from an admin-only section to Templates', () => {
    isAdmin = false;
    renderGuarded();
    expect(screen.queryByText('ADMIN TEAM PANEL')).not.toBeInTheDocument();
    expect(screen.getByText('TEMPLATES PANEL')).toBeInTheDocument();
  });

  it('renders the guarded child for an admin', () => {
    isAdmin = true;
    renderGuarded();
    expect(screen.getByText('ADMIN TEAM PANEL')).toBeInTheDocument();
    expect(screen.queryByText('TEMPLATES PANEL')).not.toBeInTheDocument();
  });
});
