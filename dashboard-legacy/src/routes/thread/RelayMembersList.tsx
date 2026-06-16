// RelayMembersList — the relay-group roster side panel (M1.7), the relay
// counterpart of ContactPanel. Lists each member (name, else formatted phone —
// honest identity), with a per-member Remove button, and an add-member form
// (phone required, optional name). All mutations are idempotent and reflect the
// live roster: the hook patches from each mutation's response, and a
// conversation.updated SSE event refreshes the roster in place without a reload.
//
// When the group is closed, member edits are disabled (reopen to manage the
// roster) — the pool number is released, so the roster is frozen.
import { useState } from 'react';
import { ApiError, type ConversationParticipant } from '../../api';
import { Avatar, Badge, Button, Field, Input, Spinner } from '../../ui';
import { memberLabel } from './relay';
import { formatPhone } from './identity';
import styles from './RelayMembersList.module.css';

export interface RelayMembersListProps {
  members: ConversationParticipant[];
  loading: boolean;
  error: ApiError | undefined;
  /** True when the group is closed (member edits disabled). */
  closed: boolean;
  /** Add a member (idempotent on phone); rejects with ApiError on failure. */
  onAdd: (member: { phone: string; name?: string }) => Promise<void>;
  /** Remove a member by E.164 phone (idempotent). */
  onRemove: (phone: string) => Promise<void>;
}

export function RelayMembersList({
  members,
  loading,
  error,
  closed,
  onAdd,
  onRemove,
}: RelayMembersListProps): React.JSX.Element {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [removingPhone, setRemovingPhone] = useState<string | undefined>(undefined);

  async function handleAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmedPhone = phone.trim();
    if (trimmedPhone.length === 0 || adding) return;
    setAdding(true);
    setAddError(undefined);
    try {
      const trimmedName = name.trim();
      await onAdd({ phone: trimmedPhone, ...(trimmedName.length > 0 && { name: trimmedName }) });
      setPhone('');
      setName('');
    } catch (err) {
      setAddError(
        err instanceof ApiError
          ? err.code === 'roster_conflict'
            ? 'Someone else just changed the roster — try again.'
            : err.message
          : 'Could not add member.',
      );
    } finally {
      setAdding(false);
    }
  }

  function handleRemove(memberPhone: string): void {
    setRemovingPhone(memberPhone);
    onRemove(memberPhone)
      .catch(() => {
        // Non-fatal; the roster stays as-is and the operator can retry.
      })
      .finally(() => setRemovingPhone(undefined));
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3 className={styles.title}>Members</h3>
        <Badge tone="info" title={`${members.length} in this relay group`}>
          {members.length}
        </Badge>
      </div>

      {loading ? (
        <Spinner center label="Loading members" />
      ) : error ? (
        <p className={styles.error} role="alert">
          Couldn&apos;t load members.
        </p>
      ) : members.length === 0 ? (
        <p className={styles.empty}>No members yet. Add one below.</p>
      ) : (
        <ul className={styles.list} aria-label="Relay members">
          {members.map((m) => {
            const label = memberLabel(m);
            const hasName = m.name !== undefined && m.name.length > 0;
            return (
              <li key={m.phone} className={styles.member}>
                <Avatar name={hasName ? m.name : undefined} review={!hasName} size="sm" />
                <div className={styles.memberMain}>
                  <span className={styles.memberName}>{label}</span>
                  {hasName && <span className={styles.memberSub}>{formatPhone(m.phone)}</span>}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={closed}
                  loading={removingPhone === m.phone}
                  onClick={() => handleRemove(m.phone)}
                  title={closed ? 'Reopen the group to edit members' : 'Remove from group'}
                  aria-label={`Remove ${label}`}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <form className={styles.addForm} onSubmit={handleAdd} noValidate>
        <h4 className={styles.addTitle}>Add member</h4>
        <Field
          label="Phone"
          hint="E.164 (e.g. +13135551234)"
          {...(addError !== undefined && { error: addError })}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="tel"
              inputMode="tel"
              placeholder="+1 555 555 1234"
              value={phone}
              invalid={invalid}
              disabled={closed || adding}
              {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
              onChange={(e) => setPhone(e.target.value)}
            />
          )}
        </Field>
        <Field label="Name" hint="Optional — shown as the sender prefix">
          {({ id }) => (
            <Input
              id={id}
              placeholder="Optional name"
              value={name}
              disabled={closed || adding}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" size="sm" loading={adding} disabled={closed || phone.trim().length === 0}>
          Add member
        </Button>
        {closed && (
          <p className={styles.closedNote} role="status">
            Reopen the group to add or remove members.
          </p>
        )}
      </form>
    </div>
  );
}
