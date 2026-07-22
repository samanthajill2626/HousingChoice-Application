// TourDetail - the /tours/:tourId detail page, rebuilt on the shared two-pane
// shell (ui/twoPaneShell): a dark header band (back crumb, "Tour - <address>",
// tour StatusBadge, facts line, ONE status-aware primary CTA + a "..." kebab for
// branch actions) over a body with the three-channel conversation switcher LEFT
// and the tour file RIGHT (Schedule / People / Reminders / Guidance / Outcome /
// Activity). A segmented "Details | Conversation" toggle appears at <=860px,
// leading with DETAILS (per the 2026-07-08 decision; the contact page leads with
// comms). Everything the page needs comes from useTour + useTourChannels +
// useTourActivity; mutations go through PATCH /api/tours/:id, POST /:id/relay, and
// POST /api/placements/from-tour, applying the returned tour in place.
//
// Tours are SEPARATE from placements, but the exit gate is the handoff: a
// move-forward outcome CONVERTS IMMEDIATELY (records the decision, POSTs
// /placements/from-tour, lands on the new placement - one step, no second
// click; Cameron 2026-07-15). The standalone "Start placement" CTA remains for
// tours that are convertible but unconverted (an API-recorded outcome, or the
// retry path when the chained conversion fails). Audience: staff see
// "property" for the unit (GLOSSARY).
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  createPlacementFromTour,
  createTourRelay,
  getConversation,
  getNoShowCheckinDraft,
  patchTour,
  TOUR_OUTCOME_LABELS,
  TOUR_TYPE_LABELS,
  type Contact,
  type Tour,
  type TourOutcome,
  type TourStatus,
  type UnitItem,
} from '../../api/index.js';
import { Button, Spinner, StatusBadge } from '../../ui/index.js';
import { Card, CardAction, Chips, EmptyRow, KV, NotesText, PendingPanel, Row } from '../contact/Card.js';
import {
  contactDisplayName,
  contactStatusLabel,
  formatAddress,
  formatPhone,
} from '../contact/format.js';
import { formatRent } from '../listing/listingFormat.js';
import { dateTime, shortDate } from '../placements/placementsFormat.js';
import { useTour } from './useTour.js';
import { useTourChannels } from './useTourChannels.js';
import { useTourActivity, type TourActivityState } from './useTourActivity.js';
import { RemindersPanel } from './RemindersPanel.js';
import { TourActionsMenu } from './TourActionsMenu.js';
import { TourConversation } from './TourConversation.js';
import {
  BookTourModal,
  CancelTourModal,
  RecordOutcomeModal,
  RescheduleTourModal,
} from './TourModals.js';
import { describeTourActivity, tourActivityToMilestone } from './tourActivityFormat.js';
import { RelayCloseAskDialog } from '../conversation/RelayCloseAskDialog.js';
import shell from '../../ui/twoPaneShell.module.css';
import styles from './TourDetail.module.css';

/** Format a scheduledAt ISO datetime for human-readable display. */
function formatScheduledAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Reschedule shows for these statuses (canReschedule minus 'requested', which
 *  uses the dedicated Book control). */
const RESCHEDULABLE_UI: ReadonlySet<TourStatus> = new Set<TourStatus>([
  'scheduled',
  'canceled',
  'no_show',
]);

/** Cancel shows for the pre-tour (non-dead) statuses. */
const CANCELABLE: ReadonlySet<TourStatus> = new Set<TourStatus>(['requested', 'scheduled']);

