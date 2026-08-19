// Call-state presentation for timeline CALL cards - a pure function, unit-tested
// directly (the sibling of deliveryStatus.ts, which does the same job for message
// bubbles). It has more cases than anything else on the card, so it lives here
// rather than buried in JSX.
//
// Three rules the clause order below encodes, each one hard-won:
//   - The outbound connected/no-answer signal comes from the TARGET leg, never
//     from the navigator's press-1. On an originate the whisper gate runs on our
//     own staff member's leg, so an accepted call whose Dial summary never landed
//     is "Outcome unknown" - NOT "Connected", and NOT a blank card either: an
//     accepted, placed call whose result we never learned is a different thing
//     from a row carrying no information at all.
//   - "Not completed" is keyed to `canceled` SPECIFICALLY, never to terminality in
//     general. The dev transcript seam appends a call with terminal
//     `callStatus: 'completed'` and no outcome before attaching a full transcript;
//     a terminality-keyed clause would render a fully transcribed call
//     "Not completed". The signature that identifies a refusal stamp is a terminal
//     status WITHOUT an outcome, because every /status terminal write pairs the
//     two.
//   - A live-looking label is only ever claimed from a timestamp we could parse,
//     and it always comes with the instant it expires (`staleAt`) so the card can
//     schedule exactly one re-render and then settle.
//
// The presenter's inputs are camelCase and the wire contract is snake_case; the
// CallCard does that mapping at the call site, which is the only place the two
// vocabularies meet.
// Imported from `api/types.js` rather than the `api/index.js` barrel ON PURPOSE:
// the S5 seam test drives this presenter from an APP-side test, and the barrel
// re-exports a .tsx module, which the app's tsconfig (no `jsx`) refuses to load.
// types.ts has no imports of its own, so this keeps the presenter reachable from
// both packages. Type-only either way - nothing is emitted.
import type { CallOutcome, CallStatus, MessageDirection } from '../../api/types.js';
// Same reasoning as the types import above: `lib/time.ts` is pure, imports
// nothing, and pulls in no .tsx, so it stays reachable from the app-side seam
// test. It is also what every sibling formatter in this directory uses.
import { isoOf } from '../../lib/time.js';

/** Chip color intent. Declared here (not in types.ts) for the same reason
 *  `DeliveryTone` is: it is a presentation concept, not a wire type. */
export type CallTone = 'success' | 'danger' | 'warning' | 'neutral';

export interface CallStateInput {
  direction: MessageDirection;
  callStatus?: CallStatus;
  callOutcome?: CallOutcome;
  /** The call's own instant, ISO. May be unparseable - see `age` below. */
  at: string;
  /** The instant to evaluate against (the card's state clock). */
  now: number;
}

export interface CallStatePresentation {
  /** Chip text. Absent means NO chip - the card still renders direction and time. */
  label?: string;
  /** Present exactly when `label` is. */
  tone?: CallTone;
  /**
   * The epoch instant at which THIS label stops being the right one. Returned
   * ONLY by the fresh arms of the ringing / in-progress clauses, and only ever
   * strictly in the future. A result with no `staleAt` gets no timer at all.
   */
  staleAt?: number;
}

/**
 * How long a `ringing` row may still read "Ringing...".
 *
 * Derivation, so a reader knows what invalidates it: Twilio's default ring is 60
 * seconds and we pass no `timeout` on the originate; then the whisper `<Say>`
 * plays on the answered leg BEFORE the `<Gather>`'s 8-second silence timer even
 * starts, so the realistic worst case is 60s + the whisper (a few seconds of
 * speech) + 8s, i.e. roughly 73-78s rather than a flat 68s. 90s clears that with
 * headroom, but not much - if the ring timeout, the `<Gather>` timeout, or the
 * length of the whisper copy changes, re-derive this number.
 */
export const RINGING_STALE_MS = 90_000;

/**
 * How long an `in-progress` row may still read "In progress". A real call can
 * legitimately run an hour, so this is NOT a claim that the call ended - it is the
 * point past which asserting a LIVE call stops being honest, after which the
 * clause falls back to a direction-split statement about what we actually know.
 */
export const IN_PROGRESS_STALE_MS = 900_000;

