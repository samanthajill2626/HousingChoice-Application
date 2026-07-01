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
import {
  WEB_FORM_CONSENT_LABEL,
  PRIVACY_POLICY_URL,
  TERMS_URL,
} from '../../lib/consentCopy.js';

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
  // do-not-remove — A2P/CTIA consent gate (client-side; server also enforces).
  // REQUIRED, unchecked by default. Submit is blocked until this is true.
  const [smsConsent, setSmsConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear a standing validation error the moment the user edits any field, so a
  // corrected field stops reading as errored (the error re-evaluates on submit).
  function onField(setter: (v: string) => void): (e: { target: { value: string } }) => void {
    return (e) => {
      if (error !== null) setError(null);
      setter(e.target.value);
    };
  }

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
    // do-not-remove — A2P/CTIA consent gate (client-side; server also enforces).
    // Submit is blocked until the required consent checkbox is checked.
    if (!smsConsent) {
      setError('Please agree to receive texts to continue.');
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
        smsConsent: true,
        ...(voucherSize !== undefined && Number.isFinite(voucherSize) && { voucherSize }),
      });
    } catch {
      setError("Sorry, we couldn't send that. Please try again.");
      setPending(false);
    }
  }

  // Render the FILED CTIA disclosure (WEB_FORM_CONSENT_LABEL) VERBATIM, turning
  // the words "Privacy Policy" and "Terms" into links WITHOUT altering any other
  // character. We slice the single source-of-truth string around those two link
  // phrases so the visible text can never drift from the filed copy.
  // do-not-remove — A2P/CTIA consent copy (verbatim from lib/consentCopy.ts).
  function consentLabel(): React.ReactNode {
    const label = WEB_FORM_CONSENT_LABEL;
    const ppIdx = label.indexOf('Privacy Policy');
    const termsIdx = label.indexOf('Terms', ppIdx);
    const prefix = label.slice(0, ppIdx); // "…See our "
    const between = label.slice(ppIdx + 'Privacy Policy'.length, termsIdx); // " and "
    const suffix = label.slice(termsIdx + 'Terms'.length); // "."
    return (
      <>
        {prefix}
        <a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        {between}
        <a href={TERMS_URL} target="_blank" rel="noreferrer">
          Terms
        </a>
        {suffix}
      </>
    );
  }

  // The error element id — referenced by every required field's aria-describedby
  // (only while an error is present) so SRs announce the message in context. The
  // visible "*" is aria-hidden (keeps accessible names stable for getByLabel);
  // aria-required carries the required semantics to assistive tech.
  const errorId = 'intake-error';
  const describedBy = error !== null ? errorId : undefined;

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="intake-first">
          First name{' '}
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        </label>
        <input
          id="intake-first"
          className={styles.input}
          value={firstName}
          onChange={onField(setFirstName)}
          autoComplete="given-name"
          aria-required="true"
          aria-invalid={error !== null}
          aria-describedby={describedBy}
          disabled={pending}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="intake-last">
          Last name{' '}
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        </label>
        <input
          id="intake-last"
          className={styles.input}
          value={lastName}
          onChange={onField(setLastName)}
          autoComplete="family-name"
          aria-required="true"
          aria-invalid={error !== null}
          aria-describedby={describedBy}
          disabled={pending}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="intake-phone">
          Phone number{' '}
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        </label>
        <input
          id="intake-phone"
          className={styles.input}
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={onField(setPhone)}
          autoComplete="tel"
          aria-required="true"
          aria-invalid={error !== null}
          aria-describedby={describedBy}
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
          onChange={onField(setVoucher)}
          disabled={pending}
        />
      </div>

      {/* do-not-remove — A2P/CTIA consent gate (client-side; server also
          enforces). REQUIRED, unchecked by default; submit is blocked until it
          is checked. The label text is the FILED CTIA disclosure (verbatim,
          from lib/consentCopy.ts) — "Privacy Policy" and "Terms" are rendered as
          links (new tab, rel="noreferrer"). */}
      <div className={styles.consentField}>
        <label className={styles.consentLabel} htmlFor="intake-consent">
          <input
            id="intake-consent"
            className={styles.consentBox}
            type="checkbox"
            checked={smsConsent}
            onChange={(e) => {
              if (error !== null) setError(null);
              setSmsConsent(e.target.checked);
            }}
            aria-required="true"
            aria-invalid={error !== null && !smsConsent}
            aria-describedby={describedBy}
            disabled={pending}
          />
          <span className={styles.consentText}>{consentLabel()}</span>
        </label>
      </div>

      {error !== null && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}

      <button className={styles.submit} type="submit" disabled={pending}>
        {pending ? 'Sending…' : submitLabel}
      </button>
    </form>
  );
}
