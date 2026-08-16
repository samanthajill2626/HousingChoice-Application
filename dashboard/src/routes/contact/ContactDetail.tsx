// ContactDetail — the shared shell for the contact detail page (tenant /
// landlord / untriaged). A near-black header band (avatar - name - KIND pill -
// facts - Call ▾ - ⋯) over a two-pane body: comms-LEFT (ContactCommsPane) /
// file-RIGHT.
//
// KIND, not a binary: a three-way `kind` (landlord/pm → landlord, unknown →
// unknown, else → tenant) chooses the file pane (TenantFile / LandlordFile /
// UnknownFile) and pill colour; the pill/badge LABEL is `displayKind` = role ??
// type, so a custom kind (e.g. "Case worker", base type tenant) reads its role.
// Custom kinds layer on a base type — see 2026-06-18-extensible-contact-creation.
// UnknownFile leads with a triage CTA (Mark as Tenant/Landlord → PATCH type).
//
// Type-AGNOSTIC cards rendered here for every kind: Relationships, Custom fields.
// Comms: the LEFT pane is ContactCommsPane (extracted 2026-08-03 and shared with
// the tour/placement 1:1 tabs) - it owns reply-target resolution, the optimistic
// send, email compose, retry, consent capture and the deleted-composer lock. This
// page keeps the hook that feeds it (useContactTimeline) because it ALSO derives
// "Media from comms" from those items and refetches after its own mutations
// (status, opt-out, phone/suggestion changes). Narrow widths lead with comms + a
// segmented Comms | Profile toggle.
// Behaviours documented in 2026-06-18-contact-comms-and-listings-refinements.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useContacts } from '../contacts/useContacts.js';
import {
  ApiError,
  deleteContact,
  restoreContact,
  runExtraction,
  setContactOptOut,
  setContactVoiceOptOut,
  setTenantStatus,
  suggestionResolutionErrorMessage,
  updateContact,
  useEventStream,
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  type ContactType,
  type LandlordStatus,
  type TenantStatus,
} from '../../api/index.js';
import {
  Button,
  ContactStatusBadge,
  Spinner,
  StatusMenu,
  contactStatusTone,
} from '../../ui/index.js';
import { Modal } from './Modal.js';
import { ContactCommsPane } from './ContactCommsPane.js';
import { TenantFile } from './TenantFile.js';
import { LandlordFile } from './LandlordFile.js';
import { UnknownFile } from './UnknownFile.js';
import { PartnerFile } from './PartnerFile.js';
import { ContactActionsMenu } from './ContactActionsMenu.js';
import { ContactEditForm } from './ContactEditForm.js';
import { PhoneManager } from './PhoneManager.js';
import { PlacementCreateForm } from '../placements/PlacementCreateForm.js';
import { ScheduleTourForm } from '../tours/ScheduleTourForm.js';
import { UnitCreateForm } from '../listing/UnitCreateForm.js';
import { CallMenu } from './CallMenu.js';
import { useMe } from '../../app/useMe.js';
import { VOICE_TAB_PATH } from '../settings/settingsTabs.js';
import { commsMedia } from './media.js';
import { useContact } from './useContact.js';
import { SUGGESTION_NOT_PENDING, useSuggestions } from './useSuggestions.js';
import { SuggestionChip } from './SuggestionChip.js';
import { SUGGESTION_TARGET_LABEL, suggestionFor } from './suggestionTargets.js';
import { useContactTimeline } from './useContactTimeline.js';
import { useContactFile } from './useContactFile.js';
import { useMarkContactRead } from './useMarkContactRead.js';
import { contactDisplayName } from './format.js';
import { contactPhones, defaultPhone } from './contactPhones.js';
import { landlordUnits } from './buildContactFile.js';
import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';
import { RelationshipsCard } from './RelationshipsCard.js';
import { CustomFieldsCard } from './CustomFieldsCard.js';
import styles from './ContactDetail.module.css';

type Pane = 'comms' | 'profile';

/** How long the manual-extraction indicator waits before it stops claiming to
 *  know (manual-extraction-trigger 4.6). Comfortably above the observed 5-40s
 *  (a 30s worker poll plus the run itself), because the poll can be delayed by a
 *  long-running row ahead of this one in the same pass. Exported for the test. */
export const RUN_INDICATOR_TIMEOUT_MS = 180_000;

/** The manual-run indicator's three states. `running` accumulates across the
 *  press's scheduled threads: it resolves only once EVERY one has reported, so
 *  one failing thread cannot hide what the others found. */
