// TourDetail — the detail page for a single tour (GET /api/tours/:tourId).
// Shows: status, scheduled date/time ('Not yet booked' for a timeless
// 'requested' tour), tour type, exit-gate feedback (the "Moving forward?"
// question → PATCH { outcome, moveForward }), book / reschedule / cancel /
// confirm / mark-toured / mark-no-show controls, an 'Open group thread'
// affordance (provisions the masked relay group; members auto-resolved
// server-side), and a link to the tour's relay group thread once it exists.
//
// Tours are SEPARATE from placements. This page records the navigator decision
// (exit gate) but does NOT create a placement or change tenant status. The exit
// gate sets `convertible`; actual conversion is a downstream step.
//
// Audience vocabulary: navigator/staff see "property"; tenant sees "home".
// This is a staff-only dashboard page, so we use "property" for the unit.
import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  getTour,
  patchTour,
  createTourRelay,
  createPlacementFromTour,
  ApiError,
  TOUR_STATUS_LABELS,
  TOUR_OUTCOME_LABELS,
  TOUR_TYPE_LABELS,
  type Tour,
  type TourOutcome,
  type TourStatus,
} from '../../api/index.js';
import { RemindersPanel } from './RemindersPanel.js';

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

/** The statuses from which a navigator can cancel (anything not already terminal). */
const CANCELABLE: ReadonlySet<TourStatus> = new Set<TourStatus>([
  'requested',
  'scheduled',
  'confirmed',
]);

/** The statuses from which a navigator can RESCHEDULE. The backend's
 *  canReschedule also allows 'requested' (booking rides the same guard), but in
 *  the UI a requested tour uses the dedicated Book control, not Reschedule. */
const RESCHEDULABLE: ReadonlySet<TourStatus> = new Set<TourStatus>([
  'scheduled',
  'confirmed',
  'canceled',
  'no_show',
]);

