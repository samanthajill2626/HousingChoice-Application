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
import { ApiError } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { dayKey, formatDayDivider, formatDuration, formatPhone, formatTime } from './format.js';
import { deliveryReason, presentDeliveryStatus } from './deliveryStatus.js';
import { messageMediaSrc, messageSid } from './media.js';
import { useAutoGrowTextarea } from './useAutoGrowTextarea.js';
import { ReplyTargetPicker } from './ReplyTargetPicker.js';
import type { ReplyTarget } from './replyTargets.js';
import styles from './Timeline.module.css';

/** A send refusal → a clear, human reason. The server returns a machine-readable
 *  code (ApiError.code); map the ones a navigator can act on (esp. the
 *  Do-Not-Contact opt-out), else fall back to a generic line. */
function sendFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'contact_opted_out':
        return 'This contact is on the Do-Not-Contact list — texting is disabled. Clear the opt-out from the ⋯ menu to message them.';
      case 'manual_mode':
        return 'This conversation is paused (manual mode) — automated sending is off.';
      case 'breaker_open':
        return 'Sending is temporarily rate-limited. Please try again shortly.';
      case 'sms_sending_disabled':
        return 'SMS sending is currently disabled.';
      case 'relay_closed':
        return 'This relay group is closed — reopen it to send.';
    }
  }
  return "Couldn't send — please try again.";
}

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
  /** The contact's numbers (with their threads) the reply box can target. When
   *  more than one, the reply box shows a "change ▾" picker. */
  replyTargets?: ReplyTarget[];
  /** The conversationId currently selected to send into (for the picker check). */
  selectedConversationId?: string;
  /** Pick which number's thread to send into. */
  onSelectTarget?: (conversationId: string) => void;
  /** Whether a single conversation is resolvable to actually send into. When
   *  false the Send button is disabled with an explanatory tooltip. */
  canSend: boolean;
  /** Called with the textarea body when the operator sends. Returns a promise so
   *  the reply box can show an in-flight state and restore the draft on failure. */
  onSend?: (body: string) => Promise<void>;
  /** Retry a failed outbound message — resends its body to its own conversation. */
  onRetry?: (msg: TimelineMessage) => void;
  /** Contact is on the Do-Not-Contact list (sms_opt_out) — show a standing note
   *  at the composer so it's clear BEFORE sending (the send is refused too). */
  optedOut?: boolean;
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
    case 'placement_closed':
      return styles.green ?? '';
    default:
      return styles.neutral ?? '';
  }
}

/** The deep-link target for a milestone, by refType. Placeholders for placements /
 *  properties until those detail routes land — that's expected (links out, never
 *  inlines content). Returns null when there's nothing to link to. */
