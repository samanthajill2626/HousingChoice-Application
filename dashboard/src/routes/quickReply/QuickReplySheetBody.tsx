// QuickReplySheetBody — the working canned-reply sheet body. Renders:
//   • a one-line "replying to <phone>" target hint,
//   • the canned replies as big tap targets (auto-text leads, distinguished),
//   • a "Write a custom reply" path (toggles a small composer),
//   • an "Open full conversation" link to /conversations/:id.
// Tapping a canned reply (or sending a custom one) calls back up to QuickReply,
// which performs the send (POST /api/conversations/:id/messages) from the
// business number and shows the sent confirmation.
import { useState } from 'react';
import { Button, Textarea } from '../../ui/index.js';
import type { Conversation } from '../../api/index.js';
import type { QuickReplyOption } from './actions.js';
import styles from './QuickReply.module.css';

export interface QuickReplySheetBodyProps {
  /** The resolved conversation (for the target hint). May be undefined. */
  conversation: Conversation | undefined;
  /** The conversation id — the open-conversation link + sends target it. */
  conversationId: string;
  /** Canned reply options (auto-text + configured quick replies). */
  options: QuickReplyOption[];
  /** True while a send is in flight (disables all tap targets). */
  sending: boolean;
  /** The id of the option currently being sent (for its loading state). */
  sendingId: string | null;
  /** Send one of the canned options. */
  onSendOption: (option: QuickReplyOption) => void;
  /** Send a free-typed custom reply. */
  onSendCustom: (body: string) => void;
}

export function QuickReplySheetBody(props: QuickReplySheetBodyProps): React.JSX.Element {
  const { conversation, conversationId, options, sending, sendingId, onSendOption, onSendCustom } =
    props;
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');

  const phone = conversation?.participant_phone;
  const customTrimmed = customText.trim();

  function submitCustom(e: React.FormEvent): void {
    e.preventDefault();
    if (customTrimmed.length === 0 || sending) return;
    onSendCustom(customTrimmed);
  }

  return (
    <div>
      <p className={styles.intro}>Send a quick reply from your business number.</p>

      {phone !== undefined && phone !== '' && (
        <p className={styles.target}>
          Replying to <span className={styles.targetPhone}>{phone}</span>
        </p>
      )}

      {options.length > 0 ? (
        <ul className={styles.replyList}>
          {options.map((option) => {
            const isSending = sending && sendingId === option.id;
            return (
              <li key={option.id}>
                <button
                  type="button"
                  className={`${styles.replyButton} ${option.isAuto ? styles.replyButtonAuto : ''}`}
                  onClick={() => onSendOption(option)}
                  disabled={sending}
                  aria-busy={isSending || undefined}
                >
                  {option.isAuto && <span className={styles.replyTag}>Default reply</span>}
                  <span className={styles.replyLabel}>{option.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.intro}>
          No saved quick replies yet — write a custom reply below.
        </p>
      )}

      <div className={styles.secondary}>
        {customOpen ? (
          <form className={styles.customForm} onSubmit={submitCustom}>
            <Textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="Write a reply…"
              rows={3}
              aria-label="Custom reply"
              autoFocus
              disabled={sending}
            />
            <div className={styles.customActions}>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCustomOpen(false)}
                disabled={sending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={sending && sendingId === 'custom'}
                disabled={customTrimmed.length === 0}
              >
                Send
              </Button>
            </div>
          </form>
        ) : (
          <Button
            variant="secondary"
            block
            onClick={() => setCustomOpen(true)}
            disabled={sending}
          >
            Write a custom reply
          </Button>
        )}

        {conversationId !== '' && (
          <Button
            as="a"
            href={`/conversations/${encodeURIComponent(conversationId)}`}
            variant="ghost"
            block
          >
            Open full conversation
          </Button>
        )}
      </div>
    </div>
  );
}
