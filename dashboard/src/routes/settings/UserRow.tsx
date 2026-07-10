// UserRow — one team member, rendered as a desktop table row OR a mobile stacked
// card (the parent picks via CSS). Shows name + email, an inline role <select>
// (→ optimistic PATCH), the member's verified CELL + a verification badge, the
// single "Inbound voice line" badge + an assign/clear action (Voice Phase 1 §6),
// status, and last login. A per-row error (a reverted 409 role lockout OR a
// voice-line failure like cell_not_verified) renders inline next to this row.
import { useState } from 'react';
import type { AdminUserView, UserRole } from '../../api/index.js';
import type { RoleChangeResult, VoiceLineResult } from './useTeam.js';
import styles from './TeamSection.module.css';

export interface UserRowProps {
  user: AdminUserView;
  /** Optimistic role change; resolves with a per-row error on a 409 lockout. */
  onChangeRole: (userId: string, role: UserRole) => Promise<RoleChangeResult>;
  /** Assign the single inbound voice line to this user (MOVES it). Resolves with
   *  a per-row error on 409 cell_not_verified. */
  onAssignVoiceLine: (userId: string) => Promise<VoiceLineResult>;
  /** Clear the inbound voice line from this user. */
  onClearVoiceLine: (userId: string) => Promise<VoiceLineResult>;
  /** Desktop table cell layout vs mobile stacked card. */
  variant: 'table' | 'card';
  /** Whether the current VIEWER is an admin. Non-admins see the voice-line
   *  badge + cell read-only (no Assign/Clear controls). Defaults to true so
   *  the component is safe even if the prop is omitted (the Team tab is
   *  admin-only via route guard, but defense-in-depth). */
  viewerIsAdmin?: boolean;
  /** Open the remove-confirmation for this user. */
  onRequestRemove: (user: AdminUserView) => void;
  /** When set, the Remove button is DISABLED and this string is its tooltip
   *  (self / last-admin / voice-line-holder). Undefined = removable. */
  removeDisabledReason?: string;
}

/** Friendly "last login" — a localized date, or "Never" when unset. */
function formatLastLogin(iso: string | null): string {
  if (iso === null) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Format a US E.164 cell as "(404) 555-0100"; pass others through. */
function formatCell(e164: string | undefined): string {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `(${m[1] ?? ''}) ${m[2] ?? ''}-${m[3] ?? ''}`;
}

/** True when the user has a cell that PASSED verification. */
function isCellVerified(u: AdminUserView): boolean {
  return (
    typeof u.cell === 'string' &&
    u.cell.length > 0 &&
    typeof u.cell_verified_at === 'string' &&
    u.cell_verified_at.length > 0
  );
}

export function UserRow({
  user,
  onChangeRole,
  onAssignVoiceLine,
  onClearVoiceLine,
  variant,
  viewerIsAdmin = true,
  onRequestRemove,
  removeDisabledReason,
}: UserRowProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRoleSelect(role: UserRole): Promise<void> {
    if (role === user.role || busy) return;
    setBusy(true);
    setError(null);
    const result = await onChangeRole(user.userId, role);
    if (!result.ok) setError(result.error);
    setBusy(false);
  }

  async function onVoiceLine(assign: boolean): Promise<void> {
    if (voiceBusy) return;
    setVoiceBusy(true);
    setError(null);
    const result = assign
      ? await onAssignVoiceLine(user.userId)
      : await onClearVoiceLine(user.userId);
    if (!result.ok) setError(result.error);
    setVoiceBusy(false);
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

  const verified = isCellVerified(user);
  const holdsLine = user.inbound_voice_line === true;

  // Cell + verification badge.
  const cellCell = user.cell ? (
    <span className={styles.cellValue}>
      {formatCell(user.cell)}{' '}
      {verified ? (
        <span className={styles.verifiedBadge}>Verified ✓</span>
      ) : (
        <span className={styles.unverifiedBadge}>Not verified</span>
      )}
    </span>
  ) : (
    <span className={styles.unverifiedBadge}>Not set</span>
  );

  // Inbound-voice-line badge + assign/clear control. Assigning is only offered
  // for a verified cell (else the server 409s cell_not_verified). Non-admins
  // see the badge read-only (spec §6: "Non-admins see state read-only").
  const voiceLineCell = (
    <span className={styles.voiceLine}>
      {holdsLine ? <span className={styles.lineBadge}>Inbound voice line</span> : null}
      {viewerIsAdmin ? (
        holdsLine ? (
          <button
            type="button"
            className={styles.voiceBtn}
            disabled={voiceBusy}
            onClick={() => void onVoiceLine(false)}
            aria-label={`Clear the inbound voice line from ${user.email}`}
          >
            Clear
          </button>
        ) : (
          <button
            type="button"
            className={styles.voiceBtn}
            disabled={voiceBusy || !verified}
            title={verified ? undefined : 'Needs a verified cell first'}
            onClick={() => void onVoiceLine(true)}
            aria-label={`Assign the inbound voice line to ${user.email}`}
          >
            Assign
          </button>
        )
      ) : null}
    </span>
  );

  const lastLogin = formatLastLogin(user.last_login_at);
  const statusText = user.status ?? '—';

  const removeControl = (
    <button
      type="button"
      className={styles.removeBtn}
      disabled={removeDisabledReason !== undefined}
      title={removeDisabledReason}
      onClick={() => onRequestRemove(user)}
      aria-label={`Remove ${user.email}`}
    >
      Remove
    </button>
  );

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
            <dt className={styles.cardMetaLabel}>Cell</dt>
            <dd className={styles.cardMetaValue}>{cellCell}</dd>
          </div>
          <div className={styles.cardMetaRow}>
            <dt className={styles.cardMetaLabel}>Voice line</dt>
            <dd className={styles.cardMetaValue}>{voiceLineCell}</dd>
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
        {viewerIsAdmin ? <div className={styles.cardActions}>{removeControl}</div> : null}
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
        <td className={styles.cell}>{cellCell}</td>
        <td className={styles.cell}>{voiceLineCell}</td>
        <td className={styles.cell}>{statusText}</td>
        <td className={styles.cell}>{lastLogin}</td>
        <td className={styles.cell}>{viewerIsAdmin ? removeControl : null}</td>
      </tr>
      {error !== null ? (
        <tr>
          <td className={styles.cellError} colSpan={7}>
            <p role="alert" className={styles.error}>
              {error}
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}
