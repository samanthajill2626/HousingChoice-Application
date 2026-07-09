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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ConversationParticipant,
  TimelineCall,
  TimelineItem,
  TimelineMessage,
  TimelineMilestone,
  TimelineMilestoneType,
  TimelineScheduled,
} from '../../api/index.js';
import { ApiError, uploadMedia } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { ScheduledCard } from './ScheduledCard.js';
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
      case 'contact_no_consent':
        // A2P/CTIA just-in-time gate: the parent (ContactDetail) intercepts this
        // 409 and opens the consent-capture modal. We restore the draft (throwing
        // reaches here) but show NO inline error — the modal is the UI.
        return '';
      case 'contact_opted_out':
        return 'This contact is on the Do-Not-Contact list — texting is disabled. Clear the opt-out from the ⋯ menu to message them.';
      case 'manual_mode':
        return 'This conversation is paused (manual mode) — automated sending is off.';
      case 'breaker_open':
        return 'Sending is temporarily rate-limited. Please try again shortly.';
      case 'rate_limited':
        return 'Sending too fast — wait a moment and try again.';
      case 'sms_sending_disabled':
        return 'SMS sending is currently disabled.';
      case 'relay_closed':
        return 'This relay group is closed — reopen it to send.';
    }
  }
  return "Couldn't send — please try again.";
}

// Outbound MMS composer limits - MIRROR the server caps (spec Sec 9) so a file
// that would be rejected server-side never uploads. The server re-validates.
const MMS_MAX_MEDIA = 10;
const MMS_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MMS_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MMS_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
];
// The accept string offered to the file picker. Listing the image types keeps a
// mobile browser's camera option available while still allowing a PDF.
const MMS_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,application/pdf';

/** One composer-local attachment. Chip state is component-local (see the keyed-
 *  remount note on TimelineProps.resetScrollKey) so it can never leak across
 *  conversations/channels. `key` is the server-minted uploads/<uuid> once the
 *  upload succeeds; only 'done' chips contribute to a send. */
interface ComposerAttachment {
  /** Stable local id: React key + the handle upload results reconcile against. */
  localId: string;
  name: string;
  size: number;
  contentType: string;
  status: 'uploading' | 'done' | 'error';
  /** The uploads/<uuid> key, present once the upload succeeds. */
  key?: string;
  /** Inline error when the upload fails (retry by re-picking the file). */
  error?: string;
  /** Object URL for an image thumbnail; revoked on remove / send / unmount. */
  previewUrl?: string;
}

/** A short, human size label for a chip. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Client-side pre-check for a picked file against the current chip set. Returns
 *  a clear reason string when the file must be rejected, else null. Mirrors the
 *  server allowlist + caps so a rejected file is never uploaded. */
function attachmentReject(file: File, existing: ComposerAttachment[]): string | null {
  if (!MMS_ALLOWED_TYPES.includes(file.type)) {
    return `${file.name}: unsupported file type. Attach a JPEG, PNG, GIF, WEBP, or PDF.`;
  }
  if (file.size > MMS_MAX_FILE_BYTES) {
    return `${file.name} is too large (max 5 MB per file).`;
  }
  if (existing.length >= MMS_MAX_MEDIA) {
    return `You can attach at most ${MMS_MAX_MEDIA} files.`;
  }
  const total = existing.reduce((n, a) => n + a.size, 0) + file.size;
  if (total > MMS_MAX_TOTAL_BYTES) {
    return 'Attachments exceed the 5 MB total limit. Remove one and try again.';
  }
  return null;
}

/** An upload failure -> a short, human chip message. */
function uploadFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 413) return 'Too large (max 5 MB).';
    if (err.status === 415) return 'Unsupported file type.';
    if (err.code === 'rate_limited') return 'Uploading too fast - wait a moment.';
  }
  return 'Upload failed - remove and try again.';
}

export type TimelineStatus = 'loading' | 'ready' | 'error';

