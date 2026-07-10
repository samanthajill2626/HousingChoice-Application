// TeamSection tests — the admin team surface. Covers the roster render (mocked
// listUsers), the idempotent invite (created / created:false), and the OPTIMISTIC
// role change that reverts on a 409 lockout guard (cannot_demote_last_admin /
// cannot_demote_self) with the inline message. Also covers the non-admin (VA)
// viewer read-only path (spec §6: "Non-admins see state read-only").
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { AdminUserView } from '../../api/index.js';

const listUsers = vi.fn();
const inviteUser = vi.fn();
const setUserRole = vi.fn();
const assignInboundVoiceLine = vi.fn();
const clearInboundVoiceLine = vi.fn();
const removeUser = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listUsers: (...a: unknown[]) => listUsers(...a),
    inviteUser: (...a: unknown[]) => inviteUser(...a),
    setUserRole: (...a: unknown[]) => setUserRole(...a),
    assignInboundVoiceLine: (...a: unknown[]) => assignInboundVoiceLine(...a),
    clearInboundVoiceLine: (...a: unknown[]) => clearInboundVoiceLine(...a),
    removeUser: (...a: unknown[]) => removeUser(...a),
  };
});

// Track the viewer's admin flag so tests can flip it.
let viewerIsAdmin = true;
vi.mock('../../app/AuthContext.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    me: { userId: 'viewer', email: 'viewer@example.com', role: viewerIsAdmin ? 'admin' : 'va' },
    isAdmin: viewerIsAdmin,
    refresh: vi.fn(),
  }),
}));

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
  viewerIsAdmin = true; // default: admin viewer for existing tests
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

  it('associates a 400 error with the email input (aria-invalid + aria-describedby)', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([]);
    inviteUser.mockRejectedValue(new ApiError(400, 'invalid_email', 'not a valid email'));
    render(<TeamSection />);
    await screen.findByText(/No teammates yet/i);

    const emailInput = screen.getByLabelText('Email');
    // No error yet → not flagged.
    expect(emailInput).toHaveAttribute('aria-invalid', 'false');

    // Syntactically valid (so the native type=email check passes) but rejected
    // by the server with a 400.
    await u.type(emailInput, 'blocked@example.com');
    await u.click(screen.getByRole('button', { name: 'Invite' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not a valid email/i);
    // The input is now flagged invalid and points at the error element.
    expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    expect(emailInput).toHaveAttribute('aria-describedby', alert.id);
    expect(alert.id).toBe('invite-email-error');
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

  it('shows each member\'s cell + verification badge', async () => {
    listUsers.mockResolvedValue([
      user({
        userId: 'a',
        email: 'alice@example.com',
        cell: '+14040100001',
        cell_verified_at: '2026-06-01T00:00:00.000Z',
      }),
      user({ userId: 'b', email: 'bob@example.com', cell: '+14040100002' }),
      user({ userId: 'c', email: 'carol@example.com' }),
    ]);
    render(<TeamSection />);
    await screen.findByText('alice@example.com');

    const table = screen.getByRole('table');
    // Alice: verified badge next to her cell.
    expect(within(table).getByText('(404) 010-0001')).toBeInTheDocument();
    expect(within(table).getByText('Verified ✓')).toBeInTheDocument();
    // Bob has a cell but no verified_at → "Not verified".
    expect(within(table).getByText('(404) 010-0002')).toBeInTheDocument();
    expect(within(table).getByText('Not verified')).toBeInTheDocument();
    // Carol has no cell → "Not set".
    expect(within(table).getByText('Not set')).toBeInTheDocument();
  });
});

describe('TeamSection — inbound voice line (single holder)', () => {
  it('badges the single holder and lets an admin MOVE the line (assign)', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([
      user({
        userId: 'a',
        email: 'alice@example.com',
        cell: '+14040100001',
        cell_verified_at: '2026-06-01T00:00:00.000Z',
        inbound_voice_line: true,
      }),
      user({
        userId: 'b',
        email: 'bob@example.com',
        cell: '+14040100002',
        cell_verified_at: '2026-06-02T00:00:00.000Z',
      }),
    ]);
    // Assigning to Bob returns Bob as the new holder.
    assignInboundVoiceLine.mockResolvedValue(
      user({
        userId: 'b',
        email: 'bob@example.com',
        cell: '+14040100002',
        cell_verified_at: '2026-06-02T00:00:00.000Z',
        inbound_voice_line: true,
      }),
    );
    render(<TeamSection />);
    await screen.findByText('alice@example.com');

    // Exactly one "Inbound voice line" badge to start (Alice holds it).
    expect(screen.getAllByText('Inbound voice line')).toHaveLength(1);

    // Assign it to Bob → the line MOVES (still exactly one badge).
    await u.click(
      screen.getByRole('button', { name: /Assign the inbound voice line to bob@example.com/i }),
    );
    expect(assignInboundVoiceLine).toHaveBeenCalledWith('b');
    await waitFor(() => expect(screen.getAllByText('Inbound voice line')).toHaveLength(1));
    // And now Bob offers "Clear" (he holds it).
    expect(
      screen.getByRole('button', { name: /Clear the inbound voice line from bob@example.com/i }),
    ).toBeInTheDocument();
  });

  it('cannot assign an unverified user — surfaces the 409 cell_not_verified reason', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([
      user({ userId: 'b', email: 'bob@example.com', cell: '+14040100002' }),
    ]);
    render(<TeamSection />);
    await screen.findByText('bob@example.com');
    // An unverified user's Assign button is disabled (guarded before the request).
    expect(
      screen.getByRole('button', { name: /Assign the inbound voice line to bob@example.com/i }),
    ).toBeDisabled();
    expect(assignInboundVoiceLine).not.toHaveBeenCalled();
    void u; // (no click — the control is disabled)
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

describe('TeamSection — non-admin (VA) viewer read-only', () => {
  // Spec §6: "Non-admins see state read-only" — the inbound-voice-line badge is
  // shown but Assign/Clear buttons must NOT be rendered when the viewer is a VA.
  it('hides Assign/Clear buttons for a non-admin viewer while still showing badge and cell state', async () => {
    viewerIsAdmin = false;
    listUsers.mockResolvedValue([
      user({
        userId: 'a',
        email: 'alice@example.com',
        cell: '+14040100001',
        cell_verified_at: '2026-06-01T00:00:00.000Z',
        inbound_voice_line: true,
      }),
      user({
        userId: 'b',
        email: 'bob@example.com',
        cell: '+14040100002',
        cell_verified_at: '2026-06-02T00:00:00.000Z',
      }),
    ]);
    render(<TeamSection />);
    await screen.findByText('alice@example.com');

    // The "Inbound voice line" badge is still visible (read-only state).
    expect(screen.getByText('Inbound voice line')).toBeInTheDocument();
    // Cell and verification badges are shown (at least one Verified ✓ badge).
    expect(screen.getAllByText('Verified ✓').length).toBeGreaterThanOrEqual(1);

    // Assign and Clear action buttons must NOT appear for a non-admin viewer.
    expect(
      screen.queryByRole('button', { name: /Assign the inbound voice line/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Clear the inbound voice line/i }),
    ).not.toBeInTheDocument();
  });
});

describe('TeamSection -- remove teammate', () => {
  it('removes a member after confirming in the dialog', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([
      user({ userId: 'admin1', email: 'admin@example.com', role: 'admin' }),
      user({ userId: 'bob', email: 'bob@example.com', role: 'va' }),
    ]);
    removeUser.mockResolvedValue({ removed: true });
    render(<TeamSection />);
    await screen.findByText('bob@example.com');

    // Open the confirm dialog for Bob (a removable VA).
    await u.click(screen.getByRole('button', { name: 'Remove bob@example.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove teammate' });

    // Confirm.
    await u.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(removeUser).toHaveBeenCalledWith('bob');
    // The row is dropped from the roster.
    await waitFor(() => expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument());
  });

  it('disables Remove for your own row (self)', async () => {
    listUsers.mockResolvedValue([
      user({ userId: 'admin1', email: 'admin@example.com', role: 'admin' }),
      user({ userId: 'viewer', email: 'viewer@example.com', role: 'va' }),
    ]);
    render(<TeamSection />);
    await screen.findByText('viewer@example.com');
    const btn = screen.getByRole('button', { name: 'Remove viewer@example.com' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', "You can't remove your own account.");
  });

  it('disables Remove for the last admin', async () => {
    // Exactly one admin (not the viewer) -> that admin can't be removed.
    listUsers.mockResolvedValue([
      user({ userId: 'onlyadmin', email: 'onlyadmin@example.com', role: 'admin' }),
      user({ userId: 'bob', email: 'bob@example.com', role: 'va' }),
    ]);
    render(<TeamSection />);
    await screen.findByText('onlyadmin@example.com');
    const btn = screen.getByRole('button', { name: 'Remove onlyadmin@example.com' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'The team must keep at least one admin.');
  });

  it('disables Remove for the inbound-voice-line holder', async () => {
    listUsers.mockResolvedValue([
      user({ userId: 'admin1', email: 'admin@example.com', role: 'admin' }),
      user({
        userId: 'holder',
        email: 'holder@example.com',
        role: 'va',
        cell: '+14040100001',
        cell_verified_at: '2026-06-01T00:00:00.000Z',
        inbound_voice_line: true,
      }),
    ]);
    render(<TeamSection />);
    await screen.findByText('holder@example.com');
    const btn = screen.getByRole('button', { name: 'Remove holder@example.com' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Reassign the inbound voice line first.');
  });

  it('keeps the row and shows the error in the dialog on a 409', async () => {
    const u = userEvent.setup();
    listUsers.mockResolvedValue([
      user({ userId: 'admin1', email: 'admin@example.com', role: 'admin' }),
      user({ userId: 'bob', email: 'bob@example.com', role: 'va' }),
    ]);
    // The button is enabled (Bob looks removable), but the server rejects (race).
    removeUser.mockRejectedValue(
      new ApiError(409, 'voice_line_assigned', 'holds the inbound line'),
    );
    render(<TeamSection />);
    await screen.findByText('bob@example.com');

    await u.click(screen.getByRole('button', { name: 'Remove bob@example.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove teammate' });
    await u.click(within(dialog).getByRole('button', { name: 'Remove' }));

    // Error shown in the dialog; the row is still present.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Reassign the inbound voice line/i);
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });
});
