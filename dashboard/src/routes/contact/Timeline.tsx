// Timeline — the contact detail page's left pane: the blended Communications &
// activity stream (§B2/B3). Renders, oldest→newest, date dividers + message
// bubbles (full body, no truncation; inbound white / outbound light-blue),
// collapsed call cards (transcript behind a <details> disclosure, never auto-
// shown), and milestone pins (kind→color; they LINK OUT via refType/refId and
// never inline content — esp. group-text content). A "Comms only" toggle hides
// milestones; a reply box notes the target number and sends to the resolved
// conversation (disabled with a tooltip when none is resolvable). Message bodies
// render as TEXT (React escapes) — never dangerouslySetInnerHTML. Accessibility-
// first (roles/labels) so it's testable.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  TimelineCall,
  TimelineItem,
  TimelineMessage,
  TimelineMilestone,
  TimelineMilestoneType,
} from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { dayKey, formatDayDivider, formatDuration, formatPhone, formatTime } from './format.js';
import { deliveryReason, presentDeliveryStatus } from './deliveryStatus.js';
import styles from './Timeline.module.css';

export type TimelineStatus = 'loading' | 'ready' | 'error';

export interface TimelineProps {
  status: TimelineStatus;
  items: TimelineItem[];
  /** Which path produced items — drives an honest "(assembled)" note when the
   *  server timeline (with milestones) isn't live yet. */
  source: 'server' | 'fallback';
  /** The number the reply box will send to (primary / most-recent). */
  replyToPhone?: string;
  /** A short label for that number, e.g. "most recent" / "primary". */
  replyToLabel?: string;
  /** Whether a single conversation is resolvable to actually send into. When
   *  false the Send button is disabled with an explanatory tooltip. */
  canSend: boolean;
  /** Called with the textarea body when the operator sends. Returns a promise so
   *  the reply box can show an in-flight state and restore the draft on failure. */
  onSend?: (body: string) => Promise<void>;
  /** Retry a failed outbound message — resends its body to its own conversation. */
  onRetry?: (msg: TimelineMessage) => void;
}

/** Milestone kind → pin color variant (the mockup's neutral / amber / purple /
 *  green markers). number_added = amber; group-text add/remove = purple;
 *  the positive outcome-ish ones = green; everything else neutral. */
function milestoneVariant(type: TimelineMilestoneType): string {
  switch (type) {
    case 'number_added':
      return styles.amber ?? '';
    case 'added_to_group_text':
    case 'removed_from_group_text':
      return styles.purple ?? '';
    case 'tour_took_place':
    case 'case_closed':
      return styles.green ?? '';
    default:
      return styles.neutral ?? '';
  }
}

/** The deep-link target for a milestone, by refType. Placeholders for cases /
 *  listings until those detail routes land — that's expected (links out, never
 *  inlines content). Returns null when there's nothing to link to. */
function milestoneHref(ms: TimelineMilestone): string | null {
  if (!ms.refId) return null;
  switch (ms.refType) {
    case 'case':
      return `/cases/${ms.refId}`;
    case 'unit':
      return `/listings/${ms.refId}`;
    case 'conversation':
      return `/conversations/${ms.refId}`;
    case 'broadcast':
      return `/broadcasts/${ms.refId}`;
    default:
      return null;
  }
}

