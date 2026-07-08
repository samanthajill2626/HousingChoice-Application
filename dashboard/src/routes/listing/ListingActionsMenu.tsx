// ListingActionsMenu — the header ⋯ kebab on the property detail page. A popover
// menu (outside-click + Escape close) mirroring ContactActionsMenu: Copy link to
// this property + a Delete/Restore action. Delete asks the parent to confirm first
// (it opens a confirm dialog); the parent owns the request + applies the result.
import { useEffect, useRef, useState } from 'react';
import styles from './ListingActionsMenu.module.css';

export interface ListingActionsMenuProps {
  /** Class for the kebab trigger (the header supplies its dark-band style). */
  triggerClassName: string;
  /** Open the edit dialog. Omitted (e.g. on a deleted property) → no Edit item. */
  onEdit?: () => void;
  /** Start a placement on this property (opens the create dialog). Omitted on a
   *  deleted property → no item. */
  onStartPlacement?: () => void;
  /** Broadcast this property to tenants. Omitted on a deleted property → no item. */
  onBroadcast?: () => void;
  /** Current soft-delete state (drives Delete vs Restore). */
  deleted: boolean;
  /** Begin deleting — the parent opens a confirm dialog (then DELETEs). */
  onDelete: () => void;
  /** Restore a soft-deleted property; the parent does the request. */
  onRestore: () => void;
  /** True while a delete/restore request is in flight (disables that item). */
  deleteBusy?: boolean;
}

export function ListingActionsMenu({
  triggerClassName,
  onEdit,
  onStartPlacement,
  onBroadcast,
  deleted,
  onDelete,
  onRestore,
  deleteBusy = false,
}: ListingActionsMenuProps): React.JSX.Element {
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
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          {onStartPlacement ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                setOpen(false);
                onStartPlacement();
              }}
            >
              Start placement
            </button>
          ) : null}
          {onBroadcast ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                setOpen(false);
                onBroadcast();
              }}
            >
              Broadcast to tenants
            </button>
          ) : null}
          {onEdit ? (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
            >
              Edit property
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={copyLink}
          >
            {copied ? 'Copied ✓' : 'Copy link to property'}
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
              Restore property
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
              Delete property
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
