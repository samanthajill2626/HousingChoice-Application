// JobEnvelope — the wire format for ALL job traffic (binding guideline 2).
// Only jobs.enqueue() produces envelopes and only dispatchJob() consumes them.
import type { CorrelationContext } from '../lib/context.js';

export const JOB_ENVELOPE_VERSION = 1 as const;

export interface JobEnvelope {
  v: typeof JOB_ENVELOPE_VERSION;
  /** Unique ID for this enqueued job instance. */
  jobId: string;
  jobName: string;
  payload: unknown;
  /**
   * Correlation context captured at enqueue time (requestId, conversationId,
   * tenantId, caseId — NOT jobRunId; dispatch generates a fresh jobRunId).
   */
  correlationContext: CorrelationContext;
  /** W3C traceparent propagated across the hop. */
  traceparent: string;
  /** Job-chain depth, incremented per hop. Enqueue throws past 10. */
  hopCount: number;
  /** ISO-8601 timestamp set at enqueue time. */
  enqueuedAt: string;
}
