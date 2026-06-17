// ContactDetail — the shared shell for the Tenant (B2) + Landlord (B3) detail
// pages. A near-black header band (avatar · bold name · type pill [tenant blue /
// landlord teal] · facts subline · "Call ▾" + "⋯") over a two-pane body:
// comms-LEFT (the Timeline) / file-RIGHT (a type-driven TenantFile vs
// LandlordFile). On narrow widths it leads with comms and offers a simple
// segmented Comms | Profile toggle. The page resolves the reply target (primary
// / most-recent number) and whether a single conversation is sendable; sending
// posts to that conversation, else Send is disabled.
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { sendMessage } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { Timeline } from './Timeline.js';
import { TenantFile } from './TenantFile.js';
import { LandlordFile } from './LandlordFile.js';
import { useContact } from './useContact.js';
import { useContactTimeline } from './useContactTimeline.js';
import { useContactFile } from './useContactFile.js';
import { contactDisplayName, formatPhone } from './format.js';
import { contactPhones, defaultPhone, defaultPhoneLabel } from './contactPhones.js';
import { resolveSingleConversation } from './resolveConversation.js';
import { landlordUnits } from './buildContactFile.js';
import styles from './ContactDetail.module.css';

type Pane = 'comms' | 'profile';

export function ContactDetail(): React.JSX.Element {
  const { contactId = '' } = useParams<{ contactId: string }>();
  const [pane, setPane] = useState<Pane>('comms');

  const { status: contactStatus, contact } = useContact(contactId);
  const timeline = useContactTimeline(contactId);
  const file = useContactFile(contactId);

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

  const isLandlord = contact.type === 'landlord' || contact.type === 'pm';
  const phones = contactPhones(contact);
  const target = defaultPhone(phones);
  const name = contactDisplayName(contact.firstName, contact.lastName, target?.phone);

  // Resolve a single conversation to send into; with the messages-only fallback
  // this is the common 1:1 case. Multi-thread → no unambiguous target yet.
  const sendConvId = resolveSingleConversation(timeline.items);
  const canSend = sendConvId !== null;
  // Returns the send promise so the Timeline can show an in-flight state and
  // surface a failure (restore the draft) — a failed manual reply must NOT look
  // like it sent. The SSE message.persisted refetch reconciles the stream on
  // success.
  const onSend = (body: string): Promise<void> => {
    if (!sendConvId) return Promise.resolve();
    return sendMessage(sendConvId, { body }).then(() => undefined);
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
            <span className={`${styles.pill} ${isLandlord ? styles.pillLandlord : styles.pillTenant}`}>
              {isLandlord ? 'Landlord' : 'Tenant'}
            </span>
          </div>
          {facts ? <div className={styles.facts}>{facts}</div> : null}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.callBtn} disabled={!target}>
            📞 Call{target ? ` ${formatPhone(target.phone)} ▾` : ''}
          </button>
          <button type="button" className={styles.kebab} aria-label="More actions">
            ⋯
          </button>
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
            {...(target?.phone !== undefined && { replyToPhone: target.phone })}
            replyToLabel={defaultPhoneLabel(phones)}
            canSend={canSend}
            onSend={onSend}
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
          ) : isLandlord ? (
            <LandlordFile contact={contact} phones={phones} cases={file.cases} units={file.units} />
          ) : (
            <TenantFile
              contact={contact}
              phones={phones}
              cases={file.cases}
              units={file.units}
              listingsSentPending={file.listingsSent.status !== 'ready'}
              mediaPending={file.media.status !== 'ready'}
            />
          )}
        </div>
      </div>
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
