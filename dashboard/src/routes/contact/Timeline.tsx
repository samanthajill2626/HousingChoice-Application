// Timeline — the contact detail page's left pane: the blended Communications &
// activity stream (§B2/B3). Renders, oldest→newest, date dividers + message
// bubbles (full body, no truncation; inbound white / outbound light-blue),
// collapsed call cards (transcript behind a <details> disclosure, never auto-
// shown), and milestone pins (kind→color; they LINK OUT via refType/refId and
// never inline content - esp. relay-group content). A "Comms only" toggle hides
// milestones; a reply box notes the target number and sends to the resolved
// conversation (disabled with a tooltip when none is resolvable). Message bodies
// render as TEXT (React escapes) — never dangerouslySetInnerHTML. Accessibility-
// first (roles/labels) so it's testable.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ContactEmail,
  ConversationParticipant,
  RelayRecipientDelivery,
  TimelineCall,
  TimelineItem,
  TimelineMessage,
  TimelineMilestone,
  TimelineMilestoneType,
  TimelineScheduled,
} from '../../api/index.js';
import { ApiError, confirmMmsMedia, presignMmsMedia, uploadToPresignedPost } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { ScheduledCard } from './ScheduledCard.js';
import { deriveStreamAnchor, type StreamAnchor } from './streamAnchor.js';
import {
  dayKey,
  formatDayDivider,
  formatDuration,
  formatDateTimeWithSeconds,
  formatPhone,
  formatTime,
  formatTimeWithSeconds,
} from './format.js';
import {
  canEverGoStale,
  deliveryReason,
  isStaleLeg,
  presentDeliveryStatus,
  presentLegDelivery,
  presentRelayDelivery,
} from './deliveryStatus.js';
import type { DeliveryPresentation, DeliveryTone } from './deliveryStatus.js';
import { presentCallState } from './presentCallState.js';
import type { CallTone } from './presentCallState.js';
import { presentRelayExternalCaller } from './presentRelayExternalCaller.js';
import {
  findMemberByKey,
  memberDisplayLabel,
  senderLabel as resolveSenderLabel,
} from '../../lib/memberAttribution.js';
import { resolveRecipientLabel, type RecipientLabel } from '../../lib/recipientLabel.js';
import {
  isInlineRenderable,
  isPdfMediaType,
  mediaKindWord,
  messageMediaSrc,
  messageSid,
} from './media.js';
import { useAutoGrowTextarea } from './useAutoGrowTextarea.js';
import { ReplyTargetPicker } from './ReplyTargetPicker.js';
import type { ReplyTarget } from './replyTargets.js';
import { EmailComposer, type EmailComposerSendInput } from './EmailComposer.js';
import { EmailHtmlFrame } from './EmailHtmlFrame.js';
import { useImageViewer } from '../../ui/imageViewer/ImageViewerProvider.js';
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
      case 'contact_deleted':
        return 'This contact is deleted — restore them to reply.';
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
      // Native group text refusals (S5). Each names the ONE thing to do about
      // it: a generic "couldn't send" would leave the operator re-clicking.
      case 'group_member_deleted':
        return 'Someone in this group text is a deleted contact - restore them, or reply one to one from the member links.';
      case 'group_member_no_consent':
        return 'Someone in this group text has no recorded consent basis, so group sending is blocked.';
      case 'group_too_many_members':
        return 'This group text has too many members to send as a group - reply one to one from the member links.';
      case 'group_rail_unavailable':
        return 'This group text is not connected for sending yet - try again in a moment.';
      // RETRYABLE, and said differently on purpose: the group IS connected, the
      // attempt failed (a network blip, a provider 5xx) or the shared sending
      // meter is backed up. "Not connected yet" would send staff looking for a
      // setup problem that does not exist.
      case 'group_send_failed':
        return "That didn't send - the connection to our messaging provider failed. Try again.";
      case 'group_send_busy':
        return 'Sending is backed up right now - try again in a moment.';
      case 'group_text_media_not_supported':
        return 'Group texts are text only for now - remove the attachment to send.';
    }
  }
  return "Couldn't send — please try again.";
}

// Outbound MMS composer limits - MIRROR the server caps (spec Sec 9) so a file
// that would be rejected server-side never uploads. The server re-validates.
const MMS_MAX_MEDIA = 10;
// Per-file SOURCE ceiling (the presign policy cap): big photos upload at full
// size and the server auto-fits them into the MMS budget at confirm.
const MMS_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
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
  /** The deliverable rendition key confirm returned; sent as an attachmentKey. */
  key?: string;
  /** The pristine uploaded original (RCS-forward); rides attachmentOriginalKeys. */
  originalKey?: string;
  /** Set when a PDF was rasterized - > 1 drives the page-1-only note. */
  pdfPageCount?: number;
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
  if (file.size > MMS_MAX_SOURCE_BYTES) {
    return `${file.name} is too large (max 20 MB per file).`;
  }
  if (existing.length >= MMS_MAX_MEDIA) {
    return `You can attach at most ${MMS_MAX_MEDIA} files.`;
  }
  // Total budget over the CONFIRMED (deliverable) sizes only - a picked file's
  // source bytes shrink at confirm (auto-fit), so counting them would falsely
  // reject big photos the server can fit. The send route's total cap backstops.
  const total = existing.filter((a) => a.status === 'done').reduce((n, a) => n + a.size, 0);
  if (total > MMS_MAX_TOTAL_BYTES) {
    return 'Attachments exceed the 5 MB total limit. Remove one and try again.';
  }
  return null;
}

/** An upload failure -> a short, human chip message. The confirm route's
 *  transcode_failed carries the library diagnostic in `detail` (spec Sec 11) -
 *  surface it verbatim so the operator (and a bug report) sees the real cause. */
function uploadFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'transcode_failed' && err.detail !== undefined) {
      return `Couldn't process this file: ${err.detail}`;
    }
    if (err.code === 'transcode_failed') return "Couldn't process this file.";
    if (err.code === 'transcode_busy') return 'Server busy - remove and re-add to retry.';
    if (err.code === 'file_too_large_after_fit') return 'Too large even after fitting (max 5 MB).';
    if (err.code === 'unsupported_media_type' || err.status === 415) return 'Unsupported file type.';
    if (err.status === 413) return 'Too large (max 20 MB).';
    if (err.code === 'rate_limited') return 'Uploading too fast - wait a moment.';
  }
  return 'Upload failed - remove and try again.';
}

export type TimelineStatus = 'loading' | 'ready' | 'error';

/** Which multi-party product a roster belongs to (see TimelineProps.rosterKind). */
export type RosterKind = 'relay' | 'group_text';

/** What a paging caller must supply for the "Load older messages" control.
 *
 *  These four are one unit, not four options. `onLoadOlder` fetches,
 *  `hasOlder` decides whether the control renders, `loadingOlder` disables it
 *  AND disarms a stale scroll anchor, and `olderPagesLoaded` is what tells the
 *  layout pass a prepend actually landed. Supplying a subset yields a control
 *  whose scroll anchoring silently never fires. */
export interface TimelinePaging {
  hasOlder: boolean;
  loadingOlder: boolean;
  /** The hook's count of older pages MERGED so far - monotonic, NEVER reset for
   *  the life of the hook instance. The renderer only compares it to the value
   *  it last saw, so any reset to 0 would read as a fresh prepend and fire a
   *  bogus scroll restore. */
  olderPagesLoaded: number;
  onLoadOlder: () => void | Promise<void>;
}

export interface TimelineProps {
  status: TimelineStatus;
  items: TimelineItem[];
  /** Not-yet-sent scheduled messages - rendered as the LAST child of the
   *  scrolling stream, below the newest message and above the composer (shown
   *  only when non-empty). It scrolls with the stream rather than holding a
   *  fixed slice of the pane, and the scroll anchor keeps it below the fold
   *  until the operator scrolls to it. Never part of `items`. */
  upcoming?: TimelineScheduled[];
  /** The IANA zone the `upcoming` BODIES were composed in (spec D8), passed
   *  straight through to each card's fire-time label. Omitted (or from a
   *  response that predates the field) -> the card keeps the browser zone. */
  upcomingTimezone?: string;
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
   *  onSend(body) exactly as before). `attachmentOriginalKeys` (index-aligned)
   *  carries each attachment's pristine original for the send POST (RCS-forward,
   *  spec Sec 5); providers thread it to sendMessage the same way as the keys. */
  onSend?: (body: string, attachmentKeys?: string[], attachmentOriginalKeys?: string[]) => Promise<void>;
  /** Retry a failed outbound message — resends its body to its own conversation.
   *  May return the send promise: a rejection (e.g. 429 rate_limited — the retry
   *  shares the manual-send budget) is surfaced in the composer's error slot. */
  onRetry?: (msg: TimelineMessage) => void | Promise<void>;
  /** Contact is on the Do-Not-Contact list (sms_opt_out) — show a standing note
   *  at the composer so it's clear BEFORE sending (the send is refused too). */
  optedOut?: boolean;
  /** Contact is soft-deleted (deleted-contact resurfacing, 2026-08-03): the
   *  composer is REPLACED by a standing note + a Restore action; the send is
   *  also refused server-side (409 contact_deleted). */
  deleted?: boolean;
  /** Restore the deleted contact (the note's button). */
  onRestore?: () => void;
  /** Replace the composer entirely with this standing reason - the thread is
   *  READ-ONLY. Prefer this over `canSend={false}` when sending is structurally
   *  impossible rather than momentarily unavailable: a disabled composer invites
   *  a draft that can never be sent. Absent on every existing caller. */
  readOnlyNote?: string;
  /** History paging. Absent on every caller that does not page, which leaves
   *  those timelines visually unchanged. All four members travel together by
   *  construction - see TimelinePaging. */
  paging?: TimelinePaging;
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
  /**
   * Which PRODUCT the `relayRoster` above belongs to. It changes staff-facing
   * words and one affordance, never behavior:
   *   - the reply note names a "relay group" or a "group text";
   *   - a group text hides the ATTACH control, because outbound group media is
   *     not supported in v1 and the server 400s it - offering a picker that
   *     uploads a file and then refuses it is worse than not offering one.
   * Defaults to 'relay' so every existing caller is untouched.
   */
  rosterKind?: RosterKind;
  /** Relay group is closed — show a standing note at the composer (sending is
   *  ALSO hard-disabled via canSend=false). Analogous to the opt-out note. */
  relayClosed?: boolean;
  /** Relay group is CONNECTING (connect-when-ready, T7): its number is still
   *  warming / A2P-registering. Unlike relayClosed the composer stays ENABLED
   *  (canSend=true) - a send is HELD (queued_pending) and flushes when the group
   *  connects. Shows a standing "queued" note at the composer. */
  relayConnecting?: boolean;
  /** A stable id for the conversation/contact this timeline shows (contactId or
   *  conversationId). When it changes the stream is treated as a FRESH timeline —
   *  jump to the newest item, no "new messages" pill — so switching conversations
   *  never yanks or spuriously flags. */
  resetScrollKey?: string;
  /** Override the ready-but-empty stream copy (default "No messages yet."). Used
   *  by the tour page's create-on-demand 1:1 tab ("No messages with <name> yet").
   *  Optional + defaulted - contact/relay timelines are unchanged. */
  emptyLabel?: string;
  /** Email channel (email-channel v1, A6). Present ONLY on a 1:1 contact page -
   *  NEVER on a relay/tour/placement thread (those use useRelayThread and pass no
   *  emailChannel). Its presence renders the [Text | Email] composer toggle: when
   *  the contact has an address the Email segment swaps in the EmailComposer; when
   *  it has none the segment is disabled (tooltip) and an "Add email" affordance
   *  opens the EmailManager. */
  emailChannel?: {
    /** The contact's addresses (the EmailComposer To select). */
    emails: ContactEmail[];
    /** Compose + send an email (the parent owns the optimistic bubble + which
     *  conversation to send into). Rejects on an A5 refusal. */
    onSendEmail: (input: EmailComposerSendInput) => Promise<void>;
    /** Open the "Manage email" dialog (the disabled/Add-email affordance). */
    onManageEmails: () => void;
    /** Contact is suppressed for email (opt-out/unreachable) - standing note. */
    suppressed?: boolean;
  };
  /** "Comms only" filter, CONTROLLED. Pass this WITH onCommsOnlyChange to let a
   *  caller own the toggle above a remount boundary - the tour/placement pages
   *  hold one value per page visit so the filter survives a tab switch. Pass
   *  NEITHER (the contact page) and the toggle stays per-mount internal state,
   *  defaulting to off. */
  commsOnly?: boolean;
  /** Reports a toggle click when `commsOnly` is controlled. Nothing renders
   *  differently until the caller re-renders us with the new value. */
  onCommsOnlyChange?: (v: boolean) => void;
  /** Seed the composer textarea with this body ON MOUNT ONLY (read by the draft
   *  useState initializer). Used by the tour page's "Send no-show check-in" to
   *  prefill the tenant 1:1 composer with the editable template. Changing it
   *  after mount is inert, so the parent can clear its seed (see onDraftSeeded)
   *  without wiping an in-progress draft. */
  initialDraft?: string;
  /** Fired once, on mount, iff initialDraft was a non-empty string. Lets the
   *  parent clear its seed so a later remount of this timeline does not re-seed. */
  onDraftSeeded?: () => void;
}

