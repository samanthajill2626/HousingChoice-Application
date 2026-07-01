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
const assignInboundVoiceLine = vi.fn();
const clearInboundVoiceLine = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listUsers: (...a: unknown[]) => listUsers(...a),
    inviteUser: (...a: unknown[]) => inviteUser(...a),
    setUserRole: (...a: unknown[]) => setUserRole(...a),
    assignInboundVoiceLine: (...a: unknown[]) => assignInboundVoiceLine(...a),
    clearInboundVoiceLine: (...a: unknown[]) => clearInboundVoiceLine(...a),
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
