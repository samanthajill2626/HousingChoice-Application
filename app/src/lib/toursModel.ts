// Tour-specific status model — pure constants, guards, and helpers. NO I/O.
//
// Tours are orthogonal to the placement status model (statusModel.ts) and
// live in their own file to keep each model focused. The design follows the
// same idioms: a `as const` array → `type` → `Set` → guard → labels map.
//
// STATUS LIFECYCLE:
//   requested -> scheduled                    (booking - the time is set)
//   requested -> canceled                     (canceled before a time is set)
//   scheduled -> toured -> closed             (normal happy path)
//   * -> canceled                             (pre-tour cancellation)
//   scheduled -> no_show                      (tenant no-show)
//   canceled / no_show -> scheduled           (reschedule - see canReschedule)
//   toured + outcome set -> closed            (exit gate)
//
// NOTE (2026-07-08): the 'confirmed' status was removed - scheduled covers it
// (booking IS the confirmation; the [AUTO] booking text already says so).
//
// `requested` is the timeless pre-scheduled state: the tour record exists as
// the coordination anchor (it owns the group thread) before any time is set.
// Booking = setting scheduledAt, which advances it to `scheduled` — only then
// are reminders armed (a `requested` tour MUST have no reminder rows).
//
// `closed` is the terminal for a finished-and-decided tour. The `outcome`
// field (TourOutcome) records the exit decision; `moveForward=true` marks
// the tour as convertible. Conversion to a placement is NOT handled here —
// this is pure enums/guards.

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

// --- Tour outcomes (exit gate) -----------------------------------------------
// Recorded on the tour when it moves to `closed`. `move_forward` means the
// tenant is worth pursuing for a placement; `not_a_fit` ends the tour thread.
// The actual placement creation is deferred — this model captures only the
// decision so the conversion can happen later with full placement logic.
export const TOUR_OUTCOMES = ['move_forward', 'not_a_fit'] as const;

export type TourOutcome = (typeof TOUR_OUTCOMES)[number];

const TOUR_OUTCOME_SET: ReadonlySet<string> = new Set(TOUR_OUTCOMES);

export const TOUR_OUTCOME_LABELS: Readonly<Record<TourOutcome, string>> = {
  move_forward: 'Move forward',
  not_a_fit: 'Not a fit',
};

/** Is `x` a known tour outcome? */
export function isTourOutcome(x: unknown): x is TourOutcome {
  return typeof x === 'string' && TOUR_OUTCOME_SET.has(x);
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
// it cannot be recycled as a new appointment. A `closed` tour is terminal.
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
