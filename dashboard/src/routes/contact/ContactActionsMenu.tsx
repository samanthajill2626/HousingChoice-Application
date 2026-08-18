// ContactActionsMenu — the header ⋯ kebab on the contact page. A popover menu
// (outside-click + Escape close, mirroring the app account menu) with: Edit
// contact details, Copy link to this contact, a Do-Not-Contact (sms_opt_out)
// toggle, a "Do not call" (voice_opt_out) toggle — INDEPENDENT of the SMS one —
// and a Delete/Restore action. The toggles reflect + flip current state; the
// parent owns the request + applies the returned contact. Delete asks the parent
// to confirm first (it opens a confirm dialog).
// "Run AI extraction" (manual-extraction-trigger 4.6) follows the same contract:
// the parent POSTs and owns the running indicator; this file only reports the
// press and reflects the busy flag.
import { useEffect, useRef, useState } from 'react';
import styles from './ContactActionsMenu.module.css';

export interface ContactActionsMenuProps {
  onEdit: () => void;
  /** Current sms_opt_out flag (drives the toggle label + state). */
  optedOut: boolean;
  /** Flip the opt-out flag; the parent does the request. */
  onToggleOptOut: () => void;
  /** True while the opt-out request is in flight (disables that item). */
  optOutBusy?: boolean;
  /** Current voice_opt_out (do-not-call) flag — INDEPENDENT of sms_opt_out. */
  voiceOptedOut: boolean;
  /** Flip the voice_opt_out flag; the parent does the request. */
  onToggleVoiceOptOut: () => void;
  /** True while the voice-opt-out request is in flight (disables that item). */
  voiceOptOutBusy?: boolean;
  /** Current soft-delete state (drives Delete vs Restore). */
  deleted: boolean;
  /** Begin deleting — the parent opens a confirm dialog (then DELETEs). */
  onDelete: () => void;
  /** Restore a soft-deleted contact; the parent does the request. */
  onRestore: () => void;
  /** True while a delete/restore request is in flight (disables that item). */
  deleteBusy?: boolean;
  /** Start a manual AI extraction run; the parent does the request and renders
   *  the running indicator (manual-extraction-trigger 4.6). */
  onRunExtraction: () => void;
  /** True from the press until the run reports back (disables that item). */
  extractionBusy?: boolean;
  /** The contact's display name - the accessible-name subject for the unread
   *  toggle, spelled exactly as the inbox row spells it. */
  contactName: string;
  /** Whether this contact's comms currently carry unread (drives which HALF of
   *  the toggle is offered - never both). Derived by the parent. */
  hasUnread: boolean;
  /** Flip it; the parent owns the request, the navigation and the error copy. */
  onToggleUnread: () => void;
  /** True while that request is in flight (disables the item). */
  unreadBusy?: boolean;
}

export function ContactActionsMenu({
  onEdit,
  optedOut,
  onToggleOptOut,
  optOutBusy = false,
  voiceOptedOut,
  onToggleVoiceOptOut,
  voiceOptOutBusy = false,
  deleted,
  onDelete,
  onRestore,
  deleteBusy = false,
  onRunExtraction,
  extractionBusy = false,
  contactName,
  hasUnread,
  onToggleUnread,
  unreadBusy = false,
}: ContactActionsMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const copyLink = (): void => {
    void navigator.clipboard?.writeText(window.location.href).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard blocked — silently ignore (rare; non-critical) */
      },
    );
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
        ⋯
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            Edit contact details
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              copyLink();
              // Keep the menu open briefly so the "Copied" confirmation shows.
            }}
          >
            {copied ? 'Copied ✓' : 'Copy link to contact'}
          </button>
          {/* D6, the unread toggle: ONE item, never both halves, chosen by the
           *  parent's derived state. HIDDEN for a soft-deleted contact - MU-2
           *  makes the server refuse that with 409 contact_deleted, so the
           *  action would only ever fail. The label follows the inbox row
           *  exactly, "as" included: it keeps the two accessible names from
           *  being substrings of each other for assistive tech and selectors.
           *  Same contract as every sibling here - this file reports the press
           *  and reflects a busy flag; the parent owns the request, the
           *  navigation and the error copy. */}
          {deleted ? null : (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={unreadBusy}
              aria-label={
                hasUnread ? `Mark ${contactName} read` : `Mark ${contactName} as unread`
              }
              onClick={() => {
                setOpen(false);
                onToggleUnread();
              }}
            >
              {hasUnread ? 'Mark read' : 'Mark unread'}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            disabled={extractionBusy}
            onClick={() => {
              setOpen(false);
              onRunExtraction();
            }}
          >
            Run AI extraction
          </button>
          <div className={styles.divider} />
          <button
            type="button"
            role="menuitem"
            className={`${styles.item} ${optedOut ? '' : styles.danger}`}
            disabled={optOutBusy}
            onClick={() => {
              setOpen(false);
              onToggleOptOut();
            }}
          >
            {optedOut ? 'Allow SMS (clear opt-out)' : 'Mark Do-Not-Contact'}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.item} ${voiceOptedOut ? '' : styles.danger}`}
            disabled={voiceOptOutBusy}
            onClick={() => {
              setOpen(false);
              onToggleVoiceOptOut();
            }}
          >
            {voiceOptedOut ? 'Allow calls (clear do-not-call)' : 'Mark Do-Not-Call'}
          </button>
          <div className={styles.divider} />
          {deleted ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={deleteBusy}
              onClick={() => {
                setOpen(false);
                onRestore();
              }}
            >
              Restore contact
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${styles.danger}`}
              disabled={deleteBusy}
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
            >
              Delete contact
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
