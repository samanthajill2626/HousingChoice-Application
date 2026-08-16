// T6.3 - the periodic guardrail duties for native group texting.
//
// FOUR DUTIES, ONE RUNNER, on the existing worker-poller pattern:
//
//   crosscheck_sweep  - alarm on any Conversations event still unmatched past
//                       its grace deadline (spec 8 mechanism 2).
//   send_staleness    - alarm on any group send whose recipient slots are still
//                       non-terminal past their deadline (T6.4). Since classic
//                       status callbacks do not fire for Conversations sends,
//                       this is the ONLY detector of a dead receipts webhook.
//   channel_quiet     - WARN when railed group threads took classic inbound in
//                       the last 24h while the cross-check recorded nothing:
//                       the monitor itself has died.
//   heartbeat         - WARN when group threads exist but no group-origin
//                       INBOUND has been seen for seven days (spec 8 mechanism
//                       3). INBOUND, not activity: a staff reply must never be
//                       able to silence the detector.
//
// CADENCE, NOT PER-POLL. The worker polls on WORKER_POLL_INTERVAL_MS; these duties act ONCE per
// elapsed period. The gate is a conditional claim on a settings record, so it
// holds across processes rather than in a variable one process owns.
//
// WHY THE `force` FLAG EXISTS (worklist A16, and the plan misses it). Hermetic
// e2e lanes spawn a REAL worker process alongside the app, polling the SAME lane
// data at real cadence. Two consequences, both binding:
//   (a) worker-process WARN/ERROR never reaches the app-side /__dev/logtail, so
//       any log line an e2e spec asserts must be drivable through an APP-side
//       tick - which is why every duty here is callable from routes/dev.ts;
//   (b) the tick and the worker share these cadence records, so without a
//       bypass a spec would silently no-op whenever the worker had just claimed
//       the period. `force` sets the claim's `notBefore` to now, which both
//       bypasses the gate and stamps the record, so a forced run never leaves
//       the worker free to immediately repeat the work.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createSettingsRepo,
  GROUP_CHANNEL_QUIET_LAST_RUN_AT_ID,
  GROUP_CROSSCHECK_LAST_EVENT_AT_ID,
  GROUP_CROSSCHECK_SWEEP_LAST_RUN_AT_ID,
  GROUP_INBOUND_HEARTBEAT_LAST_RUN_AT_ID,
  GROUP_RAILED_INBOUND_LAST_AT_ID,
  GROUP_SEND_STALENESS_LAST_RUN_AT_ID,
  type GroupPeriodRecordId,
  type SettingsRepo,
} from '../repos/settingsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import {
  createGroupCrossCheck,
  type GroupCrossCheck,
} from '../services/groupCrossCheck.js';
import {
  createGroupSendStaleness,
  type GroupSendStalenessService,
} from '../services/groupSendStaleness.js';

export const GROUP_GUARDRAIL_DUTIES = [
  'crosscheck_sweep',
  'send_staleness',
  'channel_quiet',
  'heartbeat',
] as const;

export type GroupGuardrailDuty = (typeof GROUP_GUARDRAIL_DUTIES)[number];

