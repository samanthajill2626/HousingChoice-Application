// OWNED BY FEATURE AGENT 3 (M1.4) — the team-management screen.
//
// Route: '/admin/users' (admin only — wrapped in <RequireAdmin> by the router).
// List users (GET /api/users), invite (POST /api/users { email, role }), and
// change a role (PATCH /api/users/:userId/role). The server's lockout guards
// surface as ApiError(409, 'cannot_demote_last_admin' | 'cannot_demote_self');
// we render them as friendly lines (see ./admin/errors.ts). A role change signs
// the affected user out within ~60s (session epoch) — we say so in an info note.
import { useState } from 'react';
import {
  ApiError,
  changeUserRole,
  inviteUser,
  listUsers,
  useApi,
  type AdminUser,
  type UserRole,
} from '../api/index.js';
import { Avatar, Badge, Button, EmptyState, Field, Input, Spinner, useToast, UsersIcon } from '../ui/index.js';
import { useAuth } from '../app/AuthContext.js';
import { inviteErrorMessage, roleChangeErrorMessage } from './admin/errors.js';
import { relativeTime } from './admin/relativeTime.js';
import styles from './admin/AdminUsers.module.css';

const ROLE_LABEL: Record<UserRole, string> = { admin: 'Admin', va: 'VA' };

export default function AdminUsers(): React.JSX.Element {
  const { me } = useAuth();
  const toast = useToast();
  const { data: users, loading, error, refetch } = useApi((signal) => listUsers(signal), []);

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>Users</h1>
        <p className={styles.lead}>Invite teammates and manage who can do what.</p>
      </header>

      <InviteSection onInvited={refetch} toast={toast} />

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Team</h2>
        <p className={styles.note}>
          Changing someone&apos;s role signs them out within about a minute, so they pick up the
          new permissions on their next sign-in.
        </p>
        <UserList
          users={users}
          loading={loading}
          error={error}
          onRetry={refetch}
          onChanged={refetch}
          currentUserId={me?.userId}
          toast={toast}
        />
      </div>
    </section>
  );
}

// --- Invite ----------------------------------------------------------------

function InviteSection({
  onInvited,
  toast,
}: {
  onInvited: () => void;
  toast: ReturnType<typeof useToast>;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('va');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = email.trim();
    if (trimmed === '') {
      setFieldError('Enter an email address.');
      return;
    }
    setFieldError(undefined);
    setSubmitting(true);
    try {
      const result = await inviteUser(trimmed, role);
      if (result.created) {
        toast.success(`Invited ${result.user.email} as ${ROLE_LABEL[result.user.role]}.`);
      } else {
        toast.info(`${result.user.email} already exists (${ROLE_LABEL[result.user.role]}).`);
      }
      setEmail('');
      setRole('va');
      onInvited();
    } catch (err) {
      setFieldError(inviteErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Invite a teammate</h2>
      <form className={styles.inviteForm} onSubmit={(e) => void handleSubmit(e)} noValidate>
        <div className={styles.inviteRow}>
          <Field
            label="Email"
            required
            {...(fieldError !== undefined && { error: fieldError })}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="email"
                inputMode="email"
                autoComplete="off"
                placeholder="teammate@example.com"
                value={email}
                invalid={invalid}
                disabled={submitting}
                {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (fieldError !== undefined) setFieldError(undefined);
                }}
              />
            )}
          </Field>

          <Field label="Role">
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={role}
                disabled={submitting}
                onChange={(e) => setRole(e.target.value as UserRole)}
              >
                <option value="va">VA</option>
                <option value="admin">Admin</option>
              </select>
            )}
          </Field>

          <div className={styles.submit}>
            <Button type="submit" loading={submitting}>
              Send invite
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

// --- User list -------------------------------------------------------------

