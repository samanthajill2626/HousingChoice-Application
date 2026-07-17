// PlacementDetail — a single placement's detail page (F2.3) at
// /placements/:placementId, rebuilt on the shared two-pane shell
// (ui/twoPaneShell): a dark header band (back crumb, "Placement - <tenant> ->
// <property>", the stage pill, a date-vocabulary facts line, an "Advance to
// <next stage>" primary CTA + a "..." kebab) over a body with the three-channel
// conversation switcher (PlacementConversation) LEFT and the placement file
// RIGHT. A segmented "Details | Conversation" toggle appears at <=860px, leading
// with DETAILS (matching the tour page).
//
// The header CTA + the kebab's "Move to..." picker drive transitions through the
// SAME gated pipeline as before (lost -> LostReasonModal; OUT of
// awaiting_rent_acceptance -> finalRent; OUT of awaiting_inspection ->
// inspectionOutcome / inspectionDate; determine_rent -> rentDetermined; into
// awaiting_move_in -> moveInReady). Right pane order (spec section 3): the Now
// card, Deadlines-and-nudges, People and provenance, Placement facts, History.
// Staff see "property" for the unit (GLOSSARY). The old StageDataCard +
// PaperworkCard recorders live INSIDE the Now card now (its stage-scoped
// Record section) — they no longer render standalone here.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  PLACEMENT_STAGES,
  STAGE_LABELS,
  STAGE_PHASE,
  TERMINAL_STAGES,
  formatLostReason,
  getConversation,
  getPlacement,
  getContact,
  getUnit,
  provisionPlacementRelay,
  setPlacementFollowUp,
  transitionPlacement,
  updatePlacement,
  updateUnit,
  useEventStream,
  type PlacementItem,
  type PlacementUpdatedEvent,
  type Contact,
  type LostReason,
  type PlacementStage,
  type UnitItem,
} from '../../api/index.js';
import { Button, Spinner, StatusMenu, type StatusMenuGroup } from '../../ui/index.js';
import { Card, EmptyRow, KV, NotesText, Row } from '../contact/Card.js';
import { formatMoney } from '../listing/listingFormat.js';
import { contactDisplayName, formatAddress } from '../contact/format.js';
import {
  dateTime,
  expiresOn,
  historyTitle,
  shortDate,
  sinceWhen,
  summarizeHistory,
} from './placementsFormat.js';
import { gateFor, type TransitionGate } from './transitionGate.js';
import { LostReasonModal } from './LostReasonModal.js';
import { MovePromptModal, type MovePromptResult } from './MovePromptModal.js';
import { RelayCloseAskDialog } from '../conversation/RelayCloseAskDialog.js';
import { usePlacementHistory } from './usePlacementHistory.js';
import { usePlacementChannels } from './usePlacementChannels.js';
import { usePlacementNudges } from './usePlacementNudges.js';
import { PlacementConversation } from './PlacementConversation.js';
import { PlacementNowCard } from './PlacementNowCard.js';
import { DeadlinesNudgesCard } from './DeadlinesNudgesCard.js';
import { FollowUpModal } from './FollowUpModal.js';
import shell from '../../ui/twoPaneShell.module.css';
import menuStyles from '../tours/TourActionsMenu.module.css';
import styles from './PlacementDetail.module.css';

interface PendingMove {
  toStage: PlacementStage;
  gate: TransitionGate;
}

// The distinct phases in ladder order - the stage pill's menu groups its stages
// under these as section headings, so the sub-stages read within their phase
// (Application / RTA / Inspection / ...) instead of one flat list.
const PLACEMENT_PHASES_ORDERED = [...new Set(PLACEMENT_STAGES.map((s) => STAGE_PHASE[s]))];

// Every stage, grouped by phase — the interactive stage pill's menu. The current
// stage is shown (checked) rather than hidden; picking a different one drives the
// SAME gated transition as the board (requestMove → gate → confirm/reason modal).
const STAGE_GROUPS: StatusMenuGroup[] = PLACEMENT_PHASES_ORDERED.map((ph) => ({
  label: ph,
  options: PLACEMENT_STAGES.filter((s) => STAGE_PHASE[s] === ph).map((s) => ({
    value: s,
    label: STAGE_LABELS[s],
  })),
})).filter((g) => g.options.length > 0);

