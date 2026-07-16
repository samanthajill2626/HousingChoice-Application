// PlacementConversation - the placement page's LEFT pane: a three-channel switcher
// (Group text / Tenant 1:1 / Landlord 1:1). Structural mirror of
// tours/TourConversation.tsx. All three tabs always render; the initial tab is
// Group when the placement already has a group thread, else Tenant, and it NEVER
// auto-switches after load (only a user click moves it). Each tab shows an unread
// dot from its conversation's unread_count; viewing a tab marks that SINGLE
// conversation read (via the channels hook -> markConversationRead, never the
// contact-wide inbox fan-out).
//
// The active tab lazily mounts ONE transcript: only the active conversation's
// useRelayThread fetches (we never fetch all three up front). Transcripts reuse
// the shared <Timeline> + useRelayThread + sendMessage machinery. Empty states
// render in place: the group offers [Open group text] (which provisions the
// masked relay via provisionPlacementRelay and mounts the fresh thread at once);
// a 1:1 with no thread yet offers a live composer that creates the conversation
// on the first send.
//
// A2P/CTIA just-in-time consent gate (ContactDetail parity): a proactive 1:1 send
// to a no-consent contact is refused server-side with a 409 `contact_no_consent`.
// The 1:1 threads report that refusal UP (onConsentRefused) so this component
// holds the pending send + opens the SAME hard-block ConsentCaptureModal the
// contact page uses; recording consent retries the exact send and clears the
// composer's restored draft. Without this the refusal was SILENT here - the
// optimistic bubble vanished, the draft came back, no error.
//
// Differences from the tour template, and ONLY these: the channel SOURCES are
// placement.* (group = placement.group_thread; tenant = placement.tenantId;
// landlord = unit.landlordId); there is no pm_team label branch (labels are
// exactly Group text / Tenant - {first} / Landlord - {first}); and the group
// empty-state button provisions the relay INTERNALLY (provisionPlacementRelay ->
// setConversationId) rather than delegating to a parent onOpenGroup. A placement
// has no `status` field, so the group "dead" guard keys on TERMINAL_STAGES
// (moved_in / lost) instead of tour.status.
import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  ensureContactConversation,
  getConversation,
  getConversationMembers,
  provisionPlacementRelay,
  sendMessage,
  STAGE_LABELS,
  TERMINAL_STAGES,
  type Contact,
  type ConversationParticipant,
  type PlacementItem,
  type UnitItem,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Timeline } from '../contact/Timeline.js';
import { ConsentCaptureModal } from '../contact/ConsentCaptureModal.js';
import { contactDisplayName } from '../contact/format.js';
import { useRelayThread } from '../conversation/useRelayThread.js';
import { type PlacementChannelKey, type PlacementChannelsState } from './usePlacementChannels.js';
// Reuse the tour page's comms CSS verbatim (scoped CSS module, tokens only) - the
// pill rail / pane / empty-state styling is identical for both hubs.
import styles from '../tours/TourDetail.module.css';

/** A 1:1 send refused by the consent gate, held while the modal is open. */
interface PendingConsentSend {
  key: 'tenant' | 'landlord';
  contactId: string;
  name: string;
  /** Null when the thread didn't exist yet - the retry ensures it first. */
  conversationId: string | null;
  body: string;
  attachmentKeys?: string[];
  attachmentOriginalKeys?: string[];
}

export interface PlacementConversationProps {
  placement: PlacementItem;
  /** The placement's unit - its landlordId is the landlord 1:1 target. */
  unit: UnitItem | null;
  tenant: Contact | null;
  landlord: Contact | null;
  channels: PlacementChannelsState;
}

/** A member's first name, or null when unknown. */
function firstNameOf(c: Contact | null): string | null {
  const f = c?.firstName?.trim();
  return f && f.length > 0 ? f : null;
}

