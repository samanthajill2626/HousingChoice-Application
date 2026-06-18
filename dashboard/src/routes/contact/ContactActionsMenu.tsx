// ContactActionsMenu — the header ⋯ kebab on the contact page. A popover menu
// (outside-click + Escape close, mirroring the app account menu) with: Edit
// contact details, Copy link to this contact, and a Do-Not-Contact (sms_opt_out)
// toggle. The opt-out item reflects + flips the current flag; the parent owns the
// request + applies the returned contact.
import { useEffect, useRef, useState } from 'react';
import styles from './ContactActionsMenu.module.css';

export interface ContactActionsMenuProps {
  onEdit: () => void;
  /** Current sms_opt_out flag (drives the toggle label + state). */
  optedOut: boolean;
  /** Flip the opt-out flag; the parent does the request. */
  onToggleOptOut: () => void;
  /** True while the opt-out request is in flight (disables that item). */
  optOutBusy?: boolean;
}

export function ContactActionsMenu({
  onEdit,
  optedOut,
  onToggleOptOut,
  optOutBusy = false,
}: ContactActionsMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const copyLink = (): void => {
    void navigator.clipboard?.writeText(window.location.href).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard blocked — silently ignore (rare; non-critical) */
      },
    );
  };

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.kebab}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            Edit contact details
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              copyLink();
              // Keep the menu open briefly so the "Copied" confirmation shows.
            }}
          >
            {copied ? 'Copied ✓' : 'Copy link to contact'}
          </button>
          <div className={styles.divider} />
          <button
            type="button"
            role="menuitem"
            className={`${styles.item} ${optedOut ? '' : styles.danger}`}
            disabled={optOutBusy}
            onClick={() => {
              setOpen(false);
              onToggleOptOut();
            }}
          >
            {optedOut ? 'Allow SMS (clear opt-out)' : 'Mark Do-Not-Contact'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