/** The GROUP composer footer: a reply relays to EVERY member, so the line names
 *  the whole roster ("everyone in this relay group (Ann, Marcus)") instead of a
 *  single number. A member with no resolved name falls back to their formatted
 *  phone; an empty/unloaded roster (best-effort fetch) keeps the honest
 *  "everyone" line with no list. */
function GroupReplyNote({
  roster,
  kind,
}: {
  roster: ConversationParticipant[];
  kind: RosterKind;
}): React.JSX.Element {
  const names = roster.map((m) => {
    const n = m.name?.trim();
    return n && n.length > 0 ? n : formatPhone(m.phone) || m.phone;
  });
  // The noun matters: a NATIVE group text is not a relay group, and calling it
  // one on the very control that fans a message out to real handsets is the
  // exact privacy-relevant confusion the S1 rename existed to end.
  const label = kind === 'group_text' ? 'everyone in this group text' : 'everyone in this relay group';
  return (
    <>
      Reply sends to <strong>{label}</strong>
      {names.length > 0 ? <> ({names.join(', ')})</> : null}
    </>
  );
}

/** Milestone kind → pin color variant (the mockup's neutral / amber / purple /
 *  green markers). number_added = amber; relay-group add/remove/open = purple;
 *  the positive outcome-ish ones = green; everything else neutral (including
 *  tour_converted - the placement_opened pin beside it carries the same news). */
