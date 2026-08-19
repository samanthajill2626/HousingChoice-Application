// TourActionsMenu - the tour header kebab. A popover menu (outside-click + Escape
// close) mirroring ContactActionsMenu, holding the STATUS-BRANCH actions that
// aren't the one guided primary CTA: Reschedule, Mark already toured, Cancel,
// Mark no-show, and Open relay group.
// Each item is shown only when its guard passes (the parent computes
// the guards from the tour status); an item that needs input opens a Modal that
// the parent owns. When no item qualifies the parent renders nothing (no empty
// kebab).
import { useEffect, useRef, useState } from 'react';
import styles from './TourActionsMenu.module.css';

export interface TourActionsMenuProps {
  /** Reschedule (canReschedule statuses: scheduled / canceled / no_show). */
  canReschedule: boolean;
  onReschedule: () => void;
  /** Mark already toured (requested only): the tour happened without ever being
   *  booked, so it skips scheduling entirely and goes straight to the exit gate.
   *  Scheduling it instead would arm - and send - a reminder ladder for a visit
   *  that already took place. */
  canMarkAlreadyToured: boolean;
  onMarkAlreadyToured: () => void;
  /** Cancel (pre-tour statuses: requested / scheduled). */
  canCancel: boolean;
  onCancel: () => void;
  /** Mark no-show (scheduled only). */
  canMarkNoShow: boolean;
  onMarkNoShow: () => void;
  /** Send the manual no-show check-in (tour start passed; scheduled or no_show). */
  canSendNoShowCheckin: boolean;
  onSendNoShowCheckin: () => void;
  /** Open relay group (no group yet + tour not dead). */
  canOpenGroup: boolean;
  onOpenGroup: () => void;
  /** Why the relay group cannot be opened RIGHT NOW even though the tour could
   *  otherwise take one - today: fewer than two reachable roster members
   *  (contact-rosters spec 6.2). The item stays VISIBLE and DISABLED carrying
   *  this reason, instead of failing at click time with the route's
   *  400 relay_member_unresolvable. Same gate the pane's own button obeys. */
  openGroupDisabledReason?: string;
  /** True while a mutation is in flight (disables the items). */
  busy?: boolean;
}

export function TourActionsMenu({
  canReschedule,
  onReschedule,
  canMarkAlreadyToured,
  onMarkAlreadyToured,
  canCancel,
  onCancel,
  canMarkNoShow,
  onMarkNoShow,
  canSendNoShowCheckin,
  onSendNoShowCheckin,
  canOpenGroup,
  onOpenGroup,
  openGroupDisabledReason,
  busy = false,
}: TourActionsMenuProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
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

  // Nothing qualifies -> no kebab at all (a closed tour with a group has no branch
  // actions, so the parent shows only the header + primary CTA).
  if (
    !canReschedule &&
    !canMarkAlreadyToured &&
    !canCancel &&
    !canMarkNoShow &&
    !canOpenGroup &&
    !canSendNoShowCheckin
  )
    return null;

  const run = (fn: () => void): void => {
    setOpen(false);
    fn();
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
        {/* U+22EF midline horizontal ellipsis - the SAME kebab glyph
            ContactActionsMenu renders; written as an escape so this new file
            stays ASCII-only in source. */}
        {'\u22EF'}
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          {canReschedule ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={busy}
              onClick={() => run(onReschedule)}
            >
              Reschedule
            </button>
          ) : null}
          {canMarkAlreadyToured ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={busy}
              onClick={() => run(onMarkAlreadyToured)}
            >
              Mark already toured
            </button>
          ) : null}
          {canMarkNoShow ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={busy}
              onClick={() => run(onMarkNoShow)}
            >
              Mark no-show
            </button>
          ) : null}
          {canSendNoShowCheckin ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={busy}
              onClick={() => run(onSendNoShowCheckin)}
            >
              Send no-show check-in
            </button>
          ) : null}
          {canOpenGroup ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={busy || openGroupDisabledReason !== undefined}
              {...(openGroupDisabledReason !== undefined && { title: openGroupDisabledReason })}
              onClick={() => run(onOpenGroup)}
            >
              Open relay group
            </button>
          ) : null}
          {canCancel ? (
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${styles.danger}`}
              disabled={busy}
              onClick={() => run(onCancel)}
            >
              Cancel tour
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
