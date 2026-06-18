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
import { useParams } from 'react-router-dom';
import {
  retryMessage,
  sendMessage,
  setContactOptOut,
  updateContact,
  type ContactType,
  type TimelineMessage,
} from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { Timeline } from './Timeline.js';
import { TenantFile } from './TenantFile.js';
import { LandlordFile } from './LandlordFile.js';
import { UnknownFile } from './UnknownFile.js';
import { ContactActionsMenu } from './ContactActionsMenu.js';
import { ContactEditForm } from './ContactEditForm.js';
import { PhoneManager } from './PhoneManager.js';
import { CallMenu } from './CallMenu.js';
import { commsMedia } from './media.js';
import { useContact } from './useContact.js';
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
  const [pane, setPane] = useState<Pane>('comms');
  const [editing, setEditing] = useState(false);
  const [managingPhones, setManagingPhones] = useState(false);
  const [optOutBusy, setOptOutBusy] = useState(false);
  const [triaging, setTriaging] = useState(false);
  // Which number's thread the reply box sends into (null = use the default). Set
  // by the reply-target picker for multi-number contacts.
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);

  const { status: contactStatus, contact, setContact } = useContact(contactId);
  const timeline = useContactTimeline(contactId);
  const file = useContactFile(contactId);
  // Viewing the contact page (while the tab is visible) marks its comms read —
  // so the Inbox unread badge clears once you've actually seen the messages here.
  useMarkContactRead(contactId);

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

  // Three-way by audience, NOT binary: landlord/pm → landlord, unknown →
  // untriaged, everything else (tenant + team_member) → tenant. The old binary
  // `else = tenant` mislabeled untriaged inbounds as tenants and showed them the
  // tenant file. `pill`/file are chosen from this.
  const kind: 'tenant' | 'landlord' | 'unknown' =
    contact.type === 'landlord' || contact.type === 'pm'
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
  const canSend = sendConvId !== null;
  // The number shown in the reply box = the selected target's number (else the
  // default reply target).
  const replyToPhone =
    replyTargets.find((t) => t.conversationId === sendConvId)?.phone ?? target?.phone;
  // Optimistic send: show the outbound bubble ("Sending…") IMMEDIATELY, then POST.
  // On success, stamp the real tsMsgId + status so the SSE refetch reconciles by
  // id and the bubble advances Sending… → Sent → Delivered. On failure, drop the
  // optimistic bubble and rethrow so the Timeline restores the draft + shows why.
  const onSend = (body: string): Promise<void> => {
    if (!sendConvId) return Promise.resolve();
    const tempId = timeline.addOptimistic(sendConvId, body, replyToPhone);
    return sendMessage(sendConvId, { body })
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
  const onRetry = (msg: TimelineMessage): void => {
    const sid = messageSid(msg);
    if (sid.length === 0) return;
    void retryMessage(msg.conversationId, sid);
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

  // Header facts subline: voucher / authority for tenants, company / listing
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
            {optedOut ? (
              <span className={styles.doNotContact}>⛔ Do Not Contact</span>
            ) : null}
          </div>
          {facts ? <div className={styles.facts}>{facts}</div> : null}
        </div>
        <div className={styles.actions}>
          <CallMenu phones={phones} {...(target !== undefined && { defaultPhone: target })} triggerClassName={styles.callBtn} />
          <ContactActionsMenu
            onEdit={() => setEditing(true)}
            optedOut={optedOut}
            onToggleOptOut={onToggleOptOut}
            optOutBusy={optOutBusy}
          />
        </div>
      </header>

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
                cases={file.cases}
                units={file.units}
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
                cases={file.cases}
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
                cases={file.cases}
                units={file.units}
                listingsSentPending={file.listingsSent.status !== 'ready'}
                media={media}
                mediaLoading={mediaLoading}
                onEdit={() => setEditing(true)}
                onManagePhones={() => setManagingPhones(true)}
              />
              <RelationshipsCard relationships={contact.relationships} onEdit={() => setEditing(true)} />
              <CustomFieldsCard customFields={contact.customFields} onEdit={() => setEditing(true)} />
            </>
          )}
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
    </div>
  );

  function buildFacts(): string {
    const parts: string[] = [];
    if (isLandlord) {
      if (typeof contact!['company'] === 'string') parts.push(contact!['company'] as string);
      const owned = landlordUnits(file.units, contactId).length;
      if (owned > 0) parts.push(`${owned} listing${owned === 1 ? '' : 's'}`);
    } else {
      if (typeof contact!.voucherSize === 'number') parts.push(`Voucher ${contact!.voucherSize}BR`);
      if (typeof contact!['housingAuthority'] === 'string') {
        parts.push(contact!['housingAuthority'] as string);
      }
    }
    if (phones.length > 0) {
      parts.push(`${phones.length} number${phones.length === 1 ? '' : 's'}`);
    }
    if (contact!.status) parts.push(contact!.status);
    return parts.join(' · ');
  }
}
