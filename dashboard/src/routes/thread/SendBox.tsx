// SendBox — the composer. A textarea + Send button; Enter sends, Shift+Enter
// inserts a newline (mobile-friendly). The actual send is optimistic and lives
// in the parent (useThreadMessages.send); this component owns the draft text and
// translates a send rejection into an inline error:
//   - opt-out (ApiError 403/409 'contact_opted_out') → box disabled + the STOP note
//   - manual-mode / breaker refusals → show the server's returned reason
//   - anything else → a generic "couldn't send" line (the toast carries detail)
import { useState } from 'react';
import { ApiError } from '../../api';
import { Button, Field, Textarea } from '../../ui';
import styles from './SendBox.module.css';

export interface SendBoxProps {
  /** Optimistic send from the parent; rejects with ApiError on refusal. */
  onSend: (body: string) => Promise<void>;
  /** Hard-disable + opt-out note when the contact has opted out (STOP). */
  optedOut: boolean;
  /**
   * Generic hard-disable with a custom note (M1.7 relay: a CLOSED relay group
   * accepts no sends). Independent of optedOut so the message is accurate.
   */
  disabledNote?: string;
}

/** Map a send-refusal ApiError to the human inline message. */
function refusalMessage(err: ApiError): string {
  switch (err.code) {
    case 'contact_opted_out':
      return 'This contact has opted out (STOP). Texting is disabled.';
    case 'manual_mode':
      return 'This conversation is in manual mode — automated sending is paused.';
    case 'breaker_open':
      return 'Sending is temporarily paused (rate limit). Try again shortly.';
    case 'relay_closed':
      return 'This relay group is closed — reopen it to send.';
    case 'network_error':
      return 'Network problem — your message was not sent.';
    default:
      return err.message || "Couldn't send the message.";
  }
}

export function SendBox({ onSend, optedOut, disabledNote }: SendBoxProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Latch opt-out either from the conversation flag or a live 403/409 refusal.
  const [refusedOptOut, setRefusedOptOut] = useState(false);

  const disabled = optedOut || refusedOptOut || disabledNote !== undefined;

  async function doSend(): Promise<void> {
    const body = draft.trim();
    if (body.length === 0 || sending || disabled) return;
    setSending(true);
    setError(undefined);
    try {
      await onSend(body);
      setDraft('');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'contact_opted_out') setRefusedOptOut(true);
        setError(refusalMessage(err));
      } else {
        setError("Couldn't send the message.");
      }
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  }

  if (disabled) {
    return (
      <div className={styles.optedOut} role="status">
        {optedOut || refusedOptOut
          ? 'This contact has opted out (STOP). Texting is disabled.'
          : disabledNote}
      </div>
    );
  }

  return (
    <form
      className={styles.box}
      onSubmit={(e) => {
        e.preventDefault();
        void doSend();
      }}
    >
      <Field label="Message" htmlFor="thread-composer" {...(error !== undefined && { error })}>
        {({ id, describedBy, invalid }) => (
          <Textarea
            id={id}
            {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
            invalid={invalid}
            className={styles.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message…  (Enter to send, Shift+Enter for a new line)"
            rows={2}
            disabled={sending}
            aria-label="Message"
          />
        )}
      </Field>
      <div className={styles.actions}>
        <Button type="submit" loading={sending} disabled={draft.trim().length === 0}>
          Send
        </Button>
      </div>
    </form>
  );
}
