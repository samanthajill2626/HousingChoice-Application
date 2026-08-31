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
// UnknownFile leads with a four-kind triage CTA through the canonical PATCH map.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useContacts } from '../contacts/useContacts.js';
import {
  ApiError,
  deleteContact,
  markInboxRead,
  markInboxUnread,
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
  type AiRunCompletedEvent,
  type ConversationUpdatedEvent,
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
import { CreateRelayGroupModal } from './CreateRelayGroupModal.js';
import { PhoneManager } from './PhoneManager.js';
import { PlacementCreateForm } from '../placements/PlacementCreateForm.js';
import { ScheduleTourForm } from '../tours/ScheduleTourForm.js';
import { UnitCreateForm } from '../listing/UnitCreateForm.js';
import { CallMenu } from './CallMenu.js';
import { useMe } from '../../app/useMe.js';
import { VOICE_TAB_PATH } from '../settings/settingsTabs.js';
import { useContactMedia } from './useContactMedia.js';
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
import {
  CONTACT_TYPE_LABEL,
  displayKind,
  patchForSuggestedContactKind,
  type SuggestedContactKind,
} from './contactProfile.js';
import { RelationshipsCard } from './RelationshipsCard.js';
import { CustomFieldsCard } from './CustomFieldsCard.js';
import styles from './ContactDetail.module.css';

type Pane = 'comms' | 'profile';

/** How long the manual-extraction indicator waits before it stops claiming to
 *  know (manual-extraction-trigger 4.6). Comfortably above the observed 5-40s
 *  (a 30s worker poll plus the run itself), because the poll can be delayed by a
 *  long-running row ahead of this one in the same pass. Exported for the test. */
export const RUN_INDICATOR_TIMEOUT_MS = 180_000;

/** Retryable, not diagnostic. A 409 on this route is the expected
 *  participant-GSI-lag path, so the copy asks for a retry and the kebab item
 *  stays available. Every other failure gets the same treatment - there is
 *  nothing an operator can do with a status code. */
export const MARK_UNREAD_ERROR = 'Could not mark unread - try again';
/** The same treatment for the other direction. */
export const MARK_READ_ERROR = 'Could not mark read - try again';
/** ONE 404, TWO causes - so the copy has to carry both (human ruling,
 *  2026-08-18, after planner review found the earlier terminal-only wording).
 *
 *  The kebab offers "Mark unread" on every non-deleted contact and the route
 *  answers 404 `no_conversation_for_contact` in two situations that are
 *  indistinguishable from here:
 *
 *  1. PERMANENT and ordinary - the contact has no eligible thread at all (an
 *     imported landlord, nobody has messaged them, their only threads are closed
 *     or relay-only). Large class. "Try again" is nonsense advice for it.
 *  2. TRANSIENT - the participant-GSI lookup lagged and returned nothing for a
 *     contact who does have a thread. Narrow window, right after an inbound, and
 *     a second press succeeds. Telling this operator nothing can be done is
 *     equally wrong, in the other direction.
 *
 *  The server cannot separate them either: under lag the index returns the same
 *  empty set as a genuinely thread-less contact, so a distinct status code would
 *  be a guess wearing a number. The copy therefore states the common cause and
 *  leaves the retry door open, and the action stays enabled either way. The item
 *  is NOT hidden: this page has no reliable way to know which case it is, and a
 *  hidden-but-actually-available action is worse than an honest refusal. */
export const MARK_UNREAD_NO_THREAD =
  'No thread to mark unread yet - if this contact has messages, try again.';

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
      /** How many threads the press SCHEDULED. Fixed for the life of the run -
       *  `pending` shrinks as each thread reports, so reading the count off it
       *  would silently drop "on 3 threads" back to "..." after two reported
       *  (4.6 state 1 names `scheduled`, not what is left). */
      scheduledCount: number;
      wrote: number;
      suggested: number;
      /** Note lines the run(s) appended. A run whose ONLY output is notes is
       *  outcome `applied` in the job, so the resolved copy must be able to say
       *  so rather than reporting "nothing new". */
      noted: number;
      /** Threads the server could not queue at all (a partial-failure 200). */
      failedThreads: number;
      /** Threads whose run resolved to a DIFFERENT contact than this page (the
       *  conversation's participant contactId diverges from the phone roster -
       *  see docs/issues/extraction-conversation-contact-divergence.md). The
       *  facts landed on that other record; silently timing out here would hide
       *  a billed, committed write. */
      misfiled: number;
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
  // The "Create a relay group" dialog, seeded with this contact as a locked
  // member (tenant + landlord files; the other kinds have no relay card).
  const [creatingRelayGroup, setCreatingRelayGroup] = useState(false);
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
  // Which press an in-flight POST still belongs to. The POST resolves on its own
  // clock, so without this its response would write the indicator even after the
  // operator navigated to another contact (A's outcome rendered on B's page, and
  // B's kebab item disabled) or after the 180s timeout already resolved it. Every
  // press, every contact change and the timeout bump it, so a late response is
  // dropped rather than resurrecting a run nobody is watching.
  const pressGenerationRef = useRef(0);
  // ai_run.completed events seen since the CURRENT press began (cleared at
  // press time), so one that beats the POST response can be replayed once the
  // response names this press's requestId - the state machine drops events
  // while requestId is still ''. Staleness across presses is prevented by the
  // per-press server-minted UUID, not by the size cap; the cap only bounds a
  // same-window org-wide burst, since every client receives every run event.
  const recentRunEventsRef = useRef<AiRunCompletedEvent[]>([]);
  // D6's derived unread state. THERE IS NO UNREAD DATUM ON THIS PAGE and none is
  // added: the mount fan-out marks EVERY thread of this contact read, so "read"
  // is the state the page starts in, and only a conversation.updated carrying a
  // POSITIVE count for one of this contact's own threads can move it. A SKIPPED
  // (background tab) or FAILED fan-out therefore leaves this false, i.e. UNKNOWN
  // rendered as "Mark unread" - the safe default, since the server refuses if
  // that turns out to be wrong. Those two cases are indistinguishable from
  // "read" on screen ON PURPOSE: both offer the same action.
  const [hasUnread, setHasUnread] = useState(false);
  const [unreadAction, setUnreadAction] = useState<'idle' | 'read' | 'unread'>('idle');
  const [unreadError, setUnreadError] = useState<string | null>(null);
  // Which contact the in-flight unread toggle still belongs to - the same
  // generation guard pressGenerationRef gives the extraction action, for the
  // same hazard: this component is RE-RENDERED, not remounted, across a
  // contactId change, and the toggle awaits a drain (up to 2s) plus a round
  // trip, so its resolution can land after the operator has clicked through to
  // another contact. Unguarded that resolution yanks them to /inbox or writes
  // A's error banner onto B's page.
  //
  // A SEPARATE counter from pressGenerationRef on purpose: that one is bumped by
  // every extraction press and by the 180s run timeout, so sharing it would make
  // the two independent actions cancel each other (running an extraction would
  // silently swallow the mark-unread's navigation). Only the contact change
  // below bumps this one, which is the only event that invalidates a press.
  const unreadGenerationRef = useRef(0);

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
    // running on contact B. Resetting the state is not enough on its own - A's
    // POST is still in flight and would write B's indicator when it lands - so
    // the press generation is bumped too, which invalidates that response.
    setExtraction({ phase: 'idle' });
    pressGenerationRef.current += 1;
    // Same reason again: contact A's unread state, pending action and error copy
    // must not be read as contact B's. Resetting the state is not enough on its
    // own here either - A's drain and POST are still in flight - so the unread
    // generation is bumped too, which invalidates that resolution.
    setHasUnread(false);
    setUnreadAction('idle');
    setUnreadError(null);
    unreadGenerationRef.current += 1;
  }, [contactId]);
  // The current navigator's voice self-view — gates the masked-call control on
  // "has a verified cell" (the CallMenu prompts them to set one otherwise).
  const { hasVerifiedCell } = useMe();
  const timeline = useContactTimeline(contactId);
  const file = useContactFile(contactId, { contactType: contact?.type });
  // Viewing the contact page (while the tab is visible) marks its comms read —
  // so the Inbox unread badge clears once you've actually seen the messages here.
  // The returned handle is what the kebab's mark-UNREAD action awaits, so this
  // auto-read cannot silently re-read the thread the operator just flagged.
  const autoRead = useMarkContactRead(contactId);

  // --- D6: the derived unread state -----------------------------------------
  // These hooks MUST stay above the loading/error early returns below, for the
  // same reason the extraction ones do.
  //
  // WHICH conversations count as this contact's. `timeline.items` is the only
  // place the page holds conversation ids at all (`useContact` returns a bare
  // Contact). Held in a REF so the SSE handler below keeps ONE stable identity:
  // an identity that churned with every timeline page would re-register on the
  // event stream on every render. Milestone items carry no conversationId;
  // call/scheduled items carry an optional one.
  const timelineConversationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of timeline.items) {
      if (item.kind === 'milestone') continue;
      if (typeof item.conversationId === 'string' && item.conversationId.length > 0) {
        ids.add(item.conversationId);
      }
    }
    return ids;
  }, [timeline.items]);
  const timelineIdsRef = useRef(timelineConversationIds);
  // Written in a PASSIVE EFFECT, not during render (useEventStream carries the
  // same rule for the same reason): a ref written in render holds a value from a
  // render React may throw away under concurrent rendering. Nothing is lost by
  // waiting for the commit - the SSE handler reads the ref lazily, and an event
  // that arrives in the gap sees the PREVIOUS id set, whose only effect is to
  // drop an event for a conversation the timeline has only just learned about.
  // That is the handler's documented "no information" case, not a wrong answer.
  useEffect(() => {
    timelineIdsRef.current = timelineConversationIds;
  }, [timelineConversationIds]);

  const onConversationUpdated = useCallback((event: ConversationUpdatedEvent) => {
    // FILTERED to this contact's own threads: /api/events is one org-wide
    // firehose. An id we cannot match is NO INFORMATION (the timeline may still
    // be loading), never evidence that this contact is read.
    if (!timelineIdsRef.current.has(event.conversationId)) return;
    const count = event.unread_count;
    if (typeof count !== 'number' || !Number.isFinite(count)) return;
    setHasUnread(count > 0);
  }, []);
  useEventStream({ onConversationUpdated });

  const onToggleUnread = useCallback(async (): Promise<void> => {
    if (unreadAction !== 'idle') return;
    setUnreadError(null);
    // The contact this press is for. EVERY resolution below is gated on it still
    // being the current one; see unreadGenerationRef.
    const press = unreadGenerationRef.current;
    if (hasUnread) {
      // NO NAVIGATION. Marking the comms read while reading them is not a
      // departure - the operator is still here.
      setUnreadAction('read');
      try {
        await markInboxRead({ contactId });
        if (unreadGenerationRef.current !== press) return;
        // The fan-out just read every thread of this contact, which is exactly
        // the signal this derived state is built on.
        setHasUnread(false);
      } catch {
        if (unreadGenerationRef.current !== press) return;
        setUnreadError(MARK_READ_ERROR);
      } finally {
        // The contact-change reset already put this back to 'idle' for the
        // contact now on screen; writing it again would be harmless but the
        // rule is one rule.
        if (unreadGenerationRef.current === press) setUnreadAction('idle');
      }
      return;
    }
    setUnreadAction('unread');
    try {
      // BEFORE the POST, always. The page's own auto-read fires uncancelled on
      // mount, on visibilitychange and on every org-wide message.persisted, so
      // without the drain the operator's request can be silently re-read by one
      // already in flight - a no-op with a success response.
      await autoRead.suppressAndDrain();
      await markInboxUnread({ contactId });
    } catch (err) {
      // The operator has LEFT this contact: nothing below may run, because all
      // of it speaks about contact A on contact B's page. `autoRead.release()`
      // is skipped with the rest, and that is safe rather than merely tolerable
      // - the handle is keyed to the contact it was minted for (`release` only
      // clears the latch while `suppressedFor` still names that contact), and
      // the hook's own contact-change effect has already cleared it. There is
      // nothing left for the skipped call to do.
      if (unreadGenerationRef.current !== press) return;
      // We are STAYING on the page, so hand the auto-read back. Without this the
      // latch outlives the failed attempt and this contact's auto-read is dead
      // for the rest of the visit: message.persisted and visibilitychange stop
      // marking read, and a new inbound stays unread while the operator is
      // looking straight at it.
      autoRead.release();
      // Branch on the STATUS, never on message text (ApiError.message is the raw
      // code). 404 = this contact has no eligible thread, which no retry fixes.
      setUnreadError(
        err instanceof ApiError && err.status === 404 ? MARK_UNREAD_NO_THREAD : MARK_UNREAD_ERROR,
      );
      setUnreadAction('idle');
      return;
    }
    // Same guard on the success path: a POST that resolves after the operator
    // moved on must not yank them off the contact they are now reading. The
    // server write stands - it was correct for contact A - and A's inbox row is
    // unread, which is where the navigation would have taken them anyway.
    if (unreadGenerationRef.current !== press) return;
    navigate('/inbox');
  }, [autoRead, contactId, hasUnread, navigate, unreadAction]);

  // --- Manual AI extraction (manual-extraction-trigger 4.6) ------------------
  // These three hooks MUST stay above the loading/error early returns below, or
  // the page renders a different number of hooks per pass and crashes.

  const onRunExtraction = useCallback(async (): Promise<void> => {
    const press = (pressGenerationRef.current += 1);
    // The ring holds "events since THIS press began" - clearing it here is what
    // makes that true. Without the clear it accumulates every org-wide run
    // event forever and a burst could evict this press's own early event.
    recentRunEventsRef.current = [];
    // Busy from the PRESS, not from the response: otherwise a double-click fires
    // two POSTs before the first one resolves.
    setExtraction({
      phase: 'running',
      requestId: '',
      pending: new Set(),
      scheduledCount: 0,
      wrote: 0,
      suggested: 0,
      noted: 0,
      failedThreads: 0,
      misfiled: 0,
    });
    try {
      const res = await runExtraction(contactId);
      // Dropped when this press is no longer the current one - see
      // pressGenerationRef.
      if (pressGenerationRef.current !== press) return;
      setExtraction({
        phase: 'running',
        requestId: res.requestId,
        pending: new Set(res.scheduled),
        scheduledCount: res.scheduled.length,
        wrote: 0,
        suggested: 0,
        noted: 0,
        failedThreads: res.failed.length,
        misfiled: 0,
      });
      // Replay any completion event that arrived BEFORE the POST response.
      // The run happens on the worker poll seconds later, but the dev tick and
      // a stalled response can invert that order - and an event dropped here
      // could only ever resolve by the 180s timeout. The handler below records
      // every event it sees; events for this press are recognisable by the
      // requestId the response just gave us.
      const early = recentRunEventsRef.current.filter((ev) => ev.requestId === res.requestId);
      if (early.length > 0) {
        setExtraction((prev) => early.reduce((s, ev) => applyRunEvent(s, ev, contactId), prev));
      }
    } catch (err) {
      if (pressGenerationRef.current !== press) return;
      // The server is the only gate (4.6), so every refusal arrives here rather
      // than being predicted client-side.
      setExtraction({ phase: 'done', tone: 'alert', message: extractionRefusalCopy(err) });
    }
  }, [contactId]);

  // Resolution waits for EVERY scheduled thread before it decides, so one
  // failing thread does not hide what the others found. Three guards, each
  // closing a different way the wrong run could speak for this press (spec 7):
  //
  //  - requestId: an unrelated inbound run must not resolve this indicator.
  //  - contactId: a MISMATCH is this press's run resolved to ANOTHER contact
  //    (see the misfiled branch in applyRunEvent) - counted and reported, never
  //    silently dropped. A `no_contact` run carries no contactId at all and
  //    resolves normally.
  //  - pending membership: a thread the server could not queue sits in
  //    `failed[]` and no run is coming for it, so an event naming it must not
  //    add counts to a banner that simultaneously says it was never queued. It
  //    also makes a duplicate event for an already-reported thread a no-op.
  useEventStream({
    onAiRunCompleted: (e) => {
      // Recorded BEFORE the state update so an event that beats the POST
      // response is replayable once the response names this press's requestId.
      // A tiny ring: only same-instant events matter, never history.
      recentRunEventsRef.current = [...recentRunEventsRef.current.slice(-7), e];
      setExtraction((prev) => applyRunEvent(prev, e, contactId));
    },
  });

  // The indicator must never spin forever: the event can be legitimately late
  // (an inbound message sliding dueAt forward) or lost (an unset
  // EVENT_BRIDGE_URL drops the worker-to-app hop). Keyed on `phase` only, so the
  // POST answering mid-run does not restart the clock.
  useEffect(() => {
    if (extraction.phase !== 'running') return undefined;
    const timer = setTimeout(() => {
      // A POST slower than the timeout would otherwise land here and put the
      // page back into `running` with a fresh 180s clock.
      pressGenerationRef.current += 1;
      setExtraction((prev) => ({
        phase: 'done',
        // A misfiled thread is a KNOWN, billed outcome - the timeout must not
        // downgrade it to a bare "still running". Alert tone when present.
        tone: prev.phase === 'running' && prev.misfiled > 0 ? 'alert' : 'status',
        message:
          prev.phase === 'running' && prev.misfiled > 0
            ? `Still running - check Settings > AI runs.${misfiledClauseOf(prev.misfiled)}`
            : 'Still running - check Settings > AI runs.',
        ...(prev.phase === 'running' && prev.failedThreads > 0
          ? { failedThreads: prev.failedThreads }
          : {}),
      }));
    }, RUN_INDICATOR_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [extraction.phase]);

  // Load the full contact roster so the edit dialog can link relationships to
  // existing contacts (finding #1). Called unconditionally (hooks rules); the
  // 'all' filter fans out across tenant/landlord/partner/unknown. The current
  // contact is filtered out to prevent self-links (finding #5).
  const { contacts: allContacts } = useContacts('all');
  const editCandidates = useMemo(
    () => allContacts.filter((c) => c.contactId !== contactId),
    [allContacts, contactId],
  );

  // "Media from comms" reads the media pointer INDEX (useContactMedia, paged
  // by cursor, refetched on SSE message.persisted) - not the loaded timeline
  // page, which silently hid any attachment older than that page (2026-08-18).
  const mediaFeed = useContactMedia(contactId);
  const media = mediaFeed.items;
  const mediaLoading = mediaFeed.status === 'loading';
  const mediaPaging = useMemo(
    () => ({ hasMore: mediaFeed.hasMore, loadingMore: mediaFeed.loadingMore, onLoadMore: mediaFeed.loadMore }),
    [mediaFeed.hasMore, mediaFeed.loadingMore, mediaFeed.loadMore],
  );

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

  // ...and the same lock applies to the Relay groups card's "+ Create group":
  // the action's whole point is to text this contact (they are the LOCKED first
  // member of the group it creates), and the relay send path has no
  // deleted-contact gate of its own - `isMemberSuppressed` tests sms_opt_out and
  // per-phone STOP only. Withheld rather than disabled: the sibling card actions
  // carry no disabled state either, and a deleted file is a restore-first page.
  const relayCreateAction = deleted
    ? {}
    : { onCreateRelayGroup: (): void => setCreatingRelayGroup(true) };

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
  const onTriage = (kind: SuggestedContactKind): void => {
    if (triaging) return;
    setTriaging(true);
    void updateContact(contact.contactId, patchForSuggestedContactKind(kind))
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
            contactName={name}
            hasUnread={hasUnread}
            onToggleUnread={() => void onToggleUnread()}
            unreadBusy={unreadAction !== 'idle'}
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

      {/* D6's pending + failure surface. The kebab CLOSES on the press, like
          every item in it, so neither state can live in the menu - and this is
          the page's one banner region, which the operator already reads. On a
          failure the action itself stays available in the menu: a 409 here is
          the expected, retryable participant-GSI-lag path.

          NO aria-label on either region, deliberately: an accessible NAME on a
          live region REPLACES the announced content for some screen readers, so
          a label here makes the operator hear "Unread status" instead of the
          message that is the entire point of the announcement. */}
      {unreadAction !== 'idle' ? (
        <div className={styles.extractionBanner} role="status">
          <span>{unreadAction === 'unread' ? 'Marking unread...' : 'Marking read...'}</span>
        </div>
      ) : null}
      {unreadError !== null ? (
        <div className={styles.extractionBanner} role="alert">
          <span>{unreadError}</span>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => setUnreadError(null)}
          >
            Dismiss
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
            {`Running AI extraction${extraction.scheduledCount > 1 ? ` on ${extraction.scheduledCount} threads` : ''}...`}
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
                mediaPaging={mediaPaging}
                onEdit={() => setEditing(true)}
                onManagePhones={() => setManagingPhones(true)}
                onAddProperty={() => setAddingProperty(true)}
                {...relayCreateAction}
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
                mediaPaging={mediaPaging}
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
                mediaPaging={mediaPaging}
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
                mediaPaging={mediaPaging}
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
                {...relayCreateAction}
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

      {creatingRelayGroup ? (
        <CreateRelayGroupModal
          contact={contact}
          candidates={editCandidates}
          onClose={() => setCreatingRelayGroup(false)}
          onCreated={() => {
            // The Relay groups card read its rows once, on mount, and this page
            // listens for no conversation event. A `connecting` create does not
            // navigate, so without this the operator closes the panel onto "No
            // relay groups yet." over a group that exists - and a retry buys a
            // second pool number.
            file.refetch();
          }}
          onAmbiguousCreate={() => {
            // Same refresh, harder-earned: the create got NO answer, so whether a
            // group exists is a question only this card can settle - and its
            // panel sends the operator straight here to read it. A stale "No
            // relay groups yet." under that sentence is the retry it exists to
            // prevent.
            file.refetch();
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
function extractionAppliedCopy(wrote: number, suggested: number, noted: number): string {
  // A run whose ONLY output was note lines is outcome `applied` in the job
  // (notedLines counts toward `touched`), so reporting it as "nothing new"
  // would contradict the run log the banner points people at.
  if (wrote + suggested === 0 && noted > 0) {
    return `Added ${noted} note line${noted === 1 ? '' : 's'} to the contact.`;
  }
  if (wrote + suggested === 0) return 'Ran - nothing new to extract.';
  // Only name the halves that actually happened. "Updated 0 fields, 1
  // suggestion." was the live result of the first self-QA run, and it is not an
  // edge case: a manual run waives the age floor, so it pulls in older
  // multi-speaker content, and a single unknown-speaker line demotes EVERY
  // write in the run to a suggestion (design 8). wrote=0 with suggestions is
  // therefore the COMMON success shape for this feature's target data, and
  // "Updated 0 fields" both reads badly and claims something that did not
  // happen. The both-non-zero string is unchanged from design 4.6.
  const fields = `Updated ${wrote} field${wrote === 1 ? '' : 's'}`;
  const chips = `${suggested} suggestion${suggested === 1 ? '' : 's'} to review`;
  // Notes ride every branch, not only the note-only one: the success banner
  // must never report LESS than the failure banner does about the same run.
  const notes = noted > 0 ? `, ${noted} note line${noted === 1 ? '' : 's'} added` : '';
  if (wrote === 0) return `${chips.charAt(0).toUpperCase()}${chips.slice(1)}${notes}.`;
  if (suggested === 0) return `${fields}${notes}.`;
  return `${fields}, ${suggested} suggestion${suggested === 1 ? '' : 's'}${notes}.`;
}

/** `truncated` gets its own actionable sentence: it is the one failure an
 *  operator can do something about, and the likeliest one here - a manual run
 *  waives the age cutoff, so it sends the widest windows the system produces. */
function extractionFailureCopy(errorKind: string): string {
  return errorKind === 'truncated'
    ? 'Extraction ran out of room - the transcript may be too long.'
    : 'Extraction failed - see Settings > AI runs.';
}

/** The results that DID land, for a resolution whose headline is a failure.
 *  One thread failing must not erase what the other threads (or the failed
 *  run itself, when its cursor write was the only casualty) already did -
 *  those writes are committed and billed whether or not the banner mentions
 *  them. Undefined when there is nothing to report. */
function extractionPartialResults(wrote: number, suggested: number, noted: number): string | undefined {
  const parts: string[] = [];
  if (wrote > 0) parts.push(`${wrote} field${wrote === 1 ? '' : 's'} updated`);
  if (suggested > 0) parts.push(`${suggested} suggestion${suggested === 1 ? '' : 's'} to review`);
  if (noted > 0) parts.push(`${noted} note line${noted === 1 ? '' : 's'} added`);
  if (parts.length === 0) return undefined;
  return `Results that still landed: ${parts.join(', ')}.`;
}

/**
 * One completion event against the indicator state - PURE, so the live handler
 * and the early-event replay in onRunExtraction share one implementation
 * instead of drifting. requestId guards against an unrelated run, and pending
 * membership against an unqueued thread's event and duplicate delivery. A
 * contactId MISMATCH is NOT rejected: a matching requestId means it is this
 * press's run, resolved by the job to another contact, so it is counted as
 * misfiled and reported - the facts landed there and billed.
 */
function applyRunEvent(
  prev: ExtractionState,
  e: AiRunCompletedEvent,
  contactId: string,
): ExtractionState {
  if (prev.phase !== 'running' || !prev.requestId || e.requestId !== prev.requestId) {
    return prev;
  }
  if (!prev.pending.has(e.conversationId)) return prev;
  const pending = new Set(prev.pending);
  pending.delete(e.conversationId);
  // A matching requestId with a DIFFERENT contactId is not noise - it is THIS
  // press's run, resolved by the job to another contact (the conversation's
  // participant pointer diverges from the phone roster). The facts landed on
  // that record and billed; leaving the thread in `pending` would hide that
  // behind a 180s timeout. Count it and say so instead of spinning.
  if (e.contactId !== undefined && e.contactId !== contactId) {
    const misfiled = prev.misfiled + 1;
    if (pending.size > 0) return { ...prev, pending, misfiled };
    return finishRun({ ...prev, pending, misfiled });
  }
  const wrote = prev.wrote + e.wrote;
  const suggested = prev.suggested + e.suggested;
  const noted = prev.noted + e.notedLines;
  // First failure wins the copy; 'driver' stands for "failed, kind not
  // reported" and maps to the generic sentence.
  const errorKind = prev.errorKind ?? (e.outcome === 'failed' ? (e.errorKind ?? 'driver') : undefined);
  if (pending.size > 0) {
    return { ...prev, pending, wrote, suggested, noted, ...(errorKind !== undefined && { errorKind }) };
  }
  return finishRun({ ...prev, pending, wrote, suggested, noted, ...(errorKind !== undefined && { errorKind }) });
}

/** The misfiled sentence, shared by finishRun and the timeout so the two can
 *  never disagree. Pronoun-free on purpose - "its" read wrong in the plural. */
function misfiledClauseOf(misfiled: number): string {
  const subject = misfiled === 1 ? 'One thread is' : `${misfiled} threads are`;
  return ` ${subject} filed under a different contact - the results landed there. See Settings > AI runs.`;
}

/** Assemble the resolved banner from a running state whose `pending` emptied.
 *  One assembly site for BOTH exits (the normal resolution and the misfiled
 *  one), so the failure headline, the results-that-landed clause, the unqueued
 *  clause and the misfiled clause can never disagree between paths. */
function finishRun(last: Extract<ExtractionState, { phase: 'running' }>): ExtractionState {
  const unqueued = last.failedThreads > 0 ? { failedThreads: last.failedThreads } : {};
  const misfiledClause = last.misfiled > 0 ? misfiledClauseOf(last.misfiled) : '';
  if (last.errorKind !== undefined) {
    const partial = extractionPartialResults(last.wrote, last.suggested, last.noted);
    const body = partial === undefined
      ? extractionFailureCopy(last.errorKind)
      : `${extractionFailureCopy(last.errorKind)} ${partial}`;
    return { phase: 'done', tone: 'alert', message: `${body}${misfiledClause}`, ...unqueued };
  }
  if (last.misfiled > 0) {
    const partial = extractionPartialResults(last.wrote, last.suggested, last.noted);
    const body = partial === undefined ? misfiledClause.trim() : `${partial}${misfiledClause}`;
    return { phase: 'done', tone: 'alert', message: body, ...unqueued };
  }
  return {
    phase: 'done',
    tone: 'status',
    message: extractionAppliedCopy(last.wrote, last.suggested, last.noted),
    ...unqueued,
  };
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