function MilestonePin({ ms }: { ms: TimelineMilestone }): React.JSX.Element {
  const href = milestoneHref(ms);
  const inner = <span className={styles.pillText}>{ms.label}</span>;
  return (
    <div className={`${styles.evt} ${milestoneVariant(ms.type)}`}>
      {href ? (
        <Link to={href} className={styles.pill}>
          {inner}
        </Link>
      ) : (
        <span className={styles.pill}>{inner}</span>
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  onRetry,
}: {
  msg: TimelineMessage;
  onRetry?: (msg: TimelineMessage) => void;
}): React.JSX.Element {
  const outbound = msg.direction === 'outbound';
  const number = outbound ? msg.toPhone : msg.fromPhone;
  const transport = msg.type.toUpperCase();
  const meta = [
    transport,
    number ? `${outbound ? 'to ' : ''}${formatPhone(number)}` : null,
    formatTime(msg.at),
  ]
    .filter(Boolean)
    .join(' · ');
  const attachments = msg.media_attachments ?? [];

  // Delivery state is meaningful only for OUTBOUND; seed/legacy rows (no status)
  // show no chip. Failures expose a reason (when error_code is present) + Retry.
  const delivery = outbound ? presentDeliveryStatus(msg.delivery_status) : null;
  const reason = delivery?.isFailure ? deliveryReason(msg.error_code) : undefined;
  const toneClass = delivery
    ? ({
        neutral: styles.toneNeutral,
        info: styles.toneInfo,
        success: styles.toneSuccess,
        danger: styles.toneDanger,
      }[delivery.tone] ?? '')
    : '';

  return (
    <div className={`${styles.bubble} ${outbound ? styles.out : styles.in}`}>
      {msg.body ? <div className={styles.body}>{msg.body}</div> : null}
      {attachments.length > 0 ? (
        <div className={styles.media}>
          📎 {attachments.length === 1 ? '1 attachment' : `${attachments.length} attachments`}
        </div>
      ) : null}
      <div className={styles.meta}>
        <span className={styles.metaText}>{meta}</span>
        {delivery ? (
          <span
            className={`${styles.status} ${toneClass}`}
            {...(reason !== undefined && { title: reason })}
          >
            {delivery.label}
            {reason !== undefined ? ` · ${reason}` : ''}
          </span>
        ) : null}
      </div>
      {delivery?.isFailure && onRetry ? (
        <button
          type="button"
          className={styles.retry}
          onClick={() => onRetry(msg)}
          aria-label="Retry sending this message"
        >
          ↻ Retry
        </button>
      ) : null}
    </div>
  );
}

function CallCard({ call }: { call: TimelineCall }): React.JSX.Element {
  const outcomeClass =
    call.call_outcome === 'answered'
      ? styles.answered
      : call.call_outcome === 'voicemail'
        ? styles.voicemail
        : styles.missed;
  const summary = [
    'Call',
    formatDuration(call.call_duration),
    call.party_phone ? formatPhone(call.party_phone) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={styles.callcard}>
      <div className={styles.callTop}>
        <span>📞 {summary}</span>
        <span className={`${styles.outcome} ${outcomeClass}`}>
          {call.call_outcome.charAt(0).toUpperCase() + call.call_outcome.slice(1)}
        </span>
        <span className={styles.callTime}>{formatTime(call.at)}</span>
      </div>
      {call.transcript ? (
        <details className={styles.transcript}>
          <summary className={styles.transcriptToggle}>Transcript</summary>
          <p className={styles.transcriptBody}>{call.transcript}</p>
        </details>
      ) : null}
    </div>
  );
}

function StreamItem({
  item,
  onRetry,
}: {
  item: TimelineItem;
  onRetry?: (msg: TimelineMessage) => void;
}): React.JSX.Element {
  switch (item.kind) {
    case 'message':
      return <MessageBubble msg={item} onRetry={onRetry} />;
    case 'call':
      return <CallCard call={item} />;
    case 'milestone':
      return <MilestonePin ms={item} />;
  }
}

export function Timeline(props: TimelineProps): React.JSX.Element {
  const { status, items, source, replyToPhone, replyToLabel, canSend, onSend, onRetry } = props;
  const [commsOnly, setCommsOnly] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Client-side "Comms only" filter (the server can also do this via kinds=, but
  // filtering here keeps the toggle instant + works with the fallback too).
  const visible = useMemo(
    () => (commsOnly ? items.filter((i) => i.kind !== 'milestone') : items),
    [items, commsOnly],
  );

  // Group the visible items into per-day buckets (a divider per day). Items are
  // already chronological from the hook.
  const days = useMemo(() => {
    const out: { key: string; label: string; items: TimelineItem[] }[] = [];
    for (const item of visible) {
      const key = dayKey(item.at);
      const last = out[out.length - 1];
      if (last && last.key === key) {
        last.items.push(item);
      } else {
        out.push({ key, label: formatDayDivider(item.at), items: [item] });
      }
    }
    return out;
  }, [visible]);

  const handleSend = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !canSend || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend?.(text);
      setDraft(''); // clear ONLY after a confirmed send
    } catch {
      // Keep the draft so the operator doesn't lose their message; surface it.
      setSendError("Couldn't send — please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <section className={styles.comms} aria-label="Communications and activity">
      <header className={styles.chrome}>
        <span className={styles.title}>Communications &amp; activity</span>
        <span className={styles.allNumbers}>all numbers</span>
        <div className={styles.seg} role="group" aria-label="Timeline filter">
          <button
            type="button"
            className={`${styles.segBtn} ${commsOnly ? '' : styles.segOn}`}
            aria-pressed={!commsOnly}
            onClick={() => setCommsOnly(false)}
          >
            All
          </button>
          <button
            type="button"
            className={`${styles.segBtn} ${commsOnly ? styles.segOn : ''}`}
            aria-pressed={commsOnly}
            onClick={() => setCommsOnly(true)}
          >
            Comms only
          </button>
        </div>
      </header>

      <div className={styles.stream}>
        {status === 'loading' ? <Spinner center /> : null}

        {status === 'error' ? (
          <p className={styles.error} role="alert">
            We couldn&apos;t load this timeline. Please try again.
          </p>
        ) : null}

        {status === 'ready' && visible.length === 0 ? (
          <p className={styles.empty}>No messages yet.</p>
        ) : null}

        {status === 'ready' && source === 'fallback' && visible.length > 0 ? (
          <p className={styles.fallbackNote}>
            Showing messages only — activity milestones arrive with the backend.
          </p>
        ) : null}

        {status === 'ready'
          ? days.map((day, di) => (
              // `day.key` can be empty when an item lacks `at` — fall back to the
              // index so the key is always unique/defined (no React key warning).
              <div key={day.key || `day-${di}`} className={styles.day}>
                {day.label ? <div className={styles.divider}>{day.label}</div> : null}
                {day.items.map((item, ii) => (
                  <StreamItem key={`${item.kind}:${item.id}:${ii}`} item={item} onRetry={onRetry} />
                ))}
              </div>
            ))
          : null}
      </div>

      <div className={styles.reply}>
        <label className={styles.srOnly} htmlFor="reply-box">
          Reply message
        </label>
        <textarea
          id="reply-box"
          className={styles.replyBox}
          aria-label="Reply message"
          placeholder="Type a reply…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        {sendError ? (
          <p className={styles.error} role="alert">
            {sendError}
          </p>
        ) : null}
        <div className={styles.replyFoot}>
          <span className={styles.replyTarget}>
            Reply sends to <strong>{formatPhone(replyToPhone) || 'this contact'}</strong>
            {replyToLabel ? ` (${replyToLabel})` : ''} · change ▾
          </span>
          <button
            type="button"
            className={styles.sendBtn}
            onClick={() => void handleSend()}
            disabled={!canSend || draft.trim().length === 0 || sending}
            title={canSend ? undefined : 'No single conversation to send into yet'}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </section>
  );
}
