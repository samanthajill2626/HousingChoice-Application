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
  variant?: 'default' | 'media';
  headerActions?: React.ReactNode;
  trapFocus?: boolean;
  initialFocus?: 'dialog' | 'close';
  restoreFocus?: boolean;
  onDialogKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableDescendants(dialog: HTMLDivElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.tabIndex >= 0 && element.getAttribute('aria-disabled') !== 'true',
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  variant = 'default',
  headerActions,
  trapFocus = false,
  initialFocus = 'dialog',
  restoreFocus = true,
  onDialogKeyDown,
}: ModalProps): React.JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef(restoreFocus);
  // Capture before descendant effects can move focus into the dialog. This is
  // the element unmount must restore even when a child claims initial focus.
  const previouslyFocusedRef = useRef(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    restoreFocusRef.current = restoreFocus;
  }, [restoreFocus]);

  useEffect(() => {
    // A child mount effect may already have focused the first form field. Keep
    // that valid descendant focus; the dialog itself is the fallback target.
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previouslyFocused = previouslyFocusedRef.current;
    mountedDialogs.push(dialog);
    if (initialFocus === 'close') closeRef.current?.focus();
    else if (!dialog.contains(document.activeElement)) dialog.focus();
    const onKeyCapture = (e: KeyboardEvent): void => {
      const topmostDialog = mountedDialogs[mountedDialogs.length - 1];
      const targetIsInside = e.target instanceof Node && dialog.contains(e.target);
      if (
        variant === 'media' &&
        e.key === 'Escape' &&
        topmostDialog === dialog &&
        !targetIsInside
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      const topmostDialog = mountedDialogs[mountedDialogs.length - 1];
      if (e.key === 'Escape' && !e.defaultPrevented && topmostDialog === dialog) {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    if (variant === 'media') document.addEventListener('keydown', onKeyCapture, true);
    document.addEventListener('keydown', onKey, false);
    return () => {
      if (variant === 'media') document.removeEventListener('keydown', onKeyCapture, true);
      document.removeEventListener('keydown', onKey, false);
      const wasTopmost = mountedDialogs[mountedDialogs.length - 1] === dialog;
      const index = mountedDialogs.lastIndexOf(dialog);
      if (index !== -1) mountedDialogs.splice(index, 1);
      if (!wasTopmost || !restoreFocusRef.current) return;

      const nextTopmost = mountedDialogs[mountedDialogs.length - 1];
      if (nextTopmost !== undefined) {
        if (previouslyFocused !== null && nextTopmost.contains(previouslyFocused)) {
          previouslyFocused.focus?.();
        }
        if (!nextTopmost.contains(document.activeElement)) nextTopmost.focus();
      } else {
        previouslyFocused?.focus?.();
      }
    };
  }, [initialFocus, variant]);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    onDialogKeyDown?.(event);
    const dialog = dialogRef.current;
    if (dialog === null || mountedDialogs[mountedDialogs.length - 1] !== dialog) return;

    if (variant === 'media' && event.key === 'Escape') {
      event.stopPropagation();
      if (!event.defaultPrevented) {
        event.preventDefault();
        onCloseRef.current();
      }
      return;
    }

    if (!trapFocus || event.defaultPrevented || event.key !== 'Tab') return;
    const focusable = focusableDescendants(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div
      className={
        variant === 'media' ? `${styles.backdrop} ${styles.mediaBackdrop}` : styles.backdrop
      }
      data-modal-variant={variant}
      // A click on the backdrop (outside the dialog) dismisses; clicks inside don't
      // bubble here because the dialog stops propagation.
      onMouseDown={onClose}
    >
      <div
        className={variant === 'media' ? `${styles.dialog} ${styles.mediaDialog}` : styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={handleDialogKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2
            id={titleId}
            className={variant === 'media' ? `${styles.title} ${styles.mediaTitle}` : styles.title}
          >
            {title}
          </h2>
          {headerActions !== undefined ? (
            <div className={styles.headerActions}>{headerActions}</div>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            className={variant === 'media' ? `${styles.close} ${styles.mediaClose}` : styles.close}
            aria-label="Close"
            onClick={onClose}
          >
            {variant === 'media' ? 'Close' : '\u2715'}
          </button>
        </div>
        <div className={variant === 'media' ? `${styles.body} ${styles.mediaBody}` : styles.body}>
          <div
            className={
              variant === 'media' ? `${styles.bodyInner} ${styles.mediaBodyInner}` : styles.bodyInner
            }
          >
            {children}
          </div>
        </div>
        {footer !== undefined ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}