export function TourDetail(): React.JSX.Element {
  const { tourId } = useParams<{ tourId: string }>();
  const navigate = useNavigate();
  const [tour, setTour] = useState<Tour | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reschedule form state
  const [showReschedule, setShowReschedule] = useState(false);
  const [newScheduledAt, setNewScheduledAt] = useState('');

  // Book form state (a 'requested' tour has no time yet — booking sets one)
  const [showBook, setShowBook] = useState(false);
  const [bookScheduledAt, setBookScheduledAt] = useState('');

  // Exit gate form state
  const [showExitGate, setShowExitGate] = useState(false);
  const [exitOutcome, setExitOutcome] = useState<TourOutcome | ''>('');
  const [exitMoveForward, setExitMoveForward] = useState<boolean | null>(null);

  useEffect(() => {
    if (!tourId) return;
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    getTour(tourId, controller.signal)
      .then((t) => { setTour(t); setLoading(false); })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load tour');
        setLoading(false);
      });
    return () => controller.abort();
  }, [tourId]);

  // A bare status transition (confirm / toured / no-show / cancel): PATCH the
  // new status and apply the returned tour — inapplicable controls disappear.
  async function handleStatus(status: TourStatus, failMessage: string) {
    if (!tour || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const updated = await patchTour(tour.tourId, { status });
      setTour(updated);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : failMessage);
    } finally {
      setSubmitting(false);
    }
  }

  // Open a masked group thread for the tour. Members are omitted so the server
  // auto-resolves [tenant, unit's landlord]. On success the returned tour
  // carries the new groupThreadId, so the 'Group thread' row + link appear.
  async function handleOpenGroup() {
    if (!tour || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const { tour: updated } = await createTourRelay(tour.tourId);
      setTour(updated);
    } catch (err) {
      if (err instanceof ApiError) {
        // relay_member_unresolvable carries a human-readable `detail`
        // (e.g. which member has no phone) — show that, not the raw code.
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
        setActionError('Failed to open group thread');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Book a 'requested' (timeless) tour: setting scheduledAt + status 'scheduled'
  // arms the reminder ladder server-side.
  async function handleBook(e: React.FormEvent) {
    e.preventDefault();
    if (!tour || submitting || !bookScheduledAt) return;
    setSubmitting(true);
    setActionError(null);
    try {
      // Normalize the zoneless datetime-local value to a full ISO instant (the
      // navigator's timezone, not the server's) — same rule as ScheduleTourForm.
      const updated = await patchTour(tour.tourId, {
        scheduledAt: new Date(bookScheduledAt).toISOString(),
        status: 'scheduled',
      });
      setTour(updated);
      setShowBook(false);
      setBookScheduledAt('');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Booking failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReschedule(e: React.FormEvent) {
    e.preventDefault();
    if (!tour || submitting || !newScheduledAt) return;
    setSubmitting(true);
    setActionError(null);
    try {
      // Normalize like handleBook — never send the raw zoneless string.
      const updated = await patchTour(tour.tourId, {
        scheduledAt: new Date(newScheduledAt).toISOString(),
        status: 'scheduled',
      });
      setTour(updated);
      setShowReschedule(false);
      setNewScheduledAt('');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Reschedule failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleExitGate(e: React.FormEvent) {
    e.preventDefault();
    if (!tour || submitting || exitOutcome === '' || exitMoveForward === null) return;
    setSubmitting(true);
    setActionError(null);
    try {
      // The NO path CLOSES the tour in the same patch (diagram: "outcome
      // not_a_fit. Close the tour") — the server's terminal branch also cancels
      // any lingering reminder rungs. The YES path leaves it 'toured'
      // (convertible; Post-Tour & Application closes it at conversion).
      const updated = await patchTour(tour.tourId, {
        outcome: exitOutcome,
        moveForward: exitMoveForward,
        ...(exitMoveForward === false && { status: 'closed' as const }),
      });
      setTour(updated);
      setShowExitGate(false);
      setExitOutcome('');
      setExitMoveForward(null);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Exit gate update failed');
    } finally {
      setSubmitting(false);
    }
  }

  // Post-Tour & Application conversion: turn a CONVERTIBLE, not-yet-converted
  // tour into a placement, then jump to the new placement. QUIET — the server
  // sends no announcement at convert time (founder 2026-07-02).
  async function handleConvert() {
    if (!tour || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const { placement } = await createPlacementFromTour(tour.tourId);
      navigate(`/placements/${placement.placementId}`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to start placement');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <p aria-live="polite">Loading tour…</p>;
  }
  if (error !== null || !tour) {
    return <p role="alert">{error ?? 'Tour not found'}</p>;
  }

  const statusLabel = TOUR_STATUS_LABELS[tour.status] ?? tour.status;
  const typeLabel = TOUR_TYPE_LABELS[tour.tourType as keyof typeof TOUR_TYPE_LABELS] ?? tour.tourType;
  // A timeless 'requested' tour has no scheduledAt yet — never "Invalid Date".
  const scheduledDisplay =
    tour.scheduledAt !== undefined ? formatScheduledAt(tour.scheduledAt) : 'Not yet booked';
  const canCancel = CANCELABLE.has(tour.status as TourStatus);
  const canReschedule = RESCHEDULABLE.has(tour.status as TourStatus);
  // Book: only a 'requested' (timeless) tour is booked; afterwards Reschedule takes over.
  const canBook = tour.status === 'requested';
  // Status controls: Confirm only from 'scheduled'; attendance (toured /
  // no-show) from 'scheduled' or 'confirmed'. Marking toured is what makes the
  // exit gate reachable.
  const canConfirm = tour.status === 'scheduled';
  const canMarkAttendance = tour.status === 'scheduled' || tour.status === 'confirmed';
  // Open group: only before a group exists, and never on a dead tour.
  const canOpenGroup =
    tour.groupThreadId === undefined && tour.status !== 'canceled' && tour.status !== 'closed';
  // Exit gate: show when the tour has been toured but not yet decided
  const canRecord = tour.status === 'toured' && tour.outcome === undefined;

  return (
    <article aria-label="Tour details">
      <h1>Tour</h1>

      <section aria-label="Tour information">
        <dl>
          <div>
            <dt>Status</dt>
            <dd aria-label={`Status: ${statusLabel}`}>{statusLabel}</dd>
          </div>
          <div>
            <dt>Scheduled</dt>
            <dd aria-label={`Scheduled: ${scheduledDisplay}`}>{scheduledDisplay}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{typeLabel}</dd>
          </div>
          {tour.outcome !== undefined ? (
            <div>
              <dt>Outcome</dt>
              <dd>{TOUR_OUTCOME_LABELS[tour.outcome] ?? tour.outcome}</dd>
            </div>
          ) : null}
          {tour.moveForward !== undefined ? (
            <div>
              <dt>Moving forward</dt>
              <dd>{tour.moveForward ? 'Yes' : 'No'}</dd>
            </div>
          ) : null}
          {tour.convertible === true ? (
            <div>
              <dt>Convertible</dt>
              <dd>Yes — ready for placement (not yet converted)</dd>
            </div>
          ) : null}
          {tour.groupThreadId !== undefined ? (
            <div>
              <dt>Group thread</dt>
              <dd>
                <Link to={`/inbox`} aria-label="Open group thread in inbox">
                  View group thread
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      {/* The armed reminder ladder (confirmation/day_before/morning_of/en_route/
          no_show_checkin) — each rung's state (upcoming w/ fire time - sent-at -
          canceled), the NEXT reminder highlighted, and any will-be-skipped note. */}
      <RemindersPanel tourId={tour.tourId} />

      {actionError !== null ? <p role="alert">{actionError}</p> : null}

      {/* Book — a 'requested' tour has no time yet; booking sets one and arms reminders. */}
      {canBook && !showBook ? (
        <button
          type="button"
          onClick={() => setShowBook(true)}
          disabled={submitting}
        >
          Book tour
        </button>
      ) : null}
      {showBook ? (
        <form onSubmit={handleBook} aria-label="Book tour form">
          <label htmlFor="tour-book-at">Date and time</label>
          <input
            id="tour-book-at"
            type="datetime-local"
            value={bookScheduledAt}
            onChange={(e) => setBookScheduledAt(e.target.value)}
            required
          />
          <button type="submit" disabled={submitting || !bookScheduledAt}>
            Confirm booking
          </button>
          <button type="button" onClick={() => { setShowBook(false); setBookScheduledAt(''); }}>
            Cancel
          </button>
        </form>
      ) : null}

      {/* Reschedule */}
      {canReschedule && !showReschedule ? (
        <button
          type="button"
          onClick={() => setShowReschedule(true)}
          disabled={submitting}
          aria-label="Reschedule this tour"
        >
          Reschedule
        </button>
      ) : null}
      {showReschedule ? (
        <form onSubmit={handleReschedule} aria-label="Reschedule tour form">
          <label htmlFor="tour-reschedule-at">New date and time</label>
          <input
            id="tour-reschedule-at"
            type="datetime-local"
            value={newScheduledAt}
            onChange={(e) => setNewScheduledAt(e.target.value)}
            required
          />
          <button type="submit" disabled={submitting || !newScheduledAt}>
            Confirm reschedule
          </button>
          <button type="button" onClick={() => { setShowReschedule(false); setNewScheduledAt(''); }}>
            Cancel
          </button>
        </form>
      ) : null}

      {/* Status controls: confirm, then mark attendance (toured / no-show). */}
      {canConfirm ? (
        <button
          type="button"
          onClick={() => void handleStatus('confirmed', 'Confirm failed')}
          disabled={submitting}
        >
          Confirm tour
        </button>
      ) : null}
      {canMarkAttendance ? (
        <>
          <button
            type="button"
            onClick={() => void handleStatus('toured', 'Status update failed')}
            disabled={submitting}
          >
            Mark toured
          </button>
          <button
            type="button"
            onClick={() => void handleStatus('no_show', 'Status update failed')}
            disabled={submitting}
          >
            Mark no-show
          </button>
        </>
      ) : null}

      {/* Cancel */}
      {canCancel ? (
        <button
          type="button"
          onClick={() => void handleStatus('canceled', 'Cancel failed')}
          disabled={submitting}
          aria-label="Cancel this tour"
        >
          Cancel tour
        </button>
      ) : null}

      {/* Open group thread — Team-created by hand (never auto-created). Members
          are omitted so the server auto-resolves [tenant, unit's landlord]. */}
      {canOpenGroup ? (
        <button
          type="button"
          onClick={() => void handleOpenGroup()}
          disabled={submitting}
        >
          Open group thread
        </button>
      ) : null}

      {/* Exit gate: "Moving forward?" — records the navigator decision. Does NOT create a placement. */}
      {canRecord && !showExitGate ? (
        <button
          type="button"
          onClick={() => setShowExitGate(true)}
          disabled={submitting}
          aria-label="Record exit gate decision"
        >
          Record outcome
        </button>
      ) : null}
      {showExitGate ? (
        <form onSubmit={handleExitGate} aria-label="Exit gate form">
          <fieldset>
            <legend>Moving forward with this property?</legend>
            <label>
              <input
                type="radio"
                name="move-forward"
                value="yes"
                checked={exitMoveForward === true}
                onChange={() => { setExitMoveForward(true); setExitOutcome('move_forward'); }}
              />
              Yes — move forward
            </label>
            <label>
              <input
                type="radio"
                name="move-forward"
                value="no"
                checked={exitMoveForward === false}
                onChange={() => { setExitMoveForward(false); setExitOutcome('not_a_fit'); }}
              />
              No — not a fit
            </label>
          </fieldset>
          <button
            type="submit"
            disabled={submitting || exitMoveForward === null}
          >
            Save decision
          </button>
          <button
            type="button"
            onClick={() => { setShowExitGate(false); setExitOutcome(''); setExitMoveForward(null); }}
          >
            Cancel
          </button>
        </form>
      ) : null}

      {/* Post-Tour & Application: a convertible, not-yet-converted tour offers
          'Start placement' (converts + jumps to the new placement). Once converted
          the tour carries convertedPlacementId → link to the placement instead. */}
      {tour.convertible === true && tour.convertedPlacementId === undefined ? (
        <button
          type="button"
          onClick={() => void handleConvert()}
          disabled={submitting}
          aria-label="Start placement from this tour"
        >
          Start placement
        </button>
      ) : null}
      {typeof tour.convertedPlacementId === 'string' ? (
        <Link to={`/placements/${tour.convertedPlacementId}`}>View placement</Link>
      ) : null}
    </article>
  );
}
