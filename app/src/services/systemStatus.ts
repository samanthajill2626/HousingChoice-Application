// systemStatusService — the read model behind the admin-only Settings → System
// Status panel (M1.4, doc section 6). FIVE reads, all scoped to this env:
//
//   getFlags()         go-live readiness from runtime config — NO AWS call
//   getAlarms()        CloudWatch DescribeAlarms (prefix hc-<env>-), ALARM-first
//   getErrors(window)  CloudWatch Logs Insights (newest-first, ≤25)
//   getErrorDetail(ref)       CloudWatch GetLogRecord - the COMPLETE record
//                             behind one row; the env scope check lives HERE
//   getTrace(kind, id, atMs)  Logs Insights x2 - the lines around one failure,
//                             merged ascending
//
// GRACEFUL LOCAL DEGRADATION: the alarms/errors reads short-circuit to
// { available: false, reason: 'unavailable_local' } WITHOUT an SDK call when
// the stack is local/hermetic (appEnv === 'local' OR messagingDriver ===
// 'console') — so the local/e2e stack never hangs on AWS credential resolution.
// Any thrown SDK error is caught → { available: false, reason: 'cloudwatch_error' }
// and logged (no PII). Flags ALWAYS work (no AWS).
//
// PII (doc §9): flags are booleans/enums/strings ONLY — never a secret, and
// never a CONTACT's phone number. ONE narrow exception, added deliberately:
// our OWN business number (BUSINESS_PHONE_NUMBER), which we print on public
// flyers and send from, so an admin can see what the app is configured to use.
// It is omitted when unconfigured and is never logged. A founder cell, a
// tenant cell, or any other person's number still never appears here.
// The three CloudWatch reads are a DIFFERENT posture (doc section 2, HUMAN
// DECISION 2026-08-24): this panel is ADMIN-ONLY, enforced SERVER-side by
// requireRole('admin') on every /api/system route, so getErrors,
// getErrorDetail and getTrace MAY hand back contact PII - phone numbers,
// names, message text - and host operational data. That is deliberate; the
// projection is a display control, not a storage control. CREDENTIALS are the
// exclusion: the detail path admits only the `err` keys the adapter's
// ERR_ALLOWLIST names. This service itself still logs counts and reasons only.
import {
  classifyCloudWatchError,
  createCloudWatchClient,
  OOM_APP_INSIGHTS_FILTER,
  OOM_SYSTEM_INSIGHTS_FILTER,
  PINO_ERROR_INSIGHTS_FILTER,
  PINO_WARN_INSIGHTS_FILTER,
  type AlarmView,
  type CloudWatchClientSeam,
  type ErrorEventView,
  type LogRecordView,
  type TraceIdKind,
  type TraceLineView,
} from '../adapters/cloudwatch.js';
import { isPushConfigured, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { extractionPromptFingerprint } from './extraction/prompt.js';

/** The error window the dashboard offers (default 24h). */
export type SystemErrorWindow = '1h' | '24h' | '7d';

/** Valid windows + their lookback in ms. */
const WINDOW_MS: Readonly<Record<SystemErrorWindow, number>> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/** Newest-first error projection cap (doc §6). */
export const ERROR_EVENT_LIMIT = 25;

/** Synthesized (PII-safe) labels for OOM events — never derived from raw log text. */
const OOM_SYSTEM_LABEL = 'Kernel OOM-kill';
const OOM_APP_LABEL = 'V8 heap out of memory';

/**
 * The messaging driver as DISPLAYED in System Status: `twilio` | `console` |
 * `mock`. `mock` is the real `twilio` driver REDIRECTED to a fake host
 * (TWILIO_API_BASE_URL set — the local `--mock` dev loop): the production code
 * path runs, but against a local impersonator, never real Twilio. Surfacing it
 * as `mock` (not `twilio`) keeps an operator from reading the panel as if live
 * sends were on. The override is rejected in production (config.ts), so `mock`
 * can never appear on a deployed stack.
 */
export type MessagingDriverDisplay = AppConfig['messagingDriver'] | 'mock';

/**
 * Go-live readiness flags (booleans/enums/strings only — never secrets, and
 * never a CONTACT's phone). `businessPhoneNumber` is the one deliberate phone
 * number here: it is OUR own published number, not a person's (see the file
 * header).
 */
export interface SystemFlags {
  /** The deploy env name (local | dev | prod). */
  env: string;
  /** A2P kill-switch: outbound SMS enabled (false = expected pre-A2P). */
  smsSendingEnabled: boolean;
  /** A2P kill-switch: relay number provisioning enabled (false = expected pre-A2P). */
  relayLiveProvisioning: boolean;
  /** Whether Web Push (VAPID) is configured in this env. */
  pushConfigured: boolean;
  /** The outbound messaging driver as displayed (twilio | console | mock). */
  messagingDriver: MessagingDriverDisplay;
  /** Whether the conversation-fact-extraction poll runs in this env. */
  aiExtractionEnabled: boolean;
  /** The extraction driver in use, distinct from the messaging driver above. */
  aiExtractionDriver: AppConfig['extractionDriver'];
  /** The model id the Anthropic driver would call. */
  aiExtractionModel: string;
  /** sha256(system prompt + EXTRACTION_SCHEMA), first 12 hex. */
  aiExtractionPromptFingerprint: string;
  /**
   * OUR one business number (BUSINESS_PHONE_NUMBER), E.164. OPTIONAL and
   * OMITTED when unconfigured - never `null`, so every flag value stays a
   * primitive.
   */
  businessPhoneNumber?: string;
}

/** getAlarms result — degrades to { available: false, reason } (still HTTP 200). */
export type AlarmsResult =
  | { available: true; alarms: AlarmView[] }
  | { available: false; reason: string };

/**
 * getErrors result - degrades to { available: false, reason } (still HTTP 200).
 *
 * `partialSources` names the independent query sources that FAILED while others
 * succeeded. Present only when the panel is showing an incomplete picture, so a
 * short list is a positive statement that rows are missing - never silence.
 */
export type ErrorsResult =
  | { available: true; events: ErrorEventView[]; partialSources?: string[] }
  | { available: false; reason: string };

/**
 * getErrorDetail result. Degrades at HTTP 200 like the other reads, never a 500:
 * `unavailable_local` on a local/hermetic stack, `invalid_ref` for a pointer that
 * fails REF_PATTERN, `out_of_scope` when the record belongs to another
 * environment's log group, `cloudwatch_error` when the read throws.
 */
export type DetailResult =
  | { available: true; record: LogRecordView }
  | { available: false; reason: 'unavailable_local' | 'invalid_ref' | 'out_of_scope' | 'cloudwatch_error' };

/**
 * getTrace result. Degrades at HTTP 200 like the other reads, never a 500:
 * `unavailable_local` on a local/hermetic stack, `invalid_id` for an id that is
 * not UUID-shaped, `cloudwatch_error` when the read throws.
 */
export type TraceServiceResult =
  | { available: true; lines: TraceLineView[]; truncatedBefore: boolean; truncatedAfter: boolean }
  | { available: false; reason: 'unavailable_local' | 'invalid_id' | 'cloudwatch_error' };

/** Base64-family pointer, bounded. Insights pointers observed at 220 chars. */
const REF_PATTERN = /^[A-Za-z0-9+/=]{16,512}$/;

/**
 * A correlation id as this app mints them: every one of the four context ids is
 * a `randomUUID()` (lib/context.ts) and the correlation middleware MINTS rather
 * than honors an inbound header, so this can never reject a legitimate id. It
 * runs BEFORE the id reaches the adapter, which interpolates it into an Insights
 * query string - this is the boundary that keeps that interpolation safe.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SystemStatusService {
  /** Go-live flags from runtime config — always works, no AWS call. */
  getFlags(): SystemFlags;
  /** CloudWatch alarms (ALARM-first), or a degraded reason. */
  getAlarms(): Promise<AlarmsResult>;
  /**
   * Recent error events for the window (default 24h), or a degraded reason.
   * `includeWarnings` widens the pino query from level ≥ 50 to level ≥ 40 (the
   * opt-in "include warnings" firehose); Twilio delivery failures are ALWAYS
   * included regardless (they log at warn).
   */
  getErrors(window?: SystemErrorWindow, opts?: GetErrorsOptions): Promise<ErrorsResult>;
  /**
   * The complete log record behind ONE error row (`ref` is that row's Insights
   * `@ptr`), or a degraded reason. The record is rejected unless it came from one
   * of the three CONFIGURED log groups - a pointer is account-scoped and bound to
   * no group, so this is what keeps the read inside this environment.
   */
  getErrorDetail(ref: string): Promise<DetailResult>;
  /**
   * The app+worker log lines around ONE failure, anchored on that row's own
   * timestamp (`atMs`, epoch ms) and filtered on a single correlation id kind,
   * or a degraded reason. The id is validated here, before it can reach the
   * Insights query string.
   */
  getTrace(kind: TraceIdKind, id: string, atMs: number): Promise<TraceServiceResult>;
}

