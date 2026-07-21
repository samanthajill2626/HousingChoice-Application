// ContactDetail — the shared shell for the contact detail page (tenant /
// landlord / untriaged). A near-black header band (avatar - name - KIND pill -
// facts - Call ▾ - ⋯) over a two-pane body: comms-LEFT (the Timeline) / file-RIGHT.
//
// KIND, not a binary: a three-way `kind` (landlord/pm → landlord, unknown →
// unknown, else → tenant) chooses the file pane (TenantFile / LandlordFile /
// UnknownFile) and pill colour; the pill/badge LABEL is `displayKind` = role ??
// type, so a custom kind (e.g. "Case worker", base type tenant) reads its role.
// Custom kinds layer on a base type — see 2026-06-18-extensible-contact-creation.
// UnknownFile leads with a triage CTA (Mark as Tenant/Landlord → PATCH type).
//
// Type-AGNOSTIC cards rendered here for every kind: Relationships, Custom fields.
// Comms behaviours: opt-out (Do-Not-Contact) flag + refusal messaging; OPTIMISTIC
// send (Sending… → Sent → Delivered via the timeline's add/resolve/fail);
// "Media from comms" derived from the live timeline. Narrow widths lead with comms
// + a segmented Comms | Profile toggle. The page resolves the reply target
// (primary / picker) and whether a conversation is sendable, else Send is disabled.
// Behaviours documented in 2026-06-18-contact-comms-and-listings-refinements.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useContacts } from '../contacts/useContacts.js';
import {
  ApiError,
  deleteContact,
  ensureContactConversation,
  restoreContact,
  retryMessage,
  sendEmail,
  sendMessage,
  setContactOptOut,
  setContactVoiceOptOut,
  setTenantStatus,
  updateContact,
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  type Contact,
  type ContactType,
  type LandlordStatus,
  type TenantStatus,
  type TimelineMessage,
} from '../../api/index.js';
import {
  Button,
  ContactStatusBadge,
  Spinner,
  StatusMenu,
  contactStatusTone,
} from '../../ui/index.js';
import { Modal } from './Modal.js';
import { Timeline } from './Timeline.js';
import { TenantFile } from './TenantFile.js';
import { LandlordFile } from './LandlordFile.js';
import { UnknownFile } from './UnknownFile.js';
import { PartnerFile } from './PartnerFile.js';
import { ContactActionsMenu } from './ContactActionsMenu.js';
import { ContactEditForm } from './ContactEditForm.js';
import { PhoneManager } from './PhoneManager.js';
import { EmailManager } from './EmailManager.js';
import { contactEmails } from './contactEmails.js';
import type { EmailComposerSendInput } from './EmailComposer.js';
import { PlacementCreateForm } from '../placements/PlacementCreateForm.js';
import { ScheduleTourForm } from '../tours/ScheduleTourForm.js';
import { UnitCreateForm } from '../listing/UnitCreateForm.js';
import { CallMenu } from './CallMenu.js';
import { useMe } from '../../app/useMe.js';
import { VOICE_TAB_PATH } from '../settings/settingsTabs.js';
import { ConsentCaptureModal } from './ConsentCaptureModal.js';
import { commsMedia } from './media.js';
import { useContact } from './useContact.js';
import { useSuggestions } from './useSuggestions.js';
import { SuggestionChip } from './SuggestionChip.js';
import { SUGGESTION_TARGET_LABEL, suggestionFor } from './suggestionTargets.js';
import { useContactTimeline } from './useContactTimeline.js';
import { useContactFile } from './useContactFile.js';
import { useMarkContactRead } from './useMarkContactRead.js';
import { contactDisplayName } from './format.js';
import { contactPhones, defaultPhone, defaultPhoneLabel } from './contactPhones.js';
import { buildReplyTargets } from './replyTargets.js';
import { messageSid } from './media.js';
import { landlordUnits } from './buildContactFile.js';
import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';
import { RelationshipsCard } from './RelationshipsCard.js';
import { CustomFieldsCard } from './CustomFieldsCard.js';
import styles from './ContactDetail.module.css';

type Pane = 'comms' | 'profile';

