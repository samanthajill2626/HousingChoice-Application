// Tour-specific status model — pure constants, guards, and helpers. NO I/O.
//
// Tours are orthogonal to the placement status model (statusModel.ts) and
// live in their own file to keep each model focused. The design follows the
// same idioms: a `as const` array → `type` → `Set` → guard → labels map.
//
// STATUS LIFECYCLE:
//   requested -> scheduled                    (booking - the time is set)
//   requested -> canceled                     (canceled before a time is set)
//   requested -> toured                       (it happened without being booked)
//   scheduled -> toured -> closed             (normal happy path)
//   * -> canceled                             (pre-tour cancellation)
//   scheduled -> no_show                      (tenant no-show)
//   canceled / no_show -> scheduled           (reschedule - see canReschedule)
//   toured + outcome set -> closed            (exit gate)
//   scheduled / toured / no_show -> closed    (auto-close, outcome no_outcome,
//                                              two weeks after the clock start)
//   closed -> scheduled / toured / no_show    (reopen - see reopenTargetFor)
//
// NOTE (2026-07-08): the 'confirmed' status was removed - scheduled covers it
// (booking IS the confirmation; the [AUTO] booking text already says so).
//
// `requested` is the timeless pre-scheduled state: the tour record exists as
// the coordination anchor (it owns the group thread) before any time is set.
// Booking = setting scheduledAt, which advances it to `scheduled` — only then
// are reminders armed (a `requested` tour MUST have no reminder rows).
//
// A `requested` tour may ALSO go straight to `toured`: it happened without us
// booking it. That edge is deliberately SILENT - it arms nothing and sends
// nothing, which is the whole point (booking it just to reach the exit gate
// would text the group about a visit that already took place). It may carry an
// optional past scheduledAt recording when it actually happened.
//
// `closed` is terminal for PATCH; only POST /reopen leaves it (see
// reopenTargetFor). It ends a finished-and-decided tour - decided by a person,
// or with outcome `no_outcome` by the auto-close sweep. The `outcome` field
// (TourOutcome) records the exit decision; `moveForward=true` marks the tour
// as convertible. Conversion to a placement is NOT handled here - this is
// pure enums/guards.

// --- Tour statuses -----------------------------------------------------------
export const TOUR_STATUSES = [
  'requested',
  'scheduled',
  'toured',
  'no_show',
  'canceled',
  'closed',
] as const;

export type TourStatus = (typeof TOUR_STATUSES)[number];

const TOUR_STATUS_SET: ReadonlySet<string> = new Set(TOUR_STATUSES);

export const TOUR_STATUS_LABELS: Readonly<Record<TourStatus, string>> = {
  requested: 'Requested',
  scheduled: 'Scheduled',
  toured: 'Toured',
  no_show: 'No show',
  canceled: 'Canceled',
  closed: 'Closed',
};

/** Is `x` a known tour status (route allowlist + DynamoDB validation)? */
export function isTourStatus(x: unknown): x is TourStatus {
  return typeof x === 'string' && TOUR_STATUS_SET.has(x);
}

// --- Tour outcomes (exit gate + auto-close) ----------------------------------
// Recorded on the tour when it is decided. `move_forward` means the tenant is
// worth pursuing for a placement; `not_a_fit` ends the tour thread;
// `no_outcome` is written ONLY by the auto-close sweep (jobs/tourAutoClose.ts)
// when nobody recorded a decision two weeks after the tour's clock start
// (Sam #18, 2026-10-01). People record only STAFF_TOUR_OUTCOMES.
export const TOUR_OUTCOMES = ['move_forward', 'not_a_fit', 'no_outcome'] as const;

export type TourOutcome = (typeof TOUR_OUTCOMES)[number];

const TOUR_OUTCOME_SET: ReadonlySet<string> = new Set(TOUR_OUTCOMES);

export const TOUR_OUTCOME_LABELS: Readonly<Record<TourOutcome, string>> = {
  move_forward: 'Move forward',
  not_a_fit: 'Not a fit',
  no_outcome: 'No outcome recorded',
};

