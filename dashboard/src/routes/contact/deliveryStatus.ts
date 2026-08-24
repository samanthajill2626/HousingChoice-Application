// Delivery-state presentation for OUTBOUND message bubbles — pure functions,
// unit-tested directly. Ported from the legacy dashboard's ui/deliveryStatus.ts so
// the new comms pane shows the same Queued/Sent/Delivered/Undelivered/Failed states.
//
// Two rules carried over:
//   - "sent ≠ delivered": `sent` is a non-error waypoint, NEVER shown as a failure.
//   - Inbound messages have no meaningful delivery state — callers render this for
//     OUTBOUND only. A row with no stored status (seed/legacy) shows NO chip
//     (returns null) rather than a misleading "Sending…".
import type { DeliveryStatus } from '../../api/index.js';

export type DeliveryTone = 'neutral' | 'info' | 'success' | 'danger';

export interface DeliveryPresentation {
  /** Short badge label ("Sent", "Delivered", "Failed", …). */
  label: string;
  tone: DeliveryTone;
  /** undelivered/failed — the caller surfaces a Retry action. */
  isFailure: boolean;
  /**
   * Human-readable failure reason(s), ALWAYS carrying the raw Twilio error code
   * so an operator can debug (e.g. "Number not registered for A2P 10DLC (error
   * 30034)"). Present only on a failure that carried a code; absent otherwise.
   * For a relay rollup, distinct per-leg reasons are joined with "; ".
   */
  reason?: string;
}

const STATUS_PRESENTATION: Record<DeliveryStatus, DeliveryPresentation> = {
  // `queued_pending` (connect-when-ready hold, T7) = composed on a `connecting`
  // relay group and held: no number to send from yet, so it goes to nobody until
  // the group connects and it flushes. A neutral, non-failure "Queued" cue that
  // says WHEN it will send - it is a deliberate hold, not a stall.
  queued_pending: {
    label: 'Queued - will send when connected',
    tone: 'neutral',
    isFailure: false,
  },
  // `queued` = accepted by us / handed to the carrier but not yet carrier-sent —
  // i.e. the "sending from the app" waypoint. Shown as "Sending…" so the optimistic
  // bubble reads as in-progress before it advances to Sent → Delivered.
  queued: { label: 'Sending…', tone: 'neutral', isFailure: false },
  sent: { label: 'Sent', tone: 'info', isFailure: false },
  delivered: { label: 'Delivered', tone: 'success', isFailure: false },
  undelivered: { label: 'Undelivered', tone: 'danger', isFailure: true },
  failed: { label: 'Failed', tone: 'danger', isFailure: true },
};

/**
 * How long an outbound message may sit at `sent` before the chip stops implying
 * it landed. Twilio returns a terminal receipt within seconds to a couple of
 * minutes when it returns one at all; 15 minutes is well past that.
 */
export const STALE_SENT_AFTER_MS = 15 * 60 * 1000;

/**
 * `sent` that never advanced. An over-budget MMS is discarded by the carrier
 * with NO receipt and NO error code (docs/issues/
 * outbound-mms-stalls-at-sent-with-no-receipt.md), so the row sits at `sent`
 * forever and the old chip read "Sent" - indistinguishable from a message that
 * actually arrived. That is exactly how the 2026-08-19 drop went unnoticed.
 *
 * Deliberately NOT `isFailure`: no receipt is not proof of failure, the message
 * may well have landed, and marking it failed would offer a Retry that could
 * double-send. It reads as danger so it draws the eye, and says plainly that we
 * do not know. No `reason` either - the label already says it, and the bubble
 * renders a reason INLINE, where a sentence of guidance would swamp the chip.
 */
const STALE_SENT_PRESENTATION: DeliveryPresentation = {
  label: 'Sent - not confirmed',
  tone: 'danger',
  isFailure: false,
};

/**
 * THE single clock comparison in this module: has `atMs` been quiet for at least
 * STALE_SENT_AFTER_MS as of `nowMs`? Inclusive at exactly the threshold.
 *
 * One shared COMPARISON, never one shared PREDICATE. `presentDeliveryStatus`
 * keeps its own `sent`-only gate over this, and `isStaleLeg` encodes the
 * per-leg eligibility table over the same comparison, so the two rules can
 * differ in WHICH legs they consider without ever diverging on the threshold.
 *
 * `atMs` is `number | undefined` because a caller's clock is genuinely optional
 * and may be `Date.parse` of a malformed string. Both a missing clock and a
 * non-finite one answer false: no clock is no evidence of quiet.
 */
