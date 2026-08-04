// ContactCommsPane - everything between "I have a contact + a timeline state"
// and "a working comms pane": the Timeline mount plus the machinery behind it
// (reply-target resolution, optimistic SMS/MMS send with create-on-demand, email
// compose + send with its thread fallbacks, retry, the just-in-time consent gate,
// the composer-triggered "Manage email" dialog, and the deleted-contact lock).
//
// Extracted VERBATIM from ContactDetail (2026-08-03) so the tour and placement
// pages' 1:1 tabs can be the SAME person-centric pane instead of a
// single-conversation relay transcript that drops emails and calls.
//
// The CALLER owns useContactTimeline and passes the state in: the contact page
// also derives its "Media from comms" gallery from those items and refetches
// after on-page mutations, and the tour/placement wrapper must run the hook only
// once its contact is loaded (never with an empty contactId).
import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  ensureContactConversation,
  ensureEmailConversation,
  retryMessage,
  sendEmail,
  sendMessage,
  type Contact,
  type TimelineMessage,
} from '../../api/index.js';
import { Timeline } from './Timeline.js';
import { EmailManager } from './EmailManager.js';
import { ConsentCaptureModal } from './ConsentCaptureModal.js';
import { contactEmails } from './contactEmails.js';
import type { EmailComposerSendInput } from './EmailComposer.js';
import { contactDisplayName } from './format.js';
import { contactPhones, defaultPhone, defaultPhoneLabel } from './contactPhones.js';
import { buildReplyTargets } from './replyTargets.js';
import { messageSid } from './media.js';
import type { ContactTimelineState } from './useContactTimeline.js';

export interface ContactCommsPaneProps {
  /** The contact this pane talks to. NEVER null - callers gate on a loaded
   *  contact (the tour/placement wrapper renders an empty state until then). */
  contact: Contact;
  /** The CALLER-owned useContactTimeline state (see the file header). */
  timeline: ContactTimelineState;
  /** Seed the composer on mount (the tour page's "Send no-show check-in"). */
  initialDraft?: string;
  /** Fired once when initialDraft seeded, so the caller can clear its seed. */
  onDraftSeeded?: () => void;
  /** Override the ready-but-empty stream copy ("No messages with <name> yet"). */
  emptyLabel?: string;
  /** Stable id for the stream this pane shows - a change means FRESH timeline. */
  resetScrollKey: string;
  /** A contact mutation the PANE made (consent recorded, addresses managed)
   *  handed back so a caller holding page-level contact state can apply it.
   *  Tour/placement pages omit it - the pane's local override is enough there. */
  onContactUpdated?: (updated: Contact) => void;
  /** Restore a soft-deleted contact (the locked composer's note button). Only
   *  the contact page passes it; tour/placement tabs render the note WITHOUT a
   *  button (a button that silently does nothing is worse than no button). */
  onRestore?: () => void;
  /** "Comms only" filter, CONTROLLED by the caller (tour/placement pages hold it
   *  above this pane's remount boundary). Omit both on the contact page. */
  commsOnly?: boolean;
  onCommsOnlyChange?: (v: boolean) => void;
}

