// Modal — a small accessible dialog overlay (role="dialog", aria-modal). Escape
// and a backdrop click close it; focus moves into the dialog on open and returns
// to the trigger on close. Used by the contact edit form + phone manager. Kept
// local to the contact route for now (the first modal in the new dashboard).
import { useEffect, useId, useRef } from 'react';
import styles from './Modal.module.css';

// A page can temporarily mount more than one modal. Escape belongs to the most
// recently mounted one; every older document listener must leave it alone.
const mountedDialogs: HTMLDivElement[] = [];

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
  const onCloseRef = useRef(onClose);
  // Capture before descendant effects can move focus into the dialog. This is
  // the element unmount must restore even when a child claims initial focus.
  const previouslyFocusedRef = useRef(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    // A child mount effect may already have focused the first form field. Keep
    // that valid descendant focus; the dialog itself is the fallback target.
    const dialog = dialogRef.current;
    if (dialog === null) return;
    mountedDialogs.push(dialog);
    if (!dialog.contains(document.activeElement)) dialog.focus();
    const onKey = (e: KeyboardEvent): void => {
      const topmostDialog = mountedDialogs[mountedDialogs.length - 1];
      if (e.key === 'Escape' && !e.defaultPrevented && topmostDialog === dialog) {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey, false);
    return () => {
      document.removeEventListener('keydown', onKey, false);
      const wasTopmost = mountedDialogs[mountedDialogs.length - 1] === dialog;
      const index = mountedDialogs.lastIndexOf(dialog);
      if (index !== -1) mountedDialogs.splice(index, 1);
      if (!wasTopmost) return;

      const nextTopmost = mountedDialogs[mountedDialogs.length - 1];
      const previouslyFocused = previouslyFocusedRef.current;
      if (nextTopmost !== undefined) {
        if (previouslyFocused !== null && nextTopmost.contains(previouslyFocused)) {
          previouslyFocused.focus?.();
        }
        if (!nextTopmost.contains(document.activeElement)) nextTopmost.focus();
      } else {
        previouslyFocused?.focus?.();
      }
    };
  }, []);

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