export function ContactDetail(): React.JSX.Element {
  const { contactId = '' } = useParams<{ contactId: string }>();
  const navigate = useNavigate();
  const [pane, setPane] = useState<Pane>('comms');
  const [editing, setEditing] = useState(false);
  const [managingPhones, setManagingPhones] = useState(false);
  // The "Manage email" dialog (email-channel v1, A6). Opened from the composer's
  // channel toggle when the contact has no address, and from the file pane.
  const [managingEmails, setManagingEmails] = useState(false);
  // The "Start placement" dialog, pre-filled+locked to this (tenant) contact.
  const [startingPlacement, setStartingPlacement] = useState(false);
  // The "Schedule a tour" dialog, pre-filled+locked to this (tenant) contact.
  const [schedulingTour, setSchedulingTour] = useState(false);
  // The "New property" dialog, pre-filled+locked to this (landlord) contact.
  const [addingProperty, setAddingProperty] = useState(false);
  const [optOutBusy, setOptOutBusy] = useState(false);
  const [voiceOptOutBusy, setVoiceOptOutBusy] = useState(false);
  const [triaging, setTriaging] = useState(false);
  // Conversation-fact-extraction (T9): which suggestion target is mid-accept/dismiss
  // (disables its chip) + a per-target inline error (e.g. a 409 phone conflict).
  const [suggestionBusy, setSuggestionBusy] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<{ target: string; message: string } | null>(
    null,
  );
  // The header's interactive status pill (tenant/landlord lifecycle change).
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // The confirm-before-delete dialog (deleting navigates away, so we gate it).
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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

  const { status: contactStatus, contact, setContact } = useContact(contactId);
  // The contact's pending AI suggestions (chips/badges + the accept/dismiss loop).
  const suggestions = useSuggestions(contactId);

  // The /contacts/:contactId route re-renders this SAME component instance on a
  // param change (no remount — the same reason Timeline takes resetScrollKey), so
  // per-contact transient state must be reset by hand or it leaks: fail a status
  // change on contact A, navigate to B, and B would show A's error.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatusError(null);
    setStatusBusy(false);
    setSuggestionBusy(null);
    setSuggestionError(null);
  }, [contactId]);
  // The current navigator's voice self-view — gates the masked-call control on
  // "has a verified cell" (the CallMenu prompts them to set one otherwise).
  const { hasVerifiedCell } = useMe();
  const timeline = useContactTimeline(contactId);
  const file = useContactFile(contactId, { contactType: contact?.type });
  // Viewing the contact page (while the tab is visible) marks its comms read —
  // so the Inbox unread badge clears once you've actually seen the messages here.
  useMarkContactRead(contactId);

  // Load the full contact roster so the edit dialog can link relationships to
  // existing contacts (finding #1). Called unconditionally (hooks rules); the
  // 'all' filter fans out across tenant/landlord/unknown. The current contact is
  // filtered out to prevent self-links (finding #5).
  const { contacts: allContacts } = useContacts('all');
  const editCandidates = useMemo(
    () => allContacts.filter((c) => c.contactId !== contactId),
    [allContacts, contactId],
  );

  // "Media from comms" is derived from the LIVE timeline (not the one-shot C5
  // media slice), so it updates as soon as a new attachment message arrives — the
  // timeline refetches on SSE message.persisted. Memoized on items identity.
  const media = useMemo(() => commsMedia(timeline.items), [timeline.items]);
  const mediaLoading = timeline.status === 'loading';
  // The conversation an email sends into: an existing email thread if any (else
  // onSendEmail falls back to the default phone thread / creates the 1:1). A hook,
  // so it MUST run before the loading/error guards below (stable hook order).
  const existingEmailConvId = useMemo(() => {
    for (const it of timeline.items) {
      if (it.kind === 'message' && it.type === 'email') return it.conversationId;
    }
    return null;
  }, [timeline.items]);

  if (contactStatus === 'loading') {
    return (
      <div className={styles.center}>
        <Spinner center />
      </div>
    );
  }

  if (contactStatus === 'error' || !contact) {
    return (
      <div className={styles.center}>
        <p role="alert" className={styles.error}>
          We couldn&apos;t load this contact.
        </p>
      </div>
    );
  }

  // Four-way by audience: landlord -> landlord, partner -> partner (a resolved
  // third party; generic pane, no housing pipeline), unknown -> untriaged,
  // everything else (tenant + team_member) -> tenant. `pill`/file chosen from this.
  const kind: 'tenant' | 'landlord' | 'partner' | 'unknown' =
    contact.type === 'landlord'
      ? 'landlord'
      : contact.type === 'partner'
        ? 'partner'
        : contact.type === 'unknown'
          ? 'unknown'
          : 'tenant';
  const isLandlord = kind === 'landlord';
  const kindLabel = displayKind(contact, (t) => CONTACT_TYPE_LABEL[t]);
  const pill =
    kind === 'landlord'
      ? { label: kindLabel, cls: styles.pillLandlord }
      : kind === 'partner'
        ? { label: kindLabel, cls: styles.pillPartner }
        : kind === 'unknown'
          ? { label: kindLabel, cls: styles.pillUnknown }
          : { label: kindLabel, cls: styles.pillTenant };
  const phones = contactPhones(contact);
  const target = defaultPhone(phones);
  const name = contactDisplayName(contact.firstName, contact.lastName, target?.phone);

  // firstName/lastName can be WRITTEN or SUGGESTED for a tenant OR unknown contact
  // (apply.ts), but the name lives in the header - not a file-pane row - so its
  // review chips surface here, directly under the name. (voucherSize/pets/status/
  // ... chips live in TenantFile/EligibilityIntakeCard; type in UnknownFile.)
  const nameChipFor = (nameTarget: 'firstName' | 'lastName'): React.JSX.Element | null => {
    if (kind !== 'tenant' && kind !== 'unknown') return null;
    const s = suggestionFor(suggestions.suggestions, nameTarget);
    if (!s) return null;
    return (
      <SuggestionChip
        label={SUGGESTION_TARGET_LABEL[nameTarget] ?? nameTarget}
        suggestion={s}
        onAccept={() => onAcceptSuggestion(nameTarget)}
        onDismiss={() => onDismissSuggestion(nameTarget)}
        busy={suggestionBusy === nameTarget}
        error={suggestionError?.target === nameTarget ? suggestionError.message : null}
      />
    );
  };

  // Resolve which thread the reply sends into. Each of the contact's numbers is
  // its own 1:1 conversation; the picker lets the navigator choose, defaulting to
  // the primary number's thread. With a single conversation there's nothing to
  // pick (the picker hides).
  const { targets: replyTargets, defaultConversationId } = buildReplyTargets(timeline.items, phones);
  const sendConvId = selectedConvId ?? defaultConversationId;
  // Sendable when a thread already resolves OR the contact has a number to start
  // one with — a BRAND-NEW contact has no conversation yet, so the first send
  // creates it (ensureContactConversation in onSend) instead of graying out.
  const canSend = sendConvId !== null || target !== undefined;
  // Email channel (A6): the contact's addresses + which conversation an email
  // sends into. Prefer an existing email thread; else the default (phone) thread;
  // else onSendEmail creates/gets the 1:1. The A5 route attaches the email claim
  // to whichever conversation it POSTs to (or redirects to the already-claimed one).
  const emails = contactEmails(contact);
  const emailSuppressed = contact.email_opt_out === true || contact.email_unreachable === true;
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
      resolvedId = await ensureContactConversation(contact.contactId);
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
      convId = await ensureContactConversation(contact.contactId);
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
      ...(input.attachmentKeys.length > 0 && { attachmentKeys: input.attachmentKeys }),
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

  // Header ⋯ menu + UnknownFile triage. Each endpoint RETURNS the updated contact,
  // so we apply it in place (setContact) — the header, file pane, facts, and reply
  // target all re-derive instantly with no refetch.
  const optedOut = contact.sms_opt_out === true;
  const onToggleOptOut = (): void => {
    if (optOutBusy) return;
    setOptOutBusy(true);
    void setContactOptOut(contact.contactId, !optedOut)
      .then((updated) => {
        setContact(updated);
        timeline.refetch(); // opt_out_changed milestone — same no-SSE gap as status
      })
      .catch(() => {
        /* leave the flag as-is; a transient failure just no-ops the toggle */
      })
      .finally(() => setOptOutBusy(false));
  };
  // Voice do-not-call (voice_opt_out) — INDEPENDENT of the SMS opt-out above.
  const voiceOptedOut = contact.voice_opt_out === true;
  const onToggleVoiceOptOut = (): void => {
    if (voiceOptOutBusy) return;
    setVoiceOptOutBusy(true);
    void setContactVoiceOptOut(contact.contactId, !voiceOptedOut)
      .then((updated) => {
        setContact(updated);
        timeline.refetch(); // opt_out_changed (voice) milestone — same gap
      })
      .catch(() => {
        /* leave the flag as-is; a transient failure just no-ops the toggle */
      })
      .finally(() => setVoiceOptOutBusy(false));
  };
  const onTriage = (type: ContactType): void => {
    if (triaging) return;
    setTriaging(true);
    void updateContact(contact.contactId, { type })
      .then((updated) => setContact(updated))
      .catch(() => {
        /* stay on the unknown view; the buttons re-enable for a retry */
      })
      .finally(() => setTriaging(false));
  };

  // Accept an AI suggestion. The route RETURNS the updated contact (with the value
  // written + `<field>_source` provenance) plus the remaining suggestions, so we
  // apply the contact in place (setContact) - the badge appears and the chip drops.
  // A 409 phone_in_use surfaces as an inline error on that chip (suggestion kept).
  const onAcceptSuggestion = (target: string): void => {
    if (suggestionBusy !== null) return;
    setSuggestionBusy(target);
    setSuggestionError(null);
    void suggestions
      .accept(target)
      .then((res) => {
        setContact(res.contact);
        // Accepting status writes a milestone with no SSE - pull the timeline.
        if (target === 'status') timeline.refetch();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 409) {
          setSuggestionError({
            target,
            message: 'That number already belongs to another contact.',
          });
        }
        /* other failures: leave the chip in place; it re-enables for a retry */
      })
      .finally(() => setSuggestionBusy(null));
  };
  const onDismissSuggestion = (target: string): void => {
    if (suggestionBusy !== null) return;
    setSuggestionBusy(target);
    setSuggestionError(null);
    void suggestions
      .dismiss(target)
      .catch(() => {
        /* leave the chip; it re-enables for a retry */
      })
      .finally(() => setSuggestionBusy(null));
  };

  // Lifecycle-status change from the header's interactive pill. Goes through the
  // transition service (setTenantStatus serves ALL contact types — the route
  // validates against the stored contact's own type-scoped allowlist), NEVER a
  // plain contact PATCH. Manual source; on success apply the returned contact in
  // place; on failure surface an inline error (the pill keeps the stored status,
  // so a silent failure would look like the change just vanished).
  const onChangeStatus = (toStatus: string): void => {
    if (statusBusy || toStatus === contact.status) return;
    setStatusBusy(true);
    // Clear any prior error at ATTEMPT start (matches PlacementDetail's
    // runTransition) so a retry never renders a stale message.
    setStatusError(null);
    void setTenantStatus(contact.contactId, {
      // StatusMenu is stringly-typed; the value came from the type-scoped option
      // list (TENANT_STATUSES / LANDLORD_STATUSES), so the union cast is exact.
      toStatus: toStatus as TenantStatus | LandlordStatus,
      source: 'manual',
    })
      .then((updated) => {
        setContact(updated);
        // The transition wrote a contact_status_changed milestone; no SSE event
        // covers it, so pull the timeline now — otherwise the pin only appears
        // when some unrelated message event triggers a refetch.
        timeline.refetch();
      })
      .catch(() => setStatusError("Couldn't update the status - please try again."))
      .finally(() => setStatusBusy(false));
  };

  // Soft-delete (reversible). Deleting is confirmed first, then the contact drops
  // out of the normal views — so on success we navigate back to the Contacts list
  // (it can be restored from the Deleted tab). Restore stays on the page and
  // applies the returned contact in place so the Deleted banner clears.
  const deleted = typeof contact.deleted_at === 'string' && contact.deleted_at.length > 0;
  const onConfirmDelete = (): void => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    void deleteContact(contact.contactId)
      .then(() => {
        setConfirmingDelete(false);
        void navigate('/contacts');
      })
      .catch(() => {
        setDeleteError("Couldn't delete — please try again.");
        setDeleteBusy(false);
      });
  };
  const onRestore = (): void => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    void restoreContact(contact.contactId)
      .then((updated) => setContact(updated))
      .catch(() => {
        /* leave it deleted; the action re-enables for a retry */
      })
      .finally(() => setDeleteBusy(false));
  };

  // Header facts subline: a quiet domain-glance line — voucher / authority for
  // tenants, company / property count for landlords. The number count lives in the
  // Details "Phone numbers" row and the status rides its own header badge, so
  // neither is repeated here.
  const facts = buildFacts();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.avatar} aria-hidden="true" />
        <div className={styles.identity}>
          <div className={styles.nameRow}>
            <span className={styles.name}>{name}</span>
            <span className={`${styles.pill} ${pill.cls}`}>{pill.label}</span>
            {/* Tenant/landlord lifecycle status: an interactive pill that shows AND
                changes it (same pattern as the property/placement headers). Other
                types (and deleted contacts) keep the display-only badge. */}
            {contact.status && !deleted && contact.type === 'tenant' ? (
              <StatusMenu
                value={contact.status}
                options={TENANT_STATUSES.map((s) => ({ value: s, label: TENANT_STATUS_LABELS[s] }))}
                onChange={onChangeStatus}
                tone={contactStatusTone(contact.type, contact.status)}
                disabled={statusBusy}
                label="Contact status"
                error={statusError}
              />
            ) : contact.status && !deleted && contact.type === 'landlord' ? (
              <StatusMenu
                value={contact.status}
                options={LANDLORD_STATUSES.map((s) => ({ value: s, label: LANDLORD_STATUS_LABELS[s] }))}
                onChange={onChangeStatus}
                tone={contactStatusTone(contact.type, contact.status)}
                disabled={statusBusy}
                label="Contact status"
                error={statusError}
              />
            ) : contact.status ? (
              <ContactStatusBadge type={contact.type} status={contact.status} />
            ) : null}
            {deleted ? <span className={styles.deletedBadge}>🗑 Deleted</span> : null}
            {optedOut ? (
              <span className={styles.doNotContact}>⛔ Do Not Contact</span>
            ) : null}
            {voiceOptedOut ? (
              <span className={styles.doNotContact}>📵 Do Not Call</span>
            ) : null}
          </div>
          {facts ? <div className={styles.facts}>{facts}</div> : null}
          {nameChipFor('firstName')}
          {nameChipFor('lastName')}
        </div>
        <div className={styles.actions}>
          {deleted ? (
            <button
              type="button"
              className={styles.callBtn}
              disabled={deleteBusy}
              onClick={onRestore}
            >
              Restore
            </button>
          ) : null}
          <CallMenu
            contactId={contact.contactId}
            phones={phones}
            {...(target !== undefined && { defaultPhone: target })}
            voiceOptOut={voiceOptedOut}
            navigatorHasVerifiedCell={hasVerifiedCell}
            onSetUpCell={() => void navigate(VOICE_TAB_PATH)}
            triggerClassName={styles.callBtn}
          />
          <ContactActionsMenu
            onEdit={() => setEditing(true)}
            optedOut={optedOut}
            onToggleOptOut={onToggleOptOut}
            optOutBusy={optOutBusy}
            voiceOptedOut={voiceOptedOut}
            onToggleVoiceOptOut={onToggleVoiceOptOut}
            voiceOptOutBusy={voiceOptOutBusy}
            deleted={deleted}
            onDelete={() => setConfirmingDelete(true)}
            onRestore={onRestore}
            deleteBusy={deleteBusy}
          />
        </div>
      </header>

      {deleted ? (
        <div className={styles.deletedBanner} role="status">
          <span>
            This contact is <strong>deleted</strong> — hidden from the contact lists,
            inbox, and today. Its data is retained.
          </span>
          <Button variant="secondary" size="sm" type="button" onClick={onRestore} disabled={deleteBusy}>
            Restore
          </Button>
        </div>
      ) : null}

      {/* Narrow-width segmented toggle (hidden on wide via CSS). */}
      <div className={styles.segMobile} role="group" aria-label="View">
        <button
          type="button"
          className={pane === 'comms' ? styles.segOn : styles.segBtn}
          aria-pressed={pane === 'comms'}
          onClick={() => setPane('comms')}
        >
          Comms
        </button>
        <button
          type="button"
          className={pane === 'profile' ? styles.segOn : styles.segBtn}
          aria-pressed={pane === 'profile'}
          onClick={() => setPane('profile')}
        >
          Profile
        </button>
      </div>

      <div className={styles.body}>
        <div className={`${styles.left} ${pane === 'comms' ? styles.paneActive : styles.paneHidden}`}>
          {/* key= REMOUNTS the Timeline when the route param changes: this page
              re-renders the SAME component instance on contact-to-contact
              navigation (no remount), so the composer's LOCAL state - the text
              draft and, since outbound MMS, the uploaded attachment chips -
              would otherwise survive into the NEXT contact's composer and a
              Send would deliver contact A's media to contact B. Same keyed
              isolation the tour channel switcher uses (TourConversation). */}
          <Timeline
            key={contactId}
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
            clearDraftSignal={clearDraftSignal}
            resetScrollKey={contactId}
            emailChannel={{
              emails,
              onSendEmail,
              onManageEmails: () => setManagingEmails(true),
              ...(emailSuppressed && { suppressed: true }),
            }}
          />
        </div>
        <div
          className={`${styles.right} ${pane === 'profile' ? styles.paneActive : styles.paneHidden}`}
        >
          <div className={styles.rightInner}>
          {file.status === 'loading' ? (
            <Spinner center />
          ) : file.status === 'error' ? (
            <p role="alert" className={styles.error}>
              We couldn&apos;t load this file.
            </p>
          ) : kind === 'landlord' ? (
            <>
              <LandlordFile
                contact={contact}
                phones={phones}
                placements={file.placements}
                tours={file.tours}
                units={file.units}
                relayGroupsPending={file.relayGroups.status !== 'ready'}
                relayGroups={file.relayGroups.status === 'ready' ? file.relayGroups.rows : []}
                media={media}
                mediaLoading={mediaLoading}
                onEdit={() => setEditing(true)}
                onManagePhones={() => setManagingPhones(true)}
                onAddProperty={() => setAddingProperty(true)}
              />
              <RelationshipsCard relationships={contact.relationships} onEdit={() => setEditing(true)} />
              <CustomFieldsCard customFields={contact.customFields} onEdit={() => setEditing(true)} />
            </>
          ) : kind === 'partner' ? (
            <>
              <PartnerFile
                contact={contact}
                phones={phones}
                media={media}
                mediaLoading={mediaLoading}
                onEdit={() => setEditing(true)}
                onManagePhones={() => setManagingPhones(true)}
              />
              <RelationshipsCard relationships={contact.relationships} onEdit={() => setEditing(true)} />
              <CustomFieldsCard customFields={contact.customFields} onEdit={() => setEditing(true)} />
            </>
          ) : kind === 'unknown' ? (
            <>
              <UnknownFile
                contact={contact}
                phones={phones}
                placements={file.placements}
                units={file.units}
                media={media}
                mediaLoading={mediaLoading}
                suggestions={suggestions.suggestions}
                onEdit={() => setEditing(true)}
                onManagePhones={() => setManagingPhones(true)}
                onTriage={onTriage}
                triaging={triaging}
              />
              <RelationshipsCard relationships={contact.relationships} onEdit={() => setEditing(true)} />
              <CustomFieldsCard customFields={contact.customFields} onEdit={() => setEditing(true)} />
            </>
          ) : (
            <>
              <TenantFile
                contact={contact}
                phones={phones}
                placements={file.placements}
                tours={file.tours}
                units={file.units}
                listingsSentPending={file.listingsSent.status !== 'ready'}
                listingsSent={file.listingsSent.status === 'ready' ? file.listingsSent.rows : []}
                relayGroupsPending={file.relayGroups.status !== 'ready'}
                relayGroups={file.relayGroups.status === 'ready' ? file.relayGroups.rows : []}
                media={media}
                mediaLoading={mediaLoading}
                suggestions={suggestions.suggestions}
                onAcceptSuggestion={onAcceptSuggestion}
                onDismissSuggestion={onDismissSuggestion}
                suggestionBusy={suggestionBusy}
                suggestionError={suggestionError}
                onEdit={() => setEditing(true)}
                onManagePhones={() => setManagingPhones(true)}
                onStartPlacement={() => setStartingPlacement(true)}
                onScheduleTour={() => setSchedulingTour(true)}
                onSendProperty={() =>
                  navigate(`/broadcasts/new?contactId=${encodeURIComponent(contact.contactId)}`)
                }
              />
              <RelationshipsCard relationships={contact.relationships} onEdit={() => setEditing(true)} />
              <CustomFieldsCard customFields={contact.customFields} onEdit={() => setEditing(true)} />
            </>
          )}
          </div>
        </div>
      </div>

      {editing ? (
        <ContactEditForm
          contact={contact}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setContact(updated);
            setEditing(false);
          }}
          candidates={editCandidates}
        />
      ) : null}

      {managingPhones ? (
        <PhoneManager
          contact={contact}
          phones={phones}
          onClose={() => setManagingPhones(false)}
          onChanged={(updated) => {
            setContact(updated);
            timeline.refetch(); // number_added milestone — same no-SSE gap
          }}
        />
      ) : null}

      {managingEmails ? (
        <EmailManager
          contact={contact}
          emails={emails}
          onClose={() => setManagingEmails(false)}
          onChanged={(updated) => {
            setContact(updated);
            timeline.refetch();
          }}
        />
      ) : null}

      {startingPlacement ? (
        <PlacementCreateForm
          tenantId={contact.contactId}
          onClose={() => setStartingPlacement(false)}
          onCreated={(p) => {
            setStartingPlacement(false);
            void navigate('/placements/' + p.placementId);
          }}
        />
      ) : null}

      {schedulingTour ? (
        <ScheduleTourForm
          tenantId={contact.contactId}
          // Continue from the latest send: pre-commit the unit side to the most
          // recent "Properties sent" row (rows arrive newest-first by sentAt).
          initialUnitId={
            file.listingsSent.status === 'ready' ? file.listingsSent.rows[0]?.unitId : undefined
          }
          onClose={() => setSchedulingTour(false)}
          onCreated={(t) => {
            setSchedulingTour(false);
            void navigate('/tours/' + t.tourId);
          }}
        />
      ) : null}

      {addingProperty ? (
        <UnitCreateForm
          landlordId={contact.contactId}
          onClose={() => setAddingProperty(false)}
          onCreated={(u) => {
            setAddingProperty(false);
            void navigate('/listings/' + u.unitId);
          }}
        />
      ) : null}

      {pendingConsentSend !== null ? (
        <ConsentCaptureModal
          contactId={contact.contactId}
          contactName={name}
          onCancel={() => setPendingConsentSend(null)}
          onRecorded={(updated: Contact) => {
            // Apply the consent in place so the contact now reads as opted-in, then
            // RETRY the exact send that was blocked. Clear the modal first.
            const retry = pendingConsentSend;
            setContact(updated);
            setPendingConsentSend(null);
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

      {confirmingDelete ? (
        <Modal
          title="Delete contact?"
          onClose={() => {
            if (!deleteBusy) {
              setConfirmingDelete(false);
              setDeleteError(null);
            }
          }}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleteBusy}
              >
                Cancel
              </Button>
              <Button variant="danger" size="sm" type="button" onClick={onConfirmDelete} disabled={deleteBusy}>
                {deleteBusy ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          <p>
            <strong>{name}</strong> will be hidden from the contact lists, inbox, and today.
            Nothing is erased — you can restore them from the Contacts <em>Deleted</em> view.
          </p>
          {deleteError !== null ? (
            <p role="alert" className={styles.error}>
              {deleteError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );

  function buildFacts(): string {
    const parts: string[] = [];
    if (isLandlord) {
      if (typeof contact!['company'] === 'string') parts.push(contact!['company'] as string);
      const owned = landlordUnits(file.units, contactId).length;
      if (owned > 0) parts.push(`${owned} propert${owned === 1 ? 'y' : 'ies'}`);
    } else {
      if (typeof contact!.voucherSize === 'number') parts.push(`Voucher ${contact!.voucherSize}BR`);
      if (typeof contact!['housingAuthority'] === 'string') {
        parts.push(contact!['housingAuthority'] as string);
      }
    }
    return parts.join(' - ');
  }
}
