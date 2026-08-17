// The ONE way a worker poll loop is started, so a tick can never run outside a
// correlation context.
//
// WHY THIS MODULE EXISTS (prod incident 2026-08-16): the worker's five poll
// loops (tour reminders, placement nudges, roster actions, extraction, group
// guardrails) each had their own bare `setInterval` in worker.ts. A timer
// callback inherits no context - nothing upstream mints a poll tick an id the
// way an HTTP request or a job envelope does - so EVERY line those loops
// logged was an orphan. The extraction poll alone produced ~40-47 orphan lines
// a day and kept `hc-prod-orphan-logs` flapping ALARM<->OK for days, which is
// how an alarm stops being read. Worse, each loop's `.catch` arm is the only
// place a poll's own crash is reported, so a genuine poll failure was an
// orphan ERROR - carrying no id to pivot on during triage.
//
// Same lesson as jobs/queueWiring.ts: behavior five call sites must share
// belongs in one function they all call, not in five blocks that happen to
// agree.
import { newPollRunId, runWithContext, type CorrelationContext } from '../lib/context.js';
import type { Logger } from '../lib/logger.js';

export interface StartPollDeps {
  logger: Logger;
  /** Shared WORKER_POLL_INTERVAL_MS cadence. */
  intervalMs: number;
  /**
   * Process provenance merged under the tick's own id (typically the
   * entrypoint's bootContext). pollRunId outranks bootId as the correlationId,
   * so the tick still reads as the unit of work.
   */
  baseContext?: CorrelationContext;
  /**
   * Test seam. Production passes nothing and gets an UNREF'd setInterval, so a
   * pending tick never holds the process open on shutdown.
   */
  schedule?: (tick: () => void, ms: number) => void;
  /** Injectable clock (tests); the real ISO now otherwise. */
  now?: () => string;
}

/**
 * Run `run(nowIso)` every `intervalMs`, with the WHOLE tick - including the
 * rejection handler - inside a fresh pollRunId context.
 *
 * AsyncLocalStorage propagates into async continuations started within
 * `als.run()`, so `run(now)` and its `.catch` both inherit the tick's id even
 * though `run` resolves long after runWithContext returns.
 *
 * A rejection is logged and swallowed, never rethrown: an unhandled rejection
 * from a timer callback has no caller to catch it and would take the worker
 * down. One bad tick must not stop the loop - the next tick retries, which is
 * the whole point of a stateless poll (state lives in the DynamoDB rows).
 */
export function startPoll(
  pollName: string,
  run: (nowIso: string) => Promise<unknown>,
  deps: StartPollDeps,
): void {
  const { logger, intervalMs, baseContext } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const schedule =
    deps.schedule ??
    ((tick: () => void, ms: number): void => {
      setInterval(tick, ms).unref();
    });

  schedule(() => {
    runWithContext({ ...baseContext, pollRunId: newPollRunId() }, () => {
      void run(now()).catch((err: unknown) => {
        logger.error({ err, poll: pollName }, `${pollName} poll error`);
      });
    });
  }, intervalMs);
}