export function isQuietSince(atMs: number | undefined, nowMs: number): boolean {
  if (atMs === undefined || !Number.isFinite(atMs)) return false;
  return nowMs - atMs >= STALE_SENT_AFTER_MS;
}

/**
 * Map a delivery status to its label/tone/failure-flag, or `null` when there is no
 * status to show (undefined — seed/legacy rows; or an unrecognized value). Returning
 * null keeps the bubble clean instead of inventing a false "Sending…"/failure cue.
 *
 * `sentAtMs` (the message's timestamp) is optional: pass it and a `sent` row that
 * has gone quiet for STALE_SENT_AFTER_MS presents as unconfirmed instead of
 * "Sent". Omit it and behavior is exactly as before. `nowMs` is injectable for
 * tests.
 *
 * CONVENTION DIVERGENCE, deliberate - do NOT harmonise these two:
 * this function opts out of staleness by WITHHOLDING THE TIMESTAMP (`sentAtMs`).
 * Its `nowMs` is a DEFAULTED parameter, so passing `undefined` RE-ARMS the real
 * clock rather than disabling anything. The newer `isStaleLeg` /
 * `canEverGoStale` / `presentRelayDelivery` / `presentLegDelivery` opt out the
 * opposite way - by WITHHOLDING THE CLOCK (`nowMs: number | undefined`, where
 * undefined means staleness is off entirely). Changing this signature would move
 * the 1:1 rule, which three out-of-module callers depend on.
 */
export function presentDeliveryStatus(
  status: DeliveryStatus | undefined,
  sentAtMs?: number,
  nowMs: number = Date.now(),
): DeliveryPresentation | null {
  if (status === undefined) return null;
  if (status === 'sent' && isQuietSince(sentAtMs, nowMs)) {
    return STALE_SENT_PRESENTATION;
  }
  return STATUS_PRESENTATION[status] ?? null;
}

/** The slice of a relay `delivery_recipients` slot the rollup presenter reads.
 *
 *  Both clocks are ISO strings off the wire (`api/types.ts` RelayRecipientDelivery)
 *  and come from DIFFERENT sources: `sentAt` is the PROVIDER's timestamp, written
 *  only by the two relay send paths after a real send returned, and `deliveredAt`
 *  is OUR server clock, written only on the `delivered` transition. Never subtract
 *  one from the other or present the pair as a duration. */
export interface RelayDeliverySlot {
  status: DeliveryStatus;
  errorCode?: string;
  sentAt?: string;
  deliveredAt?: string;
}

/** Parse an ISO clock string off the wire, or undefined when it is absent or
 *  does not parse. "PARSEABLE" is load-bearing: a `sentAt` that is present but
 *  malformed must fall to the NO-CLOCK rows of the table below, where the rule
 *  is explicit, rather than yielding a NaN clock that silently never ages. */
