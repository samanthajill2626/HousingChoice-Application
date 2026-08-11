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
  let lastEmittedAt: number | undefined;
  let suppressed = 0;

  return (fields, message) => {
    const at = now();
    if (lastEmittedAt !== undefined && at - lastEmittedAt < opts.intervalMs) {
      suppressed += 1;
      return;
    }
    lastEmittedAt = at;
    const suppressedCount = suppressed;
    suppressed = 0;
    log.warn({ ...fields, suppressedCount }, message);
  };
}