/** ISO instant -> epoch ms, or undefined when it does not parse. `at` can be a
 *  non-instant (the projection's `atOf` can return one, and an empty `at` is a
 *  real case elsewhere in this directory).
 *
 *  Normalised through `isoOf` FIRST, exactly like the sibling formatters in this
 *  directory: this codebase's sort keys are `<ISO>#<collision suffix>`, a shape
 *  `Date.parse` cannot read. The server's `atOf` strips that suffix before it
 *  reaches this surface today, so this is a consistency guard rather than a live
 *  bug fix - it stops a future producer handing over a raw sort key from
 *  silently disabling the age-based clauses (3 and 4) instead of failing loudly.
 *  A genuinely unparseable value still yields undefined and still falls THROUGH
 *  those clauses. */
function parseInstant(at: string): number | undefined {
  const ms = Date.parse(isoOf(at));
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Resolve a call row to its chip label, tone, and expiry instant. Each clause is
 * the ELSE of the one before; the order is the contract, not an implementation
 * detail. Returns `{}` when nothing is known - deliberately distinct from
 * "Outcome unknown", which says a call went out and we never learned the result.
 */
export function presentCallState({
  direction,
  callStatus,
  callOutcome,
  at,
  now,
}: CallStateInput): CallStatePresentation {
  const outbound = direction === 'outbound';
  // `age` exists ONLY when `at` parsed. Clauses 3 and 4 require a defined age; an
  // undefined age falls THROUGH them to the outcome clauses, so an unparseable
  // timestamp never produces an age-based claim.
  const startedAt = parseInstant(at);
  const age = startedAt === undefined ? undefined : now - startedAt;

  // 1. A voicemail is a settled fact and wins over any status.
  if (callOutcome === 'voicemail') {
    return { label: 'Voicemail', tone: 'warning' };
  }

  // 2. A terminal `canceled` with NO outcome is a gate refusal: the call was
  //    placed and hung up before it could reach anyone. Keyed to `canceled`
  //    specifically - see the file head.
  if (callStatus === 'canceled' && callOutcome === undefined) {
    return { label: 'Not completed', tone: 'neutral' };
  }

  // 3. Still ringing, for as long as ringing is plausible.
  if (callStatus === 'ringing' && startedAt !== undefined && age !== undefined) {
    if (age < RINGING_STALE_MS) {
      return { label: 'Ringing...', tone: 'neutral', staleAt: startedAt + RINGING_STALE_MS };
    }
    return outbound
      ? { label: 'No team answer', tone: 'danger' }
      : { label: 'Missed', tone: 'danger' };
  }

  // 4. Connected, for as long as a live call is plausible - then the I1 split,
  //    but ONLY when no outcome was ever stored.
  if (callStatus === 'in-progress' && startedAt !== undefined && age !== undefined) {
    if (age < IN_PROGRESS_STALE_MS) {
      // The FRESH arm does NOT defer. "In progress" is the right label on a live
      // call whatever outcome is already sitting on the row.
      return { label: 'In progress', tone: 'neutral', staleAt: startedAt + IN_PROGRESS_STALE_MS };
    }
    // The STALE arm DEFERS to a stored outcome. `in-progress` and a stored
    // outcome really co-exist: the server's `mapCallStatus` folds Twilio's
    // `DialCallStatus: 'answered'` onto `'in-progress'` while the SAME handler's
    // answered-stamp writes `call_outcome: 'answered'`. Keying this arm on the
    // STATUS alone therefore returned before clause 5 could read the OUTCOME,
    // and stranded a call whose result we DID learn on "Outcome unknown" - the
    // label that exists to say we never learned it. Falling through hands the
    // row to clauses 5/6, where the stored answer wins.
    if (callOutcome === undefined) {
      // Nothing stored. Inbound: the press-1 whisper gate ran on the DIALED
      // callee's leg, so a human accepted. Outbound: it ran on the navigator's
      // OWN leg, so press-1 proves only that our staff member picked up their
      // own phone - it says nothing about whether the target ever answered.
      // NEVER "Connected" here; this is I1 on the read side.
      return outbound
        ? { label: 'Outcome unknown', tone: 'neutral' }
        : { label: 'Answered', tone: 'success' };
    }
  }

  // 5. "Connected" is the strongest honest claim on outbound: a completed Dial
  //    with a duration is produced identically by a human and by the target's
  //    carrier voicemail, and we cannot tell them apart without AMD.
  if (callOutcome === 'answered') {
    return outbound
      ? { label: 'Connected', tone: 'success' }
      : { label: 'Answered', tone: 'success' };
  }

  // 6.
  if (callOutcome === 'missed') {
    return outbound
      ? { label: 'No answer', tone: 'danger' }
      : { label: 'Missed', tone: 'danger' };
  }

  // 7. Nothing known: no label, no tone, no timer.
  return {};
}