function milestoneHref(ms: TimelineMilestone): string | null {
  if (!ms.refId) return null;
  switch (ms.refType) {
    case 'placement':
      return `/placements/${ms.refId}`;
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
  const [revealed, setRevealed] = useState(false);
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
  // Mirrored MMS attachments are served by the AUTHED same-origin endpoint
  // (the session cookie rides along) — never the provider URL or a data: URI.
  // Without a derivable provider SID there's no servable URL → fall back to a
  // count chip. (Same helpers feed the file pane's "Media from comms" gallery.)
  const sid = messageSid(msg);

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

  // The transport · number · time line is hidden by default; a click/tap on the
  // bubble reveals it (the grouped time labels give the at-a-glance time). Don't
  // toggle while the user is selecting text in the bubble.
  const toggleMeta = (): void => {
    if ((window.getSelection()?.toString() ?? '').length > 0) return;
    setRevealed((r) => !r);
  };

  return (
    <div
      className={`${styles.bubble} ${outbound ? styles.out : styles.in} ${revealed ? styles.revealed ?? '' : ''}`}
      onClick={toggleMeta}
    >
      {msg.body ? <div className={styles.body}>{msg.body}</div> : null}
      {attachments.length > 0 ? (
        sid ? (
          // Render by type: images inline, PDFs as a viewer link, else download.
          // stopPropagation so opening media doesn't also toggle the bubble meta.
          <div className={styles.mediaGallery} onClick={(e) => e.stopPropagation()}>
            {attachments.map((att, i) => {
              const src = messageMediaSrc(sid, i);
              if (att.contentType.startsWith('image/')) {
                return (
                  <a
                    key={i}
                    className={styles.mediaLink}
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <img
                      className={styles.mediaImg}
                      src={src}
                      alt={`Attachment ${i + 1}`}
                      loading="lazy"
                    />
                  </a>
                );
              }
              const isPdf = att.contentType === 'application/pdf';
              return (
                <a
                  key={i}
                  className={styles.mediaFile}
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {isPdf ? `📄 PDF attachment ${i + 1}` : `📎 Attachment ${i + 1}`}
                </a>
              );
            })}
          </div>
        ) : (
          <div className={styles.media}>
            📎 {attachments.length === 1 ? '1 attachment' : `${attachments.length} attachments`}
          </div>
        )
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
          onClick={(e) => {
            e.stopPropagation();
            onRetry(msg);
          }}
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
  const {
    status,
    items,
    source,
    replyToPhone,
    replyToLabel,
    replyTargets,
    selectedConversationId,
    onSelectTarget,
    canSend,
    onSend,
    onRetry,
    optedOut,
  } = props;
  const [commsOnly, setCommsOnly] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The reply box starts one line and grows to fit the draft (up to its CSS
  // max-height); a manual drag-resize overrides that until the draft clears.
  const replyRef = useAutoGrowTextarea(draft);

  // Client-side "Comms only" filter (the server can also do this via kinds=, but
  // filtering here keeps the toggle instant + works with the fallback too), plus
  // RETRY COLLAPSE: a failed message that's been superseded by a retry (some later
  // message carries retry_of === its tsMsgId) is hidden, so a delivered retry
  // replaces the stale failed bubble instead of stacking beneath it. Only the tail
  // of a retry chain survives — whether it delivered (no Retry) or failed (Retry).
  const visible = useMemo(() => {
    const supersededIds = new Set<string>();
    for (const i of items) {
      if (i.kind === 'message' && i.retry_of !== undefined && i.retry_of.length > 0) {
        supersededIds.add(i.retry_of);
      }
    }
    return items.filter((i) => {
      if (commsOnly && i.kind === 'milestone') return false;
      if (i.kind === 'message' && supersededIds.has(i.tsMsgId)) return false;
      return true;
    });
  }, [items, commsOnly]);

  // Group items into clusters (iMessage-style): a new cluster starts on a new day
  // OR a gap > 1h from the previous item. Each cluster gets a centered time label —
  // new day → "Mon Jun 1 · 10:00a"; same-day gap → "1:30p". Items are already
  // chronological from the hook.
  const clusters = useMemo(() => {
    const GAP_MS = 60 * 60 * 1000; // 1 hour
    const out: { label: string; items: TimelineItem[] }[] = [];
    let prevAt: number | null = null;
    let prevDay: string | null = null;
    for (const item of visible) {
      const parsed = Date.parse(item.at);
      const at = Number.isNaN(parsed) ? null : parsed;
      const day = dayKey(item.at);
      const newDay = day !== prevDay;
      const bigGap = prevAt !== null && at !== null && at - prevAt > GAP_MS;
      if (out.length === 0 || newDay || bigGap) {
        const time = formatTime(item.at);
        const label =
          out.length === 0 || newDay ? `${formatDayDivider(item.at)} · ${time}` : time;
        out.push({ label, items: [item] });
      } else {
        out[out.length - 1]!.items.push(item);
      }
      if (at !== null) prevAt = at;
      prevDay = day;
    }
    return out;
  }, [visible]);

  const handleSend = async (): Promise<void> => {
    const original = draft;
    const text = draft.trim();
    if (!text || !canSend || sending) return;
    setSending(true);
    setSendError(null);
    // Optimistic: onSend shows the bubble ("Sending…") immediately, so clear the
    // draft NOW rather than waiting on the POST — the operator sees their message
    // land instantly instead of an ambiguous "did it go?" gap.
    setDraft('');
    try {
      await onSend?.(text);
    } catch (err) {
      // POST failed (Do-Not-Contact opt-out, paused thread, …): the optimistic
      // bubble was removed upstream — surface the reason and restore the draft so
      // the operator doesn't lose their message.
      setSendError(sendFailureMessage(err));
      setDraft(original);
    } finally {
      setSending(false);
    }
  };

  // Enter-to-send is a DESKTOP affordance. On touch devices (coarse pointer) the
  // return key makes a newline and the on-screen Send button sends — the standard
  // mobile-messaging pattern. Shift+Enter is always a newline; the isComposing
  // guard avoids firing mid-IME-composition (covers the Android keyCode-229 path).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const touch = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    if (!touch && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
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
          ? clusters.map((cluster, ci) => (
              <div key={`cluster-${ci}`} className={styles.day}>
                {cluster.label ? <div className={styles.divider}>{cluster.label}</div> : null}
                {cluster.items.map((item, ii) => (
                  <StreamItem key={`${item.kind}:${item.id}:${ii}`} item={item} onRetry={onRetry} />
                ))}
              </div>
            ))
          : null}
      </div>

      <div className={styles.reply}>
        {optedOut ? (
          <p className={styles.optOutNote} role="note">
            ⛔ On the Do-Not-Contact list — texting is disabled for this contact.
          </p>
        ) : null}
        <label className={styles.srOnly} htmlFor="reply-box">
          Reply message
        </label>
        <textarea
          ref={replyRef}
          id="reply-box"
          className={styles.replyBox}
          aria-label="Reply message"
          placeholder="Type a reply…"
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {sendError ? (
          <p className={styles.error} role="alert">
            {sendError}
          </p>
        ) : null}
        <div className={styles.replyFoot}>
          <span className={styles.replyTarget}>
            <ReplyTargetPicker
              {...(replyToPhone !== undefined && { replyToPhone })}
              {...(replyToLabel !== undefined && { replyToLabel })}
              targets={replyTargets ?? []}
              {...(selectedConversationId !== undefined && { selectedConversationId })}
              {...(onSelectTarget !== undefined && { onSelectTarget })}
            />
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
