// NewRelayGroup — the create-relay-group entry point (M1.7, route
// '/relay-groups/new'). A minimal test-harness form: enter two or more members
// (phone required, optional name; an optional contactId links an existing
// contact), POST createRelayGroup (provisions a pool number + sends the intro),
// then navigate to the new thread. Honest identity: a member with no name is
// just a phone — we never fabricate one.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, createRelayGroup, type RelayMemberInput } from '../api';
import { Button, Field, Input, useToast } from '../ui';
import styles from './records/records.module.css';

interface MemberDraft {
  phone: string;
  name: string;
  contactId: string;
}

function emptyMember(): MemberDraft {
  return { phone: '', name: '', contactId: '' };
}

export default function NewRelayGroup(): React.JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const [members, setMembers] = useState<MemberDraft[]>([emptyMember(), emptyMember()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function update(index: number, patch: Partial<MemberDraft>): void {
    setMembers((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  }

  function addRow(): void {
    setMembers((prev) => [...prev, emptyMember()]);
  }

  function removeRow(index: number): void {
    setMembers((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    // Build the payload from rows that carry a phone; trim everything.
    const payload: RelayMemberInput[] = members
      .map((m) => {
        const phone = m.phone.trim();
        const name = m.name.trim();
        const contactId = m.contactId.trim();
        return {
          phone,
          ...(name.length > 0 && { name }),
          ...(contactId.length > 0 && { contactId }),
        };
      })
      .filter((m) => m.phone.length > 0);

    if (payload.length < 1) {
      setError('Add at least one member with a phone number.');
      return;
    }

    setSubmitting(true);
    setError(undefined);
    try {
      const conversation = await createRelayGroup({ members: payload });
      toast.success('Relay group created');
      navigate(`/conversations/${encodeURIComponent(conversation.conversationId)}`);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'pool_number_unavailable'
            ? 'No phone number is available right now — try again shortly.'
            : err.message
          : 'Could not create the relay group.';
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.page} aria-labelledby="new-relay-heading">
      <header className={styles.header}>
        <div>
          <button type="button" className={styles.back} onClick={() => navigate('/')}>
            ← Back to inbox
          </button>
          <h1 id="new-relay-heading">New relay group</h1>
          <p className={styles.lead}>
            Members text one masked number; replies relay to everyone else. Add each
            member&apos;s phone (and an optional name shown as the sender prefix).
          </p>
        </div>
      </header>

      <form className={styles.surface} onSubmit={handleSubmit} noValidate>
        <div className={styles.form}>
          {members.map((m, i) => (
            <fieldset key={i} className={styles.addressGroup}>
              <legend className={styles.addressLegend}>Member {i + 1}</legend>
              <div className={styles.fieldRow}>
                <Field label="Phone" required hint="E.164 (e.g. +13135551234)">
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      type="tel"
                      inputMode="tel"
                      placeholder="+1 555 555 1234"
                      value={m.phone}
                      {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
                      onChange={(e) => update(i, { phone: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Name" hint="Optional">
                  {({ id }) => (
                    <Input
                      id={id}
                      placeholder="Optional name"
                      value={m.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                    />
                  )}
                </Field>
              </div>
              <Field label="Contact ID" hint="Optional — link an existing contact">
                {({ id }) => (
                  <Input
                    id={id}
                    placeholder="Optional contactId"
                    value={m.contactId}
                    onChange={(e) => update(i, { contactId: e.target.value })}
                  />
                )}
              </Field>
              {members.length > 1 && (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRow(i)}
                    aria-label={`Remove member ${i + 1}`}
                  >
                    Remove member
                  </Button>
                </div>
              )}
            </fieldset>
          ))}

          {error !== undefined && (
            <p className={styles.formError} role="alert">
              {error}
            </p>
          )}

          <div className={styles.formActions}>
            <Button type="button" variant="secondary" onClick={addRow}>
              Add another member
            </Button>
            <Button type="submit" loading={submitting}>
              Create relay group
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}
