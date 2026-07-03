// ContactDetail — the shared shell for the contact detail page (tenant /
// landlord / untriaged). A near-black header band (avatar · name · KIND pill ·
// facts · Call ▾ · ⋯) over a two-pane body: comms-LEFT (the Timeline) / file-RIGHT.
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
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useContacts } from '../contacts/useContacts.js';
import {
  ApiError,
  deleteContact,
  ensureContactConversation,
  restoreContact,
  retryMessage,
  sendMessage,
  setContactOptOut,
  setContactVoiceOptOut,
  updateContact,
  type Contact,
  type ContactType,
  type TimelineMessage,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { Modal } from './Modal.js';
import { Timeline } from './Timeline.js';
import { TenantFile } from './TenantFile.js';
import { LandlordFile } from './LandlordFile.js';
import { UnknownFile } from './UnknownFile.js';
import { ContactActionsMenu } from './ContactActionsMenu.js';
import { ContactEditForm } from './ContactEditForm.js';
import { PhoneManager } from './PhoneManager.js';
import { PlacementCreateForm } from '../placements/PlacementCreateForm.js';
import { ScheduleTourForm } from '../tours/ScheduleTourForm.js';
import { UnitCreateForm } from '../listing/UnitCreateForm.js';
import { CallMenu } from './CallMenu.js';
import { useMe } from '../../app/useMe.js';
import { VOICE_TAB_PATH } from '../settings/settingsTabs.js';
import { ConsentCaptureModal } from './ConsentCaptureModal.js';
import { commsMedia } from './media.js';
import { useContact } from './useContact.js';
import { useContactTimeline } from './useContactTimeline.js';
import { useContactFile } from './useContactFile.js';
import { useMarkContactRead } from './useMarkContactRead.js';
import { contactDisplayName, contactStatusLabel } from './format.js';
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
  // The "Start placement" dialog, pre-filled+locked to this (tenant) contact.
  const [startingPlacement, setStartingPlacement] = useState(false);
  // The "Schedule a tour" dialog, pre-filled+locked to this (tenant) contact.
  const [schedulingTour, setSchedulingTour] = useState(false);
  // The "New property" dialog, pre-filled+locked to this (landlord) contact.
  const [addingProperty, setAddingProperty] = useState(false);
  const [optOutBusy, setOptOutBusy] = useState(false);
  const [voiceOptOutBusy, setVoiceOptOutBusy] = useState(false);
  const [triaging, setTriaging] = useState(false);
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
    { conversationId: string; body: string; replyToPhone?: string } | null
  >(null);

  const { status: contactStatus, contact, setContact } = useContact(contactId);
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

  // Three-way by audience: landlord → landlord, unknown → untriaged, everything
  // else (tenant + team_member) → tenant. `pill`/file are chosen from this.
  const kind: 'tenant' | 'landlord' | 'unknown' =
    contact.type === 'landlord'
      ? 'landlord'
      : contact.type === 'unknown'
        ? 'unknown'
        : 'tenant';
  const isLandlord = kind === 'landlord';
  const kindLabel = displayKind(contact, (t) => CONTACT_TYPE_LABEL[t]);
  const pill =
    kind === 'landlord'
      ? { label: kindLabel, cls: styles.pillLandlord }
      : kind === 'unknown'
        ? { label: kindLabel, cls: styles.pillUnknown }
        : { label: kindLabel, cls: styles.pillTenant };
  const phones = contactPhones(contact);
  const target = defaultPhone(phones);
  const name = contactDisplayName(contact.firstName, contact.lastName, target?.phone);

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
  const postSend = (conversationId: string, body: string, toPhone?: string): Promise<void> => {
    const tempId = timeline.addOptimistic(conversationId, body, toPhone);
    return sendMessage(conversationId, { body })
      .then((result) => {
        timeline.resolveOptimistic(tempId, result);
      })
      .catch((err: unknown) => {
        timeline.failOptimistic(tempId);
        throw err;
      });
  };
  const onSend = async (body: string): Promise<void> => {
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
    return postSend(convId, body, toPhone).catch((err: unknown) => {
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
        });
      }
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
      .then((updated) => setContact(updated))
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
      .then((updated) => setContact(updated))
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

  // Header facts subline: voucher / authority for tenants, company / property
  // count for landlords, plus the number count + status.
  const facts = buildFacts();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.avatar} aria-hidden="true" />
        <div className={styles.identity}>
          <div className={styles.nameRow}>
            <span className={styles.name}>{name}</span>
            <span className={`${styles.pill} ${pill.cls}`}>{pill.label}</span>
            {deleted ? <span className={styles.deletedBadge}>🗑 Deleted</span> : null}
            {optedOut ? (
              <span className={styles.doNotContact}>⛔ Do Not Contact</span>
            ) : null}
            {voiceOptedOut ? (
              <span className={styles.doNotContact}>📵 Do Not Call</span>
            ) : null}
          </div>
          {facts ? <div className={styles.facts}>{facts}</div> : null}
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
          <Timeline
            status={timeline.status}
            items={timeline.items}
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
          ) : kind === 'unknown' ? (
            <>
              <UnknownFile
                contact={contact}
                phones={phones}
                placements={file.placements}
                units={file.units}
                media={media}
                mediaLoading={mediaLoading}
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
                onEdit={() => setEditing(true)}
                onManagePhones={() => setManagingPhones(true)}
                onStartPlacement={() => setStartingPlacement(true)}
                onScheduleTour={() => setSchedulingTour(true)}
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
          onChanged={(updated) => setContact(updated)}
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
              void postSend(retry.conversationId, retry.body, retry.replyToPhone);
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
    if (phones.length > 0) {
      parts.push(`${phones.length} number${phones.length === 1 ? '' : 's'}`);
    }
    // The status rides the header facts as its DISPLAY label ("Needs review"),
    // never the raw snake_case token.
    if (contact!.status) parts.push(contactStatusLabel(contact!.type, contact!.status));
    return parts.join(' · ');
  }
}