export interface TimelineProps {
  status: TimelineStatus;
  items: TimelineItem[];
  /** Not-yet-sent scheduled messages — rendered in a pinned "Upcoming" section
   *  between the stream and the composer (shown only when non-empty). Never part
   *  of `items`. */
  upcoming?: TimelineScheduled[];
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
  /** Called with the textarea body (and any successfully-uploaded attachment
   *  keys) when the operator sends. Returns a promise so the reply box can show an
   *  in-flight state and restore the draft + chips on failure. `attachmentKeys` is
   *  passed only when at least one attachment uploaded (a text-only send calls
   *  onSend(body) exactly as before). */
  onSend?: (body: string, attachmentKeys?: string[]) => Promise<void>;
  /** Retry a failed outbound message — resends its body to its own conversation.
   *  May return the send promise: a rejection (e.g. 429 rate_limited — the retry
   *  shares the manual-send budget) is surfaced in the composer's error slot. */
  onRetry?: (msg: TimelineMessage) => void | Promise<void>;
  /** Contact is on the Do-Not-Contact list (sms_opt_out) — show a standing note
   *  at the composer so it's clear BEFORE sending (the send is refused too). */
  optedOut?: boolean;
  /** Bumped by the parent when a DEFERRED send finally goes out (the just-in-time
   *  consent modal records consent, then retries the send out-of-band of the
   *  composer). The composer restored its draft on the 409 refusal, so it must
   *  re-clear it on that success — a plain send clears optimistically; this one
   *  can't, because its success happens outside handleSend. */
  clearDraftSignal?: number;
  /** Relay group (M1.7): the current roster. When present, relayed message
   *  bubbles resolve their `relay_sender_key` → a member name (or "Team") and an
   *  outbound relay bubble shows a per-member "delivered N/M" summary. Absent on a
   *  1:1 contact timeline → those bubbles are visually unchanged. */
  relayRoster?: ConversationParticipant[];
  /** Relay group is closed — show a standing note at the composer (sending is
   *  ALSO hard-disabled via canSend=false). Analogous to the opt-out note. */
  relayClosed?: boolean;
  /** A stable id for the conversation/contact this timeline shows (contactId or
   *  conversationId). When it changes the stream is treated as a FRESH timeline —
   *  jump to the newest item, no "new messages" pill — so switching conversations
   *  never yanks or spuriously flags. */
  resetScrollKey?: string;
  /** Override the ready-but-empty stream copy (default "No messages yet."). Used
   *  by the tour page's create-on-demand 1:1 tab ("No messages with <name> yet").
   *  Optional + defaulted - contact/relay timelines are unchanged. */
  emptyLabel?: string;
}

/** The relay member key convention (MIRRORS app relayMemberKey): the member's
 *  contactId when set, else `phone#<E164>`. */
function relayMemberKey(member: ConversationParticipant): string {
  return member.contactId && member.contactId.length > 0
    ? member.contactId
    : `phone#${member.phone}`;
}

/** Resolve a relayed message's sender label: the `'team'` sentinel → "Team"; a
 *  member key → that member's name (roster lookup); otherwise undefined (no
 *  attribution line). Only meaningful for a relay bubble (relay_sender_key set). */
function relaySenderLabel(
  senderKey: string | undefined,
  roster: ConversationParticipant[] | undefined,
): string | undefined {
  if (senderKey === undefined || senderKey.length === 0) return undefined;
  if (senderKey === 'team') return 'Team';
  for (const m of roster ?? []) {
    if (relayMemberKey(m) === senderKey) {
      const name = m.name?.trim();
      return name && name.length > 0 ? name : undefined;
    }
  }
  return undefined;
}

/** The GROUP composer footer: a reply relays to EVERY member, so the line names
 *  the whole roster ("everyone in this group text (Ann, Marcus)") instead of a
 *  single number. A member with no resolved name falls back to their formatted
 *  phone; an empty/unloaded roster (best-effort fetch) keeps the honest
 *  "everyone" line with no list. */