export function PlacementConversation({
  placement,
  unit,
  tenant,
  landlord,
  channels,
}: PlacementConversationProps): React.JSX.Element {
  const landlordId = unit?.landlordId;

  // Initial tab decided ONCE from the placement at first render; never re-synced.
  const [activeKey, setActiveKey] = useState<PlacementChannelKey>(
    placement.group_thread ? 'group' : 'tenant',
  );

  const active = channels[activeKey];

  // Viewing a tab marks its SINGLE conversation read + clears the tab dot. Runs on
  // the initial tab and every switch; re-runs when the active channel resolves an
  // id or gains unread. We pass the active channel's CURRENT conversationId +
  // unread as ARGUMENTS (rather than have markRead read a ref) so the INITIAL
  // active tab marks read on the loading->ready commit: a ref would be written by
  // a parent effect that runs AFTER this child effect, so it would still be stale
  // here. markRead no-ops at unread 0, so this never loops.
  useEffect(() => {
    channels.markRead(activeKey, active.conversationId, active.unread);
  }, [activeKey, active.conversationId, active.unread, channels]);

  const tenantFirst = firstNameOf(tenant);
  const landlordFirst = firstNameOf(landlord);
  const tabs: { key: PlacementChannelKey; label: string; unread: number }[] = [
    { key: 'group', label: 'Group text', unread: channels.group.unread },
    {
      key: 'tenant',
      label: tenantFirst ? `Tenant - ${tenantFirst}` : 'Tenant',
      unread: channels.tenant.unread,
    },
    {
      key: 'landlord',
      label: landlordFirst ? `Landlord - ${landlordFirst}` : 'Landlord',
      unread: channels.landlord.unread,
    },
  ];

  const tenantName = tenant
    ? contactDisplayName(tenant.firstName, tenant.lastName, tenant.phone)
    : 'the tenant';
  const landlordName = landlord
    ? contactDisplayName(landlord.firstName, landlord.lastName, landlord.phone)
    : 'the landlord';

  // A placement has no `status`; a group text cannot be opened once the deal is
  // terminal (moved_in / lost).
  const groupDead = TERMINAL_STAGES.has(placement.stage);
  const oneToOneKey: 'tenant' | 'landlord' = activeKey === 'landlord' ? 'landlord' : 'tenant';
  const oneToOneContactId = activeKey === 'landlord' ? landlordId : placement.tenantId;
  const oneToOneName = activeKey === 'landlord' ? landlordName : tenantName;
  // The 1:1 composer footer shows WHO the reply sends to (the contact's number,
  // same as the contact page's reply box); the group tab passes none - its
  // composer matches ConversationDetail's group view.
  const oneToOnePhone = activeKey === 'landlord' ? landlord?.phone : tenant?.phone;

  // Group provisioning lives HERE (not delegated to a parent onOpenGroup like the
  // tour page): [Open group text] calls provisionPlacementRelay, then injects the
  // fresh conversationId so the relay thread mounts immediately.
  const [openGroupBusy, setOpenGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  function onOpenGroup(): void {
    if (openGroupBusy) return;
    setOpenGroupBusy(true);
    setGroupError(null);
    void provisionPlacementRelay(placement.placementId)
      .then(({ conversationId }) => channels.setConversationId('group', conversationId))
      .catch(() => setGroupError('Could not open the group text. Please try again.'))
      .finally(() => setOpenGroupBusy(false));
  }

  // Just-in-time consent gate (ContactDetail parity): the refused send held while
  // the ConsentCaptureModal is open, and a per-channel clear-draft signal for the
  // post-consent retry (per-channel so the OTHER tab's in-progress draft is never
  // wiped by this one's retry landing).
  const [pendingConsent, setPendingConsent] = useState<PendingConsentSend | null>(null);
  const [clearSignals, setClearSignals] = useState<{ tenant: number; landlord: number }>({
    tenant: 0,
    landlord: 0,
  });

  // Consent recorded -> retry the EXACT refused send out-of-band of the composer
  // (the composer restored its draft on the 409; the clear signal removes it once
  // the retry lands - a fresh failure leaves the draft, nothing is lost). The sent
  // message itself arrives via the thread's SSE-driven refetch. The modal's
  // updated Contact is ignored here: tenant/landlord are parent-owned props and
  // the placement page displays no consent state.
  function onConsentRecorded(): void {
    const retry = pendingConsent;
    setPendingConsent(null);
    if (retry === null) return;
    void (async () => {
      const convId = retry.conversationId ?? (await ensureContactConversation(retry.contactId));
      await sendMessage(convId, {
        body: retry.body,
        ...(retry.attachmentKeys !== undefined &&
          retry.attachmentKeys.length > 0 && { attachmentKeys: retry.attachmentKeys }),
        ...(retry.attachmentOriginalKeys !== undefined &&
          retry.attachmentOriginalKeys.length > 0 && {
            attachmentOriginalKeys: retry.attachmentOriginalKeys,
          }),
      });
      if (retry.conversationId === null) channels.setConversationId(retry.key, convId);
      setClearSignals((s) => ({ ...s, [retry.key]: s[retry.key] + 1 }));
    })().catch(() => {
      /* the draft is still in the box for another try */
    });
  }

  return (
    <div className={styles.convo}>
      <div className={styles.tabRail} role="tablist" aria-label="Conversation channel">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeKey === t.key}
            className={activeKey === t.key ? styles.tabOn : styles.tab}
            onClick={() => setActiveKey(t.key)}
          >
            {t.label}
            {t.unread > 0 ? (
              <>
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.srOnly}> unread</span>
              </>
            ) : null}
          </button>
        ))}
      </div>

      <div className={styles.channelPane}>
        {activeKey === 'group' ? (
          active.conversationId !== null ? (
            <GroupChannel conversationId={active.conversationId} />
          ) : (
            <div className={styles.channelEmpty}>
              <p className={styles.emptyTitle}>No group text yet</p>
              <p className={styles.emptyNote}>
                Open a masked group text with the tenant and landlord to coordinate this placement.
              </p>
              <Button
                size="sm"
                type="button"
                onClick={onOpenGroup}
                disabled={openGroupBusy || groupDead}
              >
                {openGroupBusy ? 'Opening...' : 'Open group text'}
              </Button>
              {groupError !== null ? <p className={styles.emptyNote}>{groupError}</p> : null}
              {groupDead ? (
                <p className={styles.emptyNote}>
                  This placement is {STAGE_LABELS[placement.stage]} - a group text cannot be opened.
                </p>
              ) : null}
            </div>
          )
        ) : oneToOneContactId === undefined ? (
          <div className={styles.channelEmpty}>
            <p className={styles.emptyNote}>The landlord for this property is not resolved yet.</p>
          </div>
        ) : active.conversationId !== null ? (
          // key by conversation identity so switching the Tenant<->Landlord 1:1
          // REMOUNTS a fresh Timeline. Both tabs render <ContactThread> at the same
          // JSX position; without a key React reuses the fiber and Timeline's
          // in-progress draft survives the switch, so a Send would post it to the
          // newly-selected party. Also clears the stale-transcript flash.
          <ContactThread
            key={active.conversationId}
            conversationId={active.conversationId}
            {...(oneToOnePhone !== undefined && { replyToPhone: oneToOnePhone })}
            clearDraftSignal={clearSignals[oneToOneKey]}
            onConsentRefused={(body, attachmentKeys, attachmentOriginalKeys) =>
              setPendingConsent({
                key: oneToOneKey,
                contactId: oneToOneContactId,
                name: oneToOneName,
                conversationId: active.conversationId,
                body,
                ...(attachmentKeys !== undefined && attachmentKeys.length > 0 && { attachmentKeys }),
                ...(attachmentOriginalKeys !== undefined &&
                  attachmentOriginalKeys.length > 0 && { attachmentOriginalKeys }),
              })
            }
          />
        ) : (
          // key by channel so a create-on-demand Tenant/Landlord tab also remounts
          // on switch (conversationId is null here, so it cannot key the pane).
          <NewContactThread
            key={activeKey}
            contactId={oneToOneContactId}
            name={oneToOneName}
            {...(oneToOnePhone !== undefined && { replyToPhone: oneToOnePhone })}
            onCreated={(id) => channels.setConversationId(activeKey, id)}
            clearDraftSignal={clearSignals[oneToOneKey]}
            onConsentRefused={(body, attachmentKeys, attachmentOriginalKeys) =>
              setPendingConsent({
                key: oneToOneKey,
                contactId: oneToOneContactId,
                name: oneToOneName,
                conversationId: null,
                body,
                ...(attachmentKeys !== undefined && attachmentKeys.length > 0 && { attachmentKeys }),
                ...(attachmentOriginalKeys !== undefined &&
                  attachmentOriginalKeys.length > 0 && { attachmentOriginalKeys }),
              })
            }
          />
        )}
      </div>

      {pendingConsent !== null ? (
        <ConsentCaptureModal
          contactId={pendingConsent.contactId}
          contactName={pendingConsent.name}
          onCancel={() => setPendingConsent(null)}
          onRecorded={onConsentRecorded}
        />
      ) : null}
    </div>
  );
}

