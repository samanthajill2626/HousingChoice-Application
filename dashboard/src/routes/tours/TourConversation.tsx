// TourConversation - the tour page's LEFT pane: a three-channel switcher (Group
// text / Tenant 1:1 / Landlord-or-PM 1:1). All three tabs always render; the
// initial tab is Group when the tour already has a group thread, else Tenant, and
// it NEVER auto-switches after load (only a user click moves it). Each tab shows
// an unread dot from its conversation's unread_count; viewing a tab marks that
// SINGLE conversation read (via the channels hook -> markConversationRead, never
// the contact-wide inbox fan-out).
//
// The active tab lazily mounts ONE transcript: only the active conversation's
// useRelayThread fetches (we never fetch all three up front). Transcripts reuse
// the shared <Timeline> + useRelayThread + sendMessage machinery. Empty states
// render in place: the group offers [Open group text]; a 1:1 with no thread yet
// offers a live composer that creates the conversation on the first send.
//
// A2P/CTIA just-in-time consent gate (§3.4, ContactDetail parity): a proactive
// 1:1 send to a no-consent contact is refused server-side with a 409
// `contact_no_consent`. The 1:1 threads report that refusal UP (onConsentRefused)
// so this component holds the pending send + opens the SAME hard-block
// ConsentCaptureModal the contact page uses; recording consent retries the exact
// send and clears the composer's restored draft. Without this the refusal was
// SILENT here — the optimistic bubble vanished, the draft came back, no error.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  ensureContactConversation,
  getConversation,
  getConversationMembers,
  sendMessage,
  type Contact,
  type ConversationParticipant,
  type TimelineItem,
  type TimelineMilestone,
  type Tour,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Timeline } from '../contact/Timeline.js';
import { ConsentCaptureModal } from '../contact/ConsentCaptureModal.js';
import { contactDisplayName } from '../contact/format.js';
import { useRelayThread } from '../conversation/useRelayThread.js';
import { type TourChannelKey, type TourChannelsState } from './useTourChannels.js';
import styles from './TourDetail.module.css';

/** A 1:1 send refused by the consent gate, held while the modal is open. */
interface PendingConsentSend {
  key: 'tenant' | 'landlord';
  contactId: string;
  name: string;
  /** Null when the thread didn't exist yet — the retry ensures it first. */
  conversationId: string | null;
  body: string;
  attachmentKeys?: string[];
  attachmentOriginalKeys?: string[];
}

export interface TourConversationProps {
  tour: Tour;
  tenant: Contact | null;
  landlord: Contact | null;
  /** The unit's landlordId - the landlord/PM 1:1 target (may be unresolved). */
  landlordId: string | undefined;
  channels: TourChannelsState;
  /** Provision the group thread (shared with the header kebab); errors surface in
   *  the page header banner. */
  onOpenGroup: () => void;
  openGroupBusy: boolean;
  /** THIS tour's lifecycle events as shared-Timeline milestone pins (oldest →
   *  newest), interleaved into ALL THREE transcripts so the panes show tour
   *  activity, not just comms. The Timeline's "Comms only" toggle hides them. */
  tourMilestones?: TimelineMilestone[];
  /** "Send no-show check-in" from the tour header: when nonce bumps to a new
   *  positive value, switch to the Tenant tab and PREFILL its composer with body
   *  (the editable no_show_checkin template). The tenant pane is remounted so the
   *  seed lands via the Timeline initialDraft initializer. */
  noShowDraft?: { body: string; nonce: number };
}

/** A pane's stream: its messages + the tour milestone pins, oldest→newest. Both
 *  inputs are already sorted; a plain merge-sort by `at` keeps ties stable
 *  (messages first — the sort is stable and messages come first in the input). */
