// TriageForm — the needs-review triage editor inside the contact side panel.
// Edits firstName/lastName, type (tenant/landlord/pm/team_member/unknown),
// voucherSize, status, and notes, then PATCHes /api/contacts/:id via
// updateContact. We send STRUCTURED fields (not the contactName convenience
// string) so the edits map 1:1; the foundation client accepts either.
//
// DIRTY-TRACKING (M1.4 fix): we PATCH only the fields the user ACTUALLY changed
// from the loaded contact snapshot. Editing just the type sends `{ type }` only
// — never re-sending an untouched (possibly legacy) status/name/notes that the
// backend would reject. If nothing changed, Save is disabled (the backend
// requires ≥1 field, which is guaranteed once something is dirty).
//
// STATUS allowlist: the backend (app/src/routes/contacts.ts) only accepts
// `needs_review` and `active`. We offer exactly those. If the loaded contact
// carries a legacy status (e.g. pre-honest-identity 'new') that is NOT in the
// allowlist, we add it as a visible extra option labelled "(legacy)" so the
// <select> never silently shows a different value than the one it holds.
//
// When the type is set to a real value (tenant/landlord), the backend flips the
// owning conversation's type (unknown_1to1 → tenant_1to1/landlord_1to1). The
// parent reacts to onSaved() by refetching BOTH the contact and the conversation
// so the header badge updates and the "needs review" cue clears.
import { useEffect, useMemo, useState } from 'react';
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

/** The backend allowlist EXACTLY (app/src/routes/contacts.ts CONTACT_STATUSES). */
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'active', label: 'Active' },
];

const STATUS_ALLOWLIST = new Set(STATUS_OPTIONS.map((o) => o.value));

/** Backend voucher rule (app/src/routes/contacts.ts): an integer 0..12. A blank
 *  voucher is allowed (it simply isn't sent); a non-blank one must be valid. */
function validateVoucher(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined; // blank → not sent, not an error
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 12) {
    return 'Enter a whole number of bedrooms from 0 to 12.';
  }
  return undefined;
}

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
    // Keep the contact's actual status — even a legacy value — so the select
    // reflects reality. Dirty-tracking ensures an untouched legacy value is
    // never re-sent (and never rejected) on save.
    status: contact.status ?? 'needs_review',
    notes: contact.notes ?? '',
  };
}

export function TriageForm({ contact, onSaved }: TriageFormProps): React.JSX.Element {
  const toast = useToast();
  // The snapshot we diff against. Recomputed when the loaded contact changes
  // (the parent refetches contact + conversation after a save), and the form is
  // re-synced to it below — so dirty-tracking always compares the editor state
  // against the CURRENTLY loaded contact, and a saved edit settles to clean.
  const initial = useMemo(() => initialState(contact), [contact]);
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Voucher validation error, bound to the Voucher FIELD (not the form-level
  // region) — mirrors how AdminUsers wires its email Field error.
  const [voucherError, setVoucherError] = useState<string | undefined>(undefined);

  // Re-sync the editor to the loaded snapshot when the contact prop changes
  // (e.g. after a triage save → parent refetch). `initial` is memoized on
  // [contact], so this fires exactly when the loaded contact changes — not on
  // every render — resetting the form (and clearing any stale error) to match.
  useEffect(() => {
    setForm(initial);
    setError(undefined);
    setVoucherError(undefined);
  }, [initial]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Status options = the backend allowlist, plus the contact's CURRENT status
  // when it is a legacy value outside the allowlist (so the select visibly
  // reflects the real held value rather than silently snapping to the first
  // option). Compared against the snapshot, not the live form, so the legacy
  // option doesn't vanish mid-edit.
  const statusOptions = useMemo(() => {
    if (STATUS_ALLOWLIST.has(initial.status)) return STATUS_OPTIONS;
    return [...STATUS_OPTIONS, { value: initial.status, label: `${initial.status} (legacy)` }];
  }, [initial.status]);

  // Build a patch from ONLY the fields that differ from the loaded snapshot.
  function buildPatch(): ContactPatch {
    const patch: ContactPatch = {};
    if (form.type !== initial.type) patch.type = form.type;
    if (form.firstName.trim() !== initial.firstName.trim()) patch.firstName = form.firstName.trim();
    if (form.lastName.trim() !== initial.lastName.trim()) patch.lastName = form.lastName.trim();
    if (form.status !== initial.status) patch.status = form.status;
    if (form.notes !== initial.notes) patch.notes = form.notes;
    if (form.voucherSize.trim() !== initial.voucherSize.trim()) {
      const trimmed = form.voucherSize.trim();
      if (trimmed.length > 0) {
        const n = Number(trimmed);
        if (Number.isFinite(n)) patch.voucherSize = n;
      }
      // A cleared voucher (now empty, was set) has no structured "clear" in the
      // backend contract here, so we simply don't re-send it.
    }
    return patch;
  }

  // True when at least one field differs from the loaded snapshot. Voucher is
  // dirty ONLY when its trimmed value is non-empty AND differs — so blanking a
  // previously-set voucher (which buildPatch can't express as a "clear") does
  // NOT enable Save. Keeps `dirty` in agreement with buildPatch.
  const dirty = useMemo(() => {
    const voucherTrimmed = form.voucherSize.trim();
    const voucherDirty = voucherTrimmed.length > 0 && voucherTrimmed !== initial.voucherSize.trim();
    return (
      form.type !== initial.type ||
      form.firstName.trim() !== initial.firstName.trim() ||
      form.lastName.trim() !== initial.lastName.trim() ||
      form.status !== initial.status ||
      form.notes !== initial.notes ||
      voucherDirty
    );
  }, [form, initial]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (saving) return;
    // Validate the voucher FIRST (full backend rule: integer 0..12), BEFORE
    // building the patch / the empty-patch early-return — so an invalid voucher
    // surfaces an inline field error instead of a silent no-op.
    const voucherErr = validateVoucher(form.voucherSize);
    if (voucherErr !== undefined) {
      setVoucherError(voucherErr);
      return;
    }
    setVoucherError(undefined);

    const patch = buildPatch();
    // Belt-and-suspenders: an enabled Save that somehow yields an empty patch
    // surfaces a clear message instead of silently doing nothing. (Save is also
    // disabled while !dirty, so this normally can't be reached.)
    if (Object.keys(patch).length === 0) {
      setError('No changes to save.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const updated = await updateContact(contact.contactId, patch);
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

  // noValidate: our JS validation owns the rules (full backend voucher rule + a
  // clear inline field error). The Input's min/max/step stay as defense-in-depth
  // UI hints, but native constraint validation must not silently block submit
  // before our handler runs. Mirrors AdminUsers' invite form.
  return (
    <form className={styles.form} noValidate onSubmit={(e) => void handleSubmit(e)}>
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
        <Field
          label="Voucher size"
          hint="Bedrooms, 0–12 (e.g. 2)"
          {...(voucherError !== undefined && { error: voucherError })}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={0}
              max={12}
              step={1}
              value={form.voucherSize}
              invalid={invalid}
              {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
              onChange={(e) => {
                set('voucherSize', e.target.value);
                if (voucherError !== undefined) setVoucherError(undefined);
              }}
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
              {statusOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <Field label="Notes">
        {({ id }) => (
          <Textarea
            id={id}
            rows={3}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        )}
      </Field>

      {/* Single form-level error region — never misattributed to the Notes field. */}
      {error !== undefined && (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      )}

      <Button
        type="submit"
        loading={saving}
        disabled={!dirty}
        title={!dirty ? 'Change a field to enable saving' : undefined}
        block
      >
        Save contact
      </Button>
    </form>
  );
}
