// AdminUsers screen tests — mock the api client + AuthContext, no network.
// Covers: list renders; invite submits + shows created vs already-exists;
// role change calls PATCH; the 409 lockout guards render friendly messages.
// (Uses fireEvent — @testing-library/user-event is not a project dependency.)
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import type { AdminUser } from '../../api/types.js';
import { ToastProvider } from '../../ui/index.js';
import AdminUsers from '../AdminUsers.js';

// --- Mocks -----------------------------------------------------------------

const listUsers = vi.fn();
const inviteUser = vi.fn();
const changeUserRole = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listUsers: (...args: unknown[]) => listUsers(...args),
    inviteUser: (...args: unknown[]) => inviteUser(...args),
    changeUserRole: (...args: unknown[]) => changeUserRole(...args),
  };
});

const ME = { userId: 'u-admin', email: 'founder@hc.org', role: 'admin' as const };
vi.mock('../../app/AuthContext.js', () => ({
  useAuth: () => ({ status: 'authenticated', me: ME, isAdmin: true, refresh: vi.fn() }),
}));

function makeUser(over: Partial<AdminUser> = {}): AdminUser {
  return {
    userId: 'u-1',
    email: 'va@hc.org',
    role: 'va',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    last_login_at: '2026-06-12T00:00:00.000Z',
    ...over,
  };
}

function renderScreen(): void {
  render(
    <ToastProvider>
      <AdminUsers />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listUsers.mockResolvedValue([makeUser()]);
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- Tests -----------------------------------------------------------------

describe('<AdminUsers>', () => {
  it('renders the user list once loaded', async () => {
    listUsers.mockResolvedValue([
      makeUser({ userId: 'u-1', email: 'va@hc.org', role: 'va' }),
      makeUser({ userId: 'u-admin', email: 'founder@hc.org', role: 'admin' }),
    ]);
    renderScreen();
    // Both card + table views render the email, so it appears more than once.
    expect(await screen.findAllByText('va@hc.org')).not.toHaveLength(0);
    expect(screen.getAllByText('founder@hc.org').length).toBeGreaterThan(0);
  });

  it('shows the "signs out within a minute" info note', async () => {
    renderScreen();
    expect(await screen.findByText(/signs them out within about a minute/i)).toBeInTheDocument();
  });

  it('submits an invite and reports a newly created user', async () => {
    inviteUser.mockResolvedValue({
      user: makeUser({ userId: 'u-2', email: 'new@hc.org', role: 'va', status: 'invited' }),
      created: true,
    });
    renderScreen();
    await screen.findByText(/Invite a teammate/i);

    fireEvent.change(screen.getByPlaceholderText('teammate@example.com'), {
      target: { value: 'new@hc.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => expect(inviteUser).toHaveBeenCalledWith('new@hc.org', 'va'));
    expect(await screen.findByText(/Invited new@hc.org/i)).toBeInTheDocument();
  });

  it('reports when the invited user already exists', async () => {
    inviteUser.mockResolvedValue({
      user: makeUser({ userId: 'u-2', email: 'dupe@hc.org', role: 'admin' }),
      created: false,
    });
    renderScreen();
    await screen.findByText(/Invite a teammate/i);

    fireEvent.change(screen.getByPlaceholderText('teammate@example.com'), {
      target: { value: 'dupe@hc.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('shows an inline validation error for an empty email (no request)', async () => {
    renderScreen();
    await screen.findByText(/Invite a teammate/i);
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    expect(await screen.findByText(/Enter an email address/i)).toBeInTheDocument();
    expect(inviteUser).not.toHaveBeenCalled();
  });

  it('changes a role via PATCH', async () => {
    changeUserRole.mockResolvedValue({
      user: makeUser({ userId: 'u-1', email: 'va@hc.org', role: 'admin' }),
      changed: true,
    });
    renderScreen();
    await screen.findAllByText('va@hc.org');

    const buttons = screen.getAllByRole('button', { name: /make admin/i });
    fireEvent.click(buttons[0]!);

    await waitFor(() => expect(changeUserRole).toHaveBeenCalledWith('u-1', 'admin'));
    expect(await screen.findByText(/is now an admin/i)).toBeInTheDocument();
  });

  it('renders a friendly message for the last-admin guard (409)', async () => {
    listUsers.mockResolvedValue([makeUser({ userId: 'u-1', email: 'va@hc.org', role: 'admin' })]);
    changeUserRole.mockRejectedValue(
      new ApiError(409, 'cannot_demote_last_admin', 'cannot_demote_last_admin'),
    );
    renderScreen();
    await screen.findAllByText('va@hc.org');

    const buttons = screen.getAllByRole('button', { name: /make va/i });
    fireEvent.click(buttons[0]!);

    expect(await screen.findAllByText("You can't remove the last admin.")).not.toHaveLength(0);
  });

  it('disables self role change and explains the self guard', async () => {
    // The current user (founder@hc.org / u-admin) appears as an admin.
    listUsers.mockResolvedValue([
      makeUser({ userId: 'u-admin', email: 'founder@hc.org', role: 'admin' }),
    ]);
    renderScreen();
    await screen.findAllByText('founder@hc.org');

    const selfButtons = screen.getAllByRole('button', { name: /make va/i });
    expect(selfButtons[0]).toBeDisabled();
    expect(selfButtons[0]).toHaveAttribute('title', "You can't change your own role.");
  });

  it('surfaces the cannot_demote_self guard message if the server rejects (409)', async () => {
    listUsers.mockResolvedValue([makeUser({ userId: 'u-1', email: 'other@hc.org', role: 'admin' })]);
    changeUserRole.mockRejectedValue(new ApiError(409, 'cannot_demote_self', 'cannot_demote_self'));
    renderScreen();
    await screen.findAllByText('other@hc.org');

    const buttons = screen.getAllByRole('button', { name: /make va/i });
    fireEvent.click(buttons[0]!);

    expect(await screen.findAllByText("You can't change your own role.")).not.toHaveLength(0);
  });

  it('shows the empty state when there are no users', async () => {
    listUsers.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText(/No teammates yet/i)).toBeInTheDocument();
  });

  it('shows an error state with retry when the list fails to load', async () => {
    listUsers.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    renderScreen();
    expect(await screen.findByText(/Couldn't load users/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('renders relative last-login and status badges', async () => {
    listUsers.mockResolvedValue([
      makeUser({
        userId: 'u-1',
        email: 'inv@hc.org',
        role: 'va',
        status: 'invited',
        last_login_at: null,
      }),
    ]);
    renderScreen();
    await screen.findAllByText('inv@hc.org');
    expect(screen.getAllByText(/Never/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Invited').length).toBeGreaterThan(0);
  });
});