export function PlacementDetail(): React.JSX.Element {
  const { placementId = '' } = useParams<{ placementId: string }>();
  // Consolidated load state keyed by forId — loading is DERIVED during render
  // when placementId changes (no synchronous setState in the effect → no cascading
  // render), mirroring useListing.
  const [loaded, setLoaded] = useState<{
    status: 'loading' | 'ready' | 'error';
    placement: PlacementItem | null;
    unit: UnitItem | null;
    tenant: Contact | null;
    landlord: Contact | null;
    forId: string;
  }>({ status: 'loading', placement: null, unit: null, tenant: null, landlord: null, forId: placementId });
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mobile pane: DETAILS first on narrow widths (matches the tour page).
  const [pane, setPane] = useState<'details' | 'conversation'>('details');
  // The "Set follow-up" kebab action + the Deadlines-and-nudges card's Set/Change
  // controls open the shared FollowUpModal (below) via this open-state.
  const [followUpOpen, setFollowUpOpen] = useState(false);
  // The "Also close the group text?" ask, opened AFTER a terminal move saves.
  const [closeAsk, setCloseAsk] = useState<{ conversationId: string; memberSummary: string } | null>(
    null,
  );

  // Track the in-flight load so a refetch (SSE-driven or placementId change)
  // supersedes the previous one and a late response can't clobber fresher state.
  const abortRef = useRef<AbortController | null>(null);

  // Apply an updated placement in place (after a transition returns it), keeping the
  // resolved unit — instant feedback before the placement.updated refetch reconciles.
  const setPlacement = useCallback(
    (next: PlacementItem) => {
      setLoaded((prev) => ({ ...prev, status: 'ready', placement: next, forId: placementId }));
    },
    [placementId],
  );

  // Apply an updated unit in place (after an in-place final_rent edit returns it).
  const setUnit = useCallback((next: UnitItem) => {
    setLoaded((prev) => ({ ...prev, unit: next }));
  }, []);

  // Fetch (or refetch) the full placement bundle. No synchronous loading reset — on a
  // placementId change loading is DERIVED during render (forId mismatch); a live
  // refetch updates in place (the unit carries final_rent, which a transition can
  // change, so we refetch it too rather than patch from the SSE event).
  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      const c = await getPlacement(placementId, signal);
      if (signal.aborted) return;
      // The unit (for final_rent + a readable address), the tenant contact, AND
      // the landlord contact (the unit's landlordId - the landlord 1:1 target +
      // the People card link) are all best-effort: a failure on any is non-fatal
      // - the page still renders from the placement, degrading that field to the
      // id. Staff see people by NAME, not the raw id (GLOSSARY).
      const u = await getUnit(c.unitId, signal).catch(() => null);
      if (signal.aborted) return;
      const landlordId = typeof u?.landlordId === 'string' ? u.landlordId : undefined;
      const [t, l] = await Promise.all([
        getContact(c.tenantId, signal).catch(() => null),
        landlordId !== undefined ? getContact(landlordId, signal).catch(() => null) : Promise.resolve(null),
      ]);
      if (signal.aborted) return;
      setLoaded({ status: 'ready', placement: c, unit: u, tenant: t, landlord: l, forId: placementId });
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setLoaded({ status: 'error', placement: null, unit: null, tenant: null, landlord: null, forId: placementId });
    }
  }, [placementId]);

  useEffect(() => {
    // load sets state only after an await (never synchronously) — a fetch-on-mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Live: a transition on THIS placement (here, another tab, or another user) emits
  // placement.updated — refetch so every field reflects it, not just the History panel.
  const onPlacementUpdated = useCallback(
    (ev: PlacementUpdatedEvent) => {
      if (ev.placementId === placementId) void load();
    },
    [placementId, load],
  );
  useEventStream({ onPlacementUpdated });

  // Committed state is for a previous placementId → still loading the new one.
  const fresh =
    loaded.forId === placementId
      ? loaded
      : { status: 'loading' as const, placement: null, unit: null, tenant: null, landlord: null };
  const status = fresh.status;
  const placement = fresh.placement;
  const unit = fresh.unit;
  const tenant = fresh.tenant;
  const landlord = fresh.landlord;
  const landlordId = typeof unit?.landlordId === 'string' ? unit.landlordId : undefined;

  // The three comms channels (group / tenant 1:1 / landlord 1:1). Called
  // UNCONDITIONALLY (hooks rules) with a loading-safe placeholder while the
  // bundle loads - it keys on the real placementId, so once the placement +
  // unit resolve the hook refetches against the real tenant/landlord/group. Only
  // consumed in the render below, which runs after the loaded guard.
  const channels = usePlacementChannels(
    placement ?? { placementId, tenantId: '', unitId: '', stage: 'send_application' },
    landlordId,
  );

  // The ONE nudge-ladder fetch for this placement (spec's "do not fetch twice"),
  // shared DOWN to the Now card's safety-net line AND the Deadlines and nudges
  // card. Called unconditionally (hooks rules); keys on the real placementId.
  const nudges = usePlacementNudges(placementId);

  // Provision the placement's masked group thread (members auto-resolved
  // server-side), then inject the new conversationId so the group tab mounts at
  // once. Shared by the header kebab; the left-pane empty state has its OWN
  // button (both hit the same channels instance).
  const handleOpenGroup = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void provisionPlacementRelay(placementId)
      .then(({ conversationId }) => channels.setConversationId('group', conversationId))
      .catch(() => setError('Could not open the group text. Please try again.'))
      .finally(() => setBusy(false));
  }, [busy, placementId, channels]);

  // After a terminal move (lost / moved_in) the LINKED relay group is NOT
  // auto-closed (nothing auto-closes now). If it is still OPEN, offer to close it.
  // Best-effort + non-blocking: the transition already saved before this runs; a
  // failed status check simply skips the prompt.
  const askCloseGroupIfOpen = useCallback(async (pl: PlacementItem): Promise<void> => {
    const groupId = pl.group_thread;
    if (typeof groupId !== 'string' || groupId.length === 0) return;
    try {
      const conv = await getConversation(groupId);
      if (conv.status !== 'open') return;
      const names = (conv.participants ?? [])
        .map((p) => p.name?.trim())
        .filter((n): n is string => n !== undefined && n.length > 0);
      setCloseAsk({ conversationId: groupId, memberSummary: names.join(' & ') });
    } catch {
      /* best-effort: never block the recorded move on the group check */
    }
  }, []);

  const runTransition = useCallback(
    (toStage: PlacementStage, extra: { lostReason?: LostReason } & MovePromptResult) => {
      setBusy(true);
      setError(null);
      void transitionPlacement(placementId, {
        toStage,
        source: 'manual',
        ...(extra.lostReason !== undefined && { lostReason: extra.lostReason }),
        ...(extra.finalRent !== undefined && { finalRent: extra.finalRent }),
        ...(extra.inspectionOutcome !== undefined && { inspectionOutcome: extra.inspectionOutcome }),
        ...(extra.inspectionDate !== undefined && { inspectionDate: extra.inspectionDate }),
        ...(extra.rentDetermined !== undefined && { rentDetermined: extra.rentDetermined }),
      })
        .then((updated) => {
          setPlacement(updated);
          // Terminal moves (lost = terminal-fail, moved_in = terminal-success) ask
          // whether to also close the linked group text.
          if (updated.stage === 'lost' || updated.stage === 'moved_in') {
            void askCloseGroupIfOpen(updated);
          }
        })
        .catch(() => setError('That move was rejected — please try again.'))
        .finally(() => {
          setBusy(false);
          setPending(null);
        });
    },
    [placementId, setPlacement, askCloseGroupIfOpen],
  );

  // Toggle a complete-paperwork checklist field (lease_signed / lif /
  // move_in_details): PATCH the placement and apply the returned row in place
  // (instant feedback before the placement.updated refetch reconciles).
  const togglePaperwork = useCallback(
    (field: 'lease_signed' | 'lif' | 'move_in_details', checked: boolean) => {
      setError(null);
      void updatePlacement(placementId, { [field]: checked })
        .then((updated) => setPlacement(updated))
        .catch(() => setError('We couldn’t save that — please try again.'));
    },
    [placementId, setPlacement],
  );

  // NOTE: this per-stage picker intentionally allows moving a TERMINAL placement
  // (moved_in / lost) back to an active stage — treated as an allowed "re-open".
  // We deliberately do NOT block it here.
  function requestMove(toStage: PlacementStage): void {
    if (!placement || toStage === placement.stage) return;
    const gate = gateFor(placement.stage, toStage);
    if (gate === 'none') {
      runTransition(toStage, {});
      return;
    }
    setPending({ toStage, gate });
  }

  if (status === 'loading') {
    return (
      <div className={styles.center}>
        <Spinner center />
      </div>
    );
  }

  if (status === 'error' || !placement) {
    return (
      <div className={styles.center}>
        <p role="alert" className={styles.error}>
          We couldn&apos;t load this placement.
        </p>
      </div>
    );
  }

  const stageLabel = STAGE_LABELS[placement.stage] ?? placement.stage;
  const phase = STAGE_PHASE[placement.stage];
  // Staff see the person by NAME (GLOSSARY); degrade to the raw id only when the
  // contact truly can't be loaded.
  const tenantLabel = tenant ? contactDisplayName(tenant.firstName, tenant.lastName, tenant.phone) : placement.tenantId;
  const landlordLabel = landlord
    ? contactDisplayName(landlord.firstName, landlord.lastName, landlord.phone)
    : landlordId ?? null;
  const listing = unit ? formatAddress(unit.address) || placement.unitId : placement.unitId;
  const lostReason = formatLostReason(placement.lost_reason);
  const finalRent = formatMoney(unit?.final_rent);

  // The header primary CTA advances to the NEXT rung of the PLACEMENT_STAGES
  // ladder, driving the SAME gated pipeline (requestMove). Absent at the terminal
  // stages (moved_in / lost - no next rung to advance to).
  const stageIdx = PLACEMENT_STAGES.indexOf(placement.stage);
  const nextStage: PlacementStage | undefined =
    TERMINAL_STAGES.has(placement.stage) || stageIdx < 0 ? undefined : PLACEMENT_STAGES[stageIdx + 1];

  // Open group text is a kebab action ONLY until a group exists (then the group
  // tab shows the thread).
  const canOpenGroup = placement.group_thread === undefined;

  // The date-vocabulary facts line (spec section 6): phase, in-stage-since, the
  // voucher deadline, and the source-tour provenance - each a verb phrase, joined
  // by plain hyphens; empties dropped so the line never shows dangling separators.
  const voucherIso = typeof tenant?.voucher_expiration_date === 'string' ? tenant.voucher_expiration_date : undefined;
  // The Deadlines-and-nudges card's read-only deadline rows. The placement carries
  // only the COMPUTED soonest deadline (next_deadline_type/at), so the RTA window +
  // follow-up rows show whichever of the two is currently that soonest; the voucher
  // rides its own always-available date on the tenant contact.
  const rtaWindowAt =
    placement.next_deadline_type === 'rta_window' ? placement.next_deadline_at : undefined;
  const followUpAt =
    placement.next_deadline_type === 'follow_up' ? placement.next_deadline_at : undefined;
  const factsLine = [
    `${phase} phase`,
    placement.stage_entered_at ? `in stage ${sinceWhen(placement.stage_entered_at)}` : '',
    voucherIso ? `voucher ${expiresOn(voucherIso)}` : '',
    placement.fromTourId !== undefined && placement.tour_date
      ? `converted from tour toured ${shortDate(placement.tour_date)}`
      : '',
  ]
    .filter((p) => p !== '')
    .join(' - ');

  // Any read-only fact to show in the Placement facts card?
  const hasFacts =
    placement.inspection_outcome !== undefined ||
    placement.inspection_date !== undefined ||
    finalRent !== undefined ||
    typeof placement.rent_determined === 'number' ||
    typeof placement.placement_tag === 'string' ||
    lostReason !== undefined ||
    typeof placement.notes === 'string';

  return (
    <div className={shell.page}>
      <header className={shell.header}>
        <Link to="/placements" className={styles.backBtn} aria-label="Back to placements">
          {'\u2190'}
        </Link>
        <div className={shell.identity}>
          <div className={shell.nameRow}>
            <span className={shell.name}>
              Placement - {tenantLabel} {'\u2192'} {listing}
            </span>
            <span className={styles.stagePill}>{stageLabel}</span>
          </div>
          {factsLine !== '' ? <div className={styles.facts}>{factsLine}</div> : null}
        </div>
        <div className={shell.actions}>
          {nextStage !== undefined ? (
            <Button size="sm" onClick={() => requestMove(nextStage)} disabled={busy}>
              Advance to {STAGE_LABELS[nextStage]}
            </Button>
          ) : null}
          <PlacementActionsMenu
            stage={placement.stage}
            onMove={requestMove}
            canOpenGroup={canOpenGroup}
            onOpenGroup={handleOpenGroup}
            onMarkLost={() => requestMove('lost')}
            onSetFollowUp={() => setFollowUpOpen(true)}
            busy={busy}
          />
        </div>
      </header>

      {error !== null ? (
        <div className={styles.errorBar} role="alert">
          {error}
        </div>
      ) : null}

      {/* Narrow-width segmented toggle (hidden on wide via the shell CSS). Details
          leads on mobile, matching the tour page. */}
      <div className={shell.segMobile} role="group" aria-label="View">
        <button
          type="button"
          className={pane === 'details' ? shell.segOn : shell.segBtn}
          aria-pressed={pane === 'details'}
          onClick={() => setPane('details')}
        >
          Details
        </button>
        <button
          type="button"
          className={pane === 'conversation' ? shell.segOn : shell.segBtn}
          aria-pressed={pane === 'conversation'}
          onClick={() => setPane('conversation')}
        >
          Conversation
        </button>
      </div>

      <div className={shell.body}>
        <div
          className={`${shell.left} ${pane === 'conversation' ? shell.paneActive : shell.paneHidden}`}
        >
          <PlacementConversation
            placement={placement}
            unit={unit}
            tenant={tenant}
            landlord={landlord}
            channels={channels}
          />
        </div>
        <div className={`${shell.right} ${pane === 'details' ? shell.paneActive : shell.paneHidden}`}>
          <div className={shell.rightInner}>
            {/* 1. Now card - the workflow-first "what is happening + what to do"
                surface; absorbs the stage-data + paperwork recorders and shares the
                ONE nudge fetch (safety-net line). */}
            <PlacementNowCard
              placement={placement}
              unit={unit}
              tenant={tenant}
              landlord={landlord}
              nudges={nudges.nudges}
              {...(nextStage !== undefined && { nextStageLabel: STAGE_LABELS[nextStage] })}
              {...(nextStage !== undefined && { onAdvance: () => requestMove(nextStage) })}
              onRecordPlacement={(patch) => updatePlacement(placementId, patch).then(setPlacement)}
              onRecordFinalRent={(amount) =>
                updateUnit(placement.unitId, { final_rent: amount }).then(setUnit)
              }
              onTogglePaperwork={togglePaperwork}
            />

            {/* 2. Deadlines and nudges (same shared nudge ladder as the Now card) */}
            <DeadlinesNudgesCard
              placementId={placementId}
              tenantName={tenantLabel}
              landlordName={landlordLabel}
              {...(voucherIso !== undefined && { voucherExpiration: voucherIso })}
              {...(rtaWindowAt !== undefined && { rtaWindowAt })}
              {...(followUpAt !== undefined && { followUpAt })}
              onEditFollowUp={() => setFollowUpOpen(true)}
              nudges={nudges.nudges}
              nudgesLoading={nudges.loading}
              nudgesError={nudges.error}
              busyId={nudges.busyId}
              onToggleCanceled={nudges.toggleCanceled}
            />

            {/* 3. People and provenance */}
            <Card title="People">
              <KV k="Tenant" v={<Link to={`/contacts/${placement.tenantId}`}>{tenantLabel}</Link>} />
              <KV
                k="Landlord"
                v={
                  landlordId !== undefined ? (
                    <Link to={`/contacts/${landlordId}`}>{landlordLabel ?? landlordId}</Link>
                  ) : (
                    <EmptyRow>No landlord on file.</EmptyRow>
                  )
                }
              />
              <KV k="Property" v={<Link to={`/listings/${placement.unitId}`}>{listing}</Link>} />
              {placement.fromTourId !== undefined ? (
                <Row
                  to={`/tours/${placement.fromTourId}`}
                  label={`converted from tour${
                    placement.tour_date ? ` toured ${shortDate(placement.tour_date)}` : ''
                  } \u2192`}
                />
              ) : null}
            </Card>

            {/* 4. Placement facts (read-only fields, date vocabulary) */}
            <Card title="Placement facts">
              {placement.inspection_outcome ? (
                <KV k="Inspection" v={placement.inspection_outcome === 'pass' ? 'Pass' : 'Fail'} />
              ) : null}
              {placement.inspection_date ? (
                <KV k="Inspection date" v={shortDate(placement.inspection_date)} />
              ) : null}
              {finalRent !== undefined ? <KV k="Final rent" v={`${finalRent}/mo`} /> : null}
              {typeof placement.rent_determined === 'number' ? (
                <KV k="Determined rent" v={`${formatMoney(placement.rent_determined)}/mo`} />
              ) : null}
              {typeof placement.placement_tag === 'string' ? (
                <KV k="Tag" v={placement.placement_tag} />
              ) : null}
              {lostReason !== undefined ? <KV k="Lost reason" v={lostReason} /> : null}
              {typeof placement.notes === 'string' && placement.notes !== '' ? (
                <KV k="Notes" v={<NotesText text={placement.notes} />} />
              ) : null}
              {!hasFacts ? <EmptyRow>No recorded details yet.</EmptyRow> : null}
            </Card>

            {/* 5. History */}
            <HistoryPanel placementId={placementId} />
          </div>
        </div>
      </div>

      {/* The manual follow-up date/time modal - opened from the header kebab's
          "Set follow-up" AND the Deadlines-and-nudges card's Set/Change controls.
          Confirm POSTs the follow-up deadline; the load() refetch (plus the
          server's placement.updated) reconciles the card's follow-up row. */}
      {followUpOpen ? (
        <FollowUpModal
          {...(followUpAt !== undefined && { initial: followUpAt })}
          onClose={() => setFollowUpOpen(false)}
          onConfirm={async (iso) => {
            await setPlacementFollowUp(placementId, iso);
            void load();
          }}
        />
      ) : null}

      {pending !== null && pending.gate === 'lost' ? (
        <LostReasonModal
          subject={tenantLabel}
          onClose={() => setPending(null)}
          onConfirm={(reason) => runTransition(pending.toStage, { lostReason: reason })}
          busy={busy}
        />
      ) : null}

      {pending !== null &&
      (pending.gate === 'finalRent' ||
        pending.gate === 'inspectionOutcome' ||
        pending.gate === 'inspectionDate' ||
        pending.gate === 'rentDetermined' ||
        pending.gate === 'moveInReady') ? (
        <MovePromptModal
          mode={pending.gate}
          initial={{
            finalRent: unit?.final_rent,
            inspectionOutcome: placement.inspection_outcome,
            inspectionDate: placement.inspection_date,
            rentDetermined: placement.rent_determined,
          }}
          {...(pending.gate === 'moveInReady' && {
            lifPending: tenant?.lifEligible === true && placement.lif !== true,
          })}
          onClose={() => setPending(null)}
          onConfirm={(result) => runTransition(pending.toStage, result)}
          busy={busy}
        />
      ) : null}

      {closeAsk !== null ? (
        <RelayCloseAskDialog
          conversationId={closeAsk.conversationId}
          memberSummary={closeAsk.memberSummary}
          onDone={() => setCloseAsk(null)}
        />
      ) : null}
    </div>
  );
}