/** Is `x` a known tour outcome (any writer, including the sweep)? */
export function isTourOutcome(x: unknown): x is TourOutcome {
  return typeof x === 'string' && TOUR_OUTCOME_SET.has(x);
}

/** The outcomes a PERSON may record through PATCH /api/tours/:id. `no_outcome`
 *  is system-only: the auto-close sweep writes it and nothing else may. */
export const STAFF_TOUR_OUTCOMES = ['move_forward', 'not_a_fit'] as const satisfies readonly TourOutcome[];

export type StaffTourOutcome = (typeof STAFF_TOUR_OUTCOMES)[number];

const STAFF_TOUR_OUTCOME_SET: ReadonlySet<string> = new Set(STAFF_TOUR_OUTCOMES);

/** Is `x` an outcome a person may record (the PATCH exit-gate allowlist)? */
export function isStaffTourOutcome(x: unknown): x is StaffTourOutcome {
  return typeof x === 'string' && STAFF_TOUR_OUTCOME_SET.has(x);
}

// --- Tour types --------------------------------------------------------------
// The three ways a tour can be conducted. This is the CANONICAL home of the
// TourType union (toursRepo re-exports it for existing importers). It lives
// here, next to the other tour enums, so BOTH tours (routing) and units (the
// per-unit structured tour_type) can share ONE union + label map WITHOUT a
// repo->repo import. tour type is load-bearing: reminder ROUTING branches on
// self_guided (routed 1:1 instead of via the group thread).
export const TOUR_TYPES = ['self_guided', 'landlord_led', 'pm_team'] as const;

export type TourType = (typeof TOUR_TYPES)[number];

const TOUR_TYPE_SET: ReadonlySet<string> = new Set(TOUR_TYPES);

export const TOUR_TYPE_LABELS: Readonly<Record<TourType, string>> = {
  self_guided: 'Self-guided',
  landlord_led: 'Landlord-led',
  pm_team: 'PM team',
};

/** Is `x` a known tour type (route allowlist + unit-field validation)? */
export function isTourType(x: unknown): x is TourType {
  return typeof x === 'string' && TOUR_TYPE_SET.has(x);
}

// --- Reschedulability --------------------------------------------------------
// A tour may be rescheduled (-> `scheduled`) from these statuses:
//   - `requested`  - booking: the first time is set on a timeless tour
//   - `scheduled`  - change of date/time before the visit
//   - `canceled`   - revived after cancellation
//   - `no_show`    - second-chance appointment after a no-show
//
// A `toured` tour carries a real outcome and MUST be closed via the exit gate;
// it cannot be recycled as a new appointment. A `closed` tour is terminal for
// PATCH; only POST /reopen leaves it (see reopenTargetFor).
const RESCHEDULABLE: ReadonlySet<TourStatus> = new Set<TourStatus>([
  'requested',
  'scheduled',
  'canceled',
  'no_show',
]);

/** True when a tour in `status` may be rescheduled (→ `scheduled`). */
export function canReschedule(status: TourStatus): boolean {
  return RESCHEDULABLE.has(status);
}

// --- Auto-close (Sam #18, 2026-10-01) ----------------------------------------
// A tour that still has no outcome two weeks after its CLOCK START is closed by
// the sweep (jobs/tourAutoClose.ts) with outcome `no_outcome`. The clock starts
// at the LATEST of: the tour's creation, its scheduled time (when it has one),
// and its MARK - the last time a person marked / rescheduled / reopened it
// (`lastMarkedAt`), or, for a tour nobody has marked since this shipped, its
// last change (`updatedAt`, never earlier than a pre-deploy mark). So a visit
// recorded late, a reopened tour, or one marked just before the deploy still
// gets its full two weeks. Pure: the job, the dev tick and the tests share it.

/** Two weeks, exactly (336 hours). */
export const AUTO_CLOSE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** The statuses the sweep may close. Never `requested` (no date to count
 *  from), `canceled` (already an exit) or `closed`. */
export const AUTO_CLOSE_STATUSES = ['scheduled', 'toured', 'no_show'] as const satisfies readonly TourStatus[];

export type AutoCloseStatus = (typeof AUTO_CLOSE_STATUSES)[number];