/** The group-text transcript: the relay thread + roster + closed state, mirroring
 *  ConversationDetail's left pane. Sending is hard-disabled when the group is
 *  closed. Mounts only while the Group tab is active (lazy fetch). */
function GroupChannel({ conversationId }: { conversationId: string }): React.JSX.Element {
  const thread = useRelayThread(conversationId);
  const [members, setMembers] = useState<ConversationParticipant[]>([]);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    void getConversation(conversationId, ac.signal)
      .then((h) => setClosed(h.status === 'closed'))
      .catch(() => {
        /* header best-effort - default to open */
      });
    void getConversationMembers(conversationId, ac.signal)
      .then(setMembers)
      .catch(() => {
        /* roster best-effort - attribution degrades, transcript still renders */
      });
    return () => ac.abort();
  }, [conversationId]);

  const canSend = !closed;
  const onSend = (
    body: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ): Promise<void> => {
    const tempId = thread.addOptimistic(conversationId, body, undefined, attachmentKeys);
    return sendMessage(conversationId, {
      body,
      ...(attachmentKeys !== undefined && attachmentKeys.length > 0 && { attachmentKeys }),
      ...(attachmentOriginalKeys !== undefined &&
        attachmentOriginalKeys.length > 0 && { attachmentOriginalKeys }),
    })
      .then((result) => thread.resolveOptimistic(tempId, result))
      .catch((err: unknown) => {
        thread.failOptimistic(tempId);
        throw err;
      });
  };

  return (
    <Timeline
      status={thread.status}
      items={thread.items}
      upcoming={thread.upcoming}
      source="server"
      canSend={canSend}
      {...(canSend && { onSend })}
      relayRoster={members}
      relayClosed={closed}
      resetScrollKey={conversationId}
    />
  );
}

