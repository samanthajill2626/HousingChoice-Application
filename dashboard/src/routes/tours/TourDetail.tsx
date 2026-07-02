// TourDetail — the detail page for a single tour (GET /api/tours/:tourId).
// Shows: status, scheduled date/time, tour type, exit-gate feedback (the
// "Moving forward?" question → PATCH { outcome, moveForward }), reschedule /
// cancel controls, and a link to the tour's relay group thread.
//
// Tours are SEPARATE from placements. This page records the navigator decision
// (exit gate) but does NOT create a placement or change tenant status. The exit
// gate sets `convertible`; actual conversion is a downstream step.
//
// Audience vocabulary: navigator/staff see "property"; tenant sees "home".
// This is a staff-only dashboard page, so we use "property" for the unit.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  getTour,
  patchTour,
  ApiError,
  TOUR_STATUS_LABELS,
  TOUR_OUTCOME_LABELS,
  TOUR_TYPE_LABELS,
  type Tour,
  type TourOutcome,
  type TourStatus,
} from '../../api/index.js';

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
  'scheduled',
  'confirmed',
]);

/** The statuses from which a navigator can reschedule (mirrors canReschedule in toursModel). */
const RESCHEDULABLE: ReadonlySet<TourStatus> = new Set<TourStatus>([
  'scheduled',
  'confirmed',
  'canceled',
  'no_show',
]);

export function TourDetail(): React.JSX.Element {
  const { tourId } = useParams<{ tourId: string }>();
  const [tour, setTour] = useState<Tour | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reschedule form state
  const [showReschedule, setShowReschedule] = useState(false);
  const [newScheduledAt, setNewScheduledAt] = useState('');

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

  async function handleCancel() {
    if (!tour || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const updated = await patchTour(tour.tourId, { status: 'canceled' });
      setTour(updated);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Cancel failed');
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
      const updated = await patchTour(tour.tourId, { scheduledAt: newScheduledAt, status: 'scheduled' });
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
      const updated = await patchTour(tour.tourId, {
        outcome: exitOutcome,
        moveForward: exitMoveForward,
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

  if (loading) {
    return <p aria-live="polite">Loading tour…</p>;
  }
  if (error !== null || !tour) {
    return <p role="alert">{error ?? 'Tour not found'}</p>;
  }

  const statusLabel = TOUR_STATUS_LABELS[tour.status] ?? tour.status;
  const typeLabel = TOUR_TYPE_LABELS[tour.tourType as keyof typeof TOUR_TYPE_LABELS] ?? tour.tourType;
  const canCancel = CANCELABLE.has(tour.status as TourStatus);
  const canReschedule = RESCHEDULABLE.has(tour.status as TourStatus);
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
            {/* TODO(tours): render 'Not yet booked' for a timeless 'requested' tour (tours-sequence Task 4). */}
            <dd aria-label={`Scheduled: ${formatScheduledAt(tour.scheduledAt ?? '')}`}>
              {formatScheduledAt(tour.scheduledAt ?? '')}
            </dd>
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

      {actionError !== null ? <p role="alert">{actionError}</p> : null}

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

      {/* Cancel */}
      {canCancel ? (
        <button
          type="button"
          onClick={handleCancel}
          disabled={submitting}
          aria-label="Cancel this tour"
        >
          Cancel tour
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
    </article>
  );
}
