// StageMenu - the desktop-only kebab on a ledger row. Opens the FULL stage
// ladder grouped under phase headers (the same ladder the detail page's picker
// shows) so a move is one-shot accurate - the old phase-level move always
// landed on a phase's first stage and needed a second correction. 'lost' is
// pulled out of the groups into a danger "Mark lost..." item at the bottom.
// Outside-click + Escape close, mirroring ContactActionsMenu.
//
// POSITIONING: the menu is a position:FIXED popover rendered through a React
// PORTAL to document.body, with coordinates measured from the kebab's rect at
// open time. Two ancestor traps force this (both verified live, both
// load-bearing so they stay untouched):
//   1. overflow clipping - .row / .rows (PlacementRow/PlacementsPage css) use
//      overflow:hidden (attention-stripe + rounded-corner clipping); an
//      absolutely positioned child popover was cropped to a ~5px sliver.
//   2. stacking-context trapping - .actions (PlacementRow css) is
//      position:relative + z-index:2, which CONTAINS any descendant z-index:
//      an in-place fixed menu painted under the sticky group headers (z 3)
//      and under LATER rows' kebabs (z 2, later in DOM order).
// The portal escapes both. Outside-click checks BOTH refs (the kebab wrap and
// the portaled menu) since the menu is no longer inside the wrap's subtree.
// Fixed coordinates go stale on scroll/resize, so either simply closes the
// menu (scrolls INSIDE the tall menu itself are ignored - it scrolls
// internally). The fixed-pos containing-block hazard (transform/filter/
// contain on an ancestor) was also checked live: document.body's chain is
// clean, so the viewport-relative coordinates hold.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PLACEMENT_PHASES,
  PLACEMENT_STAGES,
  STAGE_LABELS,
  STAGE_PHASE,
  type PlacementStage,
} from '../../api/index.js';
import styles from './StageMenu.module.css';

export interface StageMenuProps {
  tenant: string;
  currentStage: PlacementStage;
  /** True while a transition for this row is in flight (disables all items). */
  busy?: boolean;
  onSelect: (toStage: PlacementStage) => void;
}

/** Fixed-position coordinates for the popover, measured at open time. */
interface MenuPos {
  top: number;
  right: number;
  /** CSS max-height expression: viewport-clamped, floored at 200px, and still
   *  bounded by the design cap (min(60vh, 480px), mirroring the stylesheet). */
  maxHeight: string;
}

export function StageMenu({ tenant, currentStage, busy = false, onSelect }: StageMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      // The menu is portaled OUT of the wrap's subtree - "inside" means inside
      // either the kebab wrap or the portaled menu node.
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Fixed coordinates go stale the moment anything scrolls or resizes -
    // close instead of chasing. Capture phase so the ledger's own scroll
    // container counts; scrolls INSIDE the menu (it scrolls when tall) do not.
    const onScroll = (e: Event): void => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onResize = (): void => setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  function toggle(): void {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const top = rect.bottom + 4;
      setPos({
        top,
        right: window.innerWidth - rect.right,
        maxHeight: `max(200px, min(${window.innerHeight - top - 12}px, 60vh, 480px))`,
      });
    }
    setOpen((v) => !v);
  }

  function pick(stage: PlacementStage): void {
    setOpen(false);
    onSelect(stage);
  }

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        ref={btnRef}
        className={styles.kebab}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${tenant}`}
        onClick={toggle}
      >
        {'\u22EF'}
      </button>
      {open
        ? createPortal(
            <div
              className={styles.menu}
              ref={menuRef}
              role="menu"
              aria-label={`Move ${tenant} to stage`}
              style={pos ? { top: pos.top, right: pos.right, maxHeight: pos.maxHeight } : undefined}
            >
              {PLACEMENT_PHASES.map((phase) => {
                const stages = PLACEMENT_STAGES.filter((s) => STAGE_PHASE[s] === phase && s !== 'lost');
                if (stages.length === 0) return null;
                return (
                  <div key={phase} className={styles.group} role="presentation">
                    <div className={styles.groupHead} role="presentation" aria-hidden="true">
                      {phase}
                    </div>
                    {stages.map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="menuitem"
                        className={styles.item}
                        disabled={busy || s === currentStage}
                        onClick={() => pick(s)}
                      >
                        {STAGE_LABELS[s]}
                        {s === currentStage ? ' (current)' : ''}
                      </button>
                    ))}
                  </div>
                );
              })}
              <div className={styles.divider} role="presentation" />
              <button
                type="button"
                role="menuitem"
                className={`${styles.item} ${styles.danger}`}
                disabled={busy || currentStage === 'lost'}
                onClick={() => pick('lost')}
              >
                Mark lost...
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
