// The D11 rewrite lock and every action that starts a rewrite (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D10-D12; plan sections 3.4, 3.4b and 3.9).
//
// ORDER (D11; planner ruling R4-F3): the service mints the rewrite id FIRST;
// ONE conditional write of the org-list item then changes the list (rename,
// merge, an added entry, a remembered spelling) AND sets `lastRewrite` to
// `running` with that id and the definition; only then is the org.rewrite job
// enqueued, carrying `{ jobId }` - never the jobs envelope id, which does not
// exist until enqueue. An enqueue failure marks the rewrite `failed` so the
// Settings page offers Run again (precedent: routes/broadcasts.ts, enqueue
// failure -> markFailed); the list change stands.
//
// ONE rewrite at a time: a new one is refused (409 org_rewrite_running) while
// `lastRewrite` is `running` with a heartbeat under 15 minutes old. The job
// and the cleanup script keep the lock alive with heartbeat() and release it
// with finish(); both act ONLY while `lastRewrite` still carries the caller's
// id and is `running`, so a duplicate delivery or a stale run never
// overwrites a newer rewrite's state (planner ruling R4-F4). heartbeat()
// answers whether the lock is still the caller's: on `false` the caller stops
// writing records at once and does not finish (spec D11).
//
// A rewrite's `fields` are FIXED when it starts (spec 5.1): a value action's
// one field; a rename or merge, every field of the target entry's kind at that
// moment (recordFieldsForKind). The job and Run again use them as stored.
//
// ORG_REWRITE_JOB is declared HERE and re-exported by jobs/orgRewrite.ts: the
// job module builds this service, so this module must not import it.
import { randomUUID } from 'node:crypto';
import { enqueue } from '../jobs/jobs.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { normalizeOrgText, type OrgEntry, type SpellingProblem } from '../lib/orgNames.js';
import {
  createOrgListRepo,
  type OrgListItem,
  type OrgListRepo,
  type OrgRewriteState,
} from '../repos/orgListRepo.js';
import {
  checkNewOrgName,
  checkOrgSpelling,
  isOrgRewriteRunning,
  nameProblemError,
  OrgHttpError,
  rewriteRunningError,
} from './orgNames.js';
import { recordFieldsForKind, type OrgRecordsService } from './orgRecords.js';

/** The org.rewrite job name (plan 3.9). */
export const ORG_REWRITE_JOB = 'org.rewrite';

/** Its payload: the rewrite id, nothing else - the definition lives on `lastRewrite`. */
export interface OrgRewritePayload {
  jobId: string;
}

export interface SkippedSpelling { spelling: string; problem: SpellingProblem['problem'] }

/** `lastRewrite.error` when the job could not be queued. */
export const ORG_REWRITE_ENQUEUE_FAILED = 'enqueue_failed';

/** Plan 3.4 - Tasks 3.9-3.10 add merge, resolveNotOnList, runAgain and acquireForCleanup. */
export interface OrgRewriteService {
  rename(orgId: string, newName: string, actor: string): Promise<{ entry: OrgEntry; lastRewrite: OrgRewriteState; skippedSpellings: SkippedSpelling[] }>;
  /** For the job and the cleanup script. true = the lock is still the
   *  caller's (its heartbeat was written); false = it is not (another id holds
   *  it, or it is no longer running) - the caller stops writing records and
   *  does NOT call finish. */
  heartbeat(jobId: string): Promise<boolean>;
  finish(jobId: string, outcome: { status: 'done' | 'failed'; counts?: Record<string, number>; error?: string }): Promise<void>;
}

/** Plan 3.4b: every dep optional, defaulting to the real implementation. */
export interface OrgRewriteDeps {
  orgListRepo?: OrgListRepo;
  /**
   * Wired by the composition root (plan 3.4b). No method here reads records:
   * the records pass runs in the org.rewrite job, one pass per member of the
   * `fields` this service stores when the rewrite starts. Accepted, never
   * defaulted.
   */
  orgRecords?: OrgRecordsService;
  enqueue?: typeof enqueue;
  /** ISO clock: the lock's age, heartbeats, timestamps. */
  now?: () => string;
  /** Rewrite ids (and the id of an entry "Add as new" creates). */
  newId?: () => string;
  logger?: Logger;
}

/** The definition part of `lastRewrite` (plan 3.2). */
type RewriteDefinition = Pick<OrgRewriteState, 'action' | 'fromTexts' | 'field' | 'fields' | 'toName' | 'agencyName'>;

function runningState(jobId: string, def: RewriteDefinition, actor: string, at: string): OrgRewriteState {
  return {
    jobId,
    action: def.action,
    fromTexts: [...def.fromTexts],
    ...(def.field !== undefined && { field: def.field }),
    fields: [...def.fields],
    ...(def.toName !== undefined && { toName: def.toName }),
    ...(def.agencyName !== undefined && { agencyName: def.agencyName }),
    status: 'running',
    heartbeatAt: at,
    startedAt: at,
    startedBy: actor,
  };
}

function findEntry(entries: readonly OrgEntry[], orgId: string): OrgEntry {
  const entry = entries.find((e) => e.orgId === orgId);
  if (entry === undefined) throw new OrgHttpError(404, { error: 'org_not_found' });
  return entry;
}

function replaceEntry(entries: readonly OrgEntry[], entry: OrgEntry): OrgEntry[] {
  return entries.map((e) => (e.orgId === entry.orgId ? entry : e));
}

