// SettingsPage tests — the tab shell. Covers role-aware tabs (admin sees Team +
// System; a VA does not) and the responsive switch (a wrapping role="tab" row on
// desktop ↔ a labeled section <select> on mobile, driven by matchMedia).
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable auth — flip `isAdmin` per test before render.
let isAdmin = true;
vi.mock('../../app/AuthContext.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    me: { userId: 'u1', email: 'x@example.com', role: isAdmin ? 'admin' : 'va' },
    isAdmin,
    refresh: vi.fn(),
  }),
}));

import { SettingsPage } from './SettingsPage.js';

/** Stub matchMedia so useIsMobile resolves a known viewport. matches=true → mobile. */
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

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/settings/templates']}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  isAdmin = true;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsPage — role gating (desktop tabs)', () => {
  beforeEach(() => stubMatchMedia(false)); // desktop → the tab row

  it('an admin sees all four tabs including Team + System status', () => {
    isAdmin = true;
    renderPage();
    const tabNames = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabNames).toEqual(['Team', 'Templates', 'Notifications', 'System status']);
  });

  it('a VA sees only Templates + Notifications (no Team, no System)', () => {
    isAdmin = false;
    renderPage();
    const tabNames = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabNames).toEqual(['Templates', 'Notifications']);
    expect(screen.queryByRole('tab', { name: 'Team' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'System status' })).not.toBeInTheDocument();
  });
});

describe('SettingsPage — responsive switch', () => {
  it('renders the wrapping tab row on desktop (matchMedia matches=false)', () => {
    stubMatchMedia(false);
    renderPage();
    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Settings section' })).not.toBeInTheDocument();
  });

  it('renders the labeled section <select> on mobile (matchMedia matches=true)', () => {
    stubMatchMedia(true);
    renderPage();
    expect(screen.getByRole('combobox', { name: 'Settings section' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('the mobile dropdown lists only the role-visible sections', () => {
    isAdmin = false;
    stubMatchMedia(true);
    renderPage();
    const select = screen.getByRole('combobox', { name: 'Settings section' });
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Templates', 'Notifications']);
  });
});