function GroupReplyNote({ roster }: { roster: ConversationParticipant[] }): React.JSX.Element {
  const names = roster.map((m) => {
    const n = m.name?.trim();
    return n && n.length > 0 ? n : formatPhone(m.phone) || m.phone;
  });
  return (
    <>
      Reply sends to <strong>everyone in this group text</strong>
      {names.length > 0 ? <> ({names.join(', ')})</> : null}
    </>
  );
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
    case 'tour_scheduled':
    case 'tour_took_place':
    case 'tour_outcome':
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
    case 'tour':
      return `/tours/${ms.refId}`;
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
  relayRoster,
}: {
  msg: TimelineMessage;
  onRetry?: (msg: TimelineMessage) => void;
  /** Present in the relay-group view → enables sender attribution + delivered N/M. */
  relayRoster?: ConversationParticipant[];
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
    .join(' - ');
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

  // Relay group (M1.7): count recipients this message was NOT relayed to because
  // they opted out (a `contact_opted_out` failed slot). Surfaced as a subtle note
  // so staff know the group text didn't reach everyone. Absent on 1:1 messages.
  const optedOutCount = Object.values(msg.delivery_recipients ?? {}).filter(
    (r) => r.status === 'failed' && r.errorCode === 'contact_opted_out',
  ).length;
  // Relay group (M1.7): a message carrying a delivery_recipients map is a relayed
  // SOURCE message. For an OUTBOUND relay bubble, summarize per-member delivery as
  // "delivered N/M" (N terminal-delivered of M fanned-out) from the SAME map the
  // opted-out note reads. GUARDED to relay + outbound so a 1:1 bubble (no
  // delivery_recipients) is visually unchanged.
  const relaySlots = msg.delivery_recipients ? Object.values(msg.delivery_recipients) : null;
  const deliveredSummary =
    outbound && relaySlots !== null && relaySlots.length > 0
      ? {
          delivered: relaySlots.filter((r) => r.status === 'delivered').length,
          total: relaySlots.length,
        }
      : null;
  // Relay attribution: who authored this relayed message ("Team" or a member's
  // name). Undefined on a 1:1 bubble (no relay_sender_key) → no attribution line.
  const senderLabel = relaySenderLabel(msg.relay_sender_key, relayRoster);
  const toneClass = delivery
    ? ({
        neutral: styles.toneNeutral,
        info: styles.toneInfo,
        success: styles.toneSuccess,
        danger: styles.toneDanger,
      }[delivery.tone] ?? '')
    : '';

  // The transport - number - time line is hidden by default; a click/tap on the
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
      {senderLabel !== undefined ? (
        <div className={styles.relaySender ?? ''}>{senderLabel}</div>
      ) : null}
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
        {delivery && deliveredSummary === null ? (
          // Suppressed on a relay SOURCE bubble: its own delivery_status stays
          // 'queued' forever (DLRs land in delivery_recipients slots, never on
          // the parent), so "delivered N/M" below is the truthful state.
          <span
            className={`${styles.status} ${toneClass}`}
            {...(reason !== undefined && { title: reason })}
          >
            {delivery.label}
            {reason !== undefined ? ` - ${reason}` : ''}
          </span>
        ) : null}
        {deliveredSummary !== null ? (
          <span className={`${styles.status} ${styles.toneNeutral ?? ''}`}>
            delivered {deliveredSummary.delivered}/{deliveredSummary.total}
          </span>
        ) : null}
      </div>
      {optedOutCount > 0 ? (
        <p className={styles.relayOptOutNote}>
          {optedOutCount === 1
            ? '1 member opted out — not relayed to them.'
            : `${optedOutCount} members opted out — not relayed to them.`}
        </p>
      ) : null}
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
    .join(' - ');

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
  relayRoster,
}: {
  item: TimelineItem;
  onRetry?: (msg: TimelineMessage) => void;
  relayRoster?: ConversationParticipant[];
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'message':
      return <MessageBubble msg={item} onRetry={onRetry} {...(relayRoster !== undefined && { relayRoster })} />;
    case 'call':
      return <CallCard call={item} />;
    case 'milestone':
      return <MilestonePin ms={item} />;
    case 'scheduled':
      // The main stream never carries scheduled rows (they live in the pinned
      // `upcoming` section). This case only satisfies TS union exhaustiveness.
      return null;
  }
}