const AUTO_CLOSE_STATUS_SET: ReadonlySet<string> = new Set(AUTO_CLOSE_STATUSES);

export function isAutoCloseStatus(x: unknown): x is AutoCloseStatus {
  return typeof x === 'string' && AUTO_CLOSE_STATUS_SET.has(x);
}

/** The fields the clock reads. A stored tour item satisfies it. */
export interface AutoCloseClockInput {
  status: unknown;
  outcome?: unknown;
  convertible?: unknown;
  convertedPlacementId?: unknown;
  scheduledAt?: unknown;
  createdAt?: unknown;
  lastMarkedAt?: unknown;
  updatedAt?: unknown;
}

/** Epoch ms of a non-empty ISO string, or null. */
function parseIsoMs(x: unknown): number | null {
  if (typeof x !== 'string' || x.length === 0) return null;
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The epoch-ms instant this tour becomes due for auto-close, or null when it
 * is not a candidate at all (wrong status, already decided, convertible, or a
 * conversion claimed or finished). A present-but-unparseable instant is null:
 * never close on a date we cannot read.
 */
export function autoCloseDueAtMs(tour: AutoCloseClockInput): number | null {
  if (!isAutoCloseStatus(tour.status)) return null;
  if (tour.outcome !== undefined) return null;
  if (tour.convertible === true) return null;
  if (typeof tour.convertedPlacementId === 'string') return null;
  const created = parseIsoMs(tour.createdAt);
  if (created === null) return null;
  let start = created;
  if (tour.scheduledAt !== undefined && tour.scheduledAt !== '') {
    const at = parseIsoMs(tour.scheduledAt);
    if (at === null) return null;
    start = Math.max(start, at);
  }
  // The mark: lastMarkedAt once a person has marked / rescheduled / reopened
  // the tour since this shipped; before that, updatedAt stands in (no
  // migration - spec 5.3). Once lastMarkedAt exists, unrelated writes that
  // bump updatedAt (a roster edit, a group open) no longer move the clock.
  const mark = tour.lastMarkedAt !== undefined ? tour.lastMarkedAt : tour.updatedAt;
  if (mark !== undefined) {
    const markedMs = parseIsoMs(mark);
    if (markedMs === null) return null;
    start = Math.max(start, markedMs);
  }
  return start + AUTO_CLOSE_AFTER_MS;
}

/** True when the sweep should close this tour at `nowMs` (inclusive). */
export function isAutoCloseDue(tour: AutoCloseClockInput, nowMs: number): boolean {
  const due = autoCloseDueAtMs(tour);
  return due !== null && due <= nowMs;
}

// --- Reopen (Sam #18, 2026-10-01) --------------------------------------------
// A closed tour may be reopened to record a different outcome or reschedule
// it. It returns to the state it closed from: the sweep stores that state in
// `autoClosedFrom`; a person-decided tour (not a fit / move forward) was
// toured. A converted tour (finished or mid-claim) never reopens - the
// placement owns it. A closed tour carrying neither fact (written directly
// through the API) is refused rather than guessed.
export type ReopenRefusal = 'tour_not_closed' | 'tour_converted' | 'tour_reopen_unsupported';

export interface ReopenTargetInput {
  status: unknown;
  outcome?: unknown;
  convertedPlacementId?: unknown;
  autoClosedFrom?: unknown;
}

export type ReopenTargetResult =
  | { ok: true; target: AutoCloseStatus }
  | { ok: false; error: ReopenRefusal };

export function reopenTargetFor(tour: ReopenTargetInput): ReopenTargetResult {
  if (tour.status !== 'closed') return { ok: false, error: 'tour_not_closed' };
  if (typeof tour.convertedPlacementId === 'string') return { ok: false, error: 'tour_converted' };
  if (isAutoCloseStatus(tour.autoClosedFrom)) return { ok: true, target: tour.autoClosedFrom };
  if (tour.outcome === 'not_a_fit' || tour.outcome === 'move_forward') return { ok: true, target: 'toured' };
  return { ok: false, error: 'tour_reopen_unsupported' };
}