type ExtractionState =
  | { phase: 'idle' }
  | {
      phase: 'running';
      /** '' until the POST answers - no event can match an empty key, which is
       *  what keeps a same-instant unrelated run from resolving this press. */
      requestId: string;
      pending: Set<string>;
      wrote: number;
      suggested: number;
      /** Threads the server could not queue at all (a partial-failure 200). */
      failedThreads: number;
      errorKind?: string;
    }
  | {
      phase: 'done';
      tone: 'status' | 'alert';
      message: string;
      /** Carried through from the running state: a thread that was never queued
       *  is one no run is coming for, and dropping the fact at resolution would
       *  leave the operator with an outcome that silently omits it. */
      failedThreads?: number;
    };

/** The partial-failure sentence, identical in the running and resolved states. */
function failedThreadsCopy(failedThreads: number): string {
  if (failedThreads <= 0) return '';
  return ` ${failedThreads} thread${failedThreads === 1 ? '' : 's'} could not be queued.`;
}

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
  // The manual "Run AI extraction" press and its indicator (4.6). Session-local:
  // a reload shows the current facts instead, which by then are usually the
  // result of the run.
  const [extraction, setExtraction] = useState<ExtractionState>({ phase: 'idle' });

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
    // Same reason: a manual run pressed on contact A must not appear to be
    // running on contact B (its requestId could never resolve here anyway).
    setExtraction({ phase: 'idle' });
  }, [contactId]);
  // The current navigator's voice self-view — gates the masked-call control on
  // "has a verified cell" (the CallMenu prompts them to set one otherwise).
  const { hasVerifiedCell } = useMe();
  const timeline = useContactTimeline(contactId);
  const file = useContactFile(contactId, { contactType: contact?.type });
  // Viewing the contact page (while the tab is visible) marks its comms read —
  // so the Inbox unread badge clears once you've actually seen the messages here.
  useMarkContactRead(contactId);

  // --- Manual AI extraction (manual-extraction-trigger 4.6) ------------------
  // These three hooks MUST stay above the loading/error early returns below, or
  // the page renders a different number of hooks per pass and crashes.

  const onRunExtraction = useCallback(async (): Promise<void> => {
    // Busy from the PRESS, not from the response: otherwise a double-click fires
    // two POSTs before the first one resolves.
    setExtraction({
      phase: 'running',
      requestId: '',
      pending: new Set(),
      wrote: 0,
      suggested: 0,
      failedThreads: 0,
    });
    try {
      const res = await runExtraction(contactId);
      setExtraction({
        phase: 'running',
        requestId: res.requestId,
        pending: new Set(res.scheduled),
        wrote: 0,
        suggested: 0,
        failedThreads: res.failed.length,
      });
    } catch (err) {
      // The server is the only gate (4.6), so every refusal arrives here rather
      // than being predicted client-side.
      setExtraction({ phase: 'done', tone: 'alert', message: extractionRefusalCopy(err) });
    }
  }, [contactId]);

  // Resolution waits for EVERY scheduled thread before it decides, so one
  // failing thread does not hide what the others found. An event carrying some
  // other requestId is ignored - that is what stops an unrelated inbound run
  // resolving this operator's indicator.
  useEventStream({
    onAiRunCompleted: (e) => {
      setExtraction((prev) => {
        if (prev.phase !== 'running' || !prev.requestId || e.requestId !== prev.requestId) {
          return prev;
        }
        const pending = new Set(prev.pending);
        pending.delete(e.conversationId);
        const wrote = prev.wrote + e.wrote;
        const suggested = prev.suggested + e.suggested;
        // First failure wins the copy; 'driver' stands for "failed, kind not
        // reported" and maps to the generic sentence.
        const errorKind =
          prev.errorKind ?? (e.outcome === 'failed' ? (e.errorKind ?? 'driver') : undefined);
        if (pending.size > 0) {
          return { ...prev, pending, wrote, suggested, ...(errorKind !== undefined && { errorKind }) };
        }
        const unqueued = prev.failedThreads > 0 ? { failedThreads: prev.failedThreads } : {};
        if (errorKind !== undefined) {
          return {
            phase: 'done',
            tone: 'alert',
            message: extractionFailureCopy(errorKind),
            ...unqueued,
          };
        }
        return {
          phase: 'done',
          tone: 'status',
          message: extractionAppliedCopy(wrote, suggested),
          ...unqueued,
        };
      });
    },
  });

  // The indicator must never spin forever: the event can be legitimately late
  // (an inbound message sliding dueAt forward) or lost (an unset
  // EVENT_BRIDGE_URL drops the worker-to-app hop). Keyed on `phase` only, so the
  // POST answering mid-run does not restart the clock.
  useEffect(() => {
    if (extraction.phase !== 'running') return undefined;
    const timer = setTimeout(() => {
      setExtraction((prev) => ({
        phase: 'done',
        tone: 'status',
        message: 'Still running - check Settings > AI runs.',
        ...(prev.phase === 'running' && prev.failedThreads > 0
          ? { failedThreads: prev.failedThreads }
          : {}),
      }));
    }, RUN_INDICATOR_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [extraction.phase]);

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

  // Soft-deleted contact: the header shows a badge + banner, the status pill goes
  // display-only, and the comms pane locks its composer (restore to reply - the
  // server also refuses with 409 contact_deleted). The pane re-derives this from
  // the contact it holds; this copy serves the page chrome.
  const deleted = typeof contact.deleted_at === 'string' && contact.deleted_at.length > 0;

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

  // Every accept/dismiss failure lands on the chip the navigator clicked. The
  // resolution routes answer with a whole vocabulary of codes across 400/404/409
  // and `ApiError.message` is the RAW code, so the copy always comes from the
  // resolver; an unrecognised failure gets its generic retry sentence rather than
  // silence (a chip that just re-enables reads as "nothing happened").
  const failSuggestion = (target: string, err: unknown): void => {
    if (err instanceof ApiError) {
      setSuggestionError({ target, message: suggestionResolutionErrorMessage(err.code) });
      // These three answer with a list that has genuinely moved on: two of them
      // PROMISE "the list now shows its real state", and a refused accept has
      // already deleted the row server-side. The server DOES emit
      // `suggestion.updated` for `suggestion_field_edited` now, and for any
      // request that helped somebody else's journal commit - the
      // `helped || refused` emit in the suggestions router's shared error path
      // (named rather than cited by line, so an edit above it cannot silently
      // repoint this reference). Neither covers a plain `no_pending_suggestion`
      // or `suggestion_already_resolved`, and no emit reaches a tab whose SSE
      // stream has dropped, so the refetch is what makes the answer true HERE.
      // The remaining codes describe a live in-flight resolution and promise
      // nothing about the list.
      if (
        err.code === 'no_pending_suggestion' ||
        err.code === 'suggestion_already_resolved' ||
        err.code === 'suggestion_field_edited'
      ) {
        suggestions.refetch();
      }
      return;
    }
    if (err instanceof Error && err.message === SUGGESTION_NOT_PENDING) {
      // Our own list is stale - the same answer the server's 404 gives, plus a
      // refetch so the chip that can no longer be acted on corrects itself.
      setSuggestionError({
        target,
        message: suggestionResolutionErrorMessage('no_pending_suggestion'),
      });
      suggestions.refetch();
      return;
    }
    // Not from the API at all (a network drop, a bug): generic, never silent.
    setSuggestionError({ target, message: suggestionResolutionErrorMessage('') });
  };

  // Accept an AI suggestion. The route RETURNS the updated contact (with the value
  // written + `<field>_source` provenance) plus the remaining suggestions, so we
  // apply the contact in place (setContact) - the badge appears and the chip drops.
  // On failure the chip stays put, carrying the reason.
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
      .catch((err: unknown) => failSuggestion(target, err))
      .finally(() => setSuggestionBusy(null));
  };
  const onDismissSuggestion = (target: string): void => {
    if (suggestionBusy !== null) return;
    setSuggestionBusy(target);
    setSuggestionError(null);
    void suggestions
      .dismiss(target)
      .catch((err: unknown) => failSuggestion(target, err))
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
  // (`deleted` itself is computed higher up; onRestore is also handed to the
  // comms pane, whose locked-composer note renders the same action.)
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
            onRunExtraction={() => void onRunExtraction()}
            extractionBusy={extraction.phase === 'running'}
          />
        </div>
      </header>

      {deleted ? (
        <div className={styles.deletedBanner} role="status">
          <span>
            This contact is <strong>deleted</strong> — hidden from the contact lists,
            inbox, and today. If they message again, the thread resurfaces in the
            inbox until read. Data is retained.
          </span>
          <Button variant="secondary" size="sm" type="button" onClick={onRestore} disabled={deleteBusy}>
            Restore
          </Button>
        </div>
      ) : null}

      {/* The manual AI extraction indicator (4.6). This is the operator's ONLY
          feedback that the press did anything, so it is load-bearing. The
          aria-label keeps it distinguishable from the page's Spinners, which
          also carry role="status". */}
      {extraction.phase === 'running' ? (
        <div className={styles.extractionBanner} role="status" aria-label="AI extraction">
          <span>
            {`Running AI extraction${extraction.pending.size > 1 ? ` on ${extraction.pending.size} threads` : ''}...`}
            {failedThreadsCopy(extraction.failedThreads)}
          </span>
        </div>
      ) : null}
      {extraction.phase === 'done' ? (
        <div className={styles.extractionBanner} role={extraction.tone} aria-label="AI extraction">
          <span>{`${extraction.message}${failedThreadsCopy(extraction.failedThreads ?? 0)}`}</span>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => setExtraction({ phase: 'idle' })}
          >
            Dismiss
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
          {/* key= REMOUNTS the pane when the route param changes: this page
              re-renders the SAME component instance on contact-to-contact
              navigation (no remount), so the pane's LOCAL state - the composer
              draft, the uploaded attachment chips (outbound MMS), and the picked
              reply target - would otherwise survive into the NEXT contact's pane
              and a Send would deliver contact A's media into contact B's thread.
              Same keyed isolation the tour channel switcher uses. */}
          <ContactCommsPane
            key={contactId}
            contact={contact}
            timeline={timeline}
            resetScrollKey={contactId}
            onContactUpdated={setContact}
            onRestore={onRestore}
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
                groupThreadsPending={file.groupThreads.status !== 'ready'}
                groupThreads={file.groupThreads.status === 'ready' ? file.groupThreads.rows : []}
                groupThreadsTruncated={file.groupThreadsTruncated}
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
                groupThreadsPending={file.groupThreads.status !== 'ready'}
                groupThreads={file.groupThreads.status === 'ready' ? file.groupThreads.rows : []}
                groupThreadsTruncated={file.groupThreadsTruncated}
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
                groupThreadsPending={file.groupThreads.status !== 'ready'}
                groupThreads={file.groupThreads.status === 'ready' ? file.groupThreads.rows : []}
                groupThreadsTruncated={file.groupThreadsTruncated}
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
                groupThreadsPending={file.groupThreads.status !== 'ready'}
                groupThreads={file.groupThreads.status === 'ready' ? file.groupThreads.rows : []}
                groupThreadsTruncated={file.groupThreadsTruncated}
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
            If they message you again, the conversation resurfaces in the inbox so you can
            review it. Nothing is erased — you can restore them from the Contacts{' '}
            <em>Deleted</em> view.
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

// --- Manual-extraction copy (manual-extraction-trigger 4.6) ------------------
// Every string here is written in the operator's terms, never the job's enum.
// The message catalog does not cover this surface: it carries outbound contact
// copy on the sms/voice/email channels, not dashboard banners.

/** The aggregate a finished run reports. `wrote` are fields the run applied
 *  itself; `suggested` are the ones parked as review chips. */
function extractionAppliedCopy(wrote: number, suggested: number): string {
  if (wrote + suggested === 0) return 'Ran - nothing new to extract.';
  return `Updated ${wrote} field${wrote === 1 ? '' : 's'}, ${suggested} suggestion${suggested === 1 ? '' : 's'}.`;
}

/** `truncated` gets its own actionable sentence: it is the one failure an
 *  operator can do something about, and the likeliest one here - a manual run
 *  waives the age cutoff, so it sends the widest windows the system produces. */
function extractionFailureCopy(errorKind: string): string {
  return errorKind === 'truncated'
    ? 'Extraction ran out of room - the transcript may be too long.'
    : 'Extraction failed - see Settings > AI runs.';
}

/** A refusal from the endpoint. `ApiError.message` is the RAW code and must
 *  never be shown, so the copy always comes from `.code`; an unrecognised
 *  failure (including a network drop, which is not an ApiError at all) gets the
 *  generic retry sentence rather than silence. */
function extractionRefusalCopy(err: unknown): string {
  const code = err instanceof ApiError ? err.code : undefined;
  switch (code) {
    case 'extraction_disabled':
      return 'AI extraction is turned off for this environment.';
    case 'ineligible_contact_type':
      return 'Only tenants and untriaged contacts can be extracted.';
    case 'contact_deleted':
      return 'This is a deleted contact.';
    case 'contact_not_found':
      return 'This contact could not be found.';
    case 'no_conversations':
      return 'This contact has no conversations to extract.';
    case 'no_eligible_conversations':
      return 'This contact has no eligible conversations to extract.';
    default:
      return 'Extraction could not be started - try again.';
  }
}