function withMilestones(
  items: TimelineItem[],
  milestones: TimelineMilestone[] | undefined,
): TimelineItem[] {
  if (milestones === undefined || milestones.length === 0) return items;
  return [...items, ...milestones].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** A member's first name, or null when unknown. */
function firstNameOf(c: Contact | null): string | null {
  const f = c?.firstName?.trim();
  return f && f.length > 0 ? f : null;
}

export function TourConversation({
  tour,
  tenant,
  landlord,
  landlordId,
  channels,
  onOpenGroup,
  openGroupBusy,
  tourMilestones,
  noShowDraft,
}: TourConversationProps): React.JSX.Element {
  // Initial tab decided ONCE from the tour at first render; never re-synced.
  const [activeKey, setActiveKey] = useState<TourChannelKey>(
    tour.groupThreadId ? 'group' : 'tenant',
  );

  // "Send no-show check-in" seed: on a new nonce we (1) select the Tenant tab and
  // (2) hand seededBody to the tenant pane, bumping seedKey to REMOUNT it so the
  // Timeline initialDraft initializer picks up the copy. seededBody is cleared
  // once the pane reports it consumed the seed (onDraftSeeded), so a later manual
  // switch back to Tenant starts with an empty composer.
  const [seededBody, setSeededBody] = useState<string | null>(null);
  const [seedKey, setSeedKey] = useState(0);
  const lastSeedNonce = useRef(0);
  useEffect(() => {
    const nonce = noShowDraft?.nonce ?? 0;
    if (nonce > 0 && nonce !== lastSeedNonce.current) {
      lastSeedNonce.current = nonce;
      setActiveKey('tenant');
      setSeededBody(noShowDraft?.body ?? '');
      setSeedKey((k) => k + 1);
    }
  }, [noShowDraft?.nonce, noShowDraft?.body]);

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

  const isPm = tour.tourType === 'pm_team';
  const tenantFirst = firstNameOf(tenant);
  const landlordFirst = firstNameOf(landlord);
  const tabs: { key: TourChannelKey; label: string; unread: number }[] = [
    { key: 'group', label: 'Group text', unread: channels.group.unread },
    {
      key: 'tenant',
      label: tenantFirst ? `Tenant - ${tenantFirst}` : 'Tenant',
      unread: channels.tenant.unread,
    },
    {
      key: 'landlord',
      label: isPm
        ? landlordFirst
          ? `PM - ${landlordFirst}`
          : 'PM'
        : landlordFirst
          ? `Landlord - ${landlordFirst}`
          : 'Landlord',
      unread: channels.landlord.unread,
    },
  ];

  const tenantName = tenant
    ? contactDisplayName(tenant.firstName, tenant.lastName, tenant.phone)
    : 'the tenant';
  const landlordName = landlord
    ? contactDisplayName(landlord.firstName, landlord.lastName, landlord.phone)
    : isPm
      ? 'the property manager'
      : 'the landlord';

  const groupDead = tour.status === 'canceled' || tour.status === 'closed';
  const oneToOneKey: 'tenant' | 'landlord' = activeKey === 'landlord' ? 'landlord' : 'tenant';
  const oneToOneContactId = activeKey === 'landlord' ? landlordId : tour.tenantId;
  const oneToOneName = activeKey === 'landlord' ? landlordName : tenantName;
  // The 1:1 composer footer shows WHO the reply sends to (the contact's number,
  // same as the contact page's reply box); the group tab passes none - its
  // composer matches ConversationDetail's group view.
  const oneToOnePhone = activeKey === 'landlord' ? landlord?.phone : tenant?.phone;

  // The no-show check-in seed reaches the TENANT 1:1 composer ONLY: guarded by
  // isTenantChannel so the landlord/PM pane never receives it (its key suffix is
  // the constant 'x', so a seedKey bump never remounts it), and cleared to
  // undefined once consumed (seededBody null) so a later Tenant remount is empty.
  const isTenantChannel = oneToOneKey === 'tenant';
  const tenantSeed = isTenantChannel && seededBody !== null ? seededBody : undefined;

  // Just-in-time consent gate (ContactDetail parity): the refused send held while
  // the ConsentCaptureModal is open, and a per-channel clear-draft signal for the
  // post-consent retry (per-channel so the OTHER tab's in-progress draft is never
  // wiped by this one's retry landing).
  const [pendingConsent, setPendingConsent] = useState<PendingConsentSend | null>(null);
  const [clearSignals, setClearSignals] = useState<{ tenant: number; landlord: number }>({
    tenant: 0,
    landlord: 0,
  });

  // Consent recorded → retry the EXACT refused send out-of-band of the composer
  // (the composer restored its draft on the 409; the clear signal removes it once
  // the retry lands — a fresh failure leaves the draft, nothing is lost). The
  // sent message itself arrives via the thread's SSE-driven refetch. The modal's
  // updated Contact is ignored here: tenant/landlord are parent-owned props and
  // the tour page displays no consent state.
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
            <GroupChannel
              conversationId={active.conversationId}
              {...(tourMilestones !== undefined && { tourMilestones })}
            />
          ) : (
            <div className={styles.channelEmpty}>
              <p className={styles.emptyTitle}>No group text yet</p>
              <p className={styles.emptyNote}>
                Open a masked group text with the tenant and landlord to coordinate the visit.
              </p>
              <Button
                size="sm"
                type="button"
                onClick={onOpenGroup}
                disabled={openGroupBusy || groupDead}
              >
                {openGroupBusy ? 'Opening...' : 'Open group text'}
              </Button>
              {groupDead ? (
                <p className={styles.emptyNote}>
                  This tour is {tour.status} - a group text cannot be opened.
                </p>
              ) : null}
            </div>
          )
        ) : oneToOneContactId === undefined ? (
          <div className={styles.channelEmpty}>
            <p className={styles.emptyNote}>
              The landlord for this property is not resolved yet.
            </p>
          </div>
        ) : active.conversationId !== null ? (
          // key by conversation identity so switching the Tenant<->Landlord 1:1
          // REMOUNTS a fresh Timeline. Both tabs render <ContactThread> at the same
          // JSX position; without a key React reuses the fiber and Timeline's
          // in-progress draft survives the switch, so a Send would post it to the
          // newly-selected party. Also clears the stale-transcript flash (MINOR 3).
          <ContactThread
            key={`${active.conversationId}:${isTenantChannel ? seedKey : 'x'}`}
            conversationId={active.conversationId}
            {...(oneToOnePhone !== undefined && { replyToPhone: oneToOnePhone })}
            {...(tourMilestones !== undefined && { tourMilestones })}
            clearDraftSignal={clearSignals[oneToOneKey]}
            {...(tenantSeed !== undefined && { initialDraft: tenantSeed })}
            onDraftSeeded={() => setSeededBody(null)}
            onConsentRefused={(body, attachmentKeys, attachmentOriginalKeys) =>
              setPendingConsent({
                key: oneToOneKey,
                contactId: oneToOneContactId,
                name: oneToOneName,
                conversationId: active.conversationId,
                body,
                ...(attachmentKeys !== undefined &&
                  attachmentKeys.length > 0 && { attachmentKeys }),
                ...(attachmentOriginalKeys !== undefined &&
                  attachmentOriginalKeys.length > 0 && { attachmentOriginalKeys }),
              })
            }
          />
        ) : (
          // key by channel so a create-on-demand Tenant/Landlord tab also remounts
          // on switch (conversationId is null here, so it cannot key the pane).
          <NewContactThread
            key={`${activeKey}:${isTenantChannel ? seedKey : 'x'}`}
            contactId={oneToOneContactId}
            name={oneToOneName}
            {...(oneToOnePhone !== undefined && { replyToPhone: oneToOnePhone })}
            {...(tourMilestones !== undefined && { tourMilestones })}
            onCreated={(id) => channels.setConversationId(activeKey, id)}
            clearDraftSignal={clearSignals[oneToOneKey]}
            {...(tenantSeed !== undefined && { initialDraft: tenantSeed })}
            onDraftSeeded={() => setSeededBody(null)}
            onConsentRefused={(body, attachmentKeys, attachmentOriginalKeys) =>
              setPendingConsent({
                key: oneToOneKey,
                contactId: oneToOneContactId,
                name: oneToOneName,
                conversationId: null,
                body,
                ...(attachmentKeys !== undefined &&
                  attachmentKeys.length > 0 && { attachmentKeys }),
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
function GroupChannel({
  conversationId,
  tourMilestones,
}: {
  conversationId: string;
  tourMilestones?: TimelineMilestone[];
}): React.JSX.Element {
  const thread = useRelayThread(conversationId);
  const items = useMemo(
    () => withMilestones(thread.items, tourMilestones),
    [thread.items, tourMilestones],
  );
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
      items={items}
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
  tourMilestones,
  clearDraftSignal,
  initialDraft,
  onDraftSeeded,
  onConsentRefused,
}: {
  conversationId: string;
  /** The contact's number, shown in the composer footer ("Reply sends to ..."). */
  replyToPhone?: string;
  /** Tour lifecycle pins to interleave with the messages. */
  tourMilestones?: TimelineMilestone[];
  /** Post-consent retry landed → clear the draft the 409 refusal restored. */
  clearDraftSignal?: number;
  /** Seed the composer once on mount (no-show check-in prefill). */
  initialDraft?: string;
  /** Fired once when a non-empty initialDraft seeded the composer. */
  onDraftSeeded?: () => void;
  /** The consent gate refused this send (409 contact_no_consent) — the parent
   *  opens the capture modal holding it. Still rethrown so the composer restores
   *  the draft (the modal shows WHY; no inline error — ContactDetail parity). */
  onConsentRefused?: (
    body: string,
    attachmentKeys?: string[],
    attachmentOriginalKeys?: string[],
  ) => void;
}): React.JSX.Element {
  const thread = useRelayThread(conversationId);
  const items = useMemo(
    () => withMilestones(thread.items, tourMilestones),
    [thread.items, tourMilestones],
  );
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
      items={items}
      source="server"
      canSend
      onSend={onSend}
      {...(replyToPhone !== undefined && { replyToPhone })}
      {...(clearDraftSignal !== undefined && { clearDraftSignal })}
      {...(initialDraft !== undefined && { initialDraft })}
      {...(onDraftSeeded !== undefined && { onDraftSeeded })}
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
  tourMilestones,
  onCreated,
  clearDraftSignal,
  initialDraft,
  onDraftSeeded,
  onConsentRefused,
}: {
  contactId: string;
  name: string;
  /** The contact's number, shown in the composer footer ("Reply sends to ..."). */
  replyToPhone?: string;
  /** Tour lifecycle pins — shown even before the first message exists. */
  tourMilestones?: TimelineMilestone[];
  onCreated: (conversationId: string) => void;
  /** Post-consent retry landed → clear the draft the 409 refusal restored. */
  clearDraftSignal?: number;
  /** Seed the composer once on mount (no-show check-in prefill). */
  initialDraft?: string;
  /** Fired once when a non-empty initialDraft seeded the composer. */
  onDraftSeeded?: () => void;
  /** The consent gate refused this send — see ContactThread. */
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
      items={tourMilestones ?? []}
      source="server"
      canSend
      onSend={onSend}
      {...(replyToPhone !== undefined && { replyToPhone })}
      {...(clearDraftSignal !== undefined && { clearDraftSignal })}
      {...(initialDraft !== undefined && { initialDraft })}
      {...(onDraftSeeded !== undefined && { onDraftSeeded })}
      emptyLabel={`No messages with ${name} yet`}
      resetScrollKey={`new:${contactId}`}
    />
  );
}
