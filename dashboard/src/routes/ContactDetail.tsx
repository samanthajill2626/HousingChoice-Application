// ContactDetail — view + edit one contact (route '/contacts/:contactId').
//
// Loads the contact (GET /api/contacts/:id) and renders an edit form over the
// type's fields. We reuse the triage PATCH endpoint (updateContact) for edits,
// sending ONLY changed fields (dirty-tracking) so an untouched (possibly
// legacy) status is never re-sent — and we NEVER expose a raw status dropdown
// (the backend auto-advances status when a real type is set). Honest identity:
// an un-triaged contact shows its phone + a review chip, never a fake name.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  getContact,
  updateContact,
  useApi,
  type Contact,
  type ContactPatch,
  type ContactType,
} from '../api/index.js';
import { Badge, Button, ChevronLeftIcon, EmptyState, Field, Input, Spinner, Textarea, useToast } from '../ui/index.js';
import { formatPhone } from './thread/identity.js';
import { CONTACT_TYPES, CONTACT_TYPE_LABEL, contactName, contactNeedsReview } from './records/records.js';
import styles from './records/records.module.css';

function validateVoucher(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 12) {
    return 'Enter a whole number of bedrooms from 0 to 12.';
  }
  return undefined;
}

export default function ContactDetail(): React.JSX.Element {
  const { contactId } = useParams<{ contactId: string }>();
  const id = contactId ?? '';
  const navigate = useNavigate();

  const { data: contact, loading, error, refetch } = useApi(
    (signal) => getContact(id, signal),
    [id],
  );

  if (loading && contact === undefined) {
    return (
      <section className={styles.page}>
        <Spinner center label="Loading contact" />
      </section>
    );
  }

  if (error || !contact) {
    const notFound = error?.status === 404;
    return (
      <section className={styles.page}>
        <EmptyState
          title={notFound ? 'Contact not found' : "Couldn't load this contact"}
          description={
            notFound
              ? 'This contact may have been removed.'
              : 'Something went wrong loading the contact.'
          }
          action={
            <Button variant="secondary" onClick={() => navigate('/contacts')}>
              Back to contacts
            </Button>
          }
        />
      </section>
    );
  }

  return <ContactEditor contact={contact} onSaved={refetch} />;
}

interface FormState {
  firstName: string;
  lastName: string;
  type: ContactType;
  voucherSize: string;
  notes: string;
}

function initialState(contact: Contact): FormState {
  return {
    firstName: contact.firstName ?? '',
    lastName: contact.lastName ?? '',
    type: contact.type,
    voucherSize: contact.voucherSize !== undefined ? String(contact.voucherSize) : '',
    notes: contact.notes ?? '',
  };
}

function ContactEditor({
  contact,
  onSaved,
}: {
  contact: Contact;
  onSaved: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const initial = useMemo(() => initialState(contact), [contact]);
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [voucherError, setVoucherError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setForm(initial);
    setError(undefined);
    setVoucherError(undefined);
  }, [initial]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // tenant carries a voucher size; everyone has notes + name + type.
  const showVoucher = form.type === 'tenant';

  function buildPatch(): ContactPatch {
    const patch: ContactPatch = {};
    if (form.type !== initial.type) patch.type = form.type;
    if (form.firstName.trim() !== initial.firstName.trim()) patch.firstName = form.firstName.trim();
    if (form.lastName.trim() !== initial.lastName.trim()) patch.lastName = form.lastName.trim();
    if (form.notes !== initial.notes) patch.notes = form.notes;
    if (showVoucher && form.voucherSize.trim() !== initial.voucherSize.trim()) {
      const trimmed = form.voucherSize.trim();
      if (trimmed.length > 0) {
        const n = Number(trimmed);
        if (Number.isFinite(n)) patch.voucherSize = n;
      }
    }
    return patch;
  }

  const dirty = useMemo(() => {
    const voucherTrimmed = form.voucherSize.trim();
    const voucherDirty =
      showVoucher && voucherTrimmed.length > 0 && voucherTrimmed !== initial.voucherSize.trim();
    return (
      form.type !== initial.type ||
      form.firstName.trim() !== initial.firstName.trim() ||
      form.lastName.trim() !== initial.lastName.trim() ||
      form.notes !== initial.notes ||
      voucherDirty
    );
  }, [form, initial, showVoucher]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (saving) return;
    if (showVoucher) {
      const voucherErr = validateVoucher(form.voucherSize);
      if (voucherErr !== undefined) {
        setVoucherError(voucherErr);
        return;
      }
    }
    setVoucherError(undefined);

    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      setError('No changes to save.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await updateContact(contact.contactId, patch);
      toast.success('Contact saved');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the contact.');
      toast.error('Could not save the contact');
    } finally {
      setSaving(false);
    }
  }

  const name = contactName(contact);
  const review = contactNeedsReview(contact);
  const phone = formatPhone(contact.phone);

  return (
    <section className={styles.page} aria-labelledby="contact-detail-heading">
      <Link to="/contacts" className={styles.back}>
        <ChevronLeftIcon size={16} />
        Back to contacts
      </Link>

      <header className={styles.header}>
        <div>
          <h1 id="contact-detail-heading">{name ?? phone}</h1>
          <p className={styles.lead}>{phone}</p>
        </div>
        {review ? (
          <Badge tone="review" dot>
            Needs review
          </Badge>
        ) : (
          <Badge tone="info">{CONTACT_TYPE_LABEL[contact.type]}</Badge>
        )}
      </header>

      <div className={styles.surface}>
        <h2 className={styles.sectionTitle}>Edit contact</h2>
        <form className={styles.form} noValidate onSubmit={(e) => void handleSubmit(e)}>
          <div className={styles.fieldRow}>
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

          <Field label="Type" hint="Setting tenant or landlord resolves the contact's identity.">
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={form.type}
                onChange={(e) => set('type', e.target.value as ContactType)}
              >
                {CONTACT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CONTACT_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {showVoucher && (
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
          )}

          <Field label="Notes">
            {({ id }) => (
              <Textarea id={id} rows={4} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            )}
          </Field>

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
          >
            Save contact
          </Button>
        </form>
      </div>
    </section>
  );
}
