// TeamSection tests — the admin team surface. Covers the roster render (mocked
// listUsers), the idempotent invite (created / created:false), and the OPTIMISTIC
// role change that reverts on a 409 lockout guard (cannot_demote_last_admin /
// cannot_demote_self) with the inline message.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { AdminUserView } from '../../api/index.js';

const listUsers = vi.fn();
const inviteUser = vi.fn();
const setUserRole = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listUsers: (...a: unknown[]) => listUsers(...a),
    inviteUser: (...a: unknown[]) => inviteUser(...a),
    setUserRole: (...a: unknown[]) => setUserRole(...a),
  };
});

import { TeamSection } from './TeamSection.js';

function user(overrides: Partial<AdminUserView> = {}): AdminUserView {
  return {
    userId: 'usr_1',
    email: 'alice@example.com',
    name: 'Alice',
    role: 'va',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    last_login_at: null,
    ...overrides,
  };
}

// Desktop (table) layout — matchMedia matches=false.
function stubDesktop(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
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

beforeEach(() => {
  vi.clearAllMocks();
  stubDesktop();
});
afterEach(() => vi.unstubAllGlobals());

describe('TeamSection — roster', () => {
  it('renders the team members from listUsers', async () => {
    listUsers.mockResolvedValue([
      user({ userId: 'a', email: 'alice@example.com', name: 'Alice', role: 'admin' }),
      user({ userId: 'b', email: 'bob@example.com', name: 'Bob', role: 'va' }),
    ]);
    render(<TeamSection />);

    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  it('shows an error block + Retry when listUsers fails', async () => {
    listUsers.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    render(<TeamSection />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load the team/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('TeamSection — invite', () => {
  it('surfaces a created invite as a success notice', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([]);
    inviteUser.mockResolvedValue({
      user: user({ userId: 'new', email: 'carol@example.com', role: 'va' }),
      created: true,
    });
    render(<TeamSection />);
    await screen.findByText(/No teammates yet/i);

    await u.type(screen.getByLabelText('Email'), 'carol@example.com');
    await u.click(screen.getByRole('button', { name: 'Invite' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/Invited carol@example.com/i);
    // The new user lands in the roster too.
    expect(screen.getByText('carol@example.com')).toBeInTheDocument();
  });

  it('surfaces an idempotent (created:false) invite as "already on the team"', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([]);
    inviteUser.mockResolvedValue({
      user: user({ userId: 'dup', email: 'dave@example.com', role: 'va' }),
      created: false,
    });
    render(<TeamSection />);
    await screen.findByText(/No teammates yet/i);

    await u.type(screen.getByLabelText('Email'), 'dave@example.com');
    await u.click(screen.getByRole('button', { name: 'Invite' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/dave@example.com is already on the team/i);
  });
});

describe('TeamSection — optimistic role change revert', () => {
  it('reverts the row + shows the inline message on a 409 cannot_demote_last_admin', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([user({ userId: 'a', email: 'alice@example.com', role: 'admin' })]);
    setUserRole.mockRejectedValue(
      new ApiError(409, 'cannot_demote_last_admin', 'cannot demote the last admin'),
    );
    render(<TeamSection />);
    await screen.findByText('alice@example.com');

    const roleSelect = screen.getByLabelText('Role for alice@example.com') as HTMLSelectElement;
    expect(roleSelect.value).toBe('admin');

    await u.selectOptions(roleSelect, 'va');

    // The inline lockout message appears…
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/must keep at least one admin/i);
    // …and the control reverts to admin.
    await waitFor(() => expect(roleSelect.value).toBe('admin'));
  });

  it('reverts + shows the message on a 409 cannot_demote_self', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([user({ userId: 'me', email: 'me@example.com', role: 'admin' })]);
    setUserRole.mockRejectedValue(
      new ApiError(409, 'cannot_demote_self', 'cannot demote yourself'),
    );
    render(<TeamSection />);
    await screen.findByText('me@example.com');

    const roleSelect = screen.getByLabelText('Role for me@example.com') as HTMLSelectElement;
    await u.selectOptions(roleSelect, 'va');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can't remove your own admin access/i);
    await waitFor(() => expect(roleSelect.value).toBe('admin'));
  });

  it('commits the server row on a successful role change', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([user({ userId: 'b', email: 'bob@example.com', role: 'va' })]);
    setUserRole.mockResolvedValue({
      user: user({ userId: 'b', email: 'bob@example.com', role: 'admin' }),
      changed: true,
    });
    render(<TeamSection />);
    await screen.findByText('bob@example.com');

    const roleSelect = screen.getByLabelText('Role for bob@example.com') as HTMLSelectElement;
    await u.selectOptions(roleSelect, 'admin');

    await waitFor(() => expect(roleSelect.value).toBe('admin'));
    expect(setUserRole).toHaveBeenCalledWith('b', 'admin');
    // No inline error on success.
    expect(within(screen.getByRole('table')).queryByRole('alert')).not.toBeInTheDocument();
  });
});
