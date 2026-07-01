// systemStatusService — the read model behind the admin-only Settings → System
// Status panel (M1.4, doc §6). Three reads, scoped to the env the app runs in:
//
//   getFlags()         go-live readiness from runtime config — NO AWS call
//   getAlarms()        CloudWatch DescribeAlarms (prefix hc-<env>-), ALARM-first
//   getErrors(window)  CloudWatch Logs FilterLogEvents (pino level ≥ 50, ≤25)
//
// GRACEFUL LOCAL DEGRADATION: the alarms/errors reads short-circuit to
// { available: false, reason: 'unavailable_local' } WITHOUT an SDK call when
// the stack is local/hermetic (appEnv === 'local' OR messagingDriver ===
// 'console') — so the local/e2e stack never hangs on AWS credential resolution.
// Any thrown SDK error is caught → { available: false, reason: 'cloudwatch_error' }
// and logged (no PII). Flags ALWAYS work (no AWS).
//
// PII (doc §9): flags are booleans/enums/strings ONLY — never the founder
// number or any secret. Errors are projected to message + correlationId (+
// timestamp/level) by the adapter; this service logs counts/reasons only.
import {
  classifyCloudWatchError,
  createCloudWatchClient,
  OOM_APP_FILTER_PATTERN,
  OOM_SYSTEM_FILTER_PATTERN,
  type AlarmView,
  type CloudWatchClientSeam,
  type ErrorEventView,
} from '../adapters/cloudwatch.js';
import { isPushConfigured, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

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

/** Go-live readiness flags (booleans/enums/strings only — never secrets). */
export interface SystemFlags {
  /** The deploy env name (local | dev | prod). */
  env: string;
  /** A2P kill-switch: outbound SMS enabled (false = expected pre-A2P). */
  smsSendingEnabled: boolean;
  /** A2P kill-switch: relay number provisioning enabled (false = expected pre-A2P). */
  relayLiveProvisioning: boolean;
  /** Whether a founder cell is configured — boolean ONLY, never the number. */
  founderCellSet: boolean;
  /** Whether Web Push (VAPID) is configured in this env. */
  pushConfigured: boolean;
  /** The outbound messaging driver as displayed (twilio | console | mock). */
  messagingDriver: MessagingDriverDisplay;
}

/** getAlarms result — degrades to { available: false, reason } (still HTTP 200). */
export type AlarmsResult =
  | { available: true; alarms: AlarmView[] }
  | { available: false; reason: string };

/** getErrors result — degrades to { available: false, reason } (still HTTP 200). */
export type ErrorsResult =
  | { available: true; events: ErrorEventView[] }
  | { available: false; reason: string };

export interface SystemStatusService {
  /** Go-live flags from runtime config — always works, no AWS call. */
  getFlags(): SystemFlags;
  /** CloudWatch alarms (ALARM-first), or a degraded reason. */
  getAlarms(): Promise<AlarmsResult>;
  /** Recent error events for the window (default 24h), or a degraded reason. */
  getErrors(window?: SystemErrorWindow): Promise<ErrorsResult>;
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
        founderCellSet: config.founderCell !== undefined,
        pushConfigured: isPushConfigured(config),
        messagingDriver: messagingDriverDisplay(config),
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

    async getErrors(window = '24h') {
      if (isLocalEnv(config)) {
        return { available: false, reason: 'unavailable_local' };
      }
      const sinceMs = Date.now() - WINDOW_MS[window];
      try {
        const [appErrors, appOom, workerOom, systemOom] = await Promise.all([
          cloudwatch.filterErrorEvents(config.errorLogGroupName, sinceMs, ERROR_EVENT_LIMIT),
          cloudwatch.filterEventsByPattern(config.errorLogGroupName, sinceMs, ERROR_EVENT_LIMIT, OOM_APP_FILTER_PATTERN),
          cloudwatch.filterEventsByPattern(config.workerLogGroupName, sinceMs, ERROR_EVENT_LIMIT, OOM_APP_FILTER_PATTERN),
          cloudwatch.filterEventsByPattern(config.systemLogGroupName, sinceMs, ERROR_EVENT_LIMIT, OOM_SYSTEM_FILTER_PATTERN),
        ]);
        // Relabel OOM events with synthesized, PII-safe messages based on which
        // query found them — never from the raw log text (which projectErrorEvent
        // already collapses to "(unparseable log line)" for kernel/V8 OOM lines).
        const relabeledSystemOom = systemOom.map((e) => ({ ...e, message: OOM_SYSTEM_LABEL }));
        const relabeledAppOom = appOom.map((e) => ({ ...e, message: OOM_APP_LABEL }));
        const relabeledWorkerOom = workerOom.map((e) => ({ ...e, message: OOM_APP_LABEL }));
        // Merge, dedup by timestamp+message, sort newest-first, cap at limit.
        const seen = new Set<string>();
        const events = [...appErrors, ...relabeledAppOom, ...relabeledWorkerOom, ...relabeledSystemOom]
          .filter((e) => {
            const key = `${e.timestamp}|${e.message}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
          .slice(0, ERROR_EVENT_LIMIT);
        log.info({ window, errorCount: events.length }, 'system status: errors read');
        return { available: true, events };
      } catch (err) {
        log.error(
          { window, kind: classifyCloudWatchError(err), err: (err as Error).message },
          'system status: FilterLogEvents failed',
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