/** The placement header kebab (mirrors tours/TourActionsMenu's popover: outside-
 *  click + Escape close). Holds the branch actions that are not the one guided
 *  "Advance" CTA: "Move to..." (the EXISTING gated stage StatusMenu - a move runs
 *  the same requestMove pipeline), Set follow-up, Open group text (shown only
 *  until a group exists), and Mark lost. Reuses the tour kebab's CSS module. */
function PlacementActionsMenu({
  stage,
  onMove,
  canOpenGroup,
  onOpenGroup,
  onMarkLost,
  onSetFollowUp,
  busy = false,
}: {
  stage: PlacementStage;
  onMove: (toStage: PlacementStage) => void;
  canOpenGroup: boolean;
  onOpenGroup: () => void;
  onMarkLost: () => void;
  onSetFollowUp: () => void;
  busy?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void): void => {
    setOpen(false);
    fn();
  };

  return (
    <div className={menuStyles.wrap} ref={ref}>
      <button
        type="button"
        className={menuStyles.kebab}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        {/* U+22EF midline horizontal ellipsis - the shared kebab glyph. */}
        {'\u22EF'}
      </button>
      {open ? (
        <div className={menuStyles.menu} role="menu">
          {/* Move to... - the existing gated stage picker (grouped by phase). A
              pick closes the kebab, then runs the SAME requestMove gate pipeline. */}
          <div className={styles.moveRow}>
            <span className={styles.moveLabel}>Move to</span>
            <StatusMenu
              value={stage}
              groups={STAGE_GROUPS}
              onChange={(v) => run(() => onMove(v as PlacementStage))}
              tone="neutral"
              disabled={busy}
              label="Placement stage"
            />
          </div>
          <button
            type="button"
            role="menuitem"
            className={menuStyles.item}
            disabled={busy}
            onClick={() => run(onSetFollowUp)}
          >
            Set follow-up
          </button>
          {canOpenGroup ? (
            <button
              type="button"
              role="menuitem"
              className={menuStyles.item}
              disabled={busy}
              onClick={() => run(onOpenGroup)}
            >
              Open group text
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={`${menuStyles.item} ${menuStyles.danger}`}
            disabled={busy}
            onClick={() => run(onMarkLost)}
          >
            Mark lost
          </button>
        </div>
      ) : null}
    </div>
  );
}

function HistoryPanel({ placementId }: { placementId: string }): React.JSX.Element {
  const { status, rows, hasMore, loadingMore, loadMore } = usePlacementHistory(placementId);
  return (
    <Card title="History" aside={rows.length > 0 ? String(rows.length) : undefined}>
      {status === 'loading' ? (
        <Spinner center />
      ) : status === 'error' ? (
        <EmptyRow>We couldn&apos;t load the history.</EmptyRow>
      ) : rows.length === 0 ? (
        <EmptyRow>No history yet.</EmptyRow>
      ) : (
        <>
          <ul className={styles.history} aria-label="Placement history">
            {rows.map((row, i) => (
              <li key={`${row.ts}:${i}`} className={styles.historyRow}>
                <div className={styles.historyTop}>
                  <span className={styles.historyType}>{historyTitle(row.event_type)}</span>
                  <span className={styles.historyTs}>{dateTime(row.ts)}</span>
                </div>
                <div className={styles.historySummary}>{summarizeHistory(row.event_type, row.payload)}</div>
                {row.actorId ? <div className={styles.historyActor}>by {row.actorId}</div> : null}
              </li>
            ))}
          </ul>
          {hasMore ? (
            <Button variant="secondary" size="sm" loading={loadingMore} onClick={loadMore}>
              Load more
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}