/** True when a send was refused by the A2P/CTIA just-in-time consent gate. */
function isConsentRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'contact_no_consent';
}

/** A 1:1 transcript for an EXISTING conversation. Optimistic send via the shared
 *  relay-thread trio. Mounts only while its tab is active (lazy fetch). */
function ContactThread({
  conversationId,
  replyToPhone,
  clearDraftSignal,
  onConsentRefused,
}: {
  conversationId: string;
  /** The contact's number, shown in the composer footer ("Reply sends to ..."). */
  replyToPhone?: string;
  /** Post-consent retry landed -> clear the draft the 409 refusal restored. */
  clearDraftSignal?: number;
  /** The consent gate refused this send (409 contact_no_consent) - the parent
   *  opens the capture modal holding it. Still rethrown so the composer restores
   *  the draft (the modal shows WHY; no inline error - ContactDetail parity). */
  onConsentRefused?: (
    body: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ) => void;
}): React.JSX.Element {
  const thread = useRelayThread(conversationId);
  const onSend = (
    body: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ): Promise<void> => {
    const tempId = thread.addOptimistic(conversationId, body, undefined, attachmentKeys);
    return sendMessage(conversationId, {
      body,
      ...(attachmentKeys !== undefined && attachmentKeys.length > 0 && { attachmentKeys }),
      ...(attachmentOriginalKeys !== undefined &&
        attachmentOriginalKeys.length > 0 && { attachmentOriginalKeys }),
    })
      .then((result) => thread.resolveOptimistic(tempId, result))
      .catch((err: unknown) => {
        thread.failOptimistic(tempId);
        if (isConsentRefusal(err)) onConsentRefused?.(body, attachmentKeys, attachmentOriginalKeys);
        throw err;
      });
  };
  return (
    <Timeline
      status={thread.status}
      items={thread.items}
      source="server"
      canSend
      onSend={onSend}
      {...(replyToPhone !== undefined && { replyToPhone })}
      {...(clearDraftSignal !== undefined && { clearDraftSignal })}
      resetScrollKey={conversationId}
    />
  );
}

/** A 1:1 with NO thread yet: an empty stream + a live composer. The first send
 *  creates-or-gets the contact's conversation, sends into it, then reports the
 *  new id so the parent swaps in the real ContactThread. */
function NewContactThread({
  contactId,
  name,
  replyToPhone,
  onCreated,
  clearDraftSignal,
  onConsentRefused,
}: {
  contactId: string;
  name: string;
  /** The contact's number, shown in the composer footer ("Reply sends to ..."). */
  replyToPhone?: string;
  onCreated: (conversationId: string) => void;
  /** Post-consent retry landed -> clear the draft the 409 refusal restored. */
  clearDraftSignal?: number;
  /** The consent gate refused this send - see ContactThread. */
  onConsentRefused?: (
    body: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ) => void;
}): React.JSX.Element {
  const onSend = async (
    body: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ): Promise<void> => {
    const conversationId = await ensureContactConversation(contactId);
    try {
      await sendMessage(conversationId, {
        body,
        ...(attachmentKeys !== undefined && attachmentKeys.length > 0 && { attachmentKeys }),
        ...(attachmentOriginalKeys !== undefined &&
          attachmentOriginalKeys.length > 0 && { attachmentOriginalKeys }),
      });
    } catch (err) {
      if (isConsentRefusal(err)) onConsentRefused?.(body, attachmentKeys, attachmentOriginalKeys);
      throw err;
    }
    onCreated(conversationId);
  };
  return (
    <Timeline
      status="ready"
      items={[]}
      source="server"
      canSend
      onSend={onSend}
      {...(replyToPhone !== undefined && { replyToPhone })}
      {...(clearDraftSignal !== undefined && { clearDraftSignal })}
      emptyLabel={`No messages with ${name} yet`}
      resetScrollKey={`new:${contactId}`}
    />
  );
}
