// TourActionsMenu - the tour header kebab. A popover menu (outside-click + Escape
// close) mirroring ContactActionsMenu, holding the STATUS-BRANCH actions that
// aren't the one guided primary CTA: Reschedule, Cancel, Mark no-show, and Open
// group text. Each item is shown only when its guard passes (the parent computes
// the guards from the tour status); an item that needs input opens a Modal that
// the parent owns. When no item qualifies the parent renders nothing (no empty
// kebab).
import { useEffect, useRef, useState } from 'react';
import styles from './TourActionsMenu.module.css';

export interface TourActionsMenuProps {
  /** Reschedule (canReschedule statuses: scheduled / canceled / no_show). */
  canReschedule: boolean;
  onReschedule: () => void;
  /** Cancel (pre-tour statuses: requested / scheduled). */
  canCancel: boolean;
  onCancel: () => void;
  /** Mark no-show (scheduled only). */
  canMarkNoShow: boolean;
  onMarkNoShow: () => void;
  /** Send the manual no-show check-in (tour start passed; scheduled or no_show). */
  canSendNoShowCheckin: boolean;
  onSendNoShowCheckin: () => void;
  /** Open group text (no group yet + tour not dead). */
  canOpenGroup: boolean;
  onOpenGroup: () => void;
  /** True while a mutation is in flight (disables the items). */
  busy?: boolean;
}

export function TourActionsMenu({
  canReschedule,
  onReschedule,
  canCancel,
  onCancel,
  canMarkNoShow,
  onMarkNoShow,
  canSendNoShowCheckin,
  onSendNoShowCheckin,
  canOpenGroup,
  onOpenGroup,
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
  if (!canReschedule && !canCancel && !canMarkNoShow && !canOpenGroup && !canSendNoShowCheckin)
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
              disabled={busy}
              onClick={() => run(onOpenGroup)}
            >
              Open group text
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
