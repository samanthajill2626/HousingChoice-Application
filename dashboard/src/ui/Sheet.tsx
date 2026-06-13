// Sheet — a bottom-sheet on mobile, a centered modal on tablet/desktop. This is
// the primitive the quick-reply canned-sheet (Feature Agent 4) renders into.
// Accessible: role="dialog" aria-modal, labelled by its title, Escape closes,
// focus moves into the panel on open and the backdrop click closes. Rendered
// via a portal to <body> so it escapes any stacking context.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { IconButton } from './IconButton.js';
import { CloseIcon } from './icons.js';
import styles from './Sheet.module.css';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Hide the close (X) button (e.g. a forced-choice sheet). Default false. */
  hideClose?: boolean;
  children: ReactNode;
}

export function Sheet({ open, onClose, title, hideClose = false, children }: SheetProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the panel for keyboard + screen-reader users.
    panelRef.current?.focus();
    // Lock background scroll while the sheet is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const labelId = title !== undefined ? 'hc-sheet-title' : undefined;

  return createPortal(
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        {...(labelId !== undefined && { 'aria-labelledby': labelId })}
        tabIndex={-1}
        // Stop clicks inside the panel from bubbling to the overlay's close.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.grabber} aria-hidden="true" />
        {(title !== undefined || !hideClose) && (
          <div className={styles.header}>
            {title !== undefined ? (
              <div className={styles.title} id={labelId}>
                {title}
              </div>
            ) : (
              <span />
            )}
            {!hideClose && (
              <IconButton label="Close" size="sm" onClick={onClose}>
                <CloseIcon />
              </IconButton>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