function UserList({
  users,
  loading,
  error,
  onRetry,
  onChanged,
  currentUserId,
  toast,
}: {
  users: AdminUser[] | undefined;
  loading: boolean;
  error: ApiError | undefined;
  onRetry: () => void;
  onChanged: () => void;
  currentUserId: string | undefined;
  toast: ReturnType<typeof useToast>;
}): React.JSX.Element {
  if (loading && users === undefined) {
    return <Spinner center label="Loading users" />;
  }

  if (error !== undefined && users === undefined) {
    return (
      <EmptyState
        title="Couldn't load users"
        description="Something went wrong fetching the team."
        action={
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }

  if (users === undefined || users.length === 0) {
    return (
      <EmptyState
        icon={<UsersIcon size={28} />}
        title="No teammates yet"
        description="Invite someone above to get started."
      />
    );
  }

  return (
    <>
      {/* Mobile: cards. */}
      <div className={styles.cards}>
        {users.map((u) => (
          <UserCard
            key={u.userId}
            user={u}
            isSelf={u.userId === currentUserId}
            onChanged={onChanged}
            toast={toast}
          />
        ))}
      </div>

      {/* Wide: table. */}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Last login</th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRow
                key={u.userId}
                user={u}
                isSelf={u.userId === currentUserId}
                onChanged={onChanged}
                toast={toast}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StatusBadge({ status }: { status: AdminUser['status'] }): React.JSX.Element {
  if (status === 'active') return <Badge tone="success" dot>Active</Badge>;
  if (status === 'invited') return <Badge tone="info" dot>Invited</Badge>;
  return <Badge tone="neutral" dot>Unknown</Badge>;
}

/** The shared role-change control + its in-flight + error state. */
function useRoleChange(
  user: AdminUser,
  isSelf: boolean,
  onChanged: () => void,
  toast: ReturnType<typeof useToast>,
): {
  pending: boolean;
  rowError: string | undefined;
  nextRole: UserRole;
  disabled: boolean;
  change: () => void;
} {
  const [pending, setPending] = useState(false);
  const [rowError, setRowError] = useState<string | undefined>(undefined);
  const nextRole: UserRole = user.role === 'admin' ? 'va' : 'admin';

  async function change(): Promise<void> {
    setRowError(undefined);
    setPending(true);
    try {
      const result = await changeUserRole(user.userId, nextRole);
      if (result.changed) {
        toast.success(
          `${result.user.email} is now ${result.user.role === 'admin' ? 'an admin' : 'a VA'}.`,
        );
      } else {
        toast.info(`${result.user.email} was already ${ROLE_LABEL[result.user.role]}.`);
      }
      onChanged();
    } catch (err) {
      setRowError(roleChangeErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return {
    pending,
    rowError,
    nextRole,
    // Never offer self-demotion — the UI shouldn't imply it's fine (the server
    // also guards it with 409 cannot_demote_self).
    disabled: isSelf,
    change: () => void change(),
  };
}

function RoleControl({
  user,
  isSelf,
  onChanged,
  toast,
}: {
  user: AdminUser;
  isSelf: boolean;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}): React.JSX.Element {
  const { pending, rowError, nextRole, disabled, change } = useRoleChange(
    user,
    isSelf,
    onChanged,
    toast,
  );
  const label = nextRole === 'admin' ? 'Make admin' : 'Make VA';
  return (
    <div className={styles.actions}>
      <Button
        variant="secondary"
        size="sm"
        loading={pending}
        disabled={disabled}
        title={isSelf ? "You can't change your own role." : undefined}
        onClick={change}
      >
        {label}
      </Button>
      {rowError !== undefined && (
        <span className={styles.rowError} role="alert">
          {rowError}
        </span>
      )}
    </div>
  );
}

function UserCard({
  user,
  isSelf,
  onChanged,
  toast,
}: {
  user: AdminUser;
  isSelf: boolean;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}): React.JSX.Element {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <Avatar name={user.email} size="sm" />
        <div className={styles.identity}>
          <span className={styles.email}>{user.email}</span>
          {isSelf && <span className={styles.self}>You</span>}
        </div>
      </div>
      <div className={styles.meta}>
        <Badge tone={user.role === 'admin' ? 'info' : 'neutral'}>{ROLE_LABEL[user.role]}</Badge>
        <StatusBadge status={user.status} />
        <span>Last login: {relativeTime(user.last_login_at)}</span>
      </div>
      <RoleControl user={user} isSelf={isSelf} onChanged={onChanged} toast={toast} />
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  onChanged,
  toast,
}: {
  user: AdminUser;
  isSelf: boolean;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}): React.JSX.Element {
  return (
    <tr>
      <td>
        <div className={styles.cardHead}>
          <Avatar name={user.email} size="sm" />
          <div className={styles.identity}>
            <span className={styles.email}>{user.email}</span>
            {isSelf && <span className={styles.self}>You</span>}
          </div>
        </div>
      </td>
      <td>
        <Badge tone={user.role === 'admin' ? 'info' : 'neutral'}>{ROLE_LABEL[user.role]}</Badge>
      </td>
      <td>
        <StatusBadge status={user.status} />
      </td>
      <td>{relativeTime(user.last_login_at)}</td>
      <td>
        <RoleControl user={user} isSelf={isSelf} onChanged={onChanged} toast={toast} />
      </td>
    </tr>
  );
}