export function ContactCommsPane(props: ContactCommsPaneProps): React.JSX.Element {
  const {
    contact,
    timeline,
    initialDraft,
    onDraftSeeded,
    emptyLabel,
    resetScrollKey,
    onContactUpdated,
    onRestore,
    commsOnly,
    onCommsOnlyChange,
  } = props;
  // The "Manage email" dialog (email-channel v1, A6). Opened from the composer's
  // channel toggle when the contact has no address.
  const [managingEmails, setManagingEmails] = useState(false);
  // Which number's thread the reply box sends into (null = use the default). Set
  // by the reply-target picker for multi-number contacts.
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  // Just-in-time consent gate (§3.4): when a proactive send is refused with a 409
  // `contact_no_consent`, we hold the pending send here + open the hard-block
  // modal. On confirm we PATCH consent then RETRY this exact send.
  const [pendingConsentSend, setPendingConsentSend] = useState<
    {
      conversationId: string;
      body: string;
      replyToPhone?: string;
      attachmentKeys?: string[];
      attachmentOriginalKeys?: string[];
    } | null
  >(null);
  // Bumped by deferredSend when an out-of-band send (the post-consent retry) lands,
  // so the Timeline composer clears the draft it restored on the 409 refusal.
  const [clearDraftSignal, setClearDraftSignal] = useState(0);
  // The pane's OWN view of the contact: the consent modal and the EmailManager
  // both return an updated Contact and the pane must read as updated immediately,
  // even on a caller that holds no contact state (tour/placement pages).
  const [override, setOverride] = useState<Contact | null>(null);
  // ...but the override must never SHADOW a fresher contact from the caller: it
  // carries sms_opt_out and deleted_at, which gate sending. Any new contact
  // identity from the caller wins (on the contact page every override is mirrored
  // up via onContactUpdated first, so nothing is lost).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOverride(null);
  }, [contact]);
  const effectiveContact = override ?? contact;

  const phones = contactPhones(effectiveContact);
  const target = defaultPhone(phones);
  const name = contactDisplayName(
    effectiveContact.firstName,
    effectiveContact.lastName,
    target?.phone,
  );

  // The conversation an email sends into: an existing email thread if any (else
  // onSendEmail falls back to the default phone thread / creates the 1:1). A hook,
  // so it MUST run before any early return (stable hook order).
  const existingEmailConvId = useMemo(() => {
    for (const it of timeline.items) {
      if (it.kind === 'message' && it.type === 'email') return it.conversationId;
    }
    return null;
  }, [timeline.items]);

  // Resolve which thread the reply sends into. Each of the contact's numbers is
  // its own 1:1 conversation; the picker lets the navigator choose, defaulting to
  // the primary number's thread. With a single conversation there's nothing to
  // pick (the picker hides).
  const { targets: replyTargets, defaultConversationId } = buildReplyTargets(timeline.items, phones);
  const sendConvId = selectedConvId ?? defaultConversationId;
  // Sendable when a thread already resolves OR the contact has a number to start
  // one with — a BRAND-NEW contact has no conversation yet, so the first send
  // creates it (ensureContactConversation in onSend) instead of graying out.
  // Soft-deleted contact: the composer is locked (restore to reply). canSend
  // gates the Send affordances; the server also refuses with 409
  // contact_deleted (belt and braces).
  const deleted =
    typeof effectiveContact.deleted_at === 'string' && effectiveContact.deleted_at.length > 0;
  const canSend = (sendConvId !== null || target !== undefined) && !deleted;
  // Do-Not-Contact (sms_opt_out): a standing note at the composer on EVERY
  // surface this pane renders on (the send is refused server-side too).
  const optedOut = effectiveContact.sms_opt_out === true;
  // Email channel (A6): the contact's addresses + which conversation an email
  // sends into. Prefer an existing email thread; else the default (phone) thread;
  // else onSendEmail creates/gets the 1:1. The A5 route attaches the email claim
  // to whichever conversation it POSTs to (or redirects to the already-claimed one).
  const emails = contactEmails(effectiveContact);
  const emailSuppressed =
    effectiveContact.email_opt_out === true || effectiveContact.email_unreachable === true;
  // The number shown in the reply box = the selected target's number (else the
  // default reply target).
  const replyToPhone =
    replyTargets.find((t) => t.conversationId === sendConvId)?.phone ?? target?.phone;
  // Optimistic send: show the outbound bubble ("Sending…") IMMEDIATELY, then POST.
  // On success, stamp the real tsMsgId + status so the SSE refetch reconciles by
  // id and the bubble advances Sending… → Sent → Delivered. On failure, drop the
  // optimistic bubble and rethrow so the Timeline restores the draft + shows why.
  // The core optimistic POST into a specific conversation. Shared by the reply
  // box's onSend AND the just-in-time consent retry (after consent is recorded).
  const postSend = (
    conversationId: string,
    body: string,
    toPhone?: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ): Promise<void> => {
    const tempId = timeline.addOptimistic(conversationId, body, {
      ...(toPhone !== undefined && { toPhone }),
      ...(attachmentKeys !== undefined && { attachmentKeys }),
    });
    return sendMessage(conversationId, {
      body,
      ...(attachmentKeys !== undefined && attachmentKeys.length > 0 && { attachmentKeys }),
      ...(attachmentOriginalKeys !== undefined &&
        attachmentOriginalKeys.length > 0 && { attachmentOriginalKeys }),
    })
      .then((result) => {
        timeline.resolveOptimistic(tempId, result);
      })
      .catch((err: unknown) => {
        timeline.failOptimistic(tempId);
        throw err;
      });
  };
  // A DEFERRED send — one that runs OUTSIDE the composer's own optimistic-send flow.
  // Today that's the just-in-time consent retry (after the user records consent in the
  // modal), but ANY out-of-band/retry send should route through here. The composer
  // RESTORED its draft when the original send was refused (409), so on success we clear
  // it — matching what a normal send does. A rejected send propagates (caller decides);
  // the draft is left intact so the message isn't lost.
  //   NB: the NORMAL path (onSend, via the composer's handleSend) clears the draft
  //   SYNCHRONOUSLY before its POST and must NOT go through here — re-clearing after the
  //   POST resolves would wipe a message typed while it was in flight.
  const deferredSend = (
    conversationId: string,
    body: string,
    toPhone?: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ): Promise<void> =>
    postSend(conversationId, body, toPhone, attachmentKeys, attachmentOriginalKeys).then(() => {
      setClearDraftSignal((n) => n + 1);
    });
  const onSend = async (
    body: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ): Promise<void> => {
    // No thread yet (a brand-new contact who has never messaged us): create-or-get
    // the primary number's 1:1 conversation first, THEN send into it. Idempotent —
    // a racing inbound resolves to the same thread. An ensure failure throws before
    // any optimistic bubble, so the Timeline just restores the draft + shows why.
    let resolvedId = sendConvId;
    if (resolvedId === null) {
      if (target === undefined) return; // no number to start a thread with
      resolvedId = await ensureContactConversation(effectiveContact.contactId);
    }
    const convId = resolvedId;
    const toPhone = replyToPhone;
    return postSend(convId, body, toPhone, attachmentKeys, attachmentOriginalKeys).catch((err: unknown) => {
      // A2P/CTIA just-in-time gate: a proactive send to a no-consent contact is
      // refused with 409 `contact_no_consent`. Open the hard-block consent modal
      // (holding the pending send) instead of surfacing a generic error, and
      // rethrow so the Timeline restores the draft (the message stays in the box
      // for the retry / Cancel).
      if (err instanceof ApiError && err.status === 409 && err.code === 'contact_no_consent') {
        setPendingConsentSend({
          conversationId: convId,
          body,
          ...(toPhone !== undefined && { replyToPhone: toPhone }),
          ...(attachmentKeys !== undefined && attachmentKeys.length > 0 && { attachmentKeys }),
          ...(attachmentOriginalKeys !== undefined &&
            attachmentOriginalKeys.length > 0 && { attachmentOriginalKeys }),
        });
      }
      throw err;
    });
  };
  // Compose + send an email (A6). Resolve a conversation to POST into (an existing
  // email thread -> the default phone thread -> create/get the 1:1), show the
  // optimistic "Sending..." EmailCard immediately, then POST. On success stamp the
  // real id/status (the SSE refetch reconciles by tsMsgId - even if the send
  // `redirected` into another conversation, the contact timeline gathers all the
  // contact's threads). On any refusal, drop the optimistic card and rethrow so the
  // EmailComposer surfaces the reason.
  const onSendEmail = async (input: EmailComposerSendInput): Promise<void> => {
    let convId = existingEmailConvId ?? sendConvId;
    if (convId === null) {
      // A phoneless (email-only) contact has no phone thread to fall back to, and
      // the phone ensure route 400s (contact_has_no_phone) for them - use the
      // email-conversation route instead. Also fall through to it if the phone
      // ensure fails that way (defensive), so the composer never dead-ends.
      if (phones.length === 0) {
        convId = await ensureEmailConversation(effectiveContact.contactId);
      } else {
        try {
          convId = await ensureContactConversation(effectiveContact.contactId);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'contact_has_no_phone') {
            convId = await ensureEmailConversation(effectiveContact.contactId);
          } else {
            throw err;
          }
        }
      }
    }
    const cId = convId;
    const tempId = timeline.addOptimistic(cId, input.body, {
      type: 'email',
      subject: input.subject,
      email_to: [input.to],
      ...(input.cc.length > 0 && { email_cc: input.cc }),
    });
    return sendEmail(cId, {
      to: input.to,
      ...(input.cc.length > 0 && { cc: input.cc }),
      subject: input.subject,
      body: input.body,
      ...(input.attachments.length > 0 && { attachments: input.attachments }),
    })
      .then((result) => {
        timeline.resolveOptimistic(tempId, result);
      })
      .catch((err: unknown) => {
        timeline.failOptimistic(tempId);
        throw err;
      });
  };

  // Retry a failed outbound message. The server re-reads the original by its
  // provider SID (so body AND media resend correctly) and stamps `retry_of`, so
  // the SSE message.persisted refetch brings back BOTH the resent message and the
  // lineage that hides the stale failed bubble. The provider SID is the suffix of
  // tsMsgId (`<provider_ts>#<sid>`); without it there's nothing to retry.
  // Returns the promise so the Timeline can surface a refusal (429
  // rate_limited — the retry shares the manual-send budget — opt-out, …) in
  // its composer error slot rather than swallowing it.
  const onRetry = async (msg: TimelineMessage): Promise<void> => {
    const sid = messageSid(msg);
    if (sid.length === 0) return;
    await retryMessage(msg.conversationId, sid);
  };

  // A contact mutation the pane made: apply it locally (so this pane re-derives
  // instantly on any caller) AND hand it up for a caller with page-level state.
  const applyContact = (updated: Contact): void => {
    setOverride(updated);
    onContactUpdated?.(updated);
  };

  return (
    <>
      <Timeline
        status={timeline.status}
        items={timeline.items}
        upcoming={timeline.upcoming}
        source={timeline.source}
        {...(replyToPhone !== undefined && { replyToPhone })}
        replyToLabel={defaultPhoneLabel(phones)}
        replyTargets={replyTargets}
        {...(sendConvId !== null && { selectedConversationId: sendConvId })}
        onSelectTarget={setSelectedConvId}
        canSend={canSend}
        onSend={onSend}
        onRetry={onRetry}
        optedOut={optedOut}
        deleted={deleted}
        {...(onRestore !== undefined && { onRestore })}
        clearDraftSignal={clearDraftSignal}
        resetScrollKey={resetScrollKey}
        {...(emptyLabel !== undefined && { emptyLabel })}
        {...(initialDraft !== undefined && { initialDraft })}
        {...(onDraftSeeded !== undefined && { onDraftSeeded })}
        {...(commsOnly !== undefined && { commsOnly })}
        {...(onCommsOnlyChange !== undefined && { onCommsOnlyChange })}
        emailChannel={{
          emails,
          onSendEmail,
          onManageEmails: () => setManagingEmails(true),
          ...(emailSuppressed && { suppressed: true }),
        }}
      />

      {managingEmails ? (
        <EmailManager
          contact={effectiveContact}
          emails={emails}
          onClose={() => setManagingEmails(false)}
          onChanged={(updated) => {
            applyContact(updated);
            timeline.refetch();
          }}
        />
      ) : null}

      {pendingConsentSend !== null ? (
        <ConsentCaptureModal
          contactId={effectiveContact.contactId}
          contactName={name}
          onCancel={() => setPendingConsentSend(null)}
          onRecorded={(updated: Contact) => {
            // Apply the consent in place so the contact now reads as opted-in, then
            // RETRY the exact send that was blocked. Clear the modal first.
            const retry = pendingConsentSend;
            applyContact(updated);
            setPendingConsentSend(null);
            // The PATCH wrote a consent milestone with no SSE of its own - pull the
            // timeline so the pin lands without waiting for an unrelated event.
            timeline.refetch();
            if (retry !== null) {
              // Out-of-band of the composer: deferredSend clears the restored draft on
              // success; a fresh refusal leaves it (message preserved). The no-op catch
              // avoids an unhandled rejection.
              void deferredSend(
                retry.conversationId,
                retry.body,
                retry.replyToPhone,
                retry.attachmentKeys,
                retry.attachmentOriginalKeys,
              ).catch(() => {});
            }
          }}
        />
      ) : null}
    </>
  );
}
