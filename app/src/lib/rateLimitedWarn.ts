// Rate-limited WARN (native group texting, plan T3.7).
//
// The tripwire fires per INBOUND MESSAGE. If the undocumented
// `OtherRecipients{N}` contract ever disappears, EVERY group inbound matches the
// shape at once - an unbounded WARN flood that buries the signal it exists to
// raise. The signal is "this is happening at all", not "here is each occurrence".
//
// There is no general throttle in this repo. The one flood-suppression
// precedent, lib/composeFailTally.ts, is PER-REQUEST and does not transfer: a
// webhook request handles exactly one message, so there is nothing to tally
// within a request. This is the module-scoped equivalent - a last-emitted
// timestamp plus a suppressed counter that is FLUSHED on the next emission, so
// the throttle can never hide the true rate.
//
// PII (doc 9): this helper adds only `suppressedCount`; whatever the caller
// passes is the caller's responsibility (ids and counts only).
import { logger as defaultLogger } from './logger.js';

/** The one method this helper needs - narrow so a test fake is two lines. */
export interface WarnSink {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface RateLimitedWarnOptions {
  /** Destination logger (the router's correlated child in production). */
  logger?: WarnSink;
  /** Minimum gap between emitted WARNs, in milliseconds. */
  intervalMs: number;
  /** Injectable clock (tests); `Date.now` otherwise. */
  now?: () => number;
  /**
   * Injectable "run this once, `ms` from now" seam for the TRAILING FLUSH
   * (fix wave 5, adversarial 21). Defaults to an UNREF'd `setTimeout`, so a
   * pending flush never holds the process open. Tests pass a manual scheduler.
   */
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * A `warn(fields, message)` function that emits at most once per `intervalMs`.
 * The emitted line always carries `suppressedCount`: how many calls were
 * swallowed since the previous emission (0 on a clean first hit).
 */
export function createRateLimitedWarn(
  opts: RateLimitedWarnOptions,
): (fields: Record<string, unknown>, message: string) => void {
  const log = opts.logger ?? defaultLogger;
  const now = opts.now ?? Date.now;
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number): void => {
      setTimeout(fn, ms).unref();
    });
  let lastEmittedAt: number | undefined;
  let suppressed = 0;
  let flushPending = false;
  let lastFields: Record<string, unknown> = {};
  let lastMessage = '';

  /**
   * THE TRAILING FLUSH. `suppressed` used to be reported only on the NEXT
   * emission, so a burst of N inside one window followed by silence - or a task
   * replacement - never reported N at all. That is exactly the shape a
   * detection outage produces (a flood, then the traffic stops), and it
   * contradicted this module's own claim that "the throttle can never hide the
   * true rate". So the tally is drained when the window closes, whether or not
   * anything else happens.
   */
  function scheduleFlush(): void {
    if (flushPending) return;
    flushPending = true;
    const at = lastEmittedAt ?? now();
    schedule(() => {
      flushPending = false;
      if (suppressed === 0) return;
      const suppressedCount = suppressed;
      suppressed = 0;
      lastEmittedAt = now();
      log.warn(
        { ...lastFields, suppressedCount, trailingFlush: true },
        lastMessage,
      );
    }, Math.max(0, at + opts.intervalMs - now()));
  }

  return (fields, message) => {
    const at = now();
    const elapsed = lastEmittedAt === undefined ? undefined : at - lastEmittedAt;
    // A BACKWARDS CLOCK STEP MUST NOT BLIND THE THROTTLE (fix wave 5,
    // adversarial 21). `at - lastEmittedAt < intervalMs` is true for every
    // NEGATIVE difference, so an NTP correction or a VM snapshot restore
    // suppressed EVERY call until wall-clock time caught back up - a 30-minute
    // backwards step blinded the tripwire for 35 minutes, which is precisely
    // the window in which a detection outage would be invisible. Time going
    // backwards is not "too soon"; it means the clock is untrustworthy, so the
    // window is restarted and this call is emitted.
    if (elapsed !== undefined && elapsed < 0) {
      log.warn(
        { event: 'rate_limited_warn_clock_stepped_back', backwardsMs: -elapsed },
        'the rate-limited WARN clock stepped backwards - restarting the throttle window',
      );
    } else if (elapsed !== undefined && elapsed < opts.intervalMs) {
      suppressed += 1;
      lastFields = fields;
      lastMessage = message;
      scheduleFlush();
      return;
    }
    lastEmittedAt = at;
    lastFields = fields;
    lastMessage = message;
    const suppressedCount = suppressed;
    suppressed = 0;
    log.warn({ ...fields, suppressedCount }, message);
  };
}
