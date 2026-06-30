// InviteForm — the Team section's "invite a teammate" form: an email input + a
// role <select> → POST /api/users (idempotent). On a 400 it surfaces the
// server's message inline; on an idempotent no-op (created=false) it shows a
// friendly "already on the team" notice rather than an error.
import { useState } from 'react';
import { ApiError, type UserRole } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import type { InviteResult } from './useTeam.js';
import styles from './TeamSection.module.css';

export interface InviteFormProps {
  onInvite: (email: string, role: UserRole) => Promise<InviteResult>;
}

export function InviteForm({ onInvite }: InviteFormProps): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('va');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = email.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await onInvite(trimmed, role);
      if (result.created) {
        setNotice(`Invited ${result.user.email}.`);
      } else {
        setNotice(`${result.user.email} is already on the team.`);
      }
      setEmail('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(err.message);
      } else {
        setError("Couldn't send the invite — please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.inviteForm} onSubmit={(e) => void onSubmit(e)}>
      <h3 className={styles.inviteHeading}>Invite a teammate</h3>
      <div className={styles.inviteRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Email</span>
          <input
            className={styles.input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            autoComplete="off"
            aria-invalid={error !== null}
            {...(error !== null && { 'aria-describedby': 'invite-email-error' })}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Role</span>
          <select
            className={styles.select}
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            <option value="va">VA</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <div className={styles.inviteAction}>
          <Button type="submit" variant="primary" size="md" disabled={busy || email.trim().length === 0}>
            {busy ? 'Inviting…' : 'Invite'}
          </Button>
        </div>
      </div>

      {error !== null ? (
        <p id="invite-email-error" role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      ) : null}
    </form>
  );
}
