// AsyncLocalStorage correlation context — the async envelope every log line
// and every job hop is stamped with (binding guideline 2).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

export interface CorrelationContext {
  requestId?: string;
  jobRunId?: string;
  /**
   * The envelope's jobId — STABLE across SQS redeliveries of the same
   * enqueued job (jobRunId is fresh per run). dispatchJob stamps it so
   * handlers can key duplicate-execution guards on it (M1.2 retrySend).
   */
  jobId?: string;
  /**
   * How this context came to exist. `synthesized` marks a doc-§9
   * envelope-less payload whose context dispatchJob had to mint fresh.
   */
  originType?: 'synthesized';
  /**
   * Process-lifecycle correlation: entrypoints generate one bootId per process
   * start and wrap startup/shutdown in it, so lifecycle log lines ("app
   * listening", "worker ready", shutdown) are never orphans. Lowest-precedence
   * correlationId source — request/job ids always win.
   */
  bootId?: string;
  conversationId?: string;
  /** Contact under triage (M1.4 contact-triage route). */
  contactId?: string;
  tenantId?: string;
  placementId?: string;
  /** Authenticated session user (M1.3) — stamped by the session middleware. */
  userId?: string;
  /** Job-chain depth; incremented per enqueue hop (runaway-loop guard). */
  hopCount?: number;
  /** W3C traceparent propagated across HTTP and job hops. */
  traceparent?: string;
}

const als = new AsyncLocalStorage<CorrelationContext>();

/** Run fn with ctx as the active correlation context (a copy — callers keep ownership). */
export function runWithContext<T>(ctx: CorrelationContext, fn: () => T): T {
  return als.run({ ...ctx }, fn);
}

/** The active correlation context, or undefined outside any envelope. */
export function getContext(): CorrelationContext | undefined {
  return als.getStore();
}

/** Merge fields into the ACTIVE context (no-op outside a context). */
export function mergeContext(partial: Partial<CorrelationContext>): void {
  const store = als.getStore();
  if (store) Object.assign(store, partial);
}

export function newRequestId(): string {
  return randomUUID();
}

export function newJobRunId(): string {
  return randomUUID();
}

export function newBootId(): string {
  return randomUUID();
}

// --- W3C traceparent helpers (version 00) ---------------------------------
// Format: 00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>.
// trace-id/parent-id must not be all zeros. We keep this deliberately simple:
// flags are always 01 (sampled) on generation; full span propagation is OTel's
// job once exporters are wired (M0.4/M0.6).

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function isValidTraceparent(value: string): boolean {
  const m = TRACEPARENT_RE.exec(value);
  if (!m) return false;
  const [, traceId, parentId] = m;
  return traceId !== '0'.repeat(32) && parentId !== '0'.repeat(16);
}

export function generateTraceparent(): string {
  const traceId = randomBytes(16).toString('hex'); // 16 bytes -> 32 hex
  const parentId = randomBytes(8).toString('hex'); // 8 bytes -> 16 hex
  return `00-${traceId}-${parentId}-01`;
}

/**
 * The traceparent for the current unit of work: propagate the one in the
 * active context if valid, otherwise generate a fresh one.
 */
export function currentTraceparent(): string {
  const ctx = getContext();
  if (ctx?.traceparent && isValidTraceparent(ctx.traceparent)) {
    return ctx.traceparent;
  }
  return generateTraceparent();
}
