// TriageForm — the needs-review triage editor inside the contact side panel.
// Edits firstName/lastName, type (tenant/landlord/pm/team_member/unknown),
// voucherSize, status, and notes, then PATCHes /api/contacts/:id via
// updateContact. We send STRUCTURED fields (not the contactName convenience
// string) so the edits map 1:1; the foundation client accepts either.
//
// When the type is set to a real value (tenant/landlord), the backend flips the
// owning conversation's type (unknown_1to1 → tenant_1to1/landlord_1to1). The
// parent reacts to onSaved() by refetching BOTH the contact and the conversation
// so the header badge updates and the "needs review" cue clears.
import { useState } from 'react';
import { ApiError, updateContact, type Contact, type ContactPatch, type ContactType } from '../../api';
import { Button, Field, Input, Textarea, useToast } from '../../ui';
import styles from './TriageForm.module.css';

const TYPE_OPTIONS: { value: ContactType; label: string }[] = [
  { value: 'unknown', label: 'Unknown (needs review)' },
  { value: 'tenant', label: 'Tenant' },
  { value: 'landlord', label: 'Landlord' },
  { value: 'pm', label: 'Property manager' },
  { value: 'team_member', label: 'Team member' },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
];

export interface TriageFormProps {
  contact: Contact;
  /** Called after a successful PATCH — the parent refetches contact + conversation. */
  onSaved: (updated: Contact) => void;
}

interface FormState {
  firstName: string;
  lastName: string;
  type: ContactType;
  voucherSize: string;
  status: string;
  notes: string;
}

function initialState(contact: Contact): FormState {
  return {
    firstName: contact.firstName ?? '',
    lastName: contact.lastName ?? '',
    type: contact.type,
    voucherSize: contact.voucherSize !== undefined ? String(contact.voucherSize) : '',
    status: contact.status ?? 'needs_review',
    notes: contact.notes ?? '',
  };
}

export function TriageForm({ contact, onSaved }: TriageFormProps): React.JSX.Element {
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => initialState(contact));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function buildPatch(): ContactPatch {
    const patch: ContactPatch = { type: form.type, status: form.status };
    patch.firstName = form.firstName.trim();
    patch.lastName = form.lastName.trim();
    patch.notes = form.notes;
    const trimmedVoucher = form.voucherSize.trim();
    if (trimmedVoucher.length > 0) {
      const n = Number(trimmedVoucher);
      if (Number.isFinite(n)) patch.voucherSize = n;
    }
    return patch;
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (saving) return;
    const voucher = form.voucherSize.trim();
    if (voucher.length > 0 && !Number.isFinite(Number(voucher))) {
      setError('Voucher size must be a number.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const updated = await updateContact(contact.contactId, buildPatch());
      toast.success('Contact saved');
      onSaved(updated);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not save the contact.';
      setError(message);
      toast.error('Could not save the contact');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
      <div className={styles.row}>
        <Field label="First name">
          {({ id }) => (
            <Input id={id} value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
          )}
        </Field>
        <Field label="Last name">
          {({ id }) => (
            <Input id={id} value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
          )}
        </Field>
      </div>

      <Field label="Type" hint="Setting tenant or landlord resolves the conversation's identity.">
        {({ id }) => (
          <select
            id={id}
            className={styles.select}
            value={form.type}
            onChange={(e) => set('type', e.target.value as ContactType)}
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <div className={styles.row}>
        <Field label="Voucher size" hint="Bedrooms (e.g. 2)">
          {({ id }) => (
            <Input
              id={id}
              inputMode="numeric"
              value={form.voucherSize}
              onChange={(e) => set('voucherSize', e.target.value)}
            />
          )}
        </Field>
        <Field label="Status">
          {({ id }) => (
            <select
              id={id}
              className={styles.select}
              value={form.status}
              onChange={(e) => set('status', e.target.value)}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <Field label="Notes" {...(error !== undefined && { error })}>
        {({ id, describedBy, invalid }) => (
          <Textarea
            id={id}
            {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
            invalid={invalid}
            rows={3}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        )}
      </Field>

      <Button type="submit" loading={saving} block>
        Save contact
      </Button>
    </form>
  );
}
