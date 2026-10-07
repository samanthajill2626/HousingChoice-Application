// org.rewrite (spec 2026-10-06 D11; plan 3.9; planner rulings R4-F3, R4-F4):
// runs the rewrite that `lastRewrite` defines - rename, merge, or a "Not on
// the list" action - over every contact and unit, active and deleted, through
// services/orgRecords.ts: one pass per member of `lastRewrite.fields`, which
// the service FIXED when the rewrite started (a value action's one field; a
// rename or merge, every field of its target entry's kind then). The job never
// looks the target up again.
//
// The definition and the lock live on the org-list item; the payload carries
// only the rewrite id the service minted BEFORE its list write (never the jobs
// envelope id). The handler STARTS only while `lastRewrite` still names that
// id and is `running`, so a duplicate SQS delivery or a stale run does
// nothing. While it runs, every heartbeat (at most every 20 s, after each
// record the pass visits) re-checks the id: once the lock is no longer this
// run's - a newer rewrite took it over, or a duplicate run already finished
// it - the pass writes no further record and the job returns WITHOUT
// finish(), because the lock it would finish is not its own. finish()
// re-checks the id too (services/orgRewrite.ts).
//
// It NEVER rethrows: dispatchJob rethrows a handler error and SQS would
// redeliver it up to 5 times (infra/modules/jobs/main.tf). Every failure is
// recorded as `failed` with the counts so far; the Settings page offers Run
// again, which is safe - a record already rewritten no longer holds the
// from-text. It sends nothing, so it draws no A2P token of its own.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { OrgListRepo } from '../repos/orgListRepo.js';
import {
  OrgRewriteAbortedError,
  OrgRewriteLockLostError,
  type OrgRecordsService,
} from '../services/orgRecords.js';
import { ORG_REWRITE_JOB, type OrgRewritePayload, type OrgRewriteService } from '../services/orgRewrite.js';

// Declared by services/orgRewrite.ts, which this module imports (the reverse
// import would be a cycle); this is the job's public name.
export { ORG_REWRITE_JOB };
export type { OrgRewritePayload };

export function parseOrgRewritePayload(payload: unknown): OrgRewritePayload {
  if (typeof payload !== 'object' || payload === null) throw new Error('org.rewrite: payload is not an object');
  const jobId = (payload as Record<string, unknown>)['jobId'];
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new Error('org.rewrite: payload.jobId must be a non-empty string');
  }
  return { jobId };
}

export interface RunOrgRewriteDeps {
  orgListRepo: Pick<OrgListRepo, 'get'>;
  orgRecords: Pick<OrgRecordsService, 'rewrite'>;
  orgRewrite: Pick<OrgRewriteService, 'heartbeat' | 'finish'>;
  logger?: Logger;
}

/** `lock_lost`: the heartbeat found the lock no longer this run's - stopped, NOT finished. */
export type OrgRewriteJobResult =
  | { outcome: 'not_current' }
  | { outcome: 'done' | 'failed' | 'lock_lost'; counts: Record<string, number> };

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export async function runOrgRewriteJob(
  payload: OrgRewritePayload,
  deps: RunOrgRewriteDeps,
): Promise<OrgRewriteJobResult> {
  const log = deps.logger ?? defaultLogger;
  const { jobId } = payload;
  const counts: Record<string, number> = {};
  const add = (part: Record<string, number>): void => {
    for (const [key, n] of Object.entries(part)) counts[key] = (counts[key] ?? 0) + n;
  };
  try {
    const item = await deps.orgListRepo.get();
    const last = item.lastRewrite;
    if (last === undefined || last.jobId !== jobId || last.status !== 'running' || last.action === 'cleanup') {
      log.info({ jobId, current: last?.jobId, status: last?.status }, 'org.rewrite: not the running rewrite - nothing to do');
      return { outcome: 'not_current' };
    }
    // The passes are the fields FIXED when the rewrite started (spec 5.1).
    const fields = Array.isArray(last.fields) ? last.fields : [];
    if (fields.length === 0) throw new Error('the rewrite names no record fields');
    for (const field of fields) {
      add(
        await deps.orgRecords.rewrite(
          { ...last, field },
          { auditType: 'org_name_rewrite', actor: last.startedBy, heartbeat: () => deps.orgRewrite.heartbeat(jobId) },
        ),
      );
    }
    await deps.orgRewrite.finish(jobId, { status: 'done', counts: { ...counts } });
    log.info({ jobId, action: last.action, ...counts }, 'org.rewrite finished');
    return { outcome: 'done', counts: { ...counts } };
  } catch (err) {
    if (err instanceof OrgRewriteLockLostError) {
      // Spec D11: the lock is not this run's any more - no record was written
      // after the heartbeat said so, and finishing would touch another run's lock.
      add(err.counts);
      log.warn({ jobId, ...counts }, 'org.rewrite: lost the lock - stopped without finishing');
      return { outcome: 'lock_lost', counts: { ...counts } };
    }
    if (err instanceof OrgRewriteAbortedError) add(err.counts);
    log.error({ err, jobId }, 'org.rewrite failed - recording it failed');
    try {
      await deps.orgRewrite.finish(jobId, { status: 'failed', counts: { ...counts }, error: errorText(err) });
    } catch (finishErr) {
      log.error({ err: finishErr, jobId }, 'org.rewrite: recording the failure failed too');
    }
    return { outcome: 'failed', counts: { ...counts } };
  }
}
