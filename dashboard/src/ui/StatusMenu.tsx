// StatusMenu — an interactive status "pill". Shows the current status as a badge
// and, on click, opens a menu to change it (a single control that both DISPLAYS
// and CHANGES the status, so pages don't duplicate a badge + a separate dropdown).
// Accessible menu-button: aria-haspopup, radio menu items, outside-click + Escape
// close. Reusable across entity pages (property status now; placement stage /
// contact status are candidates for the same pattern).
import { useEffect, useRef, useState } from 'react';
import styles from './StatusMenu.module.css';

/** The pill colour, mirroring the existing status-badge tones. */
export type StatusTone = 'available' | 'placed' | 'inactive';

export interface StatusMenuOption {
  value: string;
  label: string;
}

export interface StatusMenuProps {
  /** The current status value. */
  value: string;
  /** Selectable statuses, in display order. */
  options: StatusMenuOption[];
  /** Called with the chosen status (never fired for re-selecting the current one). */
  onChange: (value: string) => void;
  /** Pill colour for the current status. */
  tone: StatusTone;
  /** Disable the control while a change is in flight. */
  disabled?: boolean;
  /** Accessible name for the trigger + menu (e.g. "Property status"). */
  label: string;
  /** Optional inline error (e.g. a rejected transition), shown below the pill. */
  error?: string | null;
}

const TONE_CLASS: Record<StatusTone, string> = {
  available: styles.toneAvailable ?? '',
  placed: styles.tonePlaced ?? '',
  inactive: styles.toneInactive ?? '',
};

export function StatusMenu({
  value,
  options,
  onChange,
  tone,
  disabled = false,
  label,
  error = null,
}: StatusMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

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

  const current = options.find((o) => o.value === value);
  return (
    <span className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={`${styles.trigger} ${TONE_CLASS[tone]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.label ?? value}
        <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={label}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              className={styles.item}
              onClick={() => {
                setOpen(false);
                if (o.value !== value) onChange(o.value);
              }}
            >
              <span className={styles.check} aria-hidden="true">
                {o.value === value ? '✓' : ''}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      {error !== null ? (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