function parseWireClock(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * THE clock a leg ages from, or undefined when this leg has none. `isStaleLeg`
 * and `canEverGoStale` are both derived from this ONE helper so they can never
 * drift about which clock a slot uses.
 *
 * The S3 eligibility table, encoded:
 *
 *   | leg status     | parseable sentAt | ages from |
 *   | sent           | yes              | sentAt    |
 *   | sent           | no               | msg.at    |
 *   | queued         | yes              | sentAt    |
 *   | queued         | no               | NOTHING   |
 *   | queued_pending | either           | NOTHING   |
 *   | delivered/failed/undelivered | either | NOTHING |
 *   | any of the above | clock MORE THAN ONE BUDGET AHEAD of nowMs | NOTHING |
 *
 * That last row is the FUTURITY bound, and it is the only row this function does
 * not decide, because it depends on the READING clock rather than on the slot:
 * it is enforced in `canEverGoStale`, whose doc carries the reasoning. A clock
 * further ahead of ours than the entire staleness budget is not measuring the
 * same time we are, so nothing may be inferred from its age.
 *
 * Why `sent` may fall back to the message clock but `queued` may NOT: a RELAY
 * leg cannot reach `sent` without a `sentAt` (the fan-out writes both on one
 * object, and the DLR path is child-field-only and never clears it), so the
 * fallback is reached only by a native group-text leg, whose `msg.at` IS its
 * send time. A `queued` leg with no `sentAt`, by contrast, is exactly the shape
 * of a released connect-when-ready hold (parent flipped to `queued` before the
 * fan-out is enqueued, `msg.at` days old) and of a fan-out that never ran. Those
 * two are BYTE-IDENTICAL, so one answer must serve both, and the decided answer
 * is silence: a false red on a message that is about to send trains staff to
 * ignore the cue. The cost is that the whole "our dispatch never happened" class
 * can never escalate here; the server's own staleness alarm covers it.
 *
 * A terminal leg has settled, and a `queued_pending` hold has not been
 * dispatched, so neither can be overdue.
 */
function stalenessClockMs(
  slot: RelayDeliverySlot,
  messageAtMs: number | undefined,
): number | undefined {
  const legClock = parseWireClock(slot.sentAt);
  // Exhaustive over DeliveryStatus. The `never` default is deliberate: a future
  // union member becomes a TYPECHECK FAILURE here rather than silently falling
  // into a default branch that decides its staleness by accident.
  switch (slot.status) {
    case 'sent':
      return legClock ?? messageAtMs;
    case 'queued':
      return legClock;
    case 'queued_pending':
    case 'delivered':
    case 'undelivered':
    case 'failed':
      return undefined;
    default: {
      const unreachable: never = slot.status;
      void unreachable;
      // Unreachable for a well-typed status; an off-wire value has no ageing
      // clock. The annotation above is what turns a NEW union member into a
      // typecheck failure instead of a silent staleness decision.
      return undefined;
    }
  }
}

/**
 * Has this leg gone quiet? True only when the leg has a clock proving the LEG
 * ITSELF started (see `stalenessClockMs`) and that clock has been quiet for
 * STALE_SENT_AFTER_MS.
 *
 * CONVENTION, opposite to `presentDeliveryStatus`'s and deliberately so:
 * staleness is evaluated ONLY when `nowMs` is supplied. With `nowMs` undefined,
 * this returns false for EVERY slot regardless of `sentAt` - a caller cannot
 * withhold a per-slot clock, so withholding the READING clock is the only total
 * off switch, and callers rely on it (an imported row, and every pre-existing
 * `presentRelayDelivery` call that passes no clock at all).
 */
export function isStaleLeg(
  slot: RelayDeliverySlot,
  messageAtMs: number | undefined,
  nowMs: number | undefined,
): boolean {
  if (nowMs === undefined) return false;
  return isQuietSince(stalenessClockMs(slot, messageAtMs), nowMs);
}

/**
 * COULD this leg ever become stale later? The ticker's run condition is
 * `canEverGoStale(...) && !isStaleLeg(...)` - a leg that can never age schedules
 * nothing, exactly like a terminal one, which is what makes the interval
 * terminate.
 *
 * True iff a clock is supplied AND the leg has an applicable clock that is
 * FINITE. Finiteness is not defensive: the row clock falls back to the message
 * instant, and `messageInstant` (conversation/useRelayThread.ts) returns `''`
 * for a non-ISO `tsMsgId`, whose `Date.parse` is NaN. Under a shape test such a
 * leg would read "eligible" for ever and never stale, and the interval would
 * spin for ever.
 *
 * The stale-capable statuses (`sent`, `queued`) are implied rather than re-listed:
 * `stalenessClockMs` returns undefined for every other status, and re-listing
 * them here is exactly the drift the shared helper exists to prevent.
 *
 * THE FUTURITY BOUND, and why it is a BOUND rather than `clock <= nowMs`. Every
 * ageing clock here is the PROVIDER's; `nowMs` is the OPERATOR'S BROWSER clock.
 * A browser clock running slow - a stale VM, no NTP, a dead CMOS battery - puts
 * every freshly-sent leg in the FUTURE, and a future clock answered "eligible"
 * and "not yet stale" at the same time, so the interval stayed armed for ever
 * (the fifth shipped non-termination; see `Timeline.tsx`'s run-condition doc).
 *
 * Two properties decide the shape of the fix, and BOTH must survive any later
 * simplification of this clause:
 *
 *  1. BOUNDEDNESS. A clock at most one staleness budget ahead of ours is
 *     ordinary skew. It stays eligible, `nowMs` advances with real time, and the
 *     leg crosses the boundary within at most TWO budgets (about 30 minutes) -
 *     so the interval terminates, and the escalation is merely LATE.
 *  2. NO MISSED ESCALATION. Requiring `clock <= nowMs` instead would make that
 *     ordinary slow-browser leg INELIGIBLE. Nothing would be armed, so nothing
 *     would re-render when `nowMs` caught up, and the escalation would be missed
 *     ENTIRELY - the exact failure direction this feature exists to prevent. A
 *     bounded late signal is acceptable; a silently absent one is not.
 *
 * Past one whole budget ahead the clock is not measuring the same time we are,
 * and this design prefers SILENCE over a signal computed from a clock we cannot
 * trust - so such a leg ages from nothing.
 *
 * `isStaleLeg` is deliberately NOT given this bound. It already answers false
 * for a future clock (it is not yet quiet) and correctly becomes true once that
 * clock genuinely is. The two functions still agree BY CONSTRUCTION about WHICH
 * clock a slot uses - they share `stalenessClockMs`, which is the drift this
 * module guards against - and they do NOT have to agree about futurity, because
 * `canEverGoStale` answers "should we buy an interval" and is allowed to be the
 * conservative one.
 */
export function canEverGoStale(
  slot: RelayDeliverySlot,
  messageAtMs: number | undefined,
  nowMs: number | undefined,
): boolean {
  if (nowMs === undefined) return false;
  const clock = stalenessClockMs(slot, messageAtMs);
  if (clock === undefined || !Number.isFinite(clock)) return false;
  // Inclusive at exactly one budget ahead, mirroring `isQuietSince`'s inclusive
  // threshold. A NaN clock is already excluded above, so this comparison never
  // decides anything by NaN's own falsiness.
  return clock - nowMs <= STALE_SENT_AFTER_MS;
}

/**
 * Present a relay SOURCE message's per-recipient rollup as one chip. The rules:
 *   - in flight → neutral "delivered N/M" that counts up as DLRs land;
 *   - every leg delivered → the SAME green "Delivered" cue as a 1:1 bubble
 *     ("Delivered N/N") so a finalized group send is legible at a glance;
 *   - any hard-failed leg (failed/undelivered) → danger, with the failure count.
 * Opted-out members are EXCLUDED from the count: they were never sent to (the
 * bubble's opt-out note explains them), and counting them would make N/M
 * unreachable — the chip could never finalize. All-opted-out (or no slots) ⇒
 * null: nothing was fanned out, so there is nothing to summarize.
 *
 * NEW: a leg that has gone QUIET (see `isStaleLeg`) is counted separately and
 * turns the chip danger as "J not confirmed" - a bare count is a coin flip, and
 * the 2026-08-23 drop was lost on exactly that toss. The opted-out exclusion
 * above covers J as well as N, M and K.
 *
 * K and J are DISJOINT by construction: a hard-failed leg is terminal, and
 * `isStaleLeg` is false for every terminal status. Branch 2's label adds them,
 * so that disjointness is load-bearing and is asserted in the tests.
 *
 * The staleness inputs are OPTIONAL and follow the WITHHELD-CLOCK convention:
 * with `nowMs` undefined this cannot select the not-confirmed branches at all,
 * whatever `sentAt` the slots carry, and behaves exactly as it did before. That
 * is what keeps every pre-existing no-clock assertion honest rather than lucky.
 * (Note the opposite convention on `presentDeliveryStatus` - see its doc.)
 */
export function presentRelayDelivery(
  slots: RelayDeliverySlot[],
  messageAtMs?: number,
  nowMs?: number,
): DeliveryPresentation | null {
  // Keyed on the CODE ALONE, deliberately. The relay fan-out records a
  // suppressed leg as `failed`; the group-text receipts path records what Twilio
  // actually reported for a 21610, which is `undelivered`. Requiring `failed` as
  // well meant a group text's opted-out member was counted as a hard failure -
  // the exact outcome the synthetic `contact_opted_out` code exists to prevent -
  // while the identical relay leg was excluded. `contact_opted_out` is written by
  // us, never by a carrier, so the code by itself is an unambiguous statement
  // that this leg was never really sent.
  const fanned = slots.filter((s) => s.errorCode !== 'contact_opted_out');
  if (fanned.length === 0) return null;
  const delivered = fanned.filter((s) => s.status === 'delivered').length;
  const failed = fanned.filter(
    (s) => s.status === 'failed' || s.status === 'undelivered',
  ).length;
  const total = fanned.length;
  const stale = fanned.filter((s) => isStaleLeg(s, messageAtMs, nowMs)).length;
  if (failed > 0) {
    // Surface the failed legs' error code(s) so the chip is debuggable (the 30034
    // relay-group bug read as a bare "0/2 - 2 failed" with no code). Distinct
    // reasons joined; a repeated code collapses to one.
    const reasons = Array.from(
      new Set(
        fanned
          .filter((s) => s.status === 'failed' || s.status === 'undelivered')
          .map((s) => deliveryReason(s.errorCode))
          .filter((r): r is string => r !== undefined),
      ),
    );
    return {
      // The reason is appended INLINE after this label by the bubble, so the
      // counts come first and the reason last: it belongs to the FAILED legs
      // only, and putting it between the two counts would attach it to the
      // unconfirmed ones instead.
      label:
        stale > 0
          ? `delivered ${delivered}/${total} - ${failed} failed, ${stale} not confirmed`
          : `delivered ${delivered}/${total} - ${failed} failed`,
      tone: 'danger',
      isFailure: true,
      ...(reasons.length > 0 && { reason: reasons.join('; ') }),
    };
  }
  if (stale > 0) {
    // Danger so it draws the eye, but deliberately NOT isFailure: no receipt is
    // not proof of failure, and isFailure is what offers a Retry that could
    // double-send a message that actually landed. Same reasoning as
    // STALE_SENT_PRESENTATION.
    return {
      label: `delivered ${delivered}/${total} - ${stale} not confirmed`,
      tone: 'danger',
      isFailure: false,
    };
  }
  if (delivered === total) {
    return { label: `Delivered ${total}/${total}`, tone: 'success', isFailure: false };
  }
  return { label: `delivered ${delivered}/${total}`, tone: 'neutral', isFailure: false };
}

/**
 * Which multi-party product a per-recipient row belongs to. Structurally
 * identical to - and assignable from - `RosterKind` in `Timeline.tsx`; declared
 * here rather than imported so this presenter module stays a leaf (the
 * broadcasts routes import it too, and it must not drag a component in).
 */
export type LegRosterKind = 'relay' | 'group_text';

/**
 * `queued` that never advanced. `presentDeliveryStatus` will NOT produce this:
 * the 1:1 rule stays `sent`-only, so the per-leg presenter renders it itself.
 *
 * It MUST differ from STALE_SENT_PRESENTATION. "Sent - not confirmed" on a leg
 * the provider never reported sent asserts an event that did not happen. Same
 * tone and same non-failure reasoning as the `sent` twin.
 */
const STALE_QUEUED_PRESENTATION: DeliveryPresentation = {
  label: 'Queued - not confirmed',
  tone: 'danger',
  isFailure: false,
};

/**
 * Present ONE recipient's leg of a multi-party send.
 *
 * Per-leg state reuses `presentDeliveryStatus` so a leg and a 1:1 message never
 * disagree about what a status MEANS, with exactly two exceptions this function
 * owns - the stale labels and the opted-out label. They live here and NOT in
 * `presentDeliveryStatus`, whose other callers (the EmailCard chip and the
 * broadcasts recipient badge) must not move.
 *
 * THE DELEGATION RULE, and the reason this function exists at all: it NEVER
 * delegates the staleness decision, on either path. It decides staleness itself
 * with `isStaleLeg` and returns its own stale presentation; for everything else
 * it calls `presentDeliveryStatus(slot.status)` with NO second argument,
 * ALWAYS - enabled path and disabled path alike, so there is exactly one
 * delegation call shape here. That is correct for all six statuses, because
 * branch 4 is reached only when the leg is NOT stale, so the plain
 * STATUS_PRESENTATION label is by construction the right answer.
 *
 * Passing `presentDeliveryStatus(slot.status, messageAtMs, nowMs)` instead would
 * hand that function's `sent`-only rule the MESSAGE clock, and a released
 * connect-when-ready hold - composed days ago, fanned out seconds ago - would
 * render instant red. That false red is the exact failure the per-leg `sentAt`
 * gate exists to prevent, and it is reachable in production.
 *
 * Returns null for an unrecognised status: the row then shows the member's name
 * and NO state chip, never a blank row and never an invented state.
 */
export function presentLegDelivery(
  slot: RelayDeliverySlot,
  rosterKind: LegRosterKind,
  messageAtMs?: number,
  nowMs?: number,
): DeliveryPresentation | null {
  // Keyed on the CODE ALONE, exactly as the rollup's denominator filter is, so a
  // leg excluded from N/M and a leg labelled "not sent" are always the same set.
  // The relay fan-out records a suppressed leg as `failed` and the group-text
  // receipts path records Twilio's `undelivered` for a 21610; both mean the same
  // thing, and `contact_opted_out` is written by us, never by a carrier.
  //
  // Deliberately NOT routed through `deliveryReason`, which maps this code to
  // "Everyone here has opted out - nothing was sent" - copy written for the
  // message-level AGGREGATE. On the row of the one member in five who opted out
  // that would be a fresh instance of the misread this feature exists to kill.
  //
  // PRODUCT-AWARE, mirroring the split the opt-out note above the rows already
  // makes, because the mechanism genuinely differs: on a group text Twilio skips
  // the participant, on a relay the app itself declines to send.
  if (slot.errorCode === 'contact_opted_out') {
    return {
      label:
        rosterKind === 'group_text'
          ? 'Not sent - opted out (Twilio skips them)'
          : 'Not sent - opted out',
      tone: 'neutral',
      // Not a failure: nothing was sent, so there is nothing to retry, and the
      // bubble renders a row's reason only when that row isFailure.
      isFailure: false,
    };
  }
  if (isStaleLeg(slot, messageAtMs, nowMs)) {
    return slot.status === 'queued' ? STALE_QUEUED_PRESENTATION : STALE_SENT_PRESENTATION;
  }
  return presentDeliveryStatus(slot.status);
}

/**
 * Twilio error code → human-readable reason (the §7.1 classes the legacy covered).
 * Used when the timeline carries `error_code` on a failure; absent code ⇒ undefined
 * (the caller shows just the "Failed" label then).
 */
const ERROR_CODE_REASONS: Record<string, string> = {
  '30003': 'Phone unreachable — will retry',
  '30005': 'Number is invalid',
  '30006': 'That number is a landline',
  '30007': 'Carrier filtered the message',
  '30034': 'Number not registered for A2P 10DLC',
  '21610': 'Recipient has opted out (STOP)',
};

/**
 * Codes THIS APP invents, which no carrier ever emits and no operator can look
 * up. They get plain operator copy and, deliberately, NO "(error <code>)" tail:
 * printing `contact_opted_out` as if it were a carrier error number is the
 * defect this map exists to fix (A16).
 *
 * `contact_opted_out` reaches the message-level chip only as the group-send
 * AGGREGATE: `deriveGroupDeliveryStatus` (app/src/services/groupDelivery.ts)
 * writes `{ status: 'undelivered', errorCode: 'contact_opted_out' }` when every
 * member is suppressed, and `presentRelayDelivery` returns null for that map, so
 * the bubble has no rollup to fall back on and this string IS what staff read.
 * The framing matches groupDelivery.ts: Twilio never creates the leg, so nothing
 * was sent - it is not a delivery failure.
 *
 * This is STAFF-FACING dashboard copy, so it lives here beside
 * ERROR_CODE_REASONS rather than in the app's message catalog (which is the
 * single source for automated MEMBER-facing copy).
 */
const INTERNAL_CODE_REASONS: Record<string, string> = {
  contact_opted_out: 'Everyone here has opted out - nothing was sent',
};

/**
 * Twilio error code → a human reason that ALWAYS surfaces the raw code number
 * (mapped or not), so an operator never has to leave the thread to learn WHY a
 * send failed. Absent code ⇒ undefined (caller shows just the "Failed" label).
 */
/** OWN-PROPERTY lookup (adversarial 30). Both maps are plain object literals, so
 *  a bare `map[code]` resolves inherited Object.prototype members - and an
 *  `error_code` is provider/wire data, never a trusted key. `INTERNAL_CODE_REASONS`
 *  is the sharp one: its early return would hand back a FUNCTION where the
 *  signature promises a string (the error map only escaped because its template
 *  wrap coerced whatever it found). */
function ownReason(map: Record<string, string>, code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : undefined;
}

export function deliveryReason(errorCode: string | undefined): string | undefined {
  if (errorCode === undefined || errorCode.length === 0) return undefined;
  const internal = ownReason(INTERNAL_CODE_REASONS, errorCode);
  if (internal !== undefined) return internal;
  const mapped = ownReason(ERROR_CODE_REASONS, errorCode);
  return mapped !== undefined
    ? `${mapped} (error ${errorCode})`
    : `Delivery failed (error ${errorCode})`;
}
