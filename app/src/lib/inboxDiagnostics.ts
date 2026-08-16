export interface InboxTraceEvent {
  caseId: string;
  repeat: number;
  operation: string;
  startedAt: string;
  startOffsetMs: number;
  durationMs: number;
  outcome: 'ok' | 'error';
  arguments: unknown[];
  resultCount: number;
  error?: string;
}

export interface InboxTraceSummary {
  caseId: string;
  operation: string;
  calls: number;
  failures: number;
  totalMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  totalResultCount: number;
}

export interface InboxTimingContext {
  caseId: string;
  repeat: number;
  originMs: number;
  nowMs: () => number;
  wallNow: () => string;
}

export interface InboxProfilePlanEntry {
  caseId: string;
  filter: 'all' | 'unread' | 'unknown' | 'groups';
  limit: number;
  repeat: number;
}

/**
 * The fixed comparison workload for the manual Inbox repository profiler.
 * Dashboard pages request 30 rows; the app-level badge requests 100. Five
 * repeats provide comparable dispersion without mutating the local data.
 */
export function createInboxProfilePlan(): InboxProfilePlanEntry[] {
  const cases = [
    { caseId: 'all-page', filter: 'all', limit: 30 },
    { caseId: 'unread-page', filter: 'unread', limit: 30 },
    { caseId: 'unknown-page', filter: 'unknown', limit: 30 },
    { caseId: 'groups-page', filter: 'groups', limit: 30 },
    { caseId: 'unread-badge', filter: 'unread', limit: 100 },
  ] as const;

  return cases.flatMap((profileCase) =>
    Array.from({ length: 5 }, (_, repeat) => ({ ...profileCase, repeat })),
  );
}

function countResult(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: unknown[] }).items.length;
  }
  return 1;
}

export function createTimedRepository<T extends object>(
  scope: string,
  target: T,
  trace: InboxTraceEvent[],
  context: InboxTimingContext,
): T {
  return new Proxy(target, {
    get(repository, property, receiver) {
      const value = Reflect.get(repository, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const startedAt = context.wallNow();
        const startMs = context.nowMs();
        try {
          const result = await Reflect.apply(value, repository, args) as unknown;
          const endMs = context.nowMs();
          trace.push({
            caseId: context.caseId,
            repeat: context.repeat,
            operation: `${scope}.${String(property)}`,
            startedAt,
            startOffsetMs: startMs - context.originMs,
            durationMs: endMs - startMs,
            outcome: 'ok',
            arguments: args,
            resultCount: countResult(result),
          });
          return result;
        } catch (err) {
          const endMs = context.nowMs();
          trace.push({
            caseId: context.caseId,
            repeat: context.repeat,
            operation: `${scope}.${String(property)}`,
            startedAt,
            startOffsetMs: startMs - context.originMs,
            durationMs: endMs - startMs,
            outcome: 'error',
            arguments: args,
            resultCount: 0,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      };
    },
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, index)]!;
}

export function summarizeInboxTrace(trace: readonly InboxTraceEvent[]): InboxTraceSummary[] {
  const grouped = new Map<string, InboxTraceEvent[]>();
  for (const event of trace) {
    const key = `${event.caseId}\0${event.operation}`;
    const events = grouped.get(key) ?? [];
    events.push(event);
    grouped.set(key, events);
  }

  return [...grouped.values()]
    .map((events) => {
      const durations = events.map((event) => event.durationMs).sort((a, b) => a - b);
      return {
        caseId: events[0]!.caseId,
        operation: events[0]!.operation,
        calls: events.length,
        failures: events.filter((event) => event.outcome === 'error').length,
        totalMs: durations.reduce((sum, value) => sum + value, 0),
        medianMs: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        maxMs: durations[durations.length - 1]!,
        totalResultCount: events.reduce((sum, event) => sum + event.resultCount, 0),
      };
    })
    .sort((a, b) => a.caseId.localeCompare(b.caseId) || a.operation.localeCompare(b.operation));
}

export function assertLocalInboxProfileTarget(endpoint: string, tablePrefix: string): void {
  if (endpoint !== 'http://localhost:8000' && endpoint !== 'http://127.0.0.1:8000') {
    throw new Error('Inbox profiling is restricted to DynamoDB Local');
  }
  if (tablePrefix !== 'hc-local-') {
    throw new Error('Inbox profiling is restricted to the hc-local- table prefix');
  }
}