function milestoneVariant(type: TimelineMilestoneType): string {
  switch (type) {
    case 'number_added':
      return styles.amber ?? '';
    case 'added_to_group_text':
    case 'removed_from_group_text':
    case 'tour_group_opened':
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

/** Delivery tone → chip color class — shared by the 1:1 status chip and the
 *  relay rollup chip so "Delivered" is the same green everywhere. */
const TONE_CLASS: Record<DeliveryTone, string | undefined> = {
  neutral: styles.toneNeutral,
  info: styles.toneInfo,
  success: styles.toneSuccess,
  danger: styles.toneDanger,
};

/** The <ul>'s accessible name. Shared by the render and by e2e/unit locators, so
 *  the list is reached with getByRole('list', { name }) rather than a test id. */
const RECIPIENT_LIST_LABEL = 'Delivery by recipient';

/** One rendered row of the per-recipient delivery breakdown. */
interface RecipientRow {
  /** The delivery_recipients map key - contactId, or `phone#<E164>`. */
  key: string;
  slot: RelayRecipientDelivery;
  /** Who this row names (lib/recipientLabel) - never blank, and silent about
   *  membership unless the roster actually supports the claim. */
  name: RecipientLabel;
  /** The row's own clock, already formatted; '' when the leg has none. */
  when: string;
}

/**
 * The row's timestamp: `deliveredAt` on a delivered leg, else `sentAt` on ANY
 * leg that carries one - not only a `sent` leg.
 *
 * Restricting it to `sent` would render a stale `Queued - not confirmed` row as
 * a red state with NO time while the identical fact one status over showed one,
 * and the row exists to answer "why is the chip red". A group-text leg has
 * neither clock (it is never given a `sentAt`), so many rows correctly show a
 * state with no time - NEVER back-filled from the message's own instant, which
 * would present a message-level fact as a per-leg one.
 *
 * formatTime returns '' for an unparseable instant, so the caller renders the
 * time element only for a non-empty string rather than a dangling separator.
 */
function recipientRowTime(slot: RelayRecipientDelivery): string {
  const iso =
    slot.status === 'delivered' && slot.deliveredAt !== undefined ? slot.deliveredAt : slot.sentAt;
  return iso === undefined ? '' : formatTime(iso);
}

/**
 * Order the map's entries for display: ROSTER order first, then every slot whose
 * key matches no roster member, in MAP-KEY order.
 *
 * The match reuses `findMemberByKey` - the same matcher `senderLabel`,
 * `relayCallSummary` and `resolveRecipientLabel` use - so a row can never sort as
 * "unmatched" while it renders a member's name.
 *
 * The `Array.isArray` guard is DEFENCE IN DEPTH, not a response to an observed
 * wire shape: these rosters arrive off raw passthroughs, and the guard holds the
 * same standard as the pre-existing `typeof` field guards in
 * `memberAttribution.ts`. It is NOT a page-level guarantee - `GroupReplyNote` in
 * this file calls `roster.map` on the same prop with no guard - so do not read it
 * as one.
 */
function orderRecipientRows(
  entries: Array<[string, RelayRecipientDelivery]>,
  roster: ConversationParticipant[] | undefined,
): RecipientRow[] {
  const members = Array.isArray(roster) ? roster : [];
  return entries
    .map(([key, slot], index) => {
      const member = members.length > 0 ? findMemberByKey(key, members) : undefined;
      const rank = member === undefined ? Number.MAX_SAFE_INTEGER : members.indexOf(member);
      return { key, slot, name: resolveRecipientLabel(key, roster), when: recipientRowTime(slot), rank, index };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ key, slot, name, when }) => ({ key, slot, name, when }));
}

/** The chip's visible string: the presenter's label with the reason appended
 *  inline, exactly as both chip spans render it. */
function chipText(presentation: DeliveryPresentation, reason: string | undefined): string {
  return reason !== undefined ? `${presentation.label} - ${reason}` : presentation.label;
}

/**
 * Rewrite a visible delivery string for a SCREEN READER: `1/2` becomes `1 of 2`
 * (a bare slash is ambiguous read aloud) and the ` - ` separator this file uses
 * everywhere becomes a comma, which reads as a pause instead of a dash.
 *
 * The wording itself is NEVER re-cased or re-worded - the presenters own it, and
 * a second spelling here would be free to drift from the visible one.
 */
function speakDeliveryText(text: string): string {
  return text.replace(/(\d+)\/(\d+)/g, '$1 of $2').split(' - ').join(', ');
}

/**
 * The delivery chip's accessible name (spec S6): the visible label, then each
 * recipient and their state.
 *
 * WHY IT EXISTS: the bubble reveal is a div `onClick` with no keyboard path, so
 * a screen-reader user cannot open the disclosure the rows live in. The name
 * puts the same facts on the always-rendered chip. CONSEQUENCE, and it is not
 * obvious: the S2 resolution above runs UNCONDITIONALLY on every outbound
 * multi-party bubble, revealed or not.
 *
 * It takes the SAME clock as the chip it names. A name computed against a
 * different clock than its own visible label is a contradiction a reader cannot
 * resolve. It takes the SAME `media` flag for the same reason: a 30005 on an
 * attachment leg must read "Attachment didn't get through" here, on the visible
 * row, and on the rollup chip alike. One `isMms`, three consumers.
 *
 * Case-3 clause: with NO roster and every slot contactId-keyed there is nothing
 * to say about anyone, so the name carries only the count rather than reciting
 * "Unnamed recipient" N times.
 */
function recipientSummaryName(
  headline: string,
  rows: RecipientRow[],
  rosterKind: RosterKind,
  messageAtMs: number | undefined,
  nowMs: number | undefined,
  media: boolean,
): string {
  const spoken = speakDeliveryText(headline);
  const anonymous = rows.every((r) => r.name.match === 'unidentified' && !r.name.phoneKeyed);
  if (rows.length === 0 || anonymous) return spoken;
  const recital = rows.map((row) => {
    const who = row.name.note !== undefined ? `${row.name.label}, ${row.name.note}` : row.name.label;
    const leg = presentLegDelivery(row.slot, rosterKind, messageAtMs, nowMs);
    // A null presentation (an unrecognised wire status) names the person and
    // claims no state - never a blank row, never an invented one.
    if (leg === null) return `${who}.`;
    // `relay` is the same product flag the rollup and the visible row pass, for
    // the same reason `media` is passed to all three: a relay 30003 promises a
    // retry that does not exist (D19), and a screen-reader user hearing "will
    // retry" while the chip beside it does not say so is the D21 contradiction.
    const legReason = leg.isFailure
      ? deliveryReason(row.slot.errorCode, { media, relay: rosterKind === 'relay' })
      : undefined;
    return `${who}: ${speakDeliveryText(chipText(leg, legReason))}.`;
  });
  return `${spoken}. ${recital.join(' ')}`;
}

/** Call tone -> chip color class. DELIBERATELY separate from TONE_CLASS above:
 *  that map is typed Record<DeliveryTone, ...> so it cannot hold 'warning', and
 *  it points at the DELIVERY palette, which is a different green (--c-success)
 *  and a different red (--c-danger) from the call palette. Reusing it would put
 *  two greens and two reds on one row. These are the card's own existing
 *  classes, so the chips keep exactly today's colors. */
const CALL_TONE_CLASS: Record<CallTone, string | undefined> = {
  success: styles.answered,
  danger: styles.missed,
  warning: styles.voicemail,
  neutral: styles.callNeutral,
};

// Direction glyphs as ESCAPES (pure-ASCII source; byte-identical render to the
// literal characters): U+2199 down-left = inbound, U+2197 up-right = outbound.
// Purely decorative - both are aria-hidden, and the direction word beside them
// is what carries the meaning to a screen reader.
const ARROW_IN = '\u2199';
const ARROW_OUT = '\u2197';

/** setTimeout's 32-bit ceiling. A delay ABOVE this fires IMMEDIATELY rather than
 *  late, so "strictly in the future" is not on its own a spin guard - past the
 *  ceiling the card schedules nothing at all. */
const MAX_TIMEOUT_MS = 2_147_483_647;

// Attachment glyphs via String.fromCodePoint (pure-ASCII source; byte-identical
// render to the literal emoji) so every source line stays ASCII. U+1F4CE =
// paperclip; U+1F4C4 = page (PDF).
const ICON_CLIP = String.fromCodePoint(0x1f4ce);
const ICON_PAGE = String.fromCodePoint(0x1f4c4);

/** The visible label for one attachment: the persisted original filename when
 *  present, else a positional fallback. The fallback names the KIND when we
 *  know it ("Video - Attachment 1"); PDF keeps its existing wording; and the
 *  opaque tier stays bare, because there is no honest kind word for
 *  application/octet-stream. */
function attachmentLabel(
  filename: string | undefined,
  contentType: string,
  isPdf: boolean,
  i: number,
): string {
  if (filename !== undefined && filename.trim().length > 0) return filename;
  if (isPdf) return `PDF attachment ${i + 1}`;
  const kind = mediaKindWord(contentType);
  return kind !== undefined ? `${kind} - Attachment ${i + 1}` : `Attachment ${i + 1}`;
}

function ImageAttachmentButton({ src, label }: { src: string; label: string }): React.JSX.Element {
  const { openImage } = useImageViewer();
  return (
    <button
      type="button"
      className={styles.mediaButton}
      aria-label={`View ${label}`}
      aria-haspopup="dialog"
      onClick={(event) => openImage({ src, alt: label, title: label }, event.currentTarget)}
    >
      <img className={styles.mediaImg} src={src} alt={label} loading="lazy" />
    </button>
  );
}

/** The mirrored-attachment gallery for a message (MMS bubble AND email card).
 *  Renderable images open in the shared viewer; PDFs/other files are links
 *  to the authed serve endpoint. Without a derivable provider SID there's no
 *  servable URL, so it falls back to a count chip. Factored so MessageBubble and
 *  EmailCard render attachments identically. `stopPropagation` keeps opening media
 *  from also toggling a parent bubble's meta. */
function AttachmentGallery({ msg }: { msg: TimelineMessage }): React.JSX.Element | null {
  const attachments = msg.media_attachments ?? [];
  if (attachments.length === 0) return null;
  const sid = messageSid(msg);
  if (!sid) {
    return (
      <div className={styles.media}>
        {ICON_CLIP} {attachments.length === 1 ? '1 attachment' : `${attachments.length} attachments`}
      </div>
    );
  }
  return (
    <div className={styles.mediaGallery} onClick={(e) => e.stopPropagation()}>
      {attachments.map((att, i) => {
        const src = messageMediaSrc(sid, i);
        if (isInlineRenderable(att.contentType)) {
          const label = attachmentLabel(att.filename, att.contentType, false, i);
          return <ImageAttachmentButton key={i} src={src} label={label} />;
        }
        const isPdf = isPdfMediaType(att.contentType);
        return (
          <a
            key={i}
            className={styles.mediaFile}
            href={src}
            target="_blank"
            rel="noopener noreferrer"
          >
            {isPdf ? ICON_PAGE : ICON_CLIP} {attachmentLabel(att.filename, att.contentType, isPdf, i)}
          </a>
        );
      })}
    </div>
  );
}

/** The staleness ticker's period. COARSE by design: it drives a RE-RENDER only -
 *  it fetches nothing and never touches the network - and the boundary it has to
 *  carry a leg across is 15 minutes wide (STALE_SENT_AFTER_MS), so a minute of
 *  granularity costs at most a minute of lateness on a 15-minute cue. */
const STALE_TICK_MS = 60 * 1000;

/** The two clocks ONE bubble presents against, derived in ONE place so the
 *  timeline's ticker run condition and the bubble's own rendering can never
 *  disagree about what time it is for a given message.
 *
 *  `bubbleNowMs` is WITHHELD (undefined) on an imported row, which is the total
 *  off switch for staleness - `isStaleLeg` and `canEverGoStale` both return
 *  false without a clock, whatever `sentAt` a slot carries. That is why an
 *  imported bubble both renders no escalation AND contributes nothing to the run
 *  condition (plan D-b / D-c2): deriving it twice is what would let those two
 *  drift apart.
 *
 *  `messageAtMs` may be NaN - `messageInstant` (conversation/useRelayThread.ts)
 *  answers '' for a message with no provider_ts and a non-ISO tsMsgId. That is
 *  handled downstream by `canEverGoStale`'s finiteness clause, NOT here: a leg
 *  with a NaN clock must read as never-ageable rather than as forever-eligible. */
function bubbleClocks(
  msg: TimelineMessage,
  tickNow: number,
): { messageAtMs: number; bubbleNowMs: number | undefined } {
  return {
    messageAtMs: Date.parse(msg.at),
    bubbleNowMs: msg.imported === true ? undefined : tickNow,
  };
}

/**
 * THE TICKER'S RUN CONDITION, per message: does this bubble render at least one
 * outbound leg that CAN still go stale but has not yet?
 *
 * It is a PREDICATE over the presenter's own two functions, never a shape test.
 * Four distinct non-terminations have been shipped-and-caught behind this one
 * line, and each is closed by a specific clause here:
 *
 *  1. "any non-terminal leg" - a STALE leg stays non-terminal for ever, so the
 *     interval would run permanently on exactly the threads this feature
 *     targets. Closed by `!isStaleLeg(...)`.
 *  2. "non-terminal AND not-yet-stale" - a `queued` leg with no `sentAt` is BOTH
 *     for ever (that is the deliberate, human-decided silence), so it would spin
 *     for ever on a group text after a receipts-webhook outage and on a relay
 *     message whose fan-out never ran. Closed by `canEverGoStale(...)`, which
 *     answers false for exactly the rows of the S3 table that have no ageing
 *     clock.
 *  3. a WITHHELD clock - an imported bubble's `nowMs` is undefined and must
 *     contribute NOTHING. Closed by passing the BUBBLE's clock (see
 *     `bubbleClocks`), not the raw tick.
 *  4. a clock that parses to NaN - a real handled shape here, not a defensive
 *     hypothetical. Closed by `canEverGoStale`'s finiteness clause.
 *  5. a clock in the FUTURE - the ageing clocks are the PROVIDER's and `nowMs`
 *     is the OPERATOR'S BROWSER clock, so a browser running slow puts every
 *     freshly-sent leg ahead of us, where it is "eligible" and "not yet stale"
 *     at once. Closed by `canEverGoStale`'s FUTURITY BOUND, which keeps ordinary
 *     skew eligible (so the escalation is late, never missed) and drops a clock
 *     more than one whole staleness budget ahead. Read that function's doc
 *     before touching the bound.
 *
 * `canEverGoStale` and `isStaleLeg` derive their clock from one shared private
 * helper inside the presenter, so they cannot disagree about which clock a slot
 * uses. Staleness is monotonic and a real receipt arrives as an SSE refetch
 * rather than a tick, so the tick only ever has to carry a leg ACROSS the
 * boundary - never back.
 *
 * The gate mirrors what the bubble actually RENDERS: a leg nothing presents
 * cannot change any pixel, so it must not buy an interval. FIVE clauses carry
 * that mirror, and each one names a real rendering decision made elsewhere:
 *
 *  - OUTBOUND only, and a non-empty `delivery_recipients` map, which is
 *    `showRecipients` / the rollup guard in `MessageBubble`.
 *  - NOT a `queued_pending` hold, which suppresses both the rollup and the rows.
 *  - NOT an `email` row. `StreamItem` routes `type === 'email'` to `EmailCard`,
 *    which renders no rollup, no rows and no legs at all - while the server
 *    (`app/src/routes/contactTimeline.ts`) attaches `delivery_recipients` to a
 *    message of ANY type. Latent today (no email carries such a map), and the
 *    check is on the TYPE for exactly the reason the routing is: this predicate
 *    must move whenever that switch does.
 *  - NOT an OPTED-OUT leg. `presentRelayDelivery` filters `contact_opted_out`
 *    out of its counts and `presentLegDelivery` short-circuits on the code
 *    BEFORE any staleness test, so neither the chip nor the row can ever change
 *    for such a leg however long it sits there.
 */
function hasTickableLeg(msg: TimelineMessage, tickNow: number): boolean {
  if (msg.direction !== 'outbound') return false;
  if (msg.type === 'email') return false;
  if (msg.delivery_status === 'queued_pending') return false;
  const { messageAtMs, bubbleNowMs } = bubbleClocks(msg, tickNow);
  if (bubbleNowMs === undefined) return false;
  return Object.values(msg.delivery_recipients ?? {}).some(
    (slot) =>
      slot.errorCode !== 'contact_opted_out' &&
      canEverGoStale(slot, messageAtMs, bubbleNowMs) &&
      !isStaleLeg(slot, messageAtMs, bubbleNowMs),
  );
}

function MessageBubble({
  msg,
  onRetry,
  relayRoster,
  rosterKind = 'relay',
  tickNow,
}: {
  msg: TimelineMessage;
  onRetry?: (msg: TimelineMessage) => void;
  /** Present in the relay-group view → enables sender attribution + delivered N/M. */
  relayRoster?: ConversationParticipant[];
  /** Which product the roster belongs to. Read by the sender chip (a nameless
   *  `group_text` member is attributed by formatted number, spec 4.2, while
   *  relay keeps its prior no-line rendering, invariant 6) and by the per-leg
   *  presenter, whose opted-out copy is product-aware for the same reason the
   *  opt-out note below is. */
  rosterKind?: RosterKind;
  /** The TIMELINE's clock, hosted once per thread and ALWAYS a number. It is not
   *  read directly: see `bubbleNowMs` below, which is the value this bubble
   *  actually presents against. */
  tickNow: number;
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

  // Delivery state is meaningful only for OUTBOUND; seed/legacy rows (no status)
  // show no chip. Failures expose a reason (when error_code is present) + Retry.
  // The timestamp goes in so a `sent` that never advanced stops reading as
  // "Sent" once it has gone quiet - a carrier that discards a message sends no
  // receipt and no error, so the age of the row is the ONLY signal there is.
  //
  // WITHHELD on an IMPORTED row. That cue means "we expected a delivery receipt
  // and never got one", which is only ever true of a message we sent through the
  // carrier ourselves. Imported history predates that: the export carries no
  // per-message receipts, so the importer writes a flat `sent` and every one of
  // those rows is permanently past the staleness budget. Omitting the timestamp
  // is the documented way to ask presentDeliveryStatus for the plain label - the
  // pure function needs no import-specific branch. A stored terminal status
  // (failed/undelivered) is the source's own fact and still renders.
  const delivery = outbound
    ? presentDeliveryStatus(msg.delivery_status, msg.imported === true ? undefined : Date.parse(msg.at))
    : null;
  // `media` scopes the reason copy to the leg that actually failed: a 30005 on
  // an attachment is routinely an MMS-path failure to a line whose texts all
  // deliver, so an attachment bubble must not read "Number is invalid". WHERE
  // that path breaks is deliberately unnamed - see
  // docs/issues/mms-silent-drop-dish-textnow.md.
  const isMms = msg.type === 'mms';
  // DELIBERATELY no `relay` flag here, and this is the one place in this
  // component where that is a decision rather than an omission. This site reads
  // the MESSAGE's own error_code, not a leg's. A relay source message never gets
  // one (the relay path writes SLOTS only); the code that does reach it is the
  // native-group-text aggregate, whose 30003 retry is real (D20). Passing
  // `rosterKind` here would drop the promise from a group text that genuinely
  // retries - the exact inversion D20 forbids.
  const reason = delivery?.isFailure ? deliveryReason(msg.error_code, { media: isMms }) : undefined;
  // The product flag for every LEG-scoped reason in this bubble: the rollup, the
  // accessible-name recital and the per-recipient row. ONE PROP, derived twice
  // from the same value - this flag serves the rollup and the row, and the
  // recital recomputes `rosterKind === 'relay'` inside recipientSummaryName -
  // so the three still cannot disagree (D21), the same argument the single
  // `isMms` above already makes for media.
  const isRelayLeg = rosterKind === 'relay';

  // Relay group (M1.7): count recipients this message was NOT relayed to because
  // they opted out (a `contact_opted_out` failed slot). Surfaced as a subtle note
  // so staff know the relay group didn't reach everyone. Absent on 1:1 messages.
  // The CODE alone, matching presentRelayDelivery: relay writes `failed` on a
  // suppressed leg, the group-text receipts path writes Twilio's own
  // `undelivered` for a 21610. Requiring `failed` too left a group text's
  // opted-out member unexplained AND counted as a hard failure.
  const optedOutCount = Object.values(msg.delivery_recipients ?? {}).filter(
    (r) => r.errorCode === 'contact_opted_out',
  ).length;
  // ONE CLOCK PER BUBBLE, and it is a DIFFERENT value from the timeline's tick.
  // `tickNow` is always a number and exists to force re-renders; `bubbleNowMs` is
  // what this bubble PRESENTS against, and it is WITHHELD on an imported row.
  // Withholding the clock is the total off switch for staleness (isStaleLeg
  // returns false for every slot without it, whatever `sentAt` the slot carries),
  // which is the same guarantee the 1:1 call above gets by withholding its
  // TIMESTAMP - the two functions take opposite conventions on the name `nowMs`,
  // see their docs. The rollup, every row and the accessible name all read this
  // ONE variable, so they cannot disagree about what time it is.
  //
  // NOT folded into the 1:1 call at the top of this component: that call's shape
  // is frozen (two out-of-scope callers depend on presentDeliveryStatus and its
  // `sent`-only rule), so it keeps its own implicit Date.now() default.
  // Derived by the SHARED helper, which is also what the timeline's ticker run
  // condition walks - so a bubble and the interval that exists to re-render it
  // can never disagree about this message's clocks.
  const { messageAtMs, bubbleNowMs } = bubbleClocks(msg, tickNow);
  // Object.entries, not Object.values: the KEYS are who each leg went to, and
  // throwing them away is precisely what left the 2026-08-23 bubble saying
  // "delivered 1/2" about a coin flip the founder lost. The rollup still reads
  // them in MAP order, exactly as it did.
  const recipientEntries = Object.entries(msg.delivery_recipients ?? {});
  // Relay group (M1.7): a message carrying a delivery_recipients map is a relayed
  // SOURCE message. For an OUTBOUND relay bubble, summarize per-member delivery
  // as ONE rollup chip (counting up while in flight, green "Delivered N/N" once
  // every leg delivered, danger when a leg hard-fails) from the SAME map the
  // opted-out note reads. GUARDED to relay + outbound so a 1:1 bubble (no
  // delivery_recipients) is visually unchanged. A `queued_pending` HOLD (T7) is
  // EXCLUDED: its per-member slots are pre-seeded 'queued' placeholders (nothing
  // was fanned out), so a rollup would read as a misleading "delivered 0/N" - the
  // message's own "Queued - will send when connected" chip is the honest state.
  const deliveredSummary =
    outbound && msg.delivery_recipients && msg.delivery_status !== 'queued_pending'
      ? presentRelayDelivery(
          recipientEntries.map(([, slot]) => slot),
          { media: isMms, relay: isRelayLeg, messageAtMs, nowMs: bubbleNowMs },
        )
      : null;
  const recipientRows = orderRecipientRows(recipientEntries, relayRoster);
  // THE LIST'S GATE - ONE predicate, evaluated INDEPENDENTLY of the rollup's
  // value. Deliberately NOT `deliveredSummary !== null`: presentRelayDelivery
  // returns null for an ALL-OPTED-OUT map as well as an empty one, so gating on
  // the rollup would delete the opted-out rows in the one case where those
  // members are the ONLY information the bubble has. There the chip states the
  // aggregate, the note counts, and the rows NAME - three elements, three jobs.
  const showRecipients =
    outbound && recipientEntries.length > 0 && msg.delivery_status !== 'queued_pending';
  // Spec S6. The name goes on whichever chip ACTUALLY RENDERS: the rollup chip
  // when there is one, else - and only on a branch-0 bubble, i.e. a non-empty map
  // whose legs all opted out - the message-level chip, which is the only chip
  // that bubble has. A bubble with NO map at all gets neither, which is what
  // keeps the repo's single unnamed-<img> guard honest.
  const rollupName =
    deliveredSummary !== null
      ? recipientSummaryName(
          chipText(deliveredSummary, deliveredSummary.reason),
          recipientRows,
          rosterKind,
          messageAtMs,
          bubbleNowMs,
          isMms,
        )
      : undefined;
  // Multi-party attribution: who authored this message ("Team" or a member's
  // name), resolved through the SHARED resolver so a relay bubble and a native
  // group_text bubble render identically. Undefined on a 1:1 bubble (no
  // relay_sender_key) -> no attribution line.
  const senderLabel = resolveSenderLabel(msg.relay_sender_key, relayRoster, rosterKind);
  const toneClass = delivery ? (TONE_CLASS[delivery.tone] ?? '') : '';
  // The branch-0 half of the S6 rule. `showRecipients && deliveredSummary === null`
  // is exactly "a non-empty map, outbound, not a queued_pending hold, and the
  // rollup still came back null" - which only happens when every leg opted out.
  const messageChipName =
    showRecipients && deliveredSummary === null && delivery !== null
      ? recipientSummaryName(
          chipText(delivery, reason),
          recipientRows,
          rosterKind,
          messageAtMs,
          bubbleNowMs,
          isMms,
        )
      : undefined;

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
      {/* Relay number lifecycle: a late text a still-rostered member sent to a
       *  now-CLOSED group's number was intercepted into their 1:1 - attribute it
       *  back to that closed group (link out; stopPropagation so it doesn't toggle
       *  the bubble meta). */}
      {typeof msg.via_closed_group === 'string' && msg.via_closed_group.length > 0 ? (
        <Link
          to={`/conversations/${msg.via_closed_group}`}
          className={styles.viaClosedGroup ?? ''}
          onClick={(e) => e.stopPropagation()}
        >
          Sent to the closed group chat
        </Link>
      ) : null}
      {msg.body ? <div className={styles.body}>{msg.body}</div> : null}
      <AttachmentGallery msg={msg} />
      <div className={styles.meta}>
        <span className={styles.metaText}>{meta}</span>
        {delivery && deliveredSummary === null ? (
          // Suppressed on a relay SOURCE bubble: its own delivery_status stays
          // 'queued' forever (DLRs land in delivery_recipients slots, never on
          // the parent), so "delivered N/M" below is the truthful state.
          <span
            className={`${styles.status} ${toneClass}`}
            {...(reason !== undefined && { title: reason })}
            {...(messageChipName !== undefined && { role: 'img', 'aria-label': messageChipName })}
          >
            {delivery.label}
            {reason !== undefined ? ` - ${reason}` : ''}
          </span>
        ) : null}
        {deliveredSummary !== null ? (
          // role="img" is what makes the name stick: a bare <span> maps to
          // role=generic, on which ARIA PROHIBITS an author-provided name, so a
          // plain aria-label is the one construct guaranteed not to work.
          // role="img" makes the chip a leaf that supports a name, and the title
          // stays for mouse users. Precedent: AutoBadge.tsx.
          <span
            className={`${styles.status} ${TONE_CLASS[deliveredSummary.tone] ?? ''}`}
            {...(deliveredSummary.reason !== undefined && { title: deliveredSummary.reason })}
            {...(rollupName !== undefined && { role: 'img', 'aria-label': rollupName })}
          >
            {deliveredSummary.label}
            {deliveredSummary.reason !== undefined ? ` - ${deliveredSummary.reason}` : ''}
          </span>
        ) : null}
      </div>
      {/* Who the send actually reached. CONDITIONALLY RENDERED on the reveal -
       *  NOT the meta line's display:none - so presence/absence is a real unit
       *  assertion in a css:false environment and no hidden row TEXT sits in the
       *  DOM for a page-scoped e2e getByText to match. A SIBLING of .meta, never
       *  a child: a <ul> inside that flex row fights margin-left:auto on .status.
       *
       *  WHAT THIS DOES NOT MEAN. A collapsed bubble is not silent about its
       *  recipients: spec S6 puts the same per-recipient facts on the
       *  always-rendered chip as an `aria-label` ATTRIBUTE (`rollupName` /
       *  `messageChipName` above, computed unconditionally), and S6 consequence 3
       *  states that DELIBERATELY - it is what gives a screen-reader user, who
       *  cannot open this disclosure at all, the names. So the guarantee here is
       *  about rendered TEXT ONLY, which is exactly what the unit negatives and
       *  the e2e `toHaveCount(0)` / `toContainText` assertions read.
       *
       *  The rows do NOT stopPropagation, deliberately. They are children of the
       *  bubble whose onClick is the toggle, so clicking a row collapses the list
       *  - ordinary disclosure behavior, and locked decision 1 forbids a second
       *  click target inside the bubble. The two OTHER interactive children opt
       *  out, which makes adding it here look defensive; do not. Staff selecting
       *  a phone number are already protected by toggleMeta's early return. */}
      {showRecipients && revealed ? (
        <ul className={styles.recipientList} aria-label={RECIPIENT_LIST_LABEL}>
          {recipientRows.map((row) => {
            const leg = presentLegDelivery(row.slot, rosterKind, messageAtMs, bubbleNowMs);
            // A reason renders only when THIS row's own presentation isFailure,
            // mirroring the message-level rule. An errorCode does NOT imply
            // failure: the fan-out writes a transient carrier code onto a leg it
            // is still retrying, and printing that beside it is its own misread.
            //
            // `{ media: isMms }` is REQUIRED, not decorative. Without it a 30005
            // on an attachment leg reads "Number is invalid" beside a named
            // member - the un-hedged copy the MMS fix removed from the rollup -
            // so this NEW surface would contradict the message-level chip
            // directly above it. One `isMms` feeds the rollup, this row and the
            // accessible name, so the three cannot disagree.
            //
            // `relay` is the second flag on exactly the same footing (D19/D21):
            // a relay leg's 30003 keeps its carrier code and drops the "will
            // retry" tail, because no relay retry is scheduled - while a native
            // group text, whose 30003 retry IS real, keeps the promise.
            const legReason =
              leg?.isFailure === true
                ? deliveryReason(row.slot.errorCode, { media: isMms, relay: isRelayLeg })
                : undefined;
            return (
              <li key={row.key} className={styles.recipientRow}>
                <span className={styles.recipientName}>
                  {row.name.note !== undefined ? `${row.name.label} - ${row.name.note}` : row.name.label}
                </span>
                {leg !== null ? (
                  <span className={`${styles.recipientState ?? ''} ${TONE_CLASS[leg.tone] ?? ''}`}>
                    {chipText(leg, legReason)}
                  </span>
                ) : null}
                {row.when.length > 0 ? (
                  <span className={styles.recipientTime}>{row.when}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {optedOutCount > 0 ? (
        // A27(a). The FRAMING is per product, because the mechanism is per
        // product. A relay send really is relayed - we fan a message out to each
        // member from a pool number, and an opted-out member is one we did not
        // send to. A NATIVE group text relays nothing: the carrier thread already
        // exists on every handset and we post one message into it, which Twilio
        // then SKIPS for a suppressed participant (no leg, no carrier attempt, no
        // receipt - app/src/services/groupDelivery.ts). Saying "not relayed to
        // them" on a group bubble invents a mechanism AND contradicts the
        // suppression banner directly above it in GroupTextView. Relay's copy is
        // deliberately untouched (invariant 6).
        <p className={styles.relayOptOutNote}>
          {rosterKind === 'group_text'
            ? optedOutCount === 1
              ? '1 member opted out - Twilio skips them, so their phone never receives it.'
              : `${optedOutCount} members opted out - Twilio skips them, so their phones never receive it.`
            : optedOutCount === 1
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

/**
 * An <audio> element whose playback is downmixed to MONO via the Web Audio API.
 *
 * Bridge recordings are DUAL-CHANNEL on purpose (caller on the left, staff on
 * the right - that channel isolation is what gives the transcript clean
 * per-speaker attribution), but hard L/R panning means a one-earbud / earpiece
 * / single-speaker listener hears only ONE party (observed live 2026-07-20).
 * Downmixing at PLAYBACK keeps the stored recording and the VI transcription
 * untouched while making both voices audible on any output device.
 *
 * Wiring happens lazily on first 'play' (a user gesture, so the AudioContext
 * is allowed to start) and exactly once per element (createMediaElementSource
 * is one-shot). The GainNode's explicit channelCount=1 makes the Web Audio
 * graph downmix L+R per the spec's 'speakers' interpretation. If Web Audio is
 * unavailable the element just plays normally (stereo) - a degraded listen,
 * never a broken player.
 */
function MonoAudio(props: React.ComponentProps<'audio'>): React.JSX.Element {
  const elRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return undefined;
    let wired = false;
    const wire = () => {
      if (wired) return;
      wired = true;
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaElementSource(el);
        const mono = ctx.createGain();
        mono.channelCount = 1;
        mono.channelCountMode = 'explicit';
        mono.channelInterpretation = 'speakers';
        source.connect(mono);
        mono.connect(ctx.destination);
        void ctx.resume();
        ctxRef.current = ctx;
      } catch {
        // No Web Audio (or graph refused): the element keeps playing directly.
      }
    };
    el.addEventListener('play', wire);
    return () => {
      el.removeEventListener('play', wire);
      void ctxRef.current?.close();
      ctxRef.current = null;
    };
  }, []);

  return <audio ref={elRef} {...props} />;
}

/** A call card: a FIRST-CLASS directional item. It takes a side like a message
 *  bubble does (position + direction word + outbound tint), states what we
 *  actually know about the call, and never asserts an outcome the data does not
 *  support - the label comes from presentCallState, which returns nothing at all
 *  when nothing is known. The party number lives behind a click-to-reveal detail
 *  line rather than on the face. */
function joinCallRecipients(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

function relayCallSummary(
  call: TimelineCall,
  roster: ConversationParticipant[] | undefined,
): string | undefined {
  if (roster === undefined || roster.length < 2) return undefined;
  let caller = findMemberByKey(call.relay_sender_key, roster);

  // Rows written before relay_sender_key still carry the counterpart's stored
  // non-phone label. On a two-person group, an unchanged current counterpart
  // name identifies the other current member as the caller. This is a migration
  // fallback only; all new rows use the stable key above.
  if (caller === undefined && roster.length === 2 && call.call_party_label) {
    const oldCounterpart = call.call_party_label.trim().toLocaleLowerCase();
    const matchingCounterparts = roster.filter((member) => {
      const current = memberDisplayLabel(member);
      return current !== undefined && current.toLocaleLowerCase() === oldCounterpart;
    });
    // Duplicate display labels are not identities. Infer only when the legacy
    // label identifies exactly one current counterpart.
    const counterpart = matchingCounterparts.length === 1 ? matchingCounterparts[0] : undefined;
    if (counterpart !== undefined) caller = roster.find((member) => member !== counterpart);
  }

  if (caller === undefined) return undefined;
  const callerLabel = memberDisplayLabel(caller);
  if (callerLabel === undefined) return undefined;
  const recipients = roster
    .filter((member) => member !== caller)
    .map(memberDisplayLabel)
    .filter((label): label is string => label !== undefined);
  if (recipients.length === 0) return undefined;
  return `${callerLabel} called ${joinCallRecipients(recipients)}`;
}

function CallCard({
  call,
  relayRoster,
}: {
  call: TimelineCall;
  relayRoster?: ConversationParticipant[];
}): React.JSX.Element {
  // The card's own clock: seeded once at mount, advanced by EXACTLY one timeout
  // when the presenter says the current label has an expiry.
  const [now, setNow] = useState<number>(() => Date.now());
  const [revealed, setRevealed] = useState(false);
  const outbound = call.direction === 'outbound';
  // The ONE place the snake_case wire vocabulary meets the presenter's camelCase.
  const state = presentCallState({
    direction: call.direction,
    callStatus: call.call_status,
    callOutcome: call.call_outcome,
    relayRefusalReason: call.relay_refusal_reason,
    at: call.at,
    now,
  });
  const staleAt = state.staleAt;

  useEffect(() => {
    // No expiry -> no timer at all. A settled card never schedules anything, and
    // there is no polling interval anywhere in here.
    if (staleAt === undefined) return undefined;
    // The delay is computed from a FRESH read, NEVER from state `now`: state
    // `now` only advances at mount and on its own timeout, so a props-driven
    // re-render in between would otherwise schedule against a stale clock and
    // fire early.
    const fresh = Date.now();
    if (staleAt <= fresh) {
      // Already expired. Advance immediately rather than merely skipping the
      // schedule - skipping would strand the card on the fresh label with no
      // correction path. The re-render takes the stale branch, which returns no
      // staleAt, and this effect settles.
      setNow(fresh);
      return undefined;
    }
    const delay = staleAt - fresh;
    if (delay > MAX_TIMEOUT_MS) return undefined;
    // Math.max, NOT a bare Date.now(): a timeout can fire marginally EARLY (an
    // early-firing timer, or the clock stepping backwards). A bare read would
    // then still be before staleAt, the presenter would return the SAME staleAt,
    // the [staleAt] dependency would not change, this effect would not re-run,
    // and no replacement timer would ever be scheduled - stranding the card on
    // "Ringing..." forever. Advancing to at least the boundary makes the next
    // render take the stale branch. `now` deliberately stays OUT of the
    // dependency list: adding it would reintroduce the reschedule spin the three
    // constraints above exist to make unrepresentable.
    const timer = setTimeout(() => setNow(Math.max(Date.now(), staleAt)), delay);
    return () => clearTimeout(timer);
  }, [staleAt]);

  const time = formatTime(call.at);
  // SECONDS precision for the accessible names ONLY. The visible clock stays at
  // minutes; two calls inside one minute would otherwise carry identical names.
  const nameTime = formatTimeWithSeconds(call.at);
  const directionWord = outbound ? 'Outgoing call' : 'Incoming call';
  const externalCaller = presentRelayExternalCaller(call);
  const relaySummary = relayCallSummary(call, relayRoster);
  const callWho = externalCaller?.summary ?? relaySummary ?? directionWord;
  // An unparseable `at` is a REAL handled case here (the presenter treats it as
  // one and has matrix coverage for it), and the formatter answers '' for it.
  // Concatenating that unconditionally would emit a dangling separator -
  // "Incoming call - " - and two such rows would collide on one name, which is
  // exactly the ambiguity the seconds were added to remove. Fall back to the
  // row id: it is always present, always distinct, and an opaque key rather
  // than anything a screen reader would announce as a phone.
  const cardName = `${callWho} - ${nameTime || call.id}`;
  const duration = formatDuration(call.call_duration);
  const toneClass = state.tone !== undefined ? (CALL_TONE_CLASS[state.tone] ?? '') : '';
  // A MASKED row carries no counterpart identity at all - party_phone is
  // stripped server-side and call_party_label is not on the wire. The time is
  // ALREADY on the card face, so a detail line there would disclose a duplicate
  // of what the reader can already see. `undefined` means no line AND no reveal
  // control: a disclosure that discloses nothing is worse than no disclosure.
  const detail = relayRoster === undefined && call.party_phone
    ? `${outbound ? 'to' : 'from'} ${formatPhone(call.party_phone)} - ${time}`
    : undefined;
  const hasDetails = externalCaller !== undefined || detail !== undefined;

  return (
    <div
      className={`${styles.callcard ?? ''} ${outbound ? styles.itemOut ?? '' : styles.itemIn ?? ''} ${outbound ? styles.callOut ?? '' : ''} ${revealed ? styles.cardRevealed ?? '' : ''}`}
      role="group"
      // The accessible name is the direction word and the time ONLY - NEVER the
      // outcome. The outcome flips with the ringing / in-progress clauses, so a
      // handle built on it would inherit exactly the staleness race this design
      // exists to escape. The outcome stays assertable as the chip's own text.
      // The time is carried to SECONDS so a redial inside the same minute does
      // not produce two cards with one name (and falls back to the row id when
      // the timestamp will not parse - see cardName).
      aria-label={cardName}
    >
      <div className={styles.callSummary}>
        <span className={styles.callArrow} aria-hidden="true">
          {outbound ? ARROW_OUT : ARROW_IN}
        </span>
        <span className={styles.callWho}>{callWho}</span>
        {state.label !== undefined ? (
          <span className={`${styles.outcome ?? ''} ${toneClass}`}>{state.label}</span>
        ) : null}
        {duration ? <span className={styles.callDuration}>{duration}</span> : null}
        <span className={styles.callTrail}>
          <span className={styles.callAt}>{time}</span>
          {hasDetails ? (
            <button
              type="button"
              className={styles.callReveal}
              aria-expanded={revealed}
              // The VISIBLE text stays "Details"; the accessible name identifies
              // which card the control belongs to. A contact with call history
              // otherwise hands a screen-reader user N buttons all named "Details".
              aria-label={`Details for ${cardName}`}
              onClick={() => setRevealed((r) => !r)}
            >
              Details
            </button>
          ) : null}
        </span>
      </div>
      {hasDetails ? (
        <div className={styles.cardMeta}>
          {externalCaller !== undefined ? (
            <>
              <div>{externalCaller.phoneLabel}</div>
              <div>Not a participant in this relay group</div>
              {externalCaller.linkedContactId !== undefined ? (
                <Link to={`/contacts/${encodeURIComponent(externalCaller.linkedContactId)}`}>View contact</Link>
              ) : (
                <div>No linked contact</div>
              )}
              <div>{formatDateTimeWithSeconds(call.at)}</div>
            </>
          ) : (
            detail
          )}
        </div>
      ) : null}
      {/* Playable recording (founder-bridge calls + voicemails). The src uses the
          BARE CallSid (call_sid), NOT `id` (the composite tsMsgId) which would 404
          at GET /api/calls/:callId/recording. Rendered only when both are present. */}
      {relayRoster === undefined && call.recording_s3_key && call.call_sid ? (
        <MonoAudio
          className={styles.recordingPlayer}
          controls
          preload="none"
          src={`/api/calls/${call.call_sid}/recording`}
          aria-label="Call recording"
        />
      ) : null}
      {/* Transcript lifecycle (voice-transcription 3.7): the in-flight indicator
          replaces the collapsible while pending/failed. */}
      {relayRoster === undefined ? (
        call.transcript_status === 'pending' ? (
          <p className={styles.transcriptPendingNote}>Transcribing...</p>
        ) : call.transcript_status === 'failed' ? (
          <p className={styles.transcriptPendingNote}>Transcript unavailable</p>
        ) : call.transcript ? (
          <details className={styles.transcript}>
            <summary className={styles.transcriptToggle}>Transcript</summary>
            <p className={styles.transcriptBody}>{call.transcript}</p>
          </details>
        ) : null
      ) : null}
    </div>
  );
}

/** A collapsed email card (email-channel v1; A6 outbound, B7 inbound). Visually
 *  DISTINCT from an SMS/MMS bubble - the CallCard treatment: an "EMAIL" transport
 *  tag, a semibold subject, a ~140-char snippet, a from/to line (the sender on
 *  inbound), a "New address" chip on a first-seen inbound address, and a delivery
 *  chip on outbound; a "View full email" <details> discloses the full plain-text
 *  body, any Cc, and attachments. Message text always renders as TEXT (React
 *  escapes) - NEVER dangerouslySetInnerHTML. An inbound mail that carries
 *  sanitized HTML also gets a "View original formatting" <details> that LAZILY
 *  mounts the CSP-framed sandboxed EmailHtmlFrame (only once opened). */
const EMAIL_SNIPPET_CHARS = 140;
function EmailCard({ msg }: { msg: TimelineMessage }): React.JSX.Element {
  // Lazy-mount gate for the HTML frame: keep the sandboxed iframe OUT of the DOM
  // (no render, no fetch) until the user opens "View original formatting".
  const [htmlOpen, setHtmlOpen] = useState(false);
  const outbound = msg.direction === 'outbound';
  const delivery = outbound ? presentDeliveryStatus(msg.delivery_status) : null;
  const reason = delivery?.isFailure ? deliveryReason(msg.error_code) : undefined;
  const toneClass = delivery ? (TONE_CLASS[delivery.tone] ?? '') : '';
  const subject = msg.subject && msg.subject.trim().length > 0 ? msg.subject : '(no subject)';
  const bodyText = msg.body ?? '';
  const truncated = bodyText.length > EMAIL_SNIPPET_CHARS;
  const snippet = truncated ? `${bodyText.slice(0, EMAIL_SNIPPET_CHARS).trimEnd()}...` : bodyText;
  const cc = msg.email_cc ?? [];
  const fromTo = [
    msg.email_from ? `from ${msg.email_from}` : null,
    msg.email_to && msg.email_to.length > 0 ? `to ${msg.email_to.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' - ');
  const hasMore = truncated || cc.length > 0 || (msg.media_attachments ?? []).length > 0;

  return (
    <div
      className={`${styles.emailCard ?? ''} ${outbound ? styles.itemOut ?? '' : styles.itemIn ?? ''} ${outbound ? styles.emailOut ?? '' : styles.emailIn ?? ''}`}
    >
      <div className={styles.emailTop}>
        <span className={styles.emailTag}>EMAIL</span>
        <span className={styles.emailSubject}>{subject}</span>
        {msg.email_new_address ? <span className={styles.emailNewAddr}>New address</span> : null}
        <span className={styles.emailTime}>{formatTime(msg.at)}</span>
      </div>
      {fromTo ? <div className={styles.emailAddrLine}>{fromTo}</div> : null}
      {snippet ? <div className={styles.emailSnippet}>{snippet}</div> : null}
      {hasMore ? (
        <details className={styles.emailDetails}>
          <summary className={styles.emailToggle}>View full email</summary>
          {cc.length > 0 ? <div className={styles.emailAddrLine}>cc {cc.join(', ')}</div> : null}
          {bodyText ? <p className={styles.emailBody}>{bodyText}</p> : null}
          <AttachmentGallery msg={msg} />
        </details>
      ) : null}
      {/* B7: sanitized inbound HTML behind its own disclosure. The frame is
       *  mounted LAZILY (only when open) and ONLY when the mail carried HTML -
       *  a fully sandboxed, CSP-locked iframe (EmailHtmlFrame), never
       *  dangerouslySetInnerHTML. Independent of "View full email" so a short
       *  HTML mail (no snippet/cc/attachments) still exposes the frame. */}
      {msg.email_html_sanitized !== undefined ? (
        <details
          className={styles.emailDetails}
          onToggle={(e) => setHtmlOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className={styles.emailToggle}>View original formatting</summary>
          {htmlOpen ? <EmailHtmlFrame html={msg.email_html_sanitized} /> : null}
        </details>
      ) : null}
      {delivery ? (
        <div className={styles.emailFoot}>
          <span
            className={`${styles.status} ${toneClass}`}
            {...(reason !== undefined && { title: reason })}
          >
            {delivery.label}
            {reason !== undefined ? ` - ${reason}` : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function StreamItem({
  item,
  onRetry,
  relayRoster,
  rosterKind,
  tickNow,
}: {
  item: TimelineItem;
  onRetry?: (msg: TimelineMessage) => void;
  relayRoster?: ConversationParticipant[];
  rosterKind?: RosterKind;
  /** The timeline's clock, passed straight through to MessageBubble. Required,
   *  not optional: an undefined clock means "staleness off" downstream, so a
   *  missed prop would silently disable the escalation rather than fail. */
  tickNow: number;
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'message':
      // Email renders a DISTINCT collapsed card (A6); sms/mms stay bubbles.
      return item.type === 'email' ? (
        <EmailCard msg={item} />
      ) : (
        <MessageBubble
          msg={item}
          onRetry={onRetry}
          tickNow={tickNow}
          {...(relayRoster !== undefined && { relayRoster })}
          {...(rosterKind !== undefined && { rosterKind })}
        />
      );
    case 'call':
      return (
        <CallCard call={item} {...(relayRoster !== undefined && { relayRoster })} />
      );
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
    upcomingTimezone,
    source,
    replyToPhone,
    replyToLabel,
    replyTargets,
    selectedConversationId,
    onSelectTarget,
    canSend,
    readOnlyNote,
    paging,
    onSend,
    onRetry,
    optedOut,
    deleted,
    onRestore,
    clearDraftSignal,
    relayRoster,
    rosterKind = 'relay',
    relayClosed,
    relayConnecting,
    resetScrollKey,
    emptyLabel,
  } = props;
  const emailChannel = props.emailChannel;
  const hasEmail = (emailChannel?.emails.length ?? 0) > 0;
  // ONE clock per THREAD, not one per bubble, reaching every bubble by the same
  // prop path rosterKind already uses. INITIALISED AT MOUNT and never undefined:
  // an undefined clock means "staleness off" downstream, so a lazy seed would
  // make the FIRST render of every thread show no escalation at all - and the
  // 2026-08-23 headline case is a founder OPENING a thread whose leg went quiet
  // hours ago. The interval below only ever has to carry a leg ACROSS the
  // boundary while the thread stays open.
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  const [channel, setChannel] = useState<'text' | 'email'>('text');
  // The [Text | Email] toggle exists ONLY on a 1:1 contact page (emailChannel
  // present) and NEVER on a relay/group thread. With no address on file the Email
  // segment is disabled, so the effective channel stays 'text' until one exists.
  const showChannelToggle = emailChannel !== undefined && relayRoster === undefined;
  const effectiveChannel: 'text' | 'email' = showChannelToggle && hasEmail ? channel : 'text';
  // "Comms only" is a CONTROLLED/UNCONTROLLED pair. With BOTH props the caller
  // owns the value (it lives above the pane's remount boundary on tour/placement
  // pages, so a tab switch can't reset the filter) and the buttons only report.
  // With neither, this is exactly the old per-mount internal state.
  const [ownCommsOnly, setOwnCommsOnly] = useState(false);
  const commsOnlyControlled = props.commsOnly !== undefined && props.onCommsOnlyChange !== undefined;
  const commsOnly = commsOnlyControlled ? props.commsOnly === true : ownCommsOnly;
  const setCommsOnly = (v: boolean): void => {
    if (commsOnlyControlled) props.onCommsOnlyChange?.(v);
    else setOwnCommsOnly(v);
  };
  const [draft, setDraft] = useState(props.initialDraft ?? '');
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

  // Seed announcement: if we mounted with a non-empty initialDraft, tell the
  // parent once so it can clear its seed (a later remount must start empty).
  // Mount-only (empty deps): initialDraft is read by the draft useState above; we
  // never re-seed on prop changes, so changing initialDraft after mount is inert.
  useEffect(() => {
    if (props.initialDraft !== undefined && props.initialDraft.length > 0) {
      props.onDraftSeeded?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Upload ONE picked file, reconciling its chip by localId as it completes.
  // Direct-to-S3 flow (spec Sec 4): presign mints a grant, the browser POSTs the
  // bytes straight to S3 (never through the app), then confirm validates or
  // transcodes the original into a deliverable rendition. The chip stays
  // 'uploading' through confirm (a transcode takes a beat).
  const uploadOne = async (localId: string, file: File): Promise<void> => {
    try {
      const { key, post } = await presignMmsMedia(file.type);
      await uploadToPresignedPost(post, file);
      const att = await confirmMmsMedia(key);
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? {
                ...a,
                status: 'done',
                key: att.s3Key,
                contentType: att.contentType,
                size: att.size,
                ...(att.originalKey !== undefined && { originalKey: att.originalKey }),
                ...(att.pdfPageCount !== undefined && { pdfPageCount: att.pdfPageCount }),
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
  // a still-uploading attachment is never silently dropped from the message. The
  // rendition keys go as attachmentKeys; the index-aligned originals (falling back
  // to the rendition key on flow-through) go as attachmentOriginalKeys.
  const doneAttachments = attachments.filter((a) => a.status === 'done' && a.key !== undefined);
  const uploadedKeys = doneAttachments.map((a) => a.key as string);
  const uploadedOriginalKeys = doneAttachments.map((a) => a.originalKey ?? (a.key as string));
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

  // THE STALENESS TICKER (spec S7 / plan D-c). ONE interval per THREAD, not one
  // per bubble, bumping the `tickNow` every MessageBubble already reads.
  //
  // ARMED ONLY while some RENDERED leg can still cross the 15-minute boundary -
  // see `hasTickableLeg` for the four non-terminations that predicate closes.
  // `visible` (not `items`) is what the stream actually renders, and `tickNow` is
  // in the deps precisely so that the moment the last eligible leg goes stale the
  // condition flips false, the effect cleans up, and the interval STOPS. That
  // flip IS the termination proof.
  // THE ARMING CLOCK MUST NEVER BE OLDER THAN THE ITEM SET IT JUDGES.
  // `tickNow` is not only the re-render trigger; it is also the clock every
  // staleness decision is measured against, and its only other writer lives
  // INSIDE the interval below. So once the ticker disarms, nothing refreshes it,
  // and a leg arriving later is judged against a frozen clock - which
  // `canEverGoStale`'s futurity bound reads as a budget INTO THE FUTURE and
  // refuses to arm for. The two reinforce each other: frozen clock -> nothing
  // eligible -> no interval -> the clock stays frozen, for the lifetime of the
  // mount and across thread switches, because this component is not keyed by
  // conversation. The reachable case is the ordinary one - open a thread where
  // everything has delivered (so the ticker never arms and the clock is pinned
  // at mount), leave it open, then send.
  //
  // Refreshing on the RENDERED SET closes that deadlock: after any commit where
  // the rendered set changed, this clock is at most one tick period old, which
  // is far inside the futurity bound's budget, so the two can no longer
  // reinforce each other. A leg that could cross the boundary is also exactly
  // what keeps the ticker armed, so while it is disarmed an ARRIVING item is
  // normally the only thing that can change the answer.
  //
  // ONE EXCEPTION, and it is deliberate - do NOT read this as a reason to delete
  // the futurity bound. A leg whose clock sits MORE than one budget in the
  // future (a badly skewed browser clock) is ineligible now and would become
  // eligible as real time passes, with no item arriving to re-evaluate it. That
  // is the disclosed LATE-becomes-NEVER trade `canEverGoStale` already documents,
  // not a new hole: the bound is what keeps ordinary skew escalating late
  // instead of never, and removing it costs far more than it buys.
  //
  // The functional update returning `prev` unchanged is load-bearing, not
  // defensive: a parent that hands us a fresh `items` array on every render
  // would otherwise bump -> re-render -> bump for ever. Bailing out under one
  // tick period makes that loop impossible while still bounding the clock's
  // staleness to a single period.
  useEffect(() => {
    setTickNow((prev) => {
      const now = Date.now();
      return now - prev >= STALE_TICK_MS ? now : prev;
    });
  }, [visible]);
  const tickerArmed = useMemo(
    () => visible.some((i) => i.kind === 'message' && hasTickableLeg(i, tickNow)),
    [visible, tickNow],
  );
  useEffect(() => {
    if (!tickerArmed) return undefined;
    const bump = (): void => {
      setTickNow(Date.now());
    };
    // VISIBILITY-GATED, matching GroupTextView.tsx's member poll: re-rendering a
    // hidden tab only updates pixels nobody is looking at, and thread paging
    // means the re-rendered timeline grows without bound as staff load older
    // pages. The focus listener is what makes coming back to the tab immediate,
    // so the interval only has to cover the tab already in front of them. It
    // fetches NOTHING - the whole cost is one React render.
    const onFocus = (): void => {
      bump();
    };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') bump();
    }, STALE_TICK_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [tickerArmed]);

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
  //
  // The Upcoming block is the LAST child of this scroller, so "the bottom" and
  // "the newest message" are no longer the same place. A zero-height SENTINEL
  // sits between the last cluster and the block, and everything below is
  // expressed against it: see streamAnchor.ts for the three-value model and why
  // one boolean could not survive the move.
  const streamRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const upcomingRef = useRef<HTMLElement>(null);
  const anchorRef = useRef<StreamAnchor>('sentinel'); // default -> open on the newest message
  // Distance from the scroller's TRUE bottom at the last observed scroll. Only
  // the `below` branch reads it: an operator standing on the block keeps this
  // constant across a growth, so the block does not slide under their eye.
  const bottomGapRef = useRef(0);
  const prevCountRef = useRef(0); // item count at the last layout pass
  const prevKeyRef = useRef(resetScrollKey); // conversation identity last seen
  // Whether the block was mounted at the last layout pass. Its appearance and
  // its disappearance both invalidate the cached anchor - see the layout effect.
  // Seeded with the MOUNT value so the first pass, which opens the thread on the
  // newest message, is never treated as a change.
  const prevHasBlockRef = useRef(upcoming !== undefined && upcoming.length > 0);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  // The block's own height changes without any item-count change (a body
  // wrapping to a second line), and the anchor depends on it. A ResizeObserver
  // ticks this, and the tick is a dep of the layout effect below.
  const [blockResizeTick, setBlockResizeTick] = useState(0);
  const hasUpcomingBlock = upcoming !== undefined && upcoming.length > 0;

  // useCallback so the layout effect can list it as a dep without re-running
  // every render: its identity changes exactly when `hasUpcomingBlock` does,
  // which is already a dep of that effect - no behavior change, just an honest
  // dependency list.
  const currentAnchor = useCallback(
    (el: HTMLElement): StreamAnchor => {
      const sentinel = sentinelRef.current;
      if (!sentinel) return 'sentinel';
      return deriveStreamAnchor({
        sentinelBottom: sentinel.getBoundingClientRect().bottom,
        viewportBottom: el.getBoundingClientRect().bottom,
        hasBlock: hasUpcomingBlock,
      });
    },
    [hasUpcomingBlock],
  );

  // Bring the sentinel's bottom edge to the scroller's bottom edge - i.e. land
  // on the newest MESSAGE, with the Upcoming block just below the fold.
  //
  // Deliberately a rect DELTA, not `sentinel.offsetTop + offsetHeight -
  // clientHeight`: `.stream` is not positioned, so the sentinel's offsetParent
  // is `.streamWrap`, and offsetTop therefore carries the "Load older messages"
  // row's height as a silent constant error that appears and disappears with
  // that control. The delta form reads the SAME two numbers the anchor is
  // derived from, so the write and the derivation cannot disagree.
  //
  // Never `scrollIntoView` - it scrolls every scrollable ANCESTOR too, which
  // moves the page shell out from under the operator.
  const scrollToSentinel = (el: HTMLElement): void => {
    const sentinel = sentinelRef.current;
    if (!sentinel) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop += sentinel.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
    }
    bottomGapRef.current = el.scrollHeight - el.scrollTop;
  };

  const scrollToBottom = (): void => {
    const el = streamRef.current;
    if (!el) return;
    scrollToSentinel(el);
    anchorRef.current = 'sentinel';
    setHasNewBelow(false);
  };

  const handleStreamScroll = (): void => {
    const el = streamRef.current;
    if (!el) return;
    anchorRef.current = currentAnchor(el);
    bottomGapRef.current = el.scrollHeight - el.scrollTop;
    // Caught up (on the newest message, or down on the block) clears the pill.
    if (anchorRef.current !== null && hasNewBelow) setHasNewBelow(false);
  };

  // Observe the BLOCK only. Keyed on the boolean, never on `upcoming` itself:
  // GroupTextView passes a fresh `[]` literal every render, so the array's
  // identity would re-subscribe on every pass.
  useEffect(() => {
    const node = upcomingRef.current;
    // jsdom has no ResizeObserver (and neither does a very old engine).
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      setBlockResizeTick((n) => n + 1);
    });
    ro.observe(node);
    return () => {
      ro.disconnect();
    };
  }, [hasUpcomingBlock]);

  // [R1] Armed immediately BEFORE an older page is requested, and consumed only
  // when the HOOK reports a merged older page (olderPagesLoaded changed). The
  // signal has to come from the hook: an SSE append grows the list without a
  // prepend, and the "Comms only" toggle changes the first RENDERED item without
  // one, so neither the item count nor the first item id can stand in for it.
  const prependAnchorRef = useRef<number | null>(null);
  const seenOlderPagesRef = useRef(paging?.olderPagesLoaded ?? 0);

  const handleLoadOlder = (): void => {
    const el = streamRef.current;
    // With no scroll container there is nothing to anchor TO. Arming with 0
    // would later scroll by the entire content height.
    prependAnchorRef.current = el ? el.scrollHeight : null;
    void paging?.onLoadOlder();
  };

  // After the rendered stream changes, decide what to do with the scroll: pin to
  // the bottom if the operator was there, flag "new below" if a new item landed
  // while they were scrolled up, or — when the conversation itself changed — treat
  // it as a fresh timeline and jump to the newest. useLayoutEffect runs before
  // paint, so any jump is invisible (no flash of the pre-scroll position).
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    // THE BLOCK VANISHED under the operator (review round m2). Both the cached
    // anchor and `bottomGapRef` were derived with the block PRESENT, and a
    // reschedule/terminal/convert emptying the bucket is this feature's
    // commonest event. A stale `below` then restores a gap the content no
    // longer warrants: the next growth scrolls the operator UP, away from the
    // newest message, and clears the pill on the same line - the one situation
    // the pill exists for. Re-derive from the DOM, which has already committed
    // the unmount. Keyed on the BOOLEAN, never on the `upcoming` array:
    // GroupTextView passes a fresh `[]` literal every render.
    //
    // ONE DIRECTION ONLY. The MOUNT flip must NOT re-derive: the block appears
    // BELOW the sentinel, so it adds content beneath the fold and cannot
    // invalidate a `sentinel` or `null` anchor - while the geometry it would be
    // read against may be a scrollTop no pin has run on yet. TourConversation
    // delivers the messages and the block in one commit, and re-deriving there
    // read scrollTop 0, answered `null`, and let the same pass take the `grew`
    // branch: the thread opened scrolled to the top with a "New messages" pill
    // (live QA, lane 1). Unmount is the only flip that invalidates anything.
    if (prevHasBlockRef.current !== hasUpcomingBlock) {
      const vanished = prevHasBlockRef.current;
      prevHasBlockRef.current = hasUpcomingBlock;
      if (vanished) {
        anchorRef.current = currentAnchor(el);
        bottomGapRef.current = el.scrollHeight - el.scrollTop;
      }
    }
    const count = clusters.reduce((n, c) => n + c.items.length, 0);
    const merged = paging?.olderPagesLoaded ?? 0;
    const prepended = merged !== seenOlderPagesRef.current;
    seenOlderPagesRef.current = merged;
    if (prevKeyRef.current !== resetScrollKey) {
      // Switched conversations -> open on the newest MESSAGE, no carried-over
      // pill. Targeting `scrollHeight` here would open every thread that has a
      // ladder scrolled onto the Upcoming block instead.
      prevKeyRef.current = resetScrollKey;
      prevCountRef.current = count;
      anchorRef.current = 'sentinel';
      prependAnchorRef.current = null;
      scrollToSentinel(el);
      setHasNewBelow(false);
      return;
    }
    const anchor = prependAnchorRef.current;
    if (anchor !== null && prepended) {
      // The prepend landed: restore the offset so the bubble the operator was
      // reading does not move, and never treat it as "new below".
      prependAnchorRef.current = null;
      prevCountRef.current = count;
      el.scrollTop += el.scrollHeight - anchor;
      return;
    }
    const grew = count > prevCountRef.current;
    prevCountRef.current = count;
    if (anchor !== null) {
      // Something ELSE changed the height while the older page is in flight - an
      // append, a filter toggle, a retry collapse. Re-baseline so the eventual
      // restore delta counts only the prepended content.
      prependAnchorRef.current = el.scrollHeight;
    }
    if (anchorRef.current === 'sentinel') {
      // On the newest message: bring the sentinel back to the fold.
      scrollToSentinel(el);
      setHasNewBelow(false);
    } else if (anchorRef.current === 'below') {
      // Down on the Upcoming block, deliberately. Everything new lands ABOVE
      // the block, so holding the distance to the scroller's true bottom holds
      // the block still on screen. No pill: nothing is hidden from them.
      el.scrollTop = el.scrollHeight - bottomGapRef.current;
      setHasNewBelow(false);
    } else if (grew) {
      setHasNewBelow(true);
    }
    // `paging?.olderPagesLoaded` MUST stay in the deps: the merge and the counter
    // bump land in the same commit, but a render where ONLY the counter changed
    // must still be able to consume the anchor.
    //
    // `blockResizeTick` is here rather than in an effect of its own: the
    // prepend-anchor re-baseline above and the pill decision below both live in
    // THIS pass, and a standalone re-pin effect would bypass them.
    //
    // `hasUpcomingBlock` is here so the UNMOUNT gets a pass at all: the observer
    // effect only disconnects, nothing ticks `blockResizeTick`, and an item-count
    // change is not required for the block to vanish.
  }, [clusters, resetScrollKey, paging?.olderPagesLoaded, blockResizeTick, hasUpcomingBlock, currentAnchor]);

  // Clear a stale anchor once the load settles. Runs after paint, so the layout
  // effect above has already had its chance to consume it.
  //
  // What it actually covers: an older page that settles having MERGED NOTHING -
  // the hook leaves `olderPagesLoaded` untouched for a page that returned no rows
  // or whose rows all mapped away, so no prepend is ever signalled and the armed
  // anchor would otherwise survive to be consumed by an unrelated later render,
  // jumping the reader by the height of whatever changed then.
  //
  // It does NOT cover "the page merged but every entry is hidden by 'Comms only'
  // / retry-collapse", which an earlier version of this comment claimed. That
  // case reaches the layout effect and is consumed there at delta 0, by two
  // independent routes: `visible` is `items.filter(...)` memoized on
  // `[items, commsOnly]`, so a merge always produces a new `visible` - and
  // therefore a new `clusters` - identity even when the rendered contents are
  // identical; and `paging?.olderPagesLoaded` is in the layout effect's dep array
  // regardless. Either alone schedules the effect. Both reviewers demonstrated
  // this by experiment; the old wording would have justified deleting that dep.
  useEffect(() => {
    if (paging?.loadingOlder !== true) prependAnchorRef.current = null;
  }, [paging?.loadingOlder]);

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
    // The operator just sent - pin to the newest message so their own message is
    // in view even if they'd scrolled up while composing. The next layout pass
    // does the scrolling; this only says where to land.
    anchorRef.current = 'sentinel';
    try {
      // Pass attachmentKeys only when present, so a text-only send stays a plain
      // onSend(body) call (unchanged contract for the no-attachment path).
      if (keys.length > 0) await onSend?.(text, keys, uploadedOriginalKeys);
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
        {/* [R2] OUTSIDE the scroll container, deliberately. Inside, it would
            contribute to el.scrollHeight and then unmount in the same commit as
            the final prepend (the pass where hasOlder flips false), so the
            restored offset would under-shoot by the control's own height on the
            LAST "Load older" of every thread. */}
        {status === 'ready' && paging?.hasOlder === true ? (
          <div className={styles.loadOlderRow}>
            <button
              type="button"
              className={styles.loadOlder}
              onClick={handleLoadOlder}
              disabled={paging.loadingOlder}
            >
              {paging.loadingOlder ? 'Loading...' : 'Load older messages'}
            </button>
          </div>
        ) : null}
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
                    tickNow={tickNow}
                    {...(relayRoster !== undefined && { relayRoster })}
                    rosterKind={rosterKind}
                  />
                ))}
              </div>
            ))
          : null}

        {/* The scroll anchor: a zero-height boundary between the message stream
            and the Upcoming block. Every pin targets THIS, so "the bottom" stays
            the newest MESSAGE even with a block rendered below it. */}
        <div ref={sentinelRef} data-testid="stream-sentinel" aria-hidden="true" />

        {/* Inside the scroller, as its LAST child: the block scrolls away with
            the history instead of holding a fixed slice of a phone-sized pane.
            Keep the section/heading/list nesting exactly as it is - four e2e
            sites resolve this region by role+name and then walk
            `> div > div` to the cards, so a wrapper here breaks all four. */}
        {upcoming && upcoming.length > 0 ? (
          <section
            ref={upcomingRef}
            className={styles.upcoming}
            aria-label="Upcoming scheduled messages"
          >
            <header className={styles.upcomingHead}>Upcoming ({upcoming.length})</header>
            <div className={styles.upcomingList}>
              {upcoming.map((sched) => (
                <ScheduledCard key={sched.id} item={sched} timezone={upcomingTimezone} />
              ))}
            </div>
          </section>
        ) : null}
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

      <div className={styles.reply}>
        {/* Soft-deleted contact (deleted-contact resurfacing, 2026-08-03): the WHOLE
            composer is replaced - channel toggle, EmailComposer and the text composer
            alike - so there is no way to reply without restoring first. The server
            refuses too (409 contact_deleted). */}
        {deleted ? (
          <>
            <p className={styles.optOutNote} role="note">
              🗑 This contact is deleted — restore them to reply.
            </p>
            {/* Only render the CTA when a handler exists — a caller may pass
                `deleted` without `onRestore` (read-only surface), and a button
                that silently does nothing is worse than no button. */}
            {onRestore !== undefined ? (
              <button type="button" className={styles.restoreBtn} onClick={onRestore}>
                Restore contact
              </button>
            ) : null}
          </>
        ) : readOnlyNote !== undefined ? (
          /* READ-ONLY thread: the composer is replaced by a plain reason, never
             rendered-but-disabled. A text box you can type into and never send
             from is a trap - the operator writes a reply, hits a dead Send, and
             loses the draft. Used by the native group-text view (no group send
             until it exists; a >9-member group can never have one). */
          <p className={styles.optOutNote} role="note">
            {readOnlyNote}
          </p>
        ) : (
          <>
            {showChannelToggle ? (
              <div className={styles.channelSeg} role="group" aria-label="Message channel">
                <button
                  type="button"
                  className={`${styles.channelBtn} ${effectiveChannel === 'text' ? styles.channelOn ?? '' : ''}`}
                  aria-pressed={effectiveChannel === 'text'}
                  onClick={() => setChannel('text')}
                >
                  Text
                </button>
                <button
                  type="button"
                  className={`${styles.channelBtn} ${effectiveChannel === 'email' ? styles.channelOn ?? '' : ''}`}
                  aria-pressed={hasEmail ? effectiveChannel === 'email' : undefined}
                  {...(hasEmail
                    ? {}
                    : { 'aria-disabled': true, title: 'No email on file - add one' })}
                  onClick={() => {
                    if (hasEmail) setChannel('email');
                    else emailChannel?.onManageEmails();
                  }}
                >
                  Email
                </button>
                {!hasEmail ? (
                  <button
                    type="button"
                    className={styles.channelAdd}
                    onClick={() => emailChannel?.onManageEmails()}
                  >
                    Add email
                  </button>
                ) : null}
              </div>
            ) : null}
            {emailChannel !== undefined && effectiveChannel === 'email' ? (
              <EmailComposer
                emails={emailChannel.emails}
                onSend={emailChannel.onSendEmail}
                {...(emailChannel.suppressed !== undefined && { suppressed: emailChannel.suppressed })}
              />
            ) : (
              <>
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
            {relayConnecting ? (
              <p className={styles.optOutNote} role="note">
                Queued - messages will send when the group connects.
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
                        {isPdfMediaType(a.contentType) ? 'PDF' : 'FILE'}
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
                    {a.status === 'done' && (a.pdfPageCount ?? 0) > 1 ? (
                      <span className={styles.chipMeta}>
                        PDF - only the first page will be sent as an image.
                      </span>
                    ) : null}
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
              {/* Outbound group MEDIA is not supported in v1 (spec 6.2) and the
                  server refuses it, so a group text offers no picker at all
                  rather than uploading a file and then rejecting it. */}
              {rosterKind === 'group_text' ? null : (
                <>
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
                </>
              )}
              <span className={styles.replyTarget}>
                {relayRoster !== undefined ? (
                  // A relay GROUP: a reply fans out to every member, so naming a
                  // single contact/number here would be wrong (and was: the shared
                  // "this contact" fallback). Say who it actually reaches.
                  <GroupReplyNote roster={relayRoster} kind={rosterKind} />
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
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
