// CallMenu — the header "📞 Call ▾" control. Opens a popover to dial one of the
// contact's numbers from the navigator's device (a tel: link) or copy it.
//
// HONESTY: in-app MASKED calling (the contact sees our pool number, not the
// navigator's cell) is NOT wired on the backend yet — voice today is inbound /
// founder-bridge only; there is no dashboard-initiated outbound-call route (only
// the `initiateCall` adapter seam). Rather than a half-working bridge, this dials
// through the device and says so. When the masked-call bridge lands, this control
// swaps the tel: link for a POST to the originate route.
import { useEffect, useRef, useState } from 'react';
import { formatPhone } from './format.js';
import type { ContactPhone } from '../../api/index.js';
import styles from './CallMenu.module.css';

export interface CallMenuProps {
  phones: ContactPhone[];
  /** The default/primary target, for the trigger label. */
  defaultPhone?: ContactPhone;
  /** Class for the trigger button so it matches the header band. */
  triggerClassName?: string;
}

export function CallMenu({ phones, defaultPhone, triggerClassName }: CallMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
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

  const hasNumber = defaultPhone !== undefined;

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!hasNumber}
        onClick={() => setOpen((v) => !v)}
      >
        📞 Call{defaultPhone ? ` ${formatPhone(defaultPhone.phone)} ▾` : ''}
      </button>
      {open && hasNumber ? (
        <div className={styles.menu} role="menu">
          {phones.map((p) => (
            <div key={p.phone} className={styles.row}>
              <a className={styles.dial} role="menuitem" href={`tel:${p.phone}`}>
                <span className={styles.num}>{formatPhone(p.phone)}</span>
                {p.label ? <span className={styles.label}>{p.label}</span> : null}
                {p.primary ? <span className={styles.primary}>primary</span> : null}
              </a>
              <button type="button" className={styles.copy} onClick={() => copy(p.phone)}>
                {copied === p.phone ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          ))}
          <p className={styles.note}>
            Dials from your device. Masked in-app calling (caller&nbsp;ID = our number)
            arrives with the voice bridge.
          </p>
        </div>
      ) : null}
    </div>
  );
}
