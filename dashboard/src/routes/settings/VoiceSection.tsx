// VoiceSection — the self-service "your cell" surface (Voice Phase 1 §7).
// Reachable by ANY logged-in user (not admin-only): a navigator attaches +
// verifies their OWN cell here so they can place masked outbound calls (their
// cell is the private bridge leg — the contact only ever sees our business
// number). Shows the current cell + verification state, then a two-step verify
// flow: enter a cell → "Send code" (SMS a 6-digit code) → enter the code →
// "Verify" → "Verified ✓" with the timestamp. The CallMenu deep-links here when
// the navigator has no verified cell yet.
import { useState } from 'react';
import { useMe } from '../../app/useMe.js';
import { Button, Spinner } from '../../ui/index.js';
import { useCellVerify } from './useCellVerify.js';
import styles from './VoiceSection.module.css';

/** Format a US E.164 as "(404) 555-0100" for display; pass through others. */
function fmtCell(e164: string | undefined): string {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `(${m[1] ?? ''}) ${m[2] ?? ''}-${m[3] ?? ''}`;
}

/** Friendly verified-at date. */
function fmtVerifiedAt(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** True when `value` is a valid US E.164 number (e.g. "+14045550100"). */
function isE164(value: string): boolean {
  return /^\+1\d{10}$/.test(value);
}

export function VoiceSection(): React.JSX.Element {
  const { status, me, refresh, setMe } = useMe();
  const [cell, setCell] = useState('');
  const [code, setCode] = useState('');
  const [cellError, setCellError] = useState<string | null>(null);

  const verify = useCellVerify({
    onVerified: (cellVerifiedAt) => {
      // Reflect the verified cell in place (the entered cell + timestamp), then
      // re-probe the server so the summary is authoritative.
      if (me !== undefined) {
        setMe({ ...me, cell: verify.pendingCell ?? cell, cell_verified_at: cellVerifiedAt });
      }
      refresh();
    },
  });

  const currentlyVerified =
    typeof me?.cell === 'string' &&
    me.cell.length > 0 &&
    typeof me?.cell_verified_at === 'string' &&
    me.cell_verified_at.length > 0;

  async function onSend(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = cell.trim();
    // Require E.164 before sending — the backend rejects anything else with a
    // 400 invalid_cell. Surface the error client-side to avoid a round trip and
    // give the user clear guidance. Example valid input: +14045550100.
    if (!isE164(trimmed)) {
      setCellError("Enter a number in E.164 format, e.g. +14045550100.");
      return;
    }
    setCellError(null);
    await verify.sendCode(trimmed);
  }

  async function onConfirm(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    await verify.confirm(code.trim());
  }

  function startOver(): void {
    verify.reset();
    setCode('');
    setCellError(null);
  }

  return (
    <section className={styles.section} aria-labelledby="voice-heading">
      <h2 id="voice-heading" className={styles.heading}>
        Voice
      </h2>
      <p className={styles.intro}>
        Verify your cell so you can place masked calls from a contact&apos;s page.
        Your number stays private — the contact only sees our business number, and
        the call rings your cell first.
      </p>

      {status === 'loading' ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : status === 'error' ? (
        <div role="alert" className={styles.errorBlock}>
          <p>Couldn&apos;t load your voice settings.</p>
          <Button variant="secondary" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          {/* Current state */}
          <div className={styles.current}>
            <span className={styles.currentLabel}>Your cell</span>
            {currentlyVerified ? (
              <span className={styles.verified} role="status">
                {fmtCell(me?.cell)} — Verified ✓
                {me?.cell_verified_at ? (
                  <span className={styles.verifiedAt}> {fmtVerifiedAt(me.cell_verified_at)}</span>
                ) : null}
              </span>
            ) : me?.cell ? (
              <span className={styles.unverified}>{fmtCell(me.cell)} — not verified</span>
            ) : (
              <span className={styles.unverified}>Not set</span>
            )}
          </div>

          {/* Verify flow */}
          {verify.phase === 'verified' ? (
            <div className={styles.doneRow}>
              <span role="status" className={styles.doneMsg}>
                Verified ✓ You can now place masked calls.
              </span>
              <Button variant="secondary" size="sm" onClick={startOver}>
                Verify a different number
              </Button>
            </div>
          ) : verify.phase === 'code_sent' ? (
            <form className={styles.form} onSubmit={(e) => void onConfirm(e)}>
              <p className={styles.sentNote}>
                We texted a 6-digit code to {fmtCell(verify.pendingCell ?? cell)}.
              </p>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Verification code</span>
                <input
                  className={styles.input}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  value={code}
                  disabled={verify.busy}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              </label>
              {verify.error !== null ? (
                <p role="alert" className={styles.error}>
                  {verify.error}
                </p>
              ) : null}
              <div className={styles.actions}>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  disabled={verify.busy || code.trim().length < 6}
                >
                  {verify.busy ? 'Verifying…' : 'Verify'}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={startOver} disabled={verify.busy}>
                  Use a different number
                </Button>
              </div>
            </form>
          ) : (
            <form className={styles.form} onSubmit={(e) => void onSend(e)}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  {currentlyVerified ? 'Change your cell' : 'Your mobile number'}
                </span>
                <input
                  className={styles.input}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+14045550100"
                  required
                  value={cell}
                  disabled={verify.busy}
                  onChange={(e) => { setCell(e.target.value); setCellError(null); }}
                />
              </label>
              {(cellError ?? verify.error) !== null ? (
                <p role="alert" className={styles.error}>
                  {cellError ?? verify.error}
                </p>
              ) : null}
              <div className={styles.actions}>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  disabled={verify.busy || cell.trim().length === 0}
                >
                  {verify.busy ? 'Sending…' : 'Send code'}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
