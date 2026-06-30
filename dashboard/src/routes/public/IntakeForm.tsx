// IntakeForm — the shared, controlled housing-fair signup form used by BOTH the
// flyer funnel (with a unitId) and the standalone /join intake (no unit). It
// owns the input state, client validation, and the pending/error UI; the PARENT
// owns what "submit" means (it passes `onSubmit`) and what happens on success
// (the funnel reveals details; /join shows a generic thank-you). Every input has
// an associated <label> (getByLabel-resolvable); the submit button has a clear
// accessible name. Mobile-first.
import { useState, type FormEvent } from 'react';
import styles from './IntakeForm.module.css';
import type { HousingFairInput } from './publicApi.js';

export interface IntakeFormProps {
  /** Submit handler — resolves on success, throws on failure. The parent decides
   *  what to do next (reveal vs. thank-you). */
  onSubmit: (input: Omit<HousingFairInput, 'unitId'>) => Promise<void>;
  /** The submit button's label (e.g. "Send my info" / "Sign up"). */
  submitLabel?: string;
}

export function IntakeForm({ onSubmit, submitLabel = 'Send my info' }: IntakeFormProps): React.JSX.Element {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [voucher, setVoucher] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    // Client validation: names + phone must be non-empty (the backend re-checks).
    if (firstName.trim() === '' || lastName.trim() === '') {
      setError('Please enter your first and last name.');
      return;
    }
    if (phone.trim() === '') {
      setError('Please enter your phone number.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      const voucherSize = voucher.trim() === '' ? undefined : Number(voucher);
      await onSubmit({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
        ...(voucherSize !== undefined && Number.isFinite(voucherSize) && { voucherSize }),
      });
    } catch {
      setError("Sorry, we couldn't send that. Please try again.");
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="intake-first">
          First name
        </label>
        <input
          id="intake-first"
          className={styles.input}
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          autoComplete="given-name"
          disabled={pending}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="intake-last">
          Last name
        </label>
        <input
          id="intake-last"
          className={styles.input}
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          autoComplete="family-name"
          disabled={pending}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="intake-phone">
          Phone number
        </label>
        <input
          id="intake-phone"
          className={styles.input}
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="tel"
          disabled={pending}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="intake-voucher">
          Voucher size (bedrooms) — optional
        </label>
        <input
          id="intake-voucher"
          className={styles.input}
          type="number"
          inputMode="numeric"
          min={0}
          value={voucher}
          onChange={(e) => setVoucher(e.target.value)}
          disabled={pending}
        />
      </div>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <button className={styles.submit} type="submit" disabled={pending}>
        {pending ? 'Sending…' : submitLabel}
      </button>
    </form>
  );
}
