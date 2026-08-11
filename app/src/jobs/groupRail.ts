// `groupRail.ensure` - the ASYNC half of the one authoritative rail path.
//
// Detection cannot create a Conversations rail inline: the Twilio webhook has a
// 5s budget and a rail create is a multi-call round trip. So ingestion ENQUEUES
// (spec 6.1) and this handler runs `ensureGroupRail` off the jobs queue, which
// is the same service the migration bulk runner and the send-time backstop call
// synchronously. One implementation, three moments.
//
// The payload deliberately carries only the conversationId: the roster is
// re-read from the row inside `ensureGroupRail`, so a job that sat in the queue
// while a member changed cannot build a rail from a stale roster.
//
// IDEMPOTENT BY CONTRACT (spec 15.3): every group inbound onto a rail-less
// thread re-enqueues, which is what heals a crash between the Twilio create and
// the local persist. Duplicate runs are normal and cost one conditional claim.
import { defineJobHandler, enqueue } from './jobs.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createGroupRailService,
  type GroupRailEnqueuer,
  type GroupRailEnsurer,
} from '../services/groupRail.js';

/** The job name. Registered in registerHandlers.ts, like every other handler. */
export const GROUP_RAIL_ENSURE_JOB = 'groupRail.ensure';

export interface GroupRailEnsureJobPayload {
  conversationId: string;
  /** Why the rail was requested - carried for the log line only. */
  reason?: 'created' | 'rail_missing' | 'migration';
}

function isPayload(value: unknown): value is GroupRailEnsureJobPayload {
  const candidate = value as GroupRailEnsureJobPayload | undefined;
  return typeof candidate?.conversationId === 'string' && candidate.conversationId.length > 0;
}

export interface GroupRailJobDeps {
  rail?: GroupRailEnsurer;
  logger?: Logger;
}

/**
 * Register the handler. Lazily builds the rail service on the FIRST run so the
 * worker boots without a Twilio client and a config problem surfaces at job
 * time (the same lazy-deps posture the other pollers use).
 */
export function registerGroupRailJobHandler(deps: GroupRailJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  let rail = deps.rail;
  defineJobHandler(GROUP_RAIL_ENSURE_JOB, async (payload) => {
    if (!isPayload(payload)) {
      // A malformed envelope is a bug, not a retry candidate - and throwing
      // would redeliver it forever.
      log.error({ event: 'group_rail_job_payload_invalid' }, 'groupRail.ensure payload invalid');
      return;
    }
    rail ??= createGroupRailService({ ...(deps.logger !== undefined && { logger: deps.logger }) });
    const result = await rail.ensureGroupRail({ conversationId: payload.conversationId, members: [] });
    if (result.status === 'failed' || result.status === 'unavailable') {
      // WARN, not ERROR: a rail-less thread is inbound-only, which the thread
      // view says out loud. The ERROR channel is reserved for the guardrail
      // alarms, and a landline in a roster must not page anyone.
      // `reason` is DELIBERATELY NOT LOGGED: it is a human-readable diagnostic
      // that can name members - the MB-map mismatch case builds it as
      // `rail participants do not cover the roster: <E.164>, <E.164>` - and log
      // sinks are not subject to the access controls and retention that member
      // data is. The service that produced it already logs the SHAPE of the
      // failure (a `missing` COUNT, not the numbers), and the full string is
      // persisted on the row by `recordRailFailure`, where it belongs. Same
      // posture as the tracked `telemetry-phone-in-url-pii` gate.
      log.warn(
        {
          event: 'group_rail_job_incomplete',
          conversationId: payload.conversationId,
          railStatus: result.status,
        },
        'groupRail.ensure did not establish a rail - the thread stays inbound-only',
      );
      return;
    }
    log.info(
      {
        event: 'group_rail_job_done',
        conversationId: payload.conversationId,
        railStatus: result.status,
      },
      'groupRail.ensure completed',
    );
  });
}

/**
 * The PRODUCER side, wired into the inbound webhook (T6.6(a)/(d)) in place of
 * `GROUP_RAIL_ENQUEUE_NOT_WIRED`. All job traffic goes through `jobs.enqueue()`
 * so correlation and trace context survive the hop.
 */
export function createGroupRailEnqueuer(deps: { logger?: Logger } = {}): GroupRailEnqueuer {
  const log = deps.logger ?? defaultLogger;
  return {
    async enqueueGroupRail(request) {
      try {
        const payload: GroupRailEnsureJobPayload = {
          conversationId: request.conversationId,
          reason: request.reason,
        };
        const envelope = await enqueue(GROUP_RAIL_ENSURE_JOB, payload);
        return { status: 'enqueued', jobId: envelope.jobId };
      } catch (err) {
        // The caller WARNs and continues: a rail failure never fails an inbound.
        log.warn(
          { err, event: 'group_rail_enqueue_failed', conversationId: request.conversationId },
          'groupRail.ensure could not be enqueued',
        );
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