export function isGroupGuardrailDuty(value: unknown): value is GroupGuardrailDuty {
  return (
    typeof value === 'string' &&
    (GROUP_GUARDRAIL_DUTIES as readonly string[]).includes(value)
  );
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How often each duty acts. The two alarm sweeps run at five minutes - fast
 * enough that a broken webhook is noticed the same morning, slow enough that the
 * per-poll cost is nearly free. The two liveness WARNs are DAILY: they compare
 * multi-day windows, so running them more often would only repeat the same line.
 */
export const GROUP_DUTY_PERIOD_MS: Record<GroupGuardrailDuty, number> = {
  crosscheck_sweep: 5 * MINUTE,
  send_staleness: 5 * MINUTE,
  channel_quiet: DAY,
  heartbeat: DAY,
};

const DUTY_RECORD: Record<GroupGuardrailDuty, GroupPeriodRecordId> = {
  crosscheck_sweep: GROUP_CROSSCHECK_SWEEP_LAST_RUN_AT_ID,
  send_staleness: GROUP_SEND_STALENESS_LAST_RUN_AT_ID,
  channel_quiet: GROUP_CHANNEL_QUIET_LAST_RUN_AT_ID,
  heartbeat: GROUP_INBOUND_HEARTBEAT_LAST_RUN_AT_ID,
};

/** The window "recently" means for the cross-check-quiet comparison. */
export const CHANNEL_QUIET_WINDOW_MS = DAY;
/** How long group silence must last before the heartbeat WARNs (spec 8.3). */
export const GROUP_HEARTBEAT_WINDOW_MS = 7 * DAY;
/**
 * How many group threads the heartbeat samples for the newest `created_at`. The
 * list is ordered by ACTIVITY, so the newest-created thread is not necessarily
 * first; one bounded page is enough to find it at this feature's scale (132
 * threads all created at cutover).
 */
export const HEARTBEAT_THREAD_SAMPLE = 25;

export interface RunGroupGuardrailsDeps {
  crossCheck?: Pick<GroupCrossCheck, 'sweepCrossCheckDeadlines'>;
  staleness?: Pick<GroupSendStalenessService, 'sweepSendStaleness'>;
  settingsRepo?: Pick<SettingsRepo, 'getGroupTimestamp' | 'claimGroupPeriod'>;
  conversationsRepo?: Pick<ConversationsRepo, 'listGroupTexts'>;
  logger?: Logger;
}

export interface RunGroupGuardrailsOptions {
  /** Bypass the cadence gate (the `__dev` tick; worklist A16). */
  force?: boolean;
  /** Run only these duties. Default: all four. */
  duties?: readonly GroupGuardrailDuty[];
}

export interface GroupGuardrailsOutcome {
  now: string;
  /** Duties that acted on this pass. */
  ran: GroupGuardrailDuty[];
  /** Duties whose period was already claimed (the ordinary poll result). */
  skipped: GroupGuardrailDuty[];
  /** Per-duty detail, keyed by duty name. Only present for duties that ran. */
  results: Partial<Record<GroupGuardrailDuty, Record<string, unknown>>>;
}

export async function runGroupGuardrails(
  nowIso: string,
  deps: RunGroupGuardrailsDeps = {},
  opts: RunGroupGuardrailsOptions = {},
): Promise<GroupGuardrailsOutcome> {
  const log = deps.logger ?? defaultLogger;
  const settings =
    deps.settingsRepo ??
    createSettingsRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const crossCheck =
    deps.crossCheck ??
    createGroupCrossCheck({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const staleness =
    deps.staleness ??
    createGroupSendStaleness({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const conversations =
    deps.conversationsRepo ??
    createConversationsRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });

  // NORMALIZED: every downstream comparison is against lexicographic ISO sort
  // keys, so '...00Z' and '...00.000Z' must collapse to one form.
  const now = new Date(nowIso).toISOString();
  const nowMs = Date.parse(now);
  const force = opts.force ?? false;
  const selected = opts.duties ?? GROUP_GUARDRAIL_DUTIES;

  const outcome: GroupGuardrailsOutcome = { now, ran: [], skipped: [], results: {} };

  async function due(duty: GroupGuardrailDuty): Promise<boolean> {
    // force -> notBefore = now, which the stored instant always satisfies, so
    // the claim succeeds AND still stamps (the worker does not repeat the work).
    const notBefore = force
      ? now
      : new Date(nowMs - GROUP_DUTY_PERIOD_MS[duty]).toISOString();
    return settings.claimGroupPeriod(DUTY_RECORD[duty], now, notBefore);
  }

  for (const duty of selected) {
    if (!(await due(duty))) {
      outcome.skipped.push(duty);
      continue;
    }
    outcome.ran.push(duty);
    switch (duty) {
      case 'crosscheck_sweep': {
        const swept = await crossCheck.sweepCrossCheckDeadlines(now);
        outcome.results.crosscheck_sweep = { scanned: swept.scanned, alarmed: swept.alarms.length };
        break;
      }
      case 'send_staleness': {
        const swept = await staleness.sweepSendStaleness(now);
        outcome.results.send_staleness = { ...swept };
        break;
      }
      case 'channel_quiet': {
        // THE MONITOR-IS-DEAD SIGNAL. Railed threads took classic inbound
        // recently while the cross-check saw nothing at all: the second channel
        // has stopped, so the guardrail is no longer guarding anything - and
        // that must be visible BEFORE the envelope it watches for actually goes.
        const [railedAt, eventAt] = await Promise.all([
          settings.getGroupTimestamp(GROUP_RAILED_INBOUND_LAST_AT_ID),
          settings.getGroupTimestamp(GROUP_CROSSCHECK_LAST_EVENT_AT_ID),
        ]);
        const since = new Date(nowMs - CHANNEL_QUIET_WINDOW_MS).toISOString();
        const railedRecently = railedAt !== undefined && railedAt >= since;
        const eventsRecently = eventAt !== undefined && eventAt >= since;
        const quiet = railedRecently && !eventsRecently;
        if (quiet) {
          log.warn(
            {
              event: 'group_crosscheck_channel_quiet',
              railedInboundLastAt: railedAt,
              crossCheckLastEventAt: eventAt,
              windowHours: CHANNEL_QUIET_WINDOW_MS / HOUR,
            },
            'cross-check channel quiet',
          );
        }
        outcome.results.channel_quiet = { quiet, railedAt, eventAt };
        break;
      }
      case 'heartbeat': {
        // Spec 8.3. Only meaningful while group threads exist - on a stack with
        // none, silence is correct and a WARN would be noise forever.
        const page = await conversations.listGroupTexts({ limit: HEARTBEAT_THREAD_SAMPLE });
        if (page.items.length === 0) {
          outcome.results.heartbeat = { threads: 0, quiet: false };
          break;
        }
        const railedAt = await settings.getGroupTimestamp(GROUP_RAILED_INBOUND_LAST_AT_ID);
        // INBOUND ONLY - never `last_activity_at`. That field is bumped by every
        // group SEND, so the failure this mechanism exists to catch (detection
        // breaks, carrier group messages start filing as 1:1s) would keep it
        // fresh forever through ordinary staff replies, and mechanism 3 could
        // never fire while anyone was working. Spec 8.3 says "zero group-origin
        // INBOUND for 7 days", and this now measures exactly that.
        //
        // The day-one protection the activity fallback was really providing is
        // kept, bounded by thread CREATION instead: the railed-inbound record is
        // only written for railed threads, so a freshly migrated stack that has
        // not been texted yet would otherwise WARN at cutover. A group thread's
        // `created_at` is itself an inbound-derived instant - migration stamps
        // the cutover, and detection only mints a thread from a group inbound -
        // so it is a grace window, never an activity signal. Sampled over a
        // bounded page because the list is ordered by activity, not creation.
        const newestCreatedAt = page.items.reduce(
          (newestSoFar, item) =>
            typeof item.created_at === 'string' && item.created_at > newestSoFar
              ? item.created_at
              : newestSoFar,
          '',
        );
        const lastSeen =
          railedAt !== undefined && railedAt > newestCreatedAt ? railedAt : newestCreatedAt;
        const since = new Date(nowMs - GROUP_HEARTBEAT_WINDOW_MS).toISOString();
        const quiet = lastSeen < since;
        if (quiet) {
          log.warn(
            {
              event: 'group_inbound_heartbeat_quiet',
              lastSeen,
              windowDays: GROUP_HEARTBEAT_WINDOW_MS / DAY,
            },
            'no group-origin inbound in seven days while group threads are active',
          );
        }
        outcome.results.heartbeat = { threads: page.items.length, quiet, lastSeen };
        break;
      }
    }
  }

  return outcome;
}
