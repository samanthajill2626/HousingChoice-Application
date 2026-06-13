// ContactNew — create a contact (route '/contacts/new').
//
// Fields: type, first/last name, phone, and (for tenants) voucher size. POSTs
// to /api/contacts. The backend dedupes by phone: on a 409 'contact_exists' it
// returns the EXISTING contact in the error body — we surface a friendly notice
// with a link to that contact instead of erroring out. On success we navigate
// to the new contact's detail page.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  createContact,
  type Contact,
  type ContactType,
  type CreateContactBody,
} from '../api/index.js';
import { Button, ChevronLeftIcon, Field, Input, useToast } from '../ui/index.js';
import { CONTACT_TYPES, CONTACT_TYPE_LABEL } from './records/records.js';
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

/** Pull the existing contact off a 409 contact_exists error body, if present. */
function existingContactFrom(err: unknown): Contact | undefined {
  if (err instanceof ApiError && err.code === 'contact_exists' && err.body !== null && typeof err.body === 'object') {
    const body = err.body as { contact?: Contact };
    if (body.contact && typeof body.contact.contactId === 'string') return body.contact;
  }
  return undefined;
}

export default function ContactNew(): React.JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();

  const [type, setType] = useState<ContactType>('tenant');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [voucherSize, setVoucherSize] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [voucherError, setVoucherError] = useState<string | undefined>(undefined);
  // Set when the phone matched an existing contact (409) — we link to it.
  const [existing, setExisting] = useState<Contact | undefined>(undefined);

  const showVoucher = type === 'tenant';

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(undefined);
    setExisting(undefined);

    if (showVoucher) {
      const voucherErr = validateVoucher(voucherSize);
      if (voucherErr !== undefined) {
        setVoucherError(voucherErr);
        return;
      }
    }
    setVoucherError(undefined);

    const body: CreateContactBody = { type };
    if (firstName.trim().length > 0) body.firstName = firstName.trim();
    if (lastName.trim().length > 0) body.lastName = lastName.trim();
    if (phone.trim().length > 0) body.phone = phone.trim();
    if (showVoucher && voucherSize.trim().length > 0) {
      const n = Number(voucherSize.trim());
      if (Number.isFinite(n)) body.voucherSize = n;
    }

    setSubmitting(true);
    try {
      const created = await createContact(body);
      toast.success('Contact created');
      navigate(`/contacts/${encodeURIComponent(created.contactId)}`);
    } catch (err) {
      const dup = existingContactFrom(err);
      if (dup !== undefined) {
        setExisting(dup);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not create the contact.');
      toast.error('Could not create the contact');
    } finally {
      setSubmitting(false);
    }
  }

  const existingLabel = useMemo(() => {
    if (existing === undefined) return '';
    const parts = [existing.firstName, existing.lastName].filter(
      (p): p is string => typeof p === 'string' && p.trim().length > 0,
    );
    return parts.length > 0 ? parts.join(' ') : (existing.phone ?? 'this contact');
  }, [existing]);

  return (
    <section className={styles.page} aria-labelledby="contact-new-heading">
      <Link to="/contacts" className={styles.back}>
        <ChevronLeftIcon size={16} />
        Back to contacts
      </Link>

      <header className={styles.header}>
        <div>
          <h1 id="contact-new-heading">New contact</h1>
          <p className={styles.lead}>Add a tenant, landlord, property manager, or team member.</p>
        </div>
      </header>

      <div className={styles.surface}>
        <form className={styles.form} noValidate onSubmit={(e) => void handleSubmit(e)}>
          <Field label="Type" required>
            {({ id }) => (
              <select
                id={id}
                className={styles.select}
                value={type}
                disabled={submitting}
                onChange={(e) => setType(e.target.value as ContactType)}
              >
                {CONTACT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CONTACT_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <div className={styles.fieldRow}>
            <Field label="First name">
              {({ id }) => (
                <Input
                  id={id}
                  value={firstName}
                  disabled={submitting}
                  onChange={(e) => setFirstName(e.target.value)}
                />
              )}
            </Field>
            <Field label="Last name">
              {({ id }) => (
                <Input
                  id={id}
                  value={lastName}
                  disabled={submitting}
                  onChange={(e) => setLastName(e.target.value)}
                />
              )}
            </Field>
          </div>

          <Field label="Phone" hint="E.164 (e.g. +13135551234)">
            {({ id }) => (
              <Input
                id={id}
                type="tel"
                inputMode="tel"
                placeholder="+13135551234"
                value={phone}
                disabled={submitting}
                onChange={(e) => setPhone(e.target.value)}
              />
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
                  value={voucherSize}
                  invalid={invalid}
                  disabled={submitting}
                  {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
                  onChange={(e) => {
                    setVoucherSize(e.target.value);
                    if (voucherError !== undefined) setVoucherError(undefined);
                  }}
                />
              )}
            </Field>
          )}

          {existing !== undefined && (
            <p className={styles.formError} role="alert">
              A contact with that phone already exists ({existingLabel}).{' '}
              <Link to={`/contacts/${encodeURIComponent(existing.contactId)}`}>
                Open the existing contact
              </Link>
              .
            </p>
          )}

          {error !== undefined && (
            <p className={styles.formError} role="alert">
              {error}
            </p>
          )}

          <Button type="submit" loading={submitting}>
            Create contact
          </Button>
        </form>
      </div>
    </section>
  );
}
