// HousingFair — the PUBLIC housing-fair signup form (route '/housing-fair',
// NO auth). Rendered ABOVE the auth gate (see App.tsx): no session, no app
// chrome. POSTs to /public/housing-fair.
//   success → a "Thanks, we'll text you!" confirmation;
//   400 'invalid request' → an inline validation message;
//   429 'rate_limited'    → "please try again in a moment".
import { useState } from 'react';
import { ApiError, submitHousingFair, type HousingFairSignup } from '../api/index.js';
import { Button, Field, Input } from '../ui/index.js';
import styles from './public.module.css';

function validateVoucher(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 12) {
    return 'Enter a whole number of bedrooms from 0 to 12.';
  }
  return undefined;
}

export default function HousingFair(): React.JSX.Element {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [voucherSize, setVoucherSize] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [voucherError, setVoucherError] = useState<string | undefined>(undefined);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setFormError(undefined);

    // Minimal client-side checks — the backend is the source of truth (it owns
    // the 400 'invalid request'), but catching empties here saves a round trip.
    if (firstName.trim().length === 0 || lastName.trim().length === 0 || phone.trim().length === 0) {
      setFormError('Please fill in your first name, last name, and phone number.');
      return;
    }
    const voucherErr = validateVoucher(voucherSize);
    if (voucherErr !== undefined) {
      setVoucherError(voucherErr);
      return;
    }
    setVoucherError(undefined);

    const body: HousingFairSignup = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: phone.trim(),
    };
    if (voucherSize.trim().length > 0) {
      const n = Number(voucherSize.trim());
      if (Number.isFinite(n)) body.voucherSize = n;
    }

    setSubmitting(true);
    try {
      await submitHousingFair(body);
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setFormError('We got a lot of signups just now — please try again in a moment.');
      } else if (err instanceof ApiError && err.status === 400) {
        setFormError('Please check your details and try again — that didn’t look quite right.');
      } else {
        setFormError('Something went wrong. Please try again in a moment.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <main className={styles.page}>
        <div className={styles.card}>
          <div className={styles.brand}>HousingChoice</div>
          <h1 className={styles.title}>Thanks, we&apos;ll text you!</h1>
          <p className={styles.subtitle}>
            You&apos;re on the list. We&apos;ll send you a text message with next steps shortly.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>HousingChoice</div>
        <h1 className={styles.title}>Housing fair sign-up</h1>
        <p className={styles.subtitle}>
          Leave your details and we&apos;ll text you about available homes.
        </p>

        <form className={styles.form} noValidate onSubmit={(e) => void handleSubmit(e)}>
          <div className={styles.fieldRow}>
            <Field label="First name" required>
              {({ id }) => (
                <Input id={id} value={firstName} disabled={submitting} autoComplete="given-name" onChange={(e) => setFirstName(e.target.value)} />
              )}
            </Field>
            <Field label="Last name" required>
              {({ id }) => (
                <Input id={id} value={lastName} disabled={submitting} autoComplete="family-name" onChange={(e) => setLastName(e.target.value)} />
              )}
            </Field>
          </div>

          <Field label="Phone" required hint="We'll text you here.">
            {({ id }) => (
              <Input
                id={id}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="(555) 555-1234"
                value={phone}
                disabled={submitting}
                onChange={(e) => setPhone(e.target.value)}
              />
            )}
          </Field>

          <Field
            label="Voucher size (optional)"
            hint="Bedrooms, 0–12"
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

          {formError !== undefined && (
            <p className={styles.formError} role="alert">
              {formError}
            </p>
          )}

          <Button type="submit" size="lg" block loading={submitting}>
            Sign me up
          </Button>

          <p className={styles.footnote}>
            By signing up you agree to receive text messages from HousingChoice. Message and data
            rates may apply. Reply STOP to opt out.
          </p>
        </form>
      </div>
    </main>
  );
}