export function createOrgRewriteService(deps: OrgRewriteDeps = {}): OrgRewriteService {
  const list = deps.orgListRepo ?? createOrgListRepo({ logger: deps.logger });
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const newId = deps.newId ?? ((): string => randomUUID());
  const enqueueJob = deps.enqueue ?? enqueue;

  /** 409 while another rewrite holds the lock (spec D11). */
  function refuseWhileHeld(current: OrgListItem, at: string): void {
    const held = current.lastRewrite;
    if (held !== undefined && isOrgRewriteRunning(held, Date.parse(at))) throw rewriteRunningError(held);
  }

  /** true = the lock is still the caller's and its heartbeat was written; false = it is not. */
  async function heartbeat(jobId: string): Promise<boolean> {
    return list.mutate((current) => {
      const last = current.lastRewrite;
      // Not this run's lock (a newer rewrite, or this one already finished):
      // write nothing, and tell the caller to stop writing records (spec D11).
      if (last === undefined || last.jobId !== jobId || last.status !== 'running') {
        return { next: current, result: false };
      }
      return { next: { ...current, lastRewrite: { ...last, heartbeatAt: now() } }, result: true };
    });
  }

  async function finish(
    jobId: string,
    outcome: { status: 'done' | 'failed'; counts?: Record<string, number>; error?: string },
  ): Promise<void> {
    const finished = await list.mutate((current) => {
      const last = current.lastRewrite;
      if (last === undefined || last.jobId !== jobId || last.status !== 'running') {
        return { next: current, result: false };
      }
      const at = now();
      const lastRewrite: OrgRewriteState = {
        ...last,
        status: outcome.status,
        heartbeatAt: at,
        finishedAt: at,
        ...(outcome.counts !== undefined && { counts: outcome.counts }),
        ...(outcome.error !== undefined && { error: outcome.error }),
      };
      return { next: { ...current, lastRewrite }, result: true };
    });
    if (!finished) log.info({ jobId }, 'org rewrite finish ignored - the lock is no longer this run');
  }

  /** Enqueue the job for a just-started rewrite; when that fails, record the rewrite failed. */
  async function enqueueOrFail<R extends { lastRewrite: OrgRewriteState }>(started: R): Promise<R> {
    const { jobId, action } = started.lastRewrite;
    const payload: OrgRewritePayload = { jobId };
    try {
      await enqueueJob(ORG_REWRITE_JOB, payload);
      log.info({ jobId, action }, 'org rewrite started');
      return started;
    } catch (err) {
      log.error({ err, jobId, action }, 'org rewrite: enqueue failed - marking the rewrite failed');
      try {
        await finish(jobId, { status: 'failed', error: ORG_REWRITE_ENQUEUE_FAILED });
        const stored = (await list.get()).lastRewrite;
        return stored === undefined ? started : { ...started, lastRewrite: stored };
      } catch (markErr) {
        log.error({ err: markErr, jobId }, 'org rewrite: recording the failed enqueue also failed');
        return started;
      }
    }
  }

  /**
   * Start a rewrite: mint its id, then ONE list write that applies `plan`'s list
   * change and sets `lastRewrite` running (refused while another rewrite holds
   * the lock), then enqueue. `plan` may run more than once (the list's version
   * race), so it must be pure.
   */
  async function start<T extends object>(
    actor: string,
    plan: (current: OrgListItem) => { entries: OrgEntry[]; def: RewriteDefinition; result: T },
  ): Promise<T & { lastRewrite: OrgRewriteState }> {
    const jobId = newId();
    const started = await list.mutate((current) => {
      const at = now();
      refuseWhileHeld(current, at);
      const { entries, def, result } = plan(current);
      const lastRewrite = runningState(jobId, def, actor, at);
      return { next: { ...current, entries, lastRewrite }, result: { ...result, lastRewrite } };
    });
    return enqueueOrFail(started);
  }

  return {
    async rename(orgId, newName, actor) {
      const name = newName.trim();
      return start(actor, (current) => {
        const entry = findEntry(current.entries, orgId);
        const problem = checkNewOrgName(current.entries, name, { excludeOrgId: orgId });
        if (problem !== null) throw nameProblemError(problem);
        const n = normalizeOrgText(name);
        // D12: the new name may be one of the entry's own spellings - drop it.
        let renamed: OrgEntry = {
          ...entry,
          name,
          spellings: entry.spellings.filter((s) => normalizeOrgText(s) !== n),
          updatedAt: now(),
          updatedBy: actor,
        };
        let entries = replaceEntry(current.entries, renamed);
        // D11: the old name stays as a spelling - an AUTOMATIC addition, so a
        // spelling that breaks a D12 rule is skipped (never a failure); one the
        // entry already finds ('duplicate', e.g. a case-only rename) is no skip.
        const skippedSpellings: SkippedSpelling[] = [];
        const oldNameProblem = checkOrgSpelling(entries, renamed, entry.name);
        if (oldNameProblem === null) {
          renamed = { ...renamed, spellings: [...renamed.spellings, entry.name] };
          entries = replaceEntry(entries, renamed);
        } else if (oldNameProblem.problem !== 'duplicate') {
          skippedSpellings.push({ spelling: entry.name, problem: oldNameProblem.problem });
        }
        return {
          entries,
          // `fields` fixed now, from the entry's kind (spec 5.1).
          def: { action: 'rename', fromTexts: [entry.name], fields: recordFieldsForKind(entry.kind), toName: name },
          result: { entry: renamed, skippedSpellings },
        };
      });
    },

    heartbeat,
    finish,
  };
}