export function Timeline(props: TimelineProps): React.JSX.Element {
  const {
    status,
    items,
    upcoming,
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
    clearDraftSignal,
    relayRoster,
    relayClosed,
    resetScrollKey,
    emptyLabel,
  } = props;
  const [commsOnly, setCommsOnly] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Outbound MMS attachments. Component-local state (like `draft`) so the tour
  // page's keyed remount (channels keyed by conversationId) gives each channel a
  // FRESH chip set - attachments can never leak across tabs. Do NOT hoist above
  // the keyed boundary. (spec Sec 6.)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachSeqRef = useRef(0);
  // Mirror attachments in a ref so the unmount cleanup revokes the CURRENT set of
  // image object URLs (a bare [] effect closes over the initial empty array).
  const attachmentsRef = useRef<ComposerAttachment[]>(attachments);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) {
        if (a.previewUrl !== undefined) URL.revokeObjectURL(a.previewUrl);
      }
    },
    [],
  );

  // A deferred send (post-consent retry) landed: clear the draft + chips the 409
  // refusal restored, matching a normal successful send. Guarded so the initial 0
  // is inert.
  useEffect(() => {
    if (clearDraftSignal) {
      setDraft('');
      setSendError(null);
      for (const a of attachmentsRef.current) {
        if (a.previewUrl !== undefined) URL.revokeObjectURL(a.previewUrl);
      }
      setAttachments([]);
      setAttachError(null);
    }
  }, [clearDraftSignal]);

  // Upload ONE picked file, reconciling its chip by localId as it completes.
  const uploadOne = async (localId: string, file: File): Promise<void> => {
    try {
      const result = await uploadMedia(file);
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? {
                ...a,
                status: 'done',
                key: result.key,
                contentType: result.contentType,
                size: result.size,
              }
            : a,
        ),
      );
    } catch (err) {
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId ? { ...a, status: 'error', error: uploadFailureMessage(err) } : a,
        ),
      );
    }
  };

  // File pick: validate each file against the running set, add a chip, and start
  // its upload immediately. A rejected file surfaces a reason and is NOT uploaded.
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    // Reset the input so re-picking the SAME file (a retry after remove) re-fires.
    e.target.value = '';
    if (files.length === 0) return;
    const combined = [...attachments];
    const accepted: { entry: ComposerAttachment; file: File }[] = [];
    let reject: string | null = null;
    for (const file of files) {
      const why = attachmentReject(file, combined);
      if (why !== null) {
        reject = why;
        continue;
      }
      const localId = `att:${(attachSeqRef.current += 1)}`;
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const entry: ComposerAttachment = {
        localId,
        name: file.name,
        size: file.size,
        contentType: file.type,
        status: 'uploading',
        ...(previewUrl !== undefined && { previewUrl }),
      };
      combined.push(entry);
      accepted.push({ entry, file });
    }
    setAttachError(reject);
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted.map((a) => a.entry)]);
      for (const a of accepted) void uploadOne(a.entry.localId, a.file);
    }
  };

  const removeAttachment = (localId: string): void => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.localId === localId);
      if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.localId !== localId);
    });
    setAttachError(null);
  };

  // Keys ready to send (uploads that finished); an in-flight upload blocks Send so
  // a still-uploading attachment is never silently dropped from the message.
  const uploadedKeys = attachments
    .filter((a) => a.status === 'done' && a.key !== undefined)
    .map((a) => a.key as string);
  const hasUploading = attachments.some((a) => a.status === 'uploading');
  // An errored chip is neither 'done' (so it's excluded from uploadedKeys) nor
  // 'uploading' (so hasUploading doesn't block) - without this guard a send with
  // a good chip + a failed chip would go out SILENTLY dropping the failed file.
  // Block Send while any chip is errored and prompt the operator to remove it.
  const hasErrored = attachments.some((a) => a.status === 'error');
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
  // new day → "Mon Jun 1 - 10:00a"; same-day gap → "1:30p". Items are already
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
          out.length === 0 || newDay ? `${formatDayDivider(item.at)} - ${time}` : time;
        out.push({ label, items: [item] });
      } else {
        out[out.length - 1]!.items.push(item);
      }
      if (at !== null) prevAt = at;
      prevDay = day;
    }
    return out;
  }, [visible]);

  // --- Stick-to-bottom + "new messages" pill -------------------------------
  // The stream scrolls with the NEWEST item at the bottom. Keep the operator
  // pinned there so incoming messages/activity stay visible while they're at (or
  // near) the bottom; if they've scrolled UP to read history, a new item must NOT
  // yank them — instead a "↓ New messages" pill appears so they know something
  // landed and can jump down on demand (the cell-phone convention).
  const streamRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true); // default true → open on the newest item
  const prevCountRef = useRef(0); // item count at the last layout pass
  const prevKeyRef = useRef(resetScrollKey); // conversation identity last seen
  const [hasNewBelow, setHasNewBelow] = useState(false);

  const isAtBottom = (el: HTMLElement): boolean =>
    // Within ~48px of the bottom counts as "at bottom" (slack for sub-pixel
    // rounding and a partially-visible last row).
    el.scrollHeight - el.scrollTop - el.clientHeight <= 48;

  const scrollToBottom = (): void => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setHasNewBelow(false);
  };

  const handleStreamScroll = (): void => {
    const el = streamRef.current;
    if (!el) return;
    atBottomRef.current = isAtBottom(el);
    // Reaching the bottom clears the pill (the operator has caught up).
    if (atBottomRef.current && hasNewBelow) setHasNewBelow(false);
  };

  // After the rendered stream changes, decide what to do with the scroll: pin to
  // the bottom if the operator was there, flag "new below" if a new item landed
  // while they were scrolled up, or — when the conversation itself changed — treat
  // it as a fresh timeline and jump to the newest. useLayoutEffect runs before
  // paint, so any jump is invisible (no flash of the pre-scroll position).
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const count = clusters.reduce((n, c) => n + c.items.length, 0);
    if (prevKeyRef.current !== resetScrollKey) {
      // Switched conversations → open on the newest item, no carried-over pill.
      prevKeyRef.current = resetScrollKey;
      prevCountRef.current = count;
      atBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      setHasNewBelow(false);
      return;
    }
    const grew = count > prevCountRef.current;
    prevCountRef.current = count;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setHasNewBelow(false);
    } else if (grew) {
      setHasNewBelow(true);
    }
  }, [clusters, resetScrollKey]);

  // A retry IS a send — surface its failure (429 rate_limited, opt-out, …) in
  // the SAME composer error slot handleSend uses, instead of swallowing the
  // rejection (the bug: retry shares the manual-send budget, so hammering Retry
  // rate-limits with zero feedback). The wrapper keeps the bubble-level
  // onRetry contract void — rejections land in sendError.
  const onRetrySurfaced = onRetry
    ? (msg: TimelineMessage): void => {
        setSendError(null);
        void Promise.resolve(onRetry(msg)).catch((err: unknown) => {
          setSendError(sendFailureMessage(err));
        });
      }
    : undefined;

  const handleSend = async (): Promise<void> => {
    const original = draft;
    const text = draft.trim();
    const keys = uploadedKeys;
    // A send needs body OR at least one uploaded attachment; block while an upload
    // is still in flight (so its key isn't lost).
    if ((!text && keys.length === 0) || !canSend || sending || hasUploading || hasErrored) return;
    setSending(true);
    setSendError(null);
    // Optimistic: onSend shows the bubble ("Sending…") immediately, so clear the
    // draft + chips NOW rather than waiting on the POST - the operator sees their
    // message land instantly instead of an ambiguous "did it go?" gap.
    const sentAttachments = attachments;
    setDraft('');
    setAttachments([]);
    setAttachError(null);
    // The operator just sent — pin to the bottom so their own message is in view
    // even if they'd scrolled up while composing.
    atBottomRef.current = true;
    try {
      // Pass attachmentKeys only when present, so a text-only send stays a plain
      // onSend(body) call (unchanged contract for the no-attachment path).
      if (keys.length > 0) await onSend?.(text, keys);
      else await onSend?.(text);
      // Success: release the sent chips' image object URLs.
      for (const a of sentAttachments) {
        if (a.previewUrl !== undefined) URL.revokeObjectURL(a.previewUrl);
      }
    } catch (err) {
      // POST failed (Do-Not-Contact opt-out, paused thread, …): the optimistic
      // bubble was removed upstream - surface the reason and restore the draft +
      // chips so the operator doesn't lose their message OR their attachments.
      setSendError(sendFailureMessage(err));
      setDraft(original);
      setAttachments(sentAttachments);
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

      <div className={styles.streamWrap}>
      <div className={styles.stream} ref={streamRef} onScroll={handleStreamScroll}>
        {status === 'loading' ? <Spinner center /> : null}

        {status === 'error' ? (
          <p className={styles.error} role="alert">
            We couldn&apos;t load this timeline. Please try again.
          </p>
        ) : null}

        {status === 'ready' && visible.length === 0 ? (
          <p className={styles.empty}>{emptyLabel ?? 'No messages yet.'}</p>
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
                  <StreamItem
                    key={`${item.kind}:${item.id}:${ii}`}
                    item={item}
                    onRetry={onRetrySurfaced}
                    {...(relayRoster !== undefined && { relayRoster })}
                  />
                ))}
              </div>
            ))
          : null}
      </div>
        {hasNewBelow ? (
          <button
            type="button"
            className={styles.newPill}
            onClick={scrollToBottom}
            aria-label="Jump to the newest messages"
          >
            <span aria-hidden="true">↓</span> New messages
          </button>
        ) : null}
      </div>

      {upcoming && upcoming.length > 0 ? (
        <section className={styles.upcoming} aria-label="Upcoming scheduled messages">
          <header className={styles.upcomingHead}>Upcoming ({upcoming.length})</header>
          <div className={styles.upcomingList}>
            {upcoming.map((sched) => (
              <ScheduledCard key={sched.id} item={sched} />
            ))}
          </div>
        </section>
      ) : null}

      <div className={styles.reply}>
        {optedOut ? (
          <p className={styles.optOutNote} role="note">
            ⛔ On the Do-Not-Contact list — texting is disabled for this contact.
          </p>
        ) : null}
        {relayClosed ? (
          <p className={styles.optOutNote} role="note">
            🔒 This group is closed — reopen it to send.
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
        {attachments.length > 0 ? (
          <ul className={styles.chips} aria-label="Attachments">
            {attachments.map((a) => (
              <li
                key={a.localId}
                className={`${styles.chip} ${a.status === 'error' ? styles.chipError ?? '' : ''}`}
                aria-busy={a.status === 'uploading'}
              >
                {a.previewUrl !== undefined ? (
                  <img className={styles.chipThumb} src={a.previewUrl} alt="" />
                ) : (
                  <span className={styles.chipIcon} aria-hidden="true">
                    {a.contentType === 'application/pdf' ? 'PDF' : 'FILE'}
                  </span>
                )}
                <span className={styles.chipName}>{a.name}</span>
                <span className={styles.chipMeta}>
                  {a.status === 'uploading'
                    ? 'Uploading...'
                    : a.status === 'error'
                      ? a.error ?? 'Upload failed'
                      : formatBytes(a.size)}
                </span>
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={() => removeAttachment(a.localId)}
                  aria-label={`Remove ${a.name}`}
                >
                  <span aria-hidden="true">x</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {hasErrored ? (
          <p className={styles.error} role="alert">
            An attachment failed to upload. Remove it to send.
          </p>
        ) : null}
        {attachError ? (
          <p className={styles.error} role="alert">
            {attachError}
          </p>
        ) : null}
        {sendError ? (
          <p className={styles.error} role="alert">
            {sendError}
          </p>
        ) : null}
        <div className={styles.replyFoot}>
          <label className={styles.srOnly} htmlFor="mms-attach-input">
            Attach files
          </label>
          <input
            ref={fileInputRef}
            id="mms-attach-input"
            className={styles.srOnly}
            type="file"
            multiple
            accept={MMS_ACCEPT}
            aria-label="Attach files"
            onChange={onPickFiles}
          />
          <button
            type="button"
            className={styles.attachBtn}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach a file"
          >
            <span aria-hidden="true">+</span> Attach
          </button>
          <span className={styles.replyTarget}>
            {relayRoster !== undefined ? (
              // A relay GROUP: a reply fans out to every member, so naming a
              // single contact/number here would be wrong (and was: the shared
              // "this contact" fallback). Say who it actually reaches.
              <GroupReplyNote roster={relayRoster} />
            ) : (
              <ReplyTargetPicker
                {...(replyToPhone !== undefined && { replyToPhone })}
                {...(replyToLabel !== undefined && { replyToLabel })}
                targets={replyTargets ?? []}
                {...(selectedConversationId !== undefined && { selectedConversationId })}
                {...(onSelectTarget !== undefined && { onSelectTarget })}
              />
            )}
          </span>
          <button
            type="button"
            className={styles.sendBtn}
            onClick={() => void handleSend()}
            disabled={
              !canSend ||
              sending ||
              hasUploading ||
              hasErrored ||
              (draft.trim().length === 0 && uploadedKeys.length === 0)
            }
            title={
              canSend
                ? hasErrored
                  ? 'Remove the failed attachment to send'
                  : undefined
                : 'No single conversation to send into yet'
            }
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </section>
  );
}
