// Modal — a small accessible dialog overlay (role="dialog", aria-modal). Escape
// and a backdrop click close it; focus moves into the dialog on open and returns
// to the trigger on close. Used by the contact edit form + phone manager. Kept
// local to the contact route for now (the first modal in the new dashboard).
import { useEffect, useId, useRef } from 'react';
import styles from './Modal.module.css';

export interface ModalProps {
  /** Accessible title; also the visible heading. */
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Optional footer (action buttons), pinned below the scrollable body. */
  footer?: React.ReactNode;
}

export function Modal({ title, onClose, children, footer }: ModalProps): React.JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Move focus into the dialog so keyboard + screen-reader users land inside it.
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className={styles.backdrop}
      // A click on the backdrop (outside the dialog) dismisses; clicks inside don't
      // bubble here because the dialog stops propagation.
      onMouseDown={onClose}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.bodyInner}>{children}</div>
        </div>
        {footer !== undefined ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}
