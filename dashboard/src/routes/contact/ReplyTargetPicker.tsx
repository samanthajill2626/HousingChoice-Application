// ReplyTargetPicker — the reply box's "Reply sends to <number> · change ▾" line.
// For a single-number contact it's just a label. For a multi-number contact the
// "change ▾" opens a popover to pick which number's thread to send into (each
// number is its own 1:1 conversation). Popover idiom matches the app header menu.
import { useEffect, useRef, useState } from 'react';
import { formatPhone } from './format.js';
import type { ReplyTarget } from './replyTargets.js';
import styles from './ReplyTargetPicker.module.css';

export interface ReplyTargetPickerProps {
  replyToPhone?: string;
  replyToLabel?: string;
  targets: ReplyTarget[];
  selectedConversationId?: string;
  onSelectTarget?: (conversationId: string) => void;
}

export function ReplyTargetPicker({
  replyToPhone,
  replyToLabel,
  targets,
  selectedConversationId,
  onSelectTarget,
}: ReplyTargetPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

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

  const canPick = targets.length > 1 && onSelectTarget !== undefined;

  return (
    <span className={styles.wrap} ref={ref}>
      Reply sends to <strong>{formatPhone(replyToPhone) || 'this contact'}</strong>
      {replyToLabel ? ` (${replyToLabel})` : ''}
      {canPick ? (
        <>
          {' · '}
          <button
            type="button"
            className={styles.changeBtn}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            change ▾
          </button>
          {open ? (
            <div className={styles.menu} role="menu">
              {targets.map((t) => (
                <button
                  key={t.conversationId}
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  onClick={() => {
                    onSelectTarget?.(t.conversationId);
                    setOpen(false);
                  }}
                >
                  <span>
                    {formatPhone(t.phone)}
                    {t.label ? ` (${t.label})` : ''}
                  </span>
                  {t.conversationId === selectedConversationId ? (
                    <span aria-hidden="true">✓</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </span>
  );
}
