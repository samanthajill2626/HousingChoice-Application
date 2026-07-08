// StageMenu - the desktop-only kebab on a ledger row. Opens the FULL stage
// ladder grouped under phase headers (the same ladder the detail page's picker
// shows) so a move is one-shot accurate - the old phase-level move always
// landed on a phase's first stage and needed a second correction. 'lost' is
// pulled out of the groups into a danger "Mark lost..." item at the bottom.
// Outside-click + Escape close, mirroring ContactActionsMenu. The menu is a
// child of the button's wrapper (position:relative) and scrolls when tall.
import { useEffect, useRef, useState } from 'react';
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

export function StageMenu({ tenant, currentStage, busy = false, onSelect }: StageMenuProps): React.JSX.Element {
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

  function pick(stage: PlacementStage): void {
    setOpen(false);
    onSelect(stage);
  }

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.kebab}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${tenant}`}
        onClick={() => setOpen((v) => !v)}
      >
        {'\u22EF'}
      </button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={`Move ${tenant} to stage`}>
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
        </div>
      ) : null}
    </div>
  );
}