/** Options for {@link SystemStatusService.getErrors}. */
export interface GetErrorsOptions {
  /** Widen the pino query to level ≥ 40 (warn+). Default false (errors only). */
  includeWarnings?: boolean;
}

export interface SystemStatusServiceDeps {
  config: AppConfig;
  logger?: Logger;
  /** Injected in tests; defaults to the real region-configured CloudWatch seam. */
  cloudwatch?: CloudWatchClientSeam;
}

/** True when this env can't reach AWS (local/hermetic) — no SDK call should run. */
function isLocalEnv(config: AppConfig): boolean {
  return config.appEnv === 'local' || config.messagingDriver === 'console';
}

/**
 * Display value for the messaging driver: the real `twilio` driver pointed at a
 * fake host (TWILIO_API_BASE_URL set — the `--mock` loop) is shown as `mock`,
 * not `twilio`. The redirect override is rejected in production (config.ts), so
 * `mock` is local-only and never appears on a deployed stack.
 */
function messagingDriverDisplay(config: AppConfig): MessagingDriverDisplay {
  if (config.messagingDriver === 'twilio' && config.twilioApiBaseUrl !== undefined) return 'mock';
  return config.messagingDriver;
}

export function createSystemStatusService(deps: SystemStatusServiceDeps): SystemStatusService {
  const log = deps.logger ?? defaultLogger;
  const { config } = deps;
  // The SDK clients ARE constructed here at service-creation time, but in a
  // local env they're never `.send()`-ed (getAlarms/getErrors short-circuit
  // before any call) — so no I/O or credential resolution happens locally.
  const cloudwatch = deps.cloudwatch ?? createCloudWatchClient({ config });

  return {
    getFlags() {
      return {
        env: config.appEnv,
        smsSendingEnabled: config.smsSendingEnabled,
        relayLiveProvisioning: config.relayLiveProvisioning,
        pushConfigured: isPushConfigured(config),
        messagingDriver: messagingDriverDisplay(config),
        aiExtractionEnabled: config.aiExtractionEnabled,
        aiExtractionDriver: config.extractionDriver,
        aiExtractionModel: config.aiExtractionModel,
        aiExtractionPromptFingerprint: extractionPromptFingerprint(),
        // OMITTED (not null) when unconfigured: this payload is asserted to
        // carry primitives only, and `typeof null === 'object'`.
        ...(config.businessPhoneNumber !== undefined && {
          businessPhoneNumber: config.businessPhoneNumber,
        }),
      };
    },

    async getAlarms() {
      if (isLocalEnv(config)) {
        // No AWS locally — short-circuit BEFORE any SDK call so the dev/e2e
        // stack never hangs resolving credentials.
        return { available: false, reason: 'unavailable_local' };
      }
      try {
        const alarms = await cloudwatch.describeAlarms(config.alarmNamePrefix);
        // ALARM-first (the spec's requirement), then by name; a name tie breaks
        // by most-recent stateUpdatedAt (recency-aware, stable) — spec allows
        // ties by name OR stateUpdatedAt.
        const sorted = [...alarms].sort((a, b) => {
          if (a.state === 'ALARM' && b.state !== 'ALARM') return -1;
          if (b.state === 'ALARM' && a.state !== 'ALARM') return 1;
          if (a.name !== b.name) return a.name < b.name ? -1 : 1;
          return a.stateUpdatedAt < b.stateUpdatedAt ? 1 : a.stateUpdatedAt > b.stateUpdatedAt ? -1 : 0;
        });
        log.info({ alarmCount: sorted.length }, 'system status: alarms read');
        return { available: true, alarms: sorted };
      } catch (err) {
        // No PII — a CloudWatch read carries no message bodies. `kind` classifies
        // the failure (credentials / unauthorized / throttled / unreachable) so a
        // degraded panel is diagnosable in the logs, not opaque.
        log.error(
          { kind: classifyCloudWatchError(err), err: (err as Error).message },
          'system status: DescribeAlarms failed',
        );
        return { available: false, reason: 'cloudwatch_error' };
      }
    },

    async getErrors(window = '24h', opts = {}) {
      if (isLocalEnv(config)) {
        return { available: false, reason: 'unavailable_local' };
      }
      const sinceMs = Date.now() - WINDOW_MS[window];
      // The pino query is level≥50 by default; the "include warnings" toggle
      // widens it to level≥40. Terminal Twilio delivery failures log at ERROR
      // (see the delivery-failure taxonomy in routes/webhooks/twilio.ts), so they
      // surface here through the normal error query; transient-retrying / opt-out
      // delivery events are warn and appear only with the toggle on.
      const pinoFilter = opts.includeWarnings ? PINO_WARN_INSIGHTS_FILTER : PINO_ERROR_INSIGHTS_FILTER;
      try {
        // Three Insights queries in parallel:
        //   appErrors      — pino level≥50 (or ≥40 with warnings) in app+worker
        //   appWorkerV8Oom — V8 heap OOM across BOTH app+worker in a single multi-group query
        //   systemOom      — kernel OOM-killer lines in the system log group
        //
        // SETTLED, NOT ALL. These three are INDEPENDENT SOURCES, not parts of
        // one answer, and `Promise.all` made the slowest of them the only one
        // that mattered: on dev the kernel-OOM query over /hc/<env>/system took
        // 17.9s against an 8s budget, so it rejected and discarded the pino
        // errors query that had already succeeded in 3.9s - the panel went fully
        // degraded while holding the exact rows it exists to show. A source that
        // times out now costs its OWN rows and nothing else.
        const settled = await Promise.allSettled([
          // BOTH process log groups: worker-side errors (extraction poll, tour
          // reminder + placement nudge polls, voice transcript jobs) were
          // invisible to this panel when only the app group was queried
          // (found live 2026-07-20: an extraction 400 surfaced nowhere).
          cloudwatch.queryInsights([config.errorLogGroupName, config.workerLogGroupName], pinoFilter, sinceMs, ERROR_EVENT_LIMIT),
          cloudwatch.queryInsights([config.errorLogGroupName, config.workerLogGroupName], OOM_APP_INSIGHTS_FILTER, sinceMs, ERROR_EVENT_LIMIT),
          cloudwatch.queryInsights([config.systemLogGroupName], OOM_SYSTEM_INSIGHTS_FILTER, sinceMs, ERROR_EVENT_LIMIT),
        ]);
        const SOURCE_NAMES = ['errors', 'app-oom', 'system-oom'] as const;
        const failedSources: string[] = [];
        settled.forEach((outcome, i) => {
          if (outcome.status === 'rejected') {
            failedSources.push(SOURCE_NAMES[i]!);
            log.warn(
              {
                source: SOURCE_NAMES[i],
                kind: classifyCloudWatchError(outcome.reason),
                err: (outcome.reason as Error).message,
              },
              'system status: one error source failed - the rest still render',
            );
          }
        });
        // EVERY source failing is the old all-or-nothing case and still degrades:
        // an empty panel drawn from zero working queries would read as "no
        // errors", which is the most dangerous thing this panel can say.
        if (failedSources.length === settled.length) {
          log.error({ window, failedSources }, 'system status: all error sources failed');
          return { available: false, reason: 'cloudwatch_error' };
        }
        const rowsOf = (i: number): ErrorEventView[] =>
          settled[i]!.status === 'fulfilled'
            ? (settled[i] as PromiseFulfilledResult<ErrorEventView[]>).value
            : [];
        const appErrors = rowsOf(0);
        const appWorkerV8Oom = rowsOf(1);
        const systemOom = rowsOf(2);
        // Relabel OOM events with synthesized, PII-safe messages based on which
        // query found them — never from the raw log text (which projectErrorEvent
        // already collapses to "(unparseable log line)" for kernel/V8 OOM lines).
        const relabeledV8 = appWorkerV8Oom.map((e) => ({ ...e, message: OOM_APP_LABEL }));
        const relabeledSystem = systemOom.map((e) => ({ ...e, message: OOM_SYSTEM_LABEL }));
        // Merge, dedup by timestamp+message+errorCode, sort newest-first, cap at
        // limit. errorCode is in the key so two distinct-code failures at the same
        // instant both survive (rather than collapsing on timestamp+message).
        const seen = new Set<string>();
        const events = [...appErrors, ...relabeledV8, ...relabeledSystem]
          .filter((e) => {
            // `ref` (the Insights @ptr) is unique per log event AND stable
            // across separate queries (measured 2026-08-24), so it is the real
            // identity here. The remaining components are retained for the
            // contract they used to carry; with a ref present they never decide.
            const key = `${e.ref}|${e.timestamp}|${e.message}|${e.errorCode ?? ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
          .slice(0, ERROR_EVENT_LIMIT);
        log.info({ window, errorCount: events.length }, 'system status: errors read');
        return {
          available: true,
          events,
          ...(failedSources.length > 0 && { partialSources: failedSources }),
        };
      } catch (err) {
        log.error(
          { window, kind: classifyCloudWatchError(err), err: (err as Error).message },
          'system status: Logs Insights query failed',
        );
        return { available: false, reason: 'cloudwatch_error' };
      }
    },

    async getErrorDetail(ref) {
      if (isLocalEnv(config)) return { available: false, reason: 'unavailable_local' };
      if (!REF_PATTERN.test(ref)) return { available: false, reason: 'invalid_ref' };
      try {
        const record = await cloudwatch.getLogRecord(ref);
        // A ref is an ACCOUNT-scoped pointer bound to nothing. This check makes
        // the route's scope independent of which IAM branch the grant landed on
        // - without it, a pointer from another environment resolves here.
        const allowed = [config.errorLogGroupName, config.workerLogGroupName, config.systemLogGroupName];
        if (!allowed.includes(record.logGroup)) {
          log.warn({ logGroup: record.logGroup }, 'system status: detail record out of scope');
          return { available: false, reason: 'out_of_scope' };
        }
        return { available: true, record };
      } catch (err) {
        log.error(
          { kind: classifyCloudWatchError(err), err: (err as Error).message },
          'system status: GetLogRecord failed',
        );
        return { available: false, reason: 'cloudwatch_error' };
      }
    },

    async getTrace(kind, id, atMs) {
      if (isLocalEnv(config)) return { available: false, reason: 'unavailable_local' };
      if (!UUID_PATTERN.test(id)) return { available: false, reason: 'invalid_id' };
      try {
        // app + worker only. The system group's kernel lines carry no
        // correlation id at all, so scanning it costs bytes for nothing.
        const trace = await cloudwatch.queryTrace(
          [config.errorLogGroupName, config.workerLogGroupName],
          kind,
          id,
          atMs,
        );
        return { available: true, ...trace };
      } catch (err) {
        log.error(
          { kind: classifyCloudWatchError(err), err: (err as Error).message },
          'system status: trace query failed',
        );
        return { available: false, reason: 'cloudwatch_error' };
      }
    },
  };
}

/** Type guard: is `value` one of the valid error windows? (route param validation) */
export function isSystemErrorWindow(value: unknown): value is SystemErrorWindow {
  return value === '1h' || value === '24h' || value === '7d';
}