export function TourDetail(): React.JSX.Element {
  const { tourId = '' } = useParams<{ tourId: string }>();
  const { status, tour, setTour, unit, tenant, landlord } = useTour(tourId);

  if (status === 'loading') {
    return (
      <div className={styles.center}>
        <Spinner center />
      </div>
    );
  }
  if (status === 'notfound') {
    return (
      <div className={styles.center}>
        <p role="alert" className={styles.error}>
          We couldn&apos;t find this tour.
        </p>
      </div>
    );
  }
  if (status === 'error' || tour === null) {
    return (
      <div className={styles.center}>
        <p role="alert" className={styles.error}>
          We couldn&apos;t load this tour.
        </p>
      </div>
    );
  }

  return (
    <TourDetailLoaded
      key={tour.tourId}
      tourId={tour.tourId}
      tour={tour}
      setTour={setTour}
      unit={unit}
      tenant={tenant}
      landlord={landlord}
    />
  );
}

interface LoadedProps {
  tourId: string;
  tour: Tour;
  setTour: (tour: Tour) => void;
  unit: UnitItem | null;
  tenant: Contact | null;
  landlord: Contact | null;
}

function TourDetailLoaded({
  tourId,
  tour,
  setTour,
  unit,
  tenant,
  landlord,
}: LoadedProps): React.JSX.Element {
  const navigate = useNavigate();
  const landlordId = typeof unit?.landlordId === 'string' ? unit.landlordId : undefined;
  const channels = useTourChannels(tour, landlordId);
  // ONE activity fetch feeds both the Activity card and the conversation
  // transcripts (as interleaved milestone pins). Rows arrive newest-first;
  // the transcripts want oldest-first, hence the reverse. Only the loaded
  // page(s) interleave — a tour's whole lifecycle fits the first page in
  // practice, and the card's "Load more" extends both.
  const activity = useTourActivity(tour.tourId);
  const tourMilestones = useMemo(
    () => activity.rows.map(tourActivityToMilestone).reverse(),
    [activity.rows],
  );

  // Mobile pane: DETAILS first on narrow widths (per the 2026-07-08 decision).
  const [pane, setPane] = useState<'details' | 'conversation'>('details');
  const [modal, setModal] = useState<'book' | 'reschedule' | 'outcome' | 'cancel' | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // "Send no-show check-in" seed handed to TourConversation (nonce bumps per click).
  const [noShowSeed, setNoShowSeed] = useState<{ body: string; nonce: number } | null>(null);
  // The "Also close the group text?" ask, opened AFTER a terminal outcome saves.
  const [closeAsk, setCloseAsk] = useState<{ conversationId: string; memberSummary: string } | null>(
    null,
  );

  const isPm = tour.tourType === 'pm_team';
  const address = unit ? formatAddress(unit.address) || tour.unitId : tour.unitId;
  const tenantName = tenant
    ? contactDisplayName(tenant.firstName, tenant.lastName, tenant.phone)
    : tour.tenantId;
  const landlordName = landlord
    ? contactDisplayName(landlord.firstName, landlord.lastName, landlord.phone)
    : landlordId ?? null;
  const typeLabel = TOUR_TYPE_LABELS[tour.tourType] ?? tour.tourType;
  const whenText = tour.scheduledAt !== undefined ? formatScheduledAt(tour.scheduledAt) : 'Not booked';
  const factsLine = `${whenText} - ${typeLabel} - ${tenantName} -> ${address}`;
  const createdText = typeof tour.createdAt === 'string' ? shortDate(tour.createdAt) : null;

  // --- Guards ---------------------------------------------------------------
  const canReschedule = RESCHEDULABLE_UI.has(tour.status);
  const canCancel = CANCELABLE.has(tour.status);
  const canMarkNoShow = tour.status === 'scheduled';
  // "Send no-show check-in" shows only once the tour start has passed AND the tour
  // is still scheduled or already no_show (hidden for canceled/toured/closed/requested).
  const startPassed =
    typeof tour.scheduledAt === 'string' && new Date(tour.scheduledAt).getTime() <= Date.now();
  const canSendNoShowCheckin =
    startPassed && (tour.status === 'scheduled' || tour.status === 'no_show');
  const canOpenGroup =
    tour.groupThreadId === undefined && tour.status !== 'canceled' && tour.status !== 'closed';
  const isConverted = typeof tour.convertedPlacementId === 'string';

  // --- Mutations ------------------------------------------------------------
  // A direct (no-input) status PATCH: apply the returned tour; errors surface in
  // the header alert bar.
  const runDirect = async (fn: () => Promise<Tour>, failMsg: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      setTour(await fn());
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : failMsg);
    } finally {
      setBusy(false);
    }
  };
  const markToured = (): void => void runDirect(() => patchTour(tourId, { status: 'toured' }), 'Status update failed');
  const markNoShow = (): void => void runDirect(() => patchTour(tourId, { status: 'no_show' }), 'Status update failed');

  // Manual no-show check-in: fetch the editable template, switch the mobile pane to
  // the conversation, and hand the body to TourConversation which selects the Tenant
  // tab and prefills its composer. Kept HERE (not in the kebab) so the trigger can
  // move to a standalone button later without rewiring the behavior. Fetch failure
  // surfaces in the header alert; nothing is seeded. The send itself rides the normal
  // composer sendMessage path, so the consent gate / opt-out / kill-switch all apply.
  const handleSendNoShowCheckin = (): void => {
    setActionError(null);
    setPane('conversation');
    void getNoShowCheckinDraft(tourId)
      .then(({ body }) => setNoShowSeed((prev) => ({ body, nonce: (prev?.nonce ?? 0) + 1 })))
      .catch((err: unknown) =>
        setActionError(err instanceof ApiError ? err.message : 'Could not load the check-in message'),
      );
  };

  // Provision the masked group thread (members auto-resolved server-side); shared
  // by the header kebab AND the left-pane empty state.
  const handleOpenGroup = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const { tour: updated } = await createTourRelay(tourId);
      setTour(updated);
      if (typeof updated.groupThreadId === 'string') {
        channels.setConversationId('group', updated.groupThreadId);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        // relay_member_unresolvable carries a human `detail` (which member has no
        // phone) - show that, not the raw code.
        const detail =
          err.body !== null && typeof err.body === 'object'
            ? (err.body as { detail?: unknown }).detail
            : undefined;
        setActionError(
          err.code === 'relay_member_unresolvable' && typeof detail === 'string'
            ? detail
            : err.message,
        );
      } else {
        setActionError('Failed to open group text');
      }
    } finally {
      setBusy(false);
    }
  };

  // Convert a convertible, not-yet-converted tour into a placement, then jump to
  // it. QUIET - no announcement at convert time (founder 2026-07-02).
  const handleConvert = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const { placement } = await createPlacementFromTour(tourId);
      navigate(`/placements/${placement.placementId}`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to start placement');
      setBusy(false);
    }
  };

  // After a terminal tour outcome (not-a-fit / canceled) the LINKED relay group is
  // NOT auto-closed (nothing auto-closes now). If it is still OPEN, offer to close
  // it. Best-effort + non-blocking: the outcome is already saved before this runs;
  // a failed status check simply skips the prompt.
  const maybeAskCloseGroup = async (): Promise<void> => {
    const groupId = tour.groupThreadId;
    if (typeof groupId !== 'string' || groupId.length === 0) return;
    try {
      const conv = await getConversation(groupId);
      if (conv.status !== 'open') return;
      const names = (conv.participants ?? [])
        .map((p) => p.name?.trim())
        .filter((n): n is string => n !== undefined && n.length > 0);
      setCloseAsk({ conversationId: groupId, memberSummary: names.join(' & ') });
    } catch {
      /* best-effort: never block the recorded outcome on the group check */
    }
  };

  // Modal confirm handlers: apply the returned tour; THROW on failure so the modal
  // surfaces its own inline error and stays open.
  const confirmBook = async (isoScheduledAt: string): Promise<void> => {
    setTour(await patchTour(tourId, { scheduledAt: isoScheduledAt, status: 'scheduled' }));
  };
  const confirmReschedule = async (isoScheduledAt: string): Promise<void> => {
    setTour(await patchTour(tourId, { scheduledAt: isoScheduledAt, status: 'scheduled' }));
  };
  const confirmOutcome = async (decision: {
    outcome: TourOutcome;
    moveForward: boolean;
  }): Promise<void> => {
    // not-a-fit ALSO closes the tour (diagram) in the same PATCH; move-forward
    // leaves it 'toured' (convertible).
    setTour(
      await patchTour(tourId, {
        outcome: decision.outcome,
        moveForward: decision.moveForward,
        ...(decision.moveForward === false && { status: 'closed' as const }),
      }),
    );
    // Move-forward flows STRAIGHT into the placement: recording the decision
    // IS the start-placement step. The outcome is already saved at this point,
    // so a conversion failure must NOT re-open the modal (throwing would) -
    // surface it in the header alert instead; the tour is convertible, so the
    // "Start placement" CTA is the retry path.
    if (decision.moveForward) {
      try {
        const { placement } = await createPlacementFromTour(tourId);
        navigate(`/placements/${placement.placementId}`);
      } catch (err) {
        setActionError(
          err instanceof ApiError ? err.message : 'Outcome saved, but starting the placement failed',
        );
      }
    } else {
      // not-a-fit closed the TOUR, not the group text - offer to close the group.
      void maybeAskCloseGroup();
    }
  };
  const confirmCancel = async (): Promise<void> => {
    setTour(await patchTour(tourId, { status: 'canceled' }));
    // Canceling the tour leaves the relay group open - offer to close it.
    void maybeAskCloseGroup();
  };

  // --- Primary CTA (one status-aware happy-path button) ---------------------
  let primaryCta: React.JSX.Element | null = null;
  if (isConverted) {
    primaryCta = (
      <Button as="a" href={`/placements/${tour.convertedPlacementId}`} size="sm">
        View placement
      </Button>
    );
  } else if (tour.convertible === true) {
    primaryCta = (
      <Button size="sm" onClick={() => void handleConvert()} disabled={busy}>
        Start placement
      </Button>
    );
  } else if (tour.status === 'requested') {
    primaryCta = (
      <Button size="sm" onClick={() => setModal('book')}>
        Schedule tour
      </Button>
    );
  } else if (tour.status === 'scheduled') {
    primaryCta = (
      <Button size="sm" onClick={markToured} disabled={busy}>
        Mark toured
      </Button>
    );
  } else if (tour.status === 'toured' && tour.outcome === undefined) {
    primaryCta = (
      <Button size="sm" onClick={() => setModal('outcome')}>
        Record outcome
      </Button>
    );
  }

  // --- People card data -----------------------------------------------------
  const tenantChips: string[] = [];
  if (tenant?.status) tenantChips.push(contactStatusLabel(tenant.type, tenant.status));
  if (typeof tenant?.voucherSize === 'number') tenantChips.push(`Voucher ${tenant.voucherSize}BR`);
  const propertyChips: string[] = [];
  if (unit) {
    if (typeof unit.beds === 'number') propertyChips.push(`${unit.beds} BR`);
    const rent = formatRent(unit.rent_min, unit.rent_max);
    if (rent) propertyChips.push(`${rent}/mo`);
  }

  // Reminder-routing chip, mirroring app tourReminders resolveUsableGroup: a
  // self-guided tour routes to the tenant 1:1; a landlord-led/pm tour routes to a
  // usable group, else warns that it falls back to the 1:1 (a coordination smell).
  const routing =
    tour.tourType === 'self_guided'
      ? { text: 'reminders -> tenant 1:1', warn: false }
      : tour.groupThreadId !== undefined
        ? { text: 'reminders -> group', warn: false }
        : { text: 'no group - reminders -> 1:1', warn: true };

  const guidanceTitle =
    tour.tourType === 'self_guided'
      ? 'Self-guided tour'
      : tour.tourType === 'landlord_led'
        ? 'Landlord-led tour'
        : 'PM-team tour';
  const tourProcess = typeof unit?.tour_process === 'string' ? unit.tour_process : undefined;
  const applicationProcess =
    typeof unit?.application_process === 'string' ? unit.application_process : undefined;

  return (
    <div className={shell.page}>
      <header className={shell.header}>
        <Link to="/tours" className={styles.backBtn} aria-label="Back to tours">
          {'\u2190'}
        </Link>
        <div className={shell.identity}>
          <div className={shell.nameRow}>
            <span className={shell.name}>Tour - {address}</span>
            <StatusBadge kind="tour" status={tour.status} />
          </div>
          <div className={styles.facts}>{factsLine}</div>
          {createdText !== null ? <div className={styles.created}>created {createdText}</div> : null}
        </div>
        <div className={shell.actions}>
          {primaryCta}
          <TourActionsMenu
            canReschedule={canReschedule}
            onReschedule={() => setModal('reschedule')}
            canCancel={canCancel}
            onCancel={() => setModal('cancel')}
            canMarkNoShow={canMarkNoShow}
            onMarkNoShow={markNoShow}
            canSendNoShowCheckin={canSendNoShowCheckin}
            onSendNoShowCheckin={handleSendNoShowCheckin}
            canOpenGroup={canOpenGroup}
            onOpenGroup={() => void handleOpenGroup()}
            busy={busy}
          />
        </div>
      </header>

      {actionError !== null ? (
        <div className={styles.errorBar} role="alert">
          {actionError}
        </div>
      ) : null}

      {/* Narrow-width segmented toggle (hidden on wide via the shell CSS). Details
          leads on mobile (unlike the contact page). */}
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
          <TourConversation
            tour={tour}
            tenant={tenant}
            landlord={landlord}
            landlordId={landlordId}
            channels={channels}
            onOpenGroup={() => void handleOpenGroup()}
            openGroupBusy={busy}
            tourMilestones={tourMilestones}
            {...(noShowSeed !== null && { noShowDraft: noShowSeed })}
          />
        </div>
        <div className={`${shell.right} ${pane === 'details' ? shell.paneActive : shell.paneHidden}`}>
          <div className={shell.rightInner}>
            {/* --- Schedule --- */}
            <Card
              title="Schedule"
              aside={
                canReschedule ? (
                  <CardAction onClick={() => setModal('reschedule')} label="Reschedule tour">
                    Reschedule
                  </CardAction>
                ) : undefined
              }
            >
              <KV k="When" v={whenText} />
              <KV
                k="Type"
                v={
                  <span className={styles.typeRow}>
                    {typeLabel}
                    <span className={routing.warn ? styles.chipWarn : styles.chip}>{routing.text}</span>
                  </span>
                }
              />
            </Card>

            {/* --- People --- */}
            <Card title="People">
              <KV
                k="Tenant"
                v={
                  <span className={styles.person}>
                    <Link to={`/contacts/${tour.tenantId}`}>{tenantName}</Link>
                    {tenantChips.length > 0 ? <Chips items={tenantChips} /> : null}
                  </span>
                }
              />
              <KV
                k={isPm ? 'Property manager' : 'Landlord'}
                v={
                  landlordId !== undefined ? (
                    <span className={styles.person}>
                      <Link to={`/contacts/${landlordId}`}>{landlordName ?? landlordId}</Link>
                      {landlord?.phone ? (
                        <span className={styles.subtle}>{formatPhone(landlord.phone)}</span>
                      ) : null}
                    </span>
                  ) : (
                    <EmptyRow>No landlord on file.</EmptyRow>
                  )
                }
              />
              <KV
                k="Property"
                v={
                  <span className={styles.person}>
                    <Link to={`/listings/${tour.unitId}`}>{address}</Link>
                    {propertyChips.length > 0 ? <Chips items={propertyChips} /> : null}
                  </span>
                }
              />
            </Card>

            {/* --- Reminders (RemindersPanel renders its own Card) --- */}
            <RemindersPanel tourId={tour.tourId} />

            {/* --- Guidance (type-aware) --- */}
            <Card title={guidanceTitle}>
              {tour.tourType === 'self_guided' ? (
                <p className={styles.guidanceLead}>Photo ID before lockbox code - always.</p>
              ) : null}
              {tourProcess !== undefined ? (
                <KV k="Tour process" v={<NotesText text={tourProcess} />} />
              ) : null}
              {applicationProcess !== undefined ? (
                <KV k="Application process" v={<NotesText text={applicationProcess} />} />
              ) : null}
              {tourProcess === undefined && applicationProcess === undefined ? (
                <EmptyRow>No tour or application notes on file.</EmptyRow>
              ) : null}
            </Card>

            {/* --- Outcome --- */}
            <Card title="Outcome">
              {tour.outcome === undefined ? (
                <PendingPanel note="Records after the tour: moving forward starts the placement right away; not a fit closes the tour." />
              ) : (
                <>
                  <KV k="Outcome" v={TOUR_OUTCOME_LABELS[tour.outcome] ?? tour.outcome} />
                  <KV k="Moving forward" v={tour.moveForward ? 'Yes' : 'No'} />
                  {isConverted ? (
                    <Row to={`/placements/${tour.convertedPlacementId}`} label="View the placement" />
                  ) : tour.convertible === true ? (
                    <Button size="sm" onClick={() => void handleConvert()} disabled={busy}>
                      Start placement
                    </Button>
                  ) : null}
                </>
              )}
            </Card>

            {/* --- Activity --- */}
            <TourActivityCard activity={activity} />
          </div>
        </div>
      </div>

      {modal === 'book' ? (
        <BookTourModal onClose={() => setModal(null)} onConfirm={confirmBook} />
      ) : null}
      {modal === 'reschedule' ? (
        <RescheduleTourModal onClose={() => setModal(null)} onConfirm={confirmReschedule} />
      ) : null}
      {modal === 'outcome' ? (
        <RecordOutcomeModal onClose={() => setModal(null)} onConfirm={confirmOutcome} />
      ) : null}
      {modal === 'cancel' ? (
        <CancelTourModal onClose={() => setModal(null)} onConfirm={confirmCancel} />
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

/** The tour's OWN lifecycle history, newest-first with "load more" - mirrors
 *  PlacementDetail's HistoryPanel. The activity state is FETCHED BY THE PARENT
 *  (one useTourActivity) because the conversation transcripts interleave the
 *  same rows as milestone pins. */
function TourActivityCard({ activity }: { activity: TourActivityState }): React.JSX.Element {
  const { status, rows, hasMore, loadingMore, loadMore } = activity;
  return (
    <Card title="Activity" aside={rows.length > 0 ? String(rows.length) : undefined}>
      {status === 'loading' ? (
        <Spinner center />
      ) : status === 'error' ? (
        <EmptyRow>We couldn&apos;t load the activity.</EmptyRow>
      ) : rows.length === 0 ? (
        <EmptyRow>No activity yet.</EmptyRow>
      ) : (
        <>
          <ul className={styles.activity} aria-label="Tour activity">
            {rows.map((row, i) => {
              const d = describeTourActivity(row);
              return (
                <li key={`${row.id}:${i}`} className={styles.activityRow}>
                  <div className={styles.activityTop}>
                    <span className={styles.activityType}>
                      {d.to !== undefined ? <Link to={d.to}>{d.label}</Link> : d.label}
                    </span>
                    <span className={styles.activityTs}>{dateTime(row.at)}</span>
                  </div>
                  {row.actorId ? <div className={styles.activityActor}>by {row.actorId}</div> : null}
                </li>
              );
            })}
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
