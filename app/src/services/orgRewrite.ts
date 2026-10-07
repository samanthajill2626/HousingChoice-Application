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
import {
  isOnListFor,
  KINDS_FOR_FIELD,
  normalizeOrgText,
  ORG_SPELLINGS_PER_ENTRY_MAX,
  type OrgEntry,
  type OrgKind,
  type SpellingProblem,
} from '../lib/orgNames.js';
import {
  createOrgListRepo,
  type OrgListItem,
  type OrgListRepo,
  type OrgRecordField,
  type OrgRewriteState,
} from '../repos/orgListRepo.js';
import {
  checkNewOrgName,
  checkOrgSpelling,
  isOrgRewriteRunning,
  nameProblemError,
  OrgHttpError,
  rewriteRunningError,
  toOrgRef,
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

export interface OrgRewriteService {
  rename(orgId: string, newName: string, actor: string): Promise<{ entry: OrgEntry; lastRewrite: OrgRewriteState; skippedSpellings: SkippedSpelling[] }>;
  merge(orgId: string, intoOrgId: string, actor: string): Promise<{ lastRewrite: OrgRewriteState }>;
  resolveNotOnList(input: {
    field: OrgRecordField;
    value: string;
    action: 'use' | 'move_to_agency' | 'move_to_housing_authority' | 'split' | 'add' | 'clear';
    name?: string;
    agencyName?: string;
    rememberSpelling?: boolean;
    actor: string;
  }): Promise<{ lastRewrite: OrgRewriteState; skippedSpellings: SkippedSpelling[] }>;
  /** Re-queues the stored definition under a new id, after re-checking that
   *  `toName` (and a split's `agencyName`) still name entries of the expected
   *  kind, and that no from-text has since become (or become a name variant
   *  of) the NAME of an entry its `fields` accept, other than `toName` - else
   *  409 org_rewrite_target_gone. */
  runAgain(actor: string): Promise<{ lastRewrite: OrgRewriteState }>;
  /** For the job and the cleanup script. true = the lock is still the
   *  caller's (its heartbeat was written); false = it is not (another id holds
   *  it, or it is no longer running) - the caller stops writing records and
   *  does NOT call finish. */
  heartbeat(jobId: string): Promise<boolean>;
  finish(jobId: string, outcome: { status: 'done' | 'failed'; counts?: Record<string, number>; error?: string }): Promise<void>;
  /** Cleanup script: take the lock as action 'cleanup' (409 when held). */
  acquireForCleanup(actor: string): Promise<OrgRewriteState>;
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

/**
 * The kind of entry `toName` must name for a re-run (spec D11 Run again):
 * Move to Agency writes an agency; Move to Housing authority and Split write a
 * housing authority (Split's agency half is checked on its own); rename, merge
 * and use write the kind of the field(s) they rewrite. Clear names no target.
 */
function rewriteTargetKind(def: OrgRewriteState): OrgKind | undefined {
  switch (def.action) {
    case 'clear':
    case 'cleanup':
      return undefined;
    case 'move_to_agency':
      return 'agency';
    case 'move_to_housing_authority':
    case 'split':
      return 'housing_authority';
    default: // rename, merge, use
      return (def.field ?? def.fields[0]) === 'agency' ? 'agency' : 'housing_authority';
  }
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

    async merge(orgId, intoOrgId, actor) {
      return start(actor, (current) => {
        const source = findEntry(current.entries, orgId);
        const target = findEntry(current.entries, intoOrgId);
        if (source.orgId === target.orgId || source.kind !== target.kind) {
          throw new OrgHttpError(400, { error: 'intoOrgId must name a different entry of the same kind' });
        }
        // From-texts (D11): the merged name and its spellings that no OTHER entry shares.
        const others = current.entries.filter((e) => e.orgId !== source.orgId);
        const unshared = source.spellings.filter((s) => {
          const n = normalizeOrgText(s);
          return !others.some((o) => o.spellings.some((x) => normalizeOrgText(x) === n));
        });
        // The transfer (D11): the name and ALL spellings move onto the target.
        // D12's automatic-addition skips do not apply, so a cap is a refusal,
        // never a silent drop. A spelling shared with a third entry stays shared
        // (the target replaces the merged carrier).
        const spellings = [...target.spellings];
        const held = new Set([normalizeOrgText(target.name), ...target.spellings.map(normalizeOrgText)]);
        for (const s of [source.name, ...source.spellings]) {
          const n = normalizeOrgText(s);
          if (held.has(n)) continue;
          held.add(n);
          spellings.push(s);
        }
        if (spellings.length > ORG_SPELLINGS_PER_ENTRY_MAX) throw new OrgHttpError(409, { error: 'org_spellings_full' });
        const merged: OrgEntry = { ...target, spellings, updatedAt: now(), updatedBy: actor };
        const entries = replaceEntry(others, merged);
        return {
          entries,
          def: {
            action: 'merge',
            fromTexts: [source.name, ...unshared],
            // `fields` fixed now, from the target's kind (spec 5.1).
            fields: recordFieldsForKind(target.kind),
            toName: target.name,
          },
          result: {},
        };
      });
    },

    async resolveNotOnList(input) {
      const { field, value, action, actor } = input;
      if (value.trim() === '') throw new OrgHttpError(400, { error: 'value must not be blank' });
      const kinds = KINDS_FOR_FIELD[field];
      const kind: OrgKind = field === 'agency' ? 'agency' : 'housing_authority';
      // Minted outside the (retryable) list change, before start() mints the rewrite id.
      const addedId = action === 'add' ? newId() : undefined;
      return start(actor, (current) => {
        let entries: OrgEntry[] = [...current.entries];
        // `value` arrives TRIMMED (trimJsonBody, app.ts), so a stored name padded
        // with whitespace reaches here as the exact name. "Use <that entry>"
        // settles it - the pass rewrites only holders whose stored text differs
        // from the name - so that one request is not "nothing to settle".
        if (isOnListFor(entries, value, kinds) && !(action === 'use' && input.name === value)) {
          throw new OrgHttpError(400, { error: 'the value is on the list for this field; there is nothing to settle' });
        }
        // A NAME VARIANT (spec D10): a value that differs from an entry NAME of
        // the field's kind only in case or punctuation normalizes equal to that
        // exact name, so a pass over it would also rewrite every exact holder.
        // Only "Use <that entry>" is safe - the pass leaves exact holders alone.
        const n = normalizeOrgText(value);
        const variantOf = entries.find((e) => kinds.includes(e.kind) && normalizeOrgText(e.name) === n);
        if (variantOf !== undefined && !(action === 'use' && input.name === variantOf.name)) {
          throw new OrgHttpError(409, { error: 'org_value_is_name_variant', entry: toOrgRef(variantOf) });
        }
        const named = (name: string | undefined, wanted: OrgKind, key: 'name' | 'agencyName'): OrgEntry => {
          const hit = name === undefined ? undefined : entries.find((e) => e.name === name && e.kind === wanted);
          if (hit === undefined) {
            throw new OrgHttpError(400, {
              error: `${key} must be the exact name of ${wanted === 'agency' ? 'an agency' : 'a housing authority'} on the list`,
            });
          }
          return hit;
        };
        const skippedSpellings: SkippedSpelling[] = [];
        // A value action rewrites the one field the row names (spec 5.1 `fields`).
        const settle = (def: Omit<RewriteDefinition, 'fromTexts' | 'field' | 'fields'>) => ({
          entries,
          def: { ...def, fromTexts: [value], field, fields: [field] },
          result: { skippedSpellings },
        });
        switch (action) {
          case 'clear':
            return settle({ action: 'clear' });
          case 'move_to_agency':
            if (field !== 'housingAuthority') {
              throw new OrgHttpError(400, { error: 'move_to_agency settles housingAuthority values only' });
            }
            return settle({ action, toName: named(input.name, 'agency', 'name').name });
          case 'move_to_housing_authority':
            if (field !== 'agency') {
              throw new OrgHttpError(400, { error: 'move_to_housing_authority settles agency values only' });
            }
            return settle({ action, toName: named(input.name, 'housing_authority', 'name').name });
          case 'split':
            if (field !== 'housingAuthority') {
              throw new OrgHttpError(400, { error: 'split settles housingAuthority values on contacts only' });
            }
            return settle({
              action,
              toName: named(input.name, 'housing_authority', 'name').name,
              agencyName: named(input.agencyName, 'agency', 'agencyName').name,
            });
          case 'use':
          case 'add': {
            let target: OrgEntry;
            if (action === 'add') {
              const name = input.name !== undefined && input.name.trim() !== '' ? input.name.trim() : value.trim();
              const problem = checkNewOrgName(entries, name);
              if (problem !== null) throw nameProblemError(problem);
              const at = now();
              target = {
                orgId: addedId ?? newId(),
                kind,
                name,
                spellings: [],
                createdAt: at,
                createdBy: actor,
                updatedAt: at,
                updatedBy: actor,
              };
              entries = [...entries, target];
            } else {
              target = named(input.name, kind, 'name');
            }
            // "Remember this spelling" (D10, D12) is an AUTOMATIC addition: a
            // problem is a skip, never a failure; a spelling the entry already
            // finds ('duplicate') is no skip at all.
            if (input.rememberSpelling === true) {
              const spelling = value.trim();
              const problem = checkOrgSpelling(entries, target, spelling);
              if (problem === null) {
                target = { ...target, spellings: [...target.spellings, spelling], updatedAt: now(), updatedBy: actor };
                entries = replaceEntry(entries, target);
              } else if (problem.problem !== 'duplicate') {
                skippedSpellings.push({ spelling, problem: problem.problem });
              }
            }
            // "Add as new" = create the entry, then Use it (D10).
            return settle({ action: 'use', toName: target.name });
          }
        }
      });
    },

    async runAgain(actor) {
      const jobId = newId();
      const started = await list.mutate((current) => {
        const at = now();
        const last = current.lastRewrite;
        // The cleanup's lock can never be re-run by a job - re-run the script
        // instead; a stale one simply stops blocking after 15 minutes (D11).
        if (last === undefined || last.action === 'cleanup') {
          throw new OrgHttpError(409, { error: 'org_rewrite_not_rerunnable' });
        }
        if (isOrgRewriteRunning(last, Date.parse(at))) throw rewriteRunningError(last);
        if (last.status === 'done') throw new OrgHttpError(409, { error: 'org_rewrite_not_rerunnable' });
        // Spec D11: a failed or stalled rewrite holds no lock, so the list may
        // have changed since. Re-run only while (1) every name it writes is
        // still an entry of the kind it expects - its target may have been
        // renamed, merged, deleted or re-kinded - and (2) every from-text is
        // still OFF the list for its fields (build ruling B-2).
        const targetGone = (name: string | undefined, kind: OrgKind): boolean =>
          name === undefined || !current.entries.some((e) => e.name === name && e.kind === kind);
        const toKind = rewriteTargetKind(last);
        if (
          (toKind !== undefined && targetGone(last.toName, toKind)) ||
          (last.action === 'split' && targetGone(last.agencyName, 'agency'))
        ) {
          throw new OrgHttpError(409, { error: 'org_rewrite_target_gone' });
        }
        // (2): a from-text that has since become - or become a name variant of
        // - the NAME of an entry a stored field accepts would rewrite every
        // record holding that now-listed name; a fresh action on the value is
        // refused (D10). The one exception is the rewrite's own target: "Use
        // <that entry>" settles a name variant and leaves exact holders alone.
        const acceptedKinds = new Set(last.fields.flatMap((f) => KINDS_FOR_FIELD[f]));
        const fromTexts = new Set(last.fromTexts.map(normalizeOrgText));
        const fromTextListed = current.entries.some(
          (e) => acceptedKinds.has(e.kind) && e.name !== last.toName && fromTexts.has(normalizeOrgText(e.name)),
        );
        if (fromTextListed) throw new OrgHttpError(409, { error: 'org_rewrite_target_gone' });
        // Failed, or running with a stale heartbeat: the SAME definition (its
        // `fields` included) under a NEW id, so a late delivery of the old run
        // finds the lock is not its own.
        const lastRewrite = runningState(jobId, last, actor, at);
        return { next: { ...current, lastRewrite }, result: { lastRewrite } };
      });
      return enqueueOrFail(started);
    },

    heartbeat,
    finish,

    async acquireForCleanup(actor) {
      const jobId = newId();
      const lastRewrite = await list.mutate((current) => {
        const at = now();
        refuseWhileHeld(current, at);
        // The cleanup touches all three fields (spec section 8); no job ever runs it.
        const state = runningState(
          jobId,
          { action: 'cleanup', fromTexts: [], fields: ['housingAuthority', 'agency', 'accepted_authorities'] },
          actor,
          at,
        );
        return { next: { ...current, lastRewrite: state }, result: state };
      });
      log.info({ jobId, actor }, 'org rewrite lock taken by the cleanup script');
      return lastRewrite;
    },
  };
}
