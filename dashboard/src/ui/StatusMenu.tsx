// StatusMenu — an interactive status "pill". Shows the current status as a badge
// and, on click, opens a menu to change it (a single control that both DISPLAYS
// and CHANGES the status, so pages don't duplicate a badge + a separate dropdown).
// Accessible menu-button: aria-haspopup, radio menu items, outside-click + Escape
// close. Reusable across entity pages: property status (flat, coloured tones) and
// placement stage (phase-GROUPED options, neutral tone, larger size). The parent
// owns any gating — onChange may kick off a confirm/reason modal instead of an
// immediate write; the menu just reports the chosen value.
//
// HEIGHT: the menu bounds itself to the room actually below its trigger and
// scrolls internally. The placement stage ladder is 18 options across 7 phase
// groups (~880px), which uncapped ran off the bottom of the window AND grew its
// scroll container, so the page sprouted a second scrollbar — on a phone the menu
// was taller than the whole viewport. The clamp mirrors the ledger row's
// StageMenu, the other menu that renders this same ladder. Unlike StageMenu this
// one does NOT need a portal: its hosts (page headers, the placement kebab) have
// no overflow-clipping or stacking-context ancestor — verified live — so it stays
// absolutely positioned and keeps tracking its trigger on scroll.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { humanize } from '../routes/contact/format.js';
import styles from './StatusMenu.module.css';

/** The pill colour. Two families:
 *  - SOLID fills (white text) for the property header's dark band:
 *    `available` | `placed` | `inactive`.
 *  - SOFT tints (dark text) mirroring StatusBadge's BadgeTone, for contact
 *    statuses: `positive` | `progress` | `warn` | `muted`.
 *  - `neutral` is an un-tinted outlined pill (e.g. a workflow stage that has no
 *    colour semantic; also the badge-neutral look).
 *  - `info` | `danger` joined BadgeTone with the tour StatusBadge work
 *    (2026-07-08); solid brand/danger fills matching the badge look, so the
 *    mirror stays total when a pill fronts one of those statuses. */
export type StatusTone =
  | 'available'
  | 'placed'
  | 'inactive'
  | 'neutral'
  | 'positive'
  | 'progress'
  | 'warn'
  | 'muted'
  | 'info'
  | 'danger';

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

/** Breathing room between the menu's bottom edge and the viewport's. */
const VIEWPORT_GUTTER = 12;
/** The shortest menu worth opening. Below this the clamp would hand back a sliver,
 *  so we let it overhang slightly instead — it scrolls internally either way. */
const MIN_MENU_HEIGHT = 200;
/** Design cap: even with a wall of room, a menu this tall is already too long to
 *  scan. Mirrors the `min(60vh, 480px)` fallback in the stylesheet. */
const MAX_MENU_HEIGHT = 480;

/** The menu's max-height in px: the room below `trigger`, bounded by the design
 *  cap and floored so it stays usable. Returns null when there's no trigger to
 *  measure (nothing rendered yet), leaving the stylesheet fallback in charge. */
function clampMenuHeight(trigger: HTMLElement | null): number | null {
  if (trigger === null) return null;
  const { bottom } = trigger.getBoundingClientRect();
  const roomBelow = window.innerHeight - bottom - VIEWPORT_GUTTER;
  const capped = Math.min(roomBelow, window.innerHeight * 0.6, MAX_MENU_HEIGHT);
  return Math.max(MIN_MENU_HEIGHT, Math.round(capped));
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
  info: styles.toneInfo ?? '',
  danger: styles.toneDanger ?? '',
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
  /** Viewport-derived px cap for the open menu; null until it's been measured. */
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /** The rendered menu items, in DOM (= display) order. */
  const menuItems = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);

  /** Close and put focus back on the trigger (APG menu-button: Escape/selection
   *  return focus; without this, closing unmounts the focused item and focus
   *  silently drops to <body>). */
  const closeAndRefocus = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // Only reclaim focus when it currently lives inside this control (a
        // keyboard user dismissing by clicking empty space) — never steal it
        // from another control the user just clicked.
        if (ref.current.contains(document.activeElement)) triggerRef.current?.focus();
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Measure BEFORE paint (layout effect) so the menu never flashes at full height
  // and shoves the page's scroll height around on the way to being clamped.
  // The menu is absolutely positioned, so it follows its trigger on scroll — only
  // the amount of room below it changes, so we re-measure rather than close.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = (): void => setMaxHeight(clampMenuHeight(triggerRef.current));
    measure();
    // Capture phase so a scroll of any ancestor container counts, not just the
    // window; scrolling INSIDE the menu changes nothing, so ignore that.
    const onScroll = (e: Event): void => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      measure();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  // On open, move focus INTO the menu — the checked item (radio-menu
  // convention), else the first (APG menu-button pattern).
  //
  // Waits for the clamp (maxHeight non-null) rather than running on `open` alone:
  // focusing while the menu is still full height scrolls nothing, and by the time
  // the cap lands the browser has no reason to revisit it — which left the current
  // stage focused but off the bottom of a menu you opened to move off that stage.
  // The ref keeps this to ONCE per open, so re-measuring on scroll never yanks
  // focus back while the user is arrowing through the list.
  const focusedOnOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedOnOpen.current = false;
      return;
    }
    if (maxHeight === null || focusedOnOpen.current) return;
    focusedOnOpen.current = true;
    const items = menuItems();
    const target = items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0];
    // preventScroll keeps focus from jerking the PAGE; the scroll we do want is
    // inside the menu, and 'nearest' is a no-op once the item is already in view.
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }, [open, maxHeight]);

  const allOptions = groups ? groups.flatMap((g) => g.options) : (options ?? []);
  const current = allOptions.find((o) => o.value === value);
  // An off-list/legacy stored value has no option to label it — humanize the raw
  // string (same fallback StatusBadge uses) instead of showing snake_case.
  const currentLabel = current?.label ?? humanize(value);

  const choose = (v: string): void => {
    closeAndRefocus();
    if (v !== value) onChange(v);
  };

  /** Arrow/Home/End roving focus inside the menu; Tab closes and resumes the
   *  page tab sequence from the trigger. Enter/Space activate natively (items
   *  are buttons). */
  const onMenuKeyDown = (e: React.KeyboardEvent): void => {
    const items = menuItems();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      // Close and refocus the trigger WITHOUT preventing default, so the tab
      // continues from the trigger to its natural neighbor.
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  /** ArrowDown/ArrowUp on the (closed) trigger open the menu, per APG. */
  const onTriggerKeyDown = (e: React.KeyboardEvent): void => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const renderItem = (o: StatusMenuOption): React.JSX.Element => (
    <button
      key={o.value}
      type="button"
      role="menuitemradio"
      aria-checked={o.value === value}
      className={styles.item}
      // Roving focus via arrows only — keep items out of the page tab order.
      tabIndex={-1}
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
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${TONE_CLASS[tone]} ${size === 'lg' ? styles.sizeLg : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${currentLabel}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        {currentLabel}
        <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          className={styles.menu}
          role="menu"
          aria-label={label}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
          {...(maxHeight !== null && { style: { maxHeight: `${maxHeight}px` } })}
        >
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
