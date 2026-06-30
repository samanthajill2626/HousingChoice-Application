// UserRow — one team member, rendered as a desktop table row OR a mobile stacked
// card (the parent picks via CSS). Shows name + email, an inline role <select>
// (→ optimistic PATCH), status, and last login. A per-row lockout error (409,
// reverted by useTeam) renders inline next to this row.
import { useState } from 'react';
import type { AdminUserView, UserRole } from '../../api/index.js';
import type { RoleChangeResult } from './useTeam.js';
import styles from './TeamSection.module.css';

export interface UserRowProps {
  user: AdminUserView;
  /** Optimistic role change; resolves with a per-row error on a 409 lockout. */
  onChangeRole: (userId: string, role: UserRole) => Promise<RoleChangeResult>;
  /** Desktop table cell layout vs mobile stacked card. */
  variant: 'table' | 'card';
}

/** Friendly "last login" — a localized date, or "Never" when unset. */
function formatLastLogin(iso: string | null): string {
  if (iso === null) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function UserRow({ user, onChangeRole, variant }: UserRowProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRoleSelect(role: UserRole): Promise<void> {
    if (role === user.role || busy) return;
    setBusy(true);
    setError(null);
    const result = await onChangeRole(user.userId, role);
    if (!result.ok) setError(result.error);
    setBusy(false);
  }

  const roleControl = (
    <label className={styles.roleControl}>
      <span className={styles.srOnly}>Role for {user.email}</span>
      <select
        className={styles.select}
        value={user.role}
        disabled={busy}
        onChange={(e) => void onRoleSelect(e.target.value as UserRole)}
      >
        <option value="va">VA</option>
        <option value="admin">Admin</option>
      </select>
    </label>
  );

  const lastLogin = formatLastLogin(user.last_login_at);
  const statusText = user.status ?? '—';

  if (variant === 'card') {
    return (
      <li className={styles.card}>
        <div className={styles.cardName}>{user.name}</div>
        <div className={styles.cardEmail}>{user.email}</div>
        <dl className={styles.cardMeta}>
          <div className={styles.cardMetaRow}>
            <dt className={styles.cardMetaLabel}>Role</dt>
            <dd className={styles.cardMetaValue}>{roleControl}</dd>
          </div>
          <div className={styles.cardMetaRow}>
            <dt className={styles.cardMetaLabel}>Status</dt>
            <dd className={styles.cardMetaValue}>{statusText}</dd>
          </div>
          <div className={styles.cardMetaRow}>
            <dt className={styles.cardMetaLabel}>Last login</dt>
            <dd className={styles.cardMetaValue}>{lastLogin}</dd>
          </div>
        </dl>
        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </li>
    );
  }

  return (
    <>
      <tr>
        <td className={styles.cell}>
          <div className={styles.name}>{user.name}</div>
          <div className={styles.email}>{user.email}</div>
        </td>
        <td className={styles.cell}>{roleControl}</td>
        <td className={styles.cell}>{statusText}</td>
        <td className={styles.cell}>{lastLogin}</td>
      </tr>
      {error !== null ? (
        <tr>
          <td className={styles.cellError} colSpan={4}>
            <p role="alert" className={styles.error}>
              {error}
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}
