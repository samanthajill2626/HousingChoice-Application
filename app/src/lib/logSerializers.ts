// THE SAFE PINO SERIALIZER for the error-carrying log keys (log-hygiene spec
// section 1). pino's default `err` serializer copies EVERY enumerable own key
// of an error-like value; an axios-backed vendor error (the Twilio SDK's
// network-failure path) carries config.headers.Authorization (a live Basic
// credential), config.data (form body), and request._header. This serializer
// makes that class structurally unloggable through the wired keys.
//
// RULES (each is load-bearing; see the spec's review history before changing):
// 1. Primitives pass through UNCHANGED - `reason`/`error` are live DOMAIN
//    string fields on 25+ production lines.
// 2. Non-Error objects pass through UNCHANGED - `{ err: summarizeError(x) }`
//    (11 sites) and `err: { name }` (7 sites) are deliberate summary shapes
//    whose fields must keep reaching the line. Every member of the dangerous
//    class extends Error (AxiosError, RestException, AWS ServiceException),
//    so `instanceof Error` is the allowlist trigger - NOT a structural
//    message-check, which would gut domain objects carrying a `message`.
// 3. `instanceof Error` values emit ONLY the allowlist below. `type` prefers
//    the DECLARED name when present and not the generic 'Error' (the
//    most-identifying-field preference summarizeError uses), else the
//    constructor name.
// 4. Inside cause/aggregate recursion, a non-Error value is DROPPED, never
//    passed through - nothing deliberate nests under `cause`.
// 5. Never throws; degrades to { type: 'UnserializableError' }.
//
// LEAF MODULE: no imports (logger.ts imports this; errors.ts imports
// logger.ts - anything imported here must not close that cycle).

export const LOG_SERIALIZER_KEYS = ['err', 'error', 'cause', 'reason'] as const;

const MAX_CAUSE_DEPTH = 3;
const MAX_AGGREGATE_ERRORS = 5;

function allowlist(err: Error, depth: number): Record<string, unknown> {
  const raw = err as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    moreInfo?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown; attempts?: unknown; totalRetryDelay?: unknown };
    response?: { status?: unknown };
    cause?: unknown;
  };
  const declared = typeof err.name === 'string' && err.name.length > 0 ? err.name : undefined;
  const constructed = err.constructor?.name;
  const out: Record<string, unknown> = {
    // pino's FIELD NAME for the error class is `type` - the key is kept so
    // existing CloudWatch queries still parse; the VALUE now prefers the
    // declared name (pino emitted the constructor), which changes what
    // vendor-class lines carry. Declared-name preference: rule 3.
    type:
      declared !== undefined && declared !== 'Error'
        ? declared
        : typeof constructed === 'string' && constructed.length > 0 && constructed !== 'Object'
          ? constructed
          : 'Error',
    message: err.message,
    ...(typeof err.stack === 'string' && { stack: err.stack }),
  };
  if (typeof raw.code === 'string' && raw.code.length > 0) out['code'] = raw.code;
  else if (typeof raw.code === 'number') out['code'] = String(raw.code);
  // Lift status from the two places vendors put it, BEFORE response is
  // dropped (the same two-source lift summarizeError does).
  if (typeof raw.status === 'number') out['status'] = raw.status;
  else if (typeof raw.response?.status === 'number') out['status'] = raw.response.status;
  if (typeof raw.statusCode === 'number') out['statusCode'] = raw.statusCode;
  if (typeof raw.moreInfo === 'string') out['moreInfo'] = raw.moreInfo;
  const meta = raw.$metadata;
  if (meta !== null && typeof meta === 'object') {
    const projected: Record<string, unknown> = {};
    if (typeof meta.httpStatusCode === 'number') projected['httpStatusCode'] = meta.httpStatusCode;
    if (typeof meta.requestId === 'string') projected['requestId'] = meta.requestId;
    if (typeof meta.attempts === 'number') projected['attempts'] = meta.attempts;
    if (typeof meta.totalRetryDelay === 'number') projected['totalRetryDelay'] = meta.totalRetryDelay;
    if (Object.keys(projected).length > 0) out['$metadata'] = projected;
  }
  if (depth < MAX_CAUSE_DEPTH && raw.cause instanceof Error) {
    out['cause'] = allowlist(raw.cause, depth + 1);
  }
  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    out['aggregateErrors'] = err.errors
      .slice(0, MAX_AGGREGATE_ERRORS)
      .filter((e): e is Error => e instanceof Error)
      .map((e) => allowlist(e, depth + 1));
  }
  return out;
}

/** The serializer bound to every LOG_SERIALIZER_KEYS entry in createLogger. */
export function serializeLoggedError(value: unknown): unknown {
  try {
    if (value instanceof Error) return allowlist(value, 0);
    // Primitives AND non-Error objects pass through - rules 1-2 above.
    return value;
  } catch {
    return { type: 'UnserializableError' };
  }
}
