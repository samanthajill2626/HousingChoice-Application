// StatusMenu — an interactive status "pill". Shows the current status as a badge
// and, on click, opens a menu to change it (a single control that both DISPLAYS
// and CHANGES the status, so pages don't duplicate a badge + a separate dropdown).
// Accessible menu-button: aria-haspopup, radio menu items, outside-click + Escape
// close. Reusable across entity pages: property status (flat, coloured tones) and
// placement stage (phase-GROUPED options, neutral tone, larger size). The parent
// owns any gating — onChange may kick off a confirm/reason modal instead of an
// immediate write; the menu just reports the chosen value.
import { useEffect, useRef, useState } from 'react';
import styles from './StatusMenu.module.css';

/** The pill colour. Two families:
 *  - SOLID fills (white text) for the property header's dark band:
 *    `available` | `placed` | `inactive`.
 *  - SOFT tints (dark text) mirroring StatusBadge's BadgeTone, for contact
 *    statuses: `positive` | `progress` | `warn` | `muted`.
 *  - `neutral` is an un-tinted outlined pill (e.g. a workflow stage that has no
 *    colour semantic; also the badge-neutral look). */
export type StatusTone =
  | 'available'
  | 'placed'
  | 'inactive'
  | 'neutral'
  | 'positive'
  | 'progress'
  | 'warn'
  | 'muted';

/** The pill size: `sm` (a compact badge, the default) or `lg` (a prominent header
 *  control, e.g. the placement stage). */
export type StatusMenuSize = 'sm' | 'lg';

export interface StatusMenuOption {
  value: string;
  label: string;
}

/** A labelled section of options (rendered as a heading + its items). */
export interface StatusMenuGroup {
  label: string;
  options: StatusMenuOption[];
}

export interface StatusMenuProps {
  /** The current status value. */
  value: string;
  /** A FLAT list of selectable options (use this OR `groups`). */
  options?: StatusMenuOption[];
  /** GROUPED options — rendered as labelled sections (use this OR `options`). */
  groups?: StatusMenuGroup[];
  /** Called with the chosen value (never fired for re-selecting the current one). */
  onChange: (value: string) => void;
  /** Pill colour for the current status. */
  tone: StatusTone;
  /** Pill size. Defaults to `sm`. */
  size?: StatusMenuSize;
  /** Disable the control while a change is in flight. */
  disabled?: boolean;
  /** Human name of what the pill controls (e.g. "Property status", "Placement
   *  stage"). The trigger announces "<label>: <current>" to assistive tech. */
  label: string;
  /** Optional inline error (e.g. a rejected transition), shown below the pill. */
  error?: string | null;
}

const TONE_CLASS: Record<StatusTone, string> = {
  available: styles.toneAvailable ?? '',
  placed: styles.tonePlaced ?? '',
  inactive: styles.toneInactive ?? '',
  neutral: styles.toneNeutral ?? '',
  positive: styles.tonePositive ?? '',
  progress: styles.toneProgress ?? '',
  warn: styles.toneWarn ?? '',
  muted: styles.toneMuted ?? '',
};

export function StatusMenu({
  value,
  options,
  groups,
  onChange,
  tone,
  size = 'sm',
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

  const allOptions = groups ? groups.flatMap((g) => g.options) : (options ?? []);
  const current = allOptions.find((o) => o.value === value);

  const choose = (v: string): void => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  const renderItem = (o: StatusMenuOption): React.JSX.Element => (
    <button
      key={o.value}
      type="button"
      role="menuitemradio"
      aria-checked={o.value === value}
      className={styles.item}
      onClick={() => choose(o.value)}
    >
      <span className={styles.check} aria-hidden="true">
        {o.value === value ? '✓' : ''}
      </span>
      {o.label}
    </button>
  );

  return (
    <span className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={`${styles.trigger} ${TONE_CLASS[tone]} ${size === 'lg' ? styles.sizeLg : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.label ?? value}
        <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={label}>
          {groups
            ? groups.map((g) => (
                <div key={g.label} role="group" aria-label={g.label} className={styles.group}>
                  <div className={styles.groupLabel} aria-hidden="true">
                    {g.label}
                  </div>
                  {g.options.map(renderItem)}
                </div>
              ))
            : (options ?? []).map(renderItem)}
        </div>
      ) : null}
      {/* The error and the menu share the same anchor slot below the pill, so the
          error is SUPPRESSED while the menu is open — otherwise it overlaps the
          first menu row and steals its pointer events. Parents also clear the
          error when a new attempt starts, so a retry never re-opens onto a stale
          message. */}
      {error !== null && !open ? (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
