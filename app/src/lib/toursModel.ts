// Tour-specific status model — pure constants, guards, and helpers. NO I/O.
//
// Tours are orthogonal to the placement status model (statusModel.ts) and
// live in their own file to keep each model focused. The design follows the
// same idioms: a `as const` array → `type` → `Set` → guard → labels map.
//
// STATUS LIFECYCLE:
//   requested → scheduled                     (time is set — the scheduling step)
//   requested → canceled                      (canceled before a time is set)
//   scheduled → confirmed → toured → closed   (normal happy path)
//   * → canceled                               (pre-tour cancellation)
//   confirmed/scheduled → no_show             (tenant no-show)
//   canceled / no_show → scheduled            (reschedule — see canReschedule)
//   toured + outcome set → closed             (exit gate)
//
// `requested` is the entry status for time-less tours (tenant wants a tour but
// no scheduledAt yet). Setting scheduledAt transitions to `scheduled`.
//
// `closed` is the terminal for a finished-and-decided tour. The `outcome`
// field (TourOutcome) records the exit decision; `moveForward=true` marks
// the tour as convertible. Conversion to a placement is NOT handled here —
// this is pure enums/guards.

// --- Tour statuses -----------------------------------------------------------
export const TOUR_STATUSES = [
  'requested',
  'scheduled',
  'confirmed',
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
  confirmed: 'Confirmed',
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

// --- Reschedulability --------------------------------------------------------
// A tour may be rescheduled (→ `scheduled`) from these statuses:
//   - `requested`  — setting a time IS the scheduling step (no prior scheduledAt)
//   - `scheduled`  — change of date/time before confirmation
//   - `confirmed`  — late rescheduling after confirmation
//   - `canceled`   — revived after cancellation
//   - `no_show`    — second-chance appointment after a no-show
//
// A `toured` tour carries a real outcome and MUST be closed via the exit gate;
// it cannot be recycled as a new appointment. A `closed` tour is terminal.
const RESCHEDULABLE: ReadonlySet<TourStatus> = new Set<TourStatus>([
  'requested',
  'scheduled',
  'confirmed',
  'canceled',
  'no_show',
]);

/** True when a tour in `status` may be rescheduled (→ `scheduled`). */
export function canReschedule(status: TourStatus): boolean {
  return RESCHEDULABLE.has(status);
}
