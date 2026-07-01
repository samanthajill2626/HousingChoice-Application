// CallMenu — the header "📞 Call ▾" control. Opens a popover to place a MASKED
// in-app call to one of the contact's numbers.
//
// Masked calling is now WIRED (Voice Phase 1 §5): clicking a number POSTs to the
// originate route (POST /api/contacts/:id/call), which rings the NAVIGATOR'S own
// verified cell first; on answer it bridges to the contact with our business
// number as the caller ID — the contact never sees the navigator's cell, and the
// call is logged + recorded. The old device-side `tel:` dial (unmasked, unlogged)
// is gone.
//
// Two guards live here (the backend enforces both too, defensively):
//   • voice_opt_out (do-not-call): the whole control is DISABLED with a note.
//   • the navigator has no VERIFIED cell: clicking prompts them to set one
//     (a Settings deep-link) instead of silently failing — the originate would
//     otherwise 409 cell_not_verified.
import { useEffect, useRef, useState } from 'react';
import { formatPhone } from './format.js';
import { ApiError, originateCall, type ContactPhone } from '../../api/index.js';
import styles from './CallMenu.module.css';

export interface CallMenuProps {
  /** The contact being called (the originate route target). */
  contactId: string;
  phones: ContactPhone[];
  /** The default/primary target, for the trigger label. */
  defaultPhone?: ContactPhone;
  /** Do-not-call (voice_opt_out): disables the control entirely, with a note. */
  voiceOptOut?: boolean;
  /** Whether the CURRENT navigator has a verified cell. When false, clicking a
   *  number prompts them to set one instead of dialing. */
  navigatorHasVerifiedCell?: boolean;
  /** Deep-link the navigator to the Settings voice section to set their cell. */
  onSetUpCell?: () => void;
  /** Class for the trigger button so it matches the header band. */
  triggerClassName?: string;
}

/** The transient call-state banner the popover shows after an originate attempt. */
type CallState =
  | { kind: 'idle' }
  | { kind: 'calling' } // 200 — the navigator's cell is ringing
  | { kind: 'need_cell' } // 409 cell_not_verified — prompt to set a cell
  | { kind: 'error'; message: string };

export function CallMenu({
  contactId,
  phones,
  defaultPhone,
  voiceOptOut = false,
  navigatorHasVerifiedCell = true,
  onSetUpCell,
  triggerClassName,
}: CallMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [call, setCall] = useState<CallState>({ kind: 'idle' });
  const [dialing, setDialing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reset the transient call banner whenever the popover closes.
  useEffect(() => {
    if (!open) setCall({ kind: 'idle' });
  }, [open]);

  const copy = (phone: string): void => {
    void navigator.clipboard?.writeText(phone).then(
      () => {
        setCopied(phone);
        window.setTimeout(() => setCopied(null), 1500);
      },
      () => {
        /* clipboard blocked — ignore */
      },
    );
  };

  const dial = (phone: string): void => {
    if (dialing) return;
    // No verified cell → don't dial; prompt to set one up (the originate would
    // 409 cell_not_verified anyway). This is the primary non-dialing path.
    if (!navigatorHasVerifiedCell) {
      setCall({ kind: 'need_cell' });
      return;
    }
    setDialing(true);
    setCall({ kind: 'idle' });
    void originateCall(contactId, { phone })
      .then(() => setCall({ kind: 'calling' }))
      .catch((err: unknown) => {
        if (err instanceof ApiError) {
          if (err.code === 'cell_not_verified') {
            setCall({ kind: 'need_cell' });
            return;
          }
          if (err.code === 'contact_voice_opted_out') {
            // Shouldn't happen (the control is disabled for do-not-call), but
            // handle gracefully rather than showing a raw error.
            setCall({
              kind: 'error',
              message: 'This contact is marked do not call.',
            });
            return;
          }
        }
        setCall({ kind: 'error', message: "Couldn't start the call — please try again." });
      })
      .finally(() => setDialing(false));
  };

  const hasNumber = defaultPhone !== undefined;
  // Do-not-call disables the whole control (spec §5/§8). Still show it so the
  // note is visible; the trigger is disabled + labelled.
  const triggerDisabled = !hasNumber || voiceOptOut;

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={triggerDisabled}
        title={voiceOptOut ? 'Do not call — this contact opted out of calls' : undefined}
        aria-describedby={voiceOptOut ? 'call-dnc-note' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        📞 Call{defaultPhone ? ` ${formatPhone(defaultPhone.phone)} ▾` : ''}
      </button>
      {voiceOptOut ? (
        <span id="call-dnc-note" className={styles.dncNote} role="status">
          Do not call
        </span>
      ) : null}
      {open && hasNumber && !voiceOptOut ? (
        <div className={styles.menu} role="menu">
          {phones.map((p) => (
            <div key={p.phone} className={styles.row}>
              <button
                type="button"
                className={styles.dial}
                role="menuitem"
                disabled={dialing}
                onClick={() => dial(p.phone)}
              >
                <span className={styles.num}>{formatPhone(p.phone)}</span>
                {p.label ? <span className={styles.label}>{p.label}</span> : null}
                {p.primary ? <span className={styles.primary}>primary</span> : null}
              </button>
              <button
                type="button"
                className={styles.copy}
                aria-label={`Copy ${formatPhone(p.phone)}`}
                onClick={() => copy(p.phone)}
              >
                {copied === p.phone ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          ))}

          {call.kind === 'calling' ? (
            <p className={styles.calling} role="status">
              Calling your cell — answer to connect.
            </p>
          ) : call.kind === 'need_cell' ? (
            <div className={styles.needCell} role="alert">
              <p className={styles.note}>
                Set up your cell to place masked calls. Your number stays private —
                the contact sees our business number.
              </p>
              {onSetUpCell ? (
                <button type="button" className={styles.setupLink} onClick={onSetUpCell}>
                  Set up my cell
                </button>
              ) : null}
            </div>
          ) : call.kind === 'error' ? (
            <p className={styles.callError} role="alert">
              {call.message}
            </p>
          ) : (
            <p className={styles.note}>
              Rings your cell first — answer to connect. The contact sees our
              business number, not yours.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
