// The Rankings page API (WP1 B2a spec D12, D18; charter 11) - ADMIN ONLY on
// the server: requireRole('admin') on every route, as routes/aiRuns.ts; the
// dashboard's AdminRoute is not authorization. Wire names are S7's (PR14).
//
//   GET /api/admin/rankings/runs?from&to&anchorKind&anchorId&cursor&limit
//       -> { runs: [...], nextCursor?, incomplete? }      newest first, by pointer
//   GET /api/admin/rankings/runs/:runId
//       -> { run, anchorDisplay, input, pairs, flags[, currentUnavailable][, flagsUnavailable] } | 404 run_not_found
//   GET /api/admin/rankings/cost?from&to
//       -> { environment, weeks, totalUsd, truncated, incomplete? }
//
// PR34: the list and the cost read S2's listRuns, whose live entries are the
// run SUMMARY only (RANKING_RUN_SUMMARY_FIELDS - never rawText, inputGzip,
// handles or results); only the run detail reads a whole item (getRun). A run
// S2 could not read after its retries comes back expired + unavailable and
// the page `incomplete: true`; both routes pass that on as `incomplete: true`
// (the row itself stays `{ runId, expired: true }`, S7's shape), never a
// silent drop. The cost fills a missing bound (R2B6): to = today (UTC),
// from = the Monday 11 weeks before to's ISO week Monday - 12 ISO weeks.
//
// Ranking runs live under their OWN key family (rrun#, with ptr#rankings#...
// pointers) and are read through rankingRunsRepo, never aiRunsRepo, whose
// list renders every ranking pointer as expired (spec D11).
//
// The run detail renders what THIS run said - its own results[] (with the
// merged missing list and cappedAtRun) - and links each pair to the CURRENT
// match's run (`currentRunId`); `sinceRescored` is that run being another
// one: the matches store holds one row per pair that any later press, from
// either anchor, rewrites.
//
// Open unlawful flags (spec D10 rev 7, charter item 16) show only on a
// PROPERTY anchor's runs, that property's own; a tenant-anchor run's detail
// reads no flag record.
import { Router } from 'express';
import type { AppConfig } from '../lib/config.js';
import { contactDisplayName } from '../lib/contactName.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { propertyLabel } from '../lib/propertyLabel.js';
import { requireRole } from '../middleware/auth.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createMatchesRepo, gunzipBase64, matchPairKey, type MatchRow, type MatchesRepo } from '../repos/matchesRepo.js';
import {
  createRankingRunsRepo,
  rankingRunEntityKey,
  type RankingRunRecord,
  type RankingRunsRepo,
} from '../repos/rankingRunsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import { createAssembleDeps, loadPropertyFacts } from '../services/ranking/assemble.js';
import { bandOf } from '../services/ranking/bands.js';
import type { PropertyFacts } from '../services/ranking/cards.js';
import { openFlags } from '../services/ranking/flags.js';
import type { RankingReadFlag } from '../services/ranking/readRanking.js';

export interface AdminRankingsRouterDeps {
  /** appEnv for the cost totals; the default property-facts reader. */
  config: AppConfig;
  logger?: Logger;
  runsRepo?: Pick<RankingRunsRepo, 'listRuns' | 'getRun' | 'getOpenCandidateFlags'>;
  matchesRepo?: Pick<MatchesRepo, 'getPairs'>;
  contactsRepo?: Pick<ContactsRepo, 'getDisplaysByIds'>;
  unitsRepo?: Pick<UnitsRepo, 'getDisplaysByIds'>;
  /** Each property's current-card facts (the open-flag check); assemble.ts's loadPropertyFacts otherwise. */
  propertyFacts?(unitIds: string[]): Promise<Map<string, PropertyFacts>>;
  /** The clock for the cost's default range (PR34); the wall clock otherwise. */
  now?(): Date;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_COST_PAGES = 50;
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Shape AND a real calendar date, by canonical round trip (routes/aiRuns.ts's rule). */
function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, n);
}

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** from / to as validated calendar dates; an error key when one is malformed. */
function dateRange(query: Record<string, unknown>): { from?: string; to?: string } | { error: string } {
  const out: { from?: string; to?: string } = {};
  for (const name of ['from', 'to'] as const) {
    const raw = query[name];
    if (raw !== undefined && typeof raw !== 'string') return { error: `invalid_${name}` };
    const value = optionalString(raw);
    if (value === undefined) continue;
    if (!isCalendarDate(value)) return { error: `invalid_${name}` };
    out[name] = value;
  }
  return out;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/** PR34: the cost's default span - 12 ISO weeks, the `to` date's week included. */
export const COST_DEFAULT_WEEKS = 12;

/**
 * PR34 / R2B6: the cost range the server reads. A missing `to` is today
 * (UTC); a missing `from` is the Monday 11 weeks before the Monday of
 * `to`'s ISO week. So no bound at all is the last 12 ISO weeks, and a lone
 * `to` never reads all time. `given` dates are already validated.
 */
export function costRange(given: { from?: string; to?: string }, now: Date): { from: string; to: string } {
  const to = given.to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  if (given.from !== undefined) return { from: given.from, to };
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  const fromMonday = (new Date(toMs).getUTCDay() + 6) % 7;
  const from = toMs - fromMonday * DAY_MS - (COST_DEFAULT_WEEKS - 1) * 7 * DAY_MS;
  return { from: new Date(from).toISOString().slice(0, 10), to };
}

/** The no-bounds case: the last 12 ISO weeks. */
export function defaultCostRange(now: Date): { from: string; to: string } {
  return costRange({}, now);
}

/** ISO 8601 week, 'YYYY-Www' (weeks start Monday; week 1 holds the year's first Thursday). */
export function isoWeekOf(iso: string): string {
  const d = new Date(iso);
  const fromMonday = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - fromMonday + 3);
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const jan4FromMonday = (new Date(jan4).getUTCDay() + 6) % 7;
  const firstThursday = jan4 - jan4FromMonday * DAY_MS + 3 * DAY_MS;
  const week = 1 + Math.round((thursday - firstThursday) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function createAdminRankingsRouter(deps: AdminRankingsRouterDeps): Router {
  const log = deps.logger ?? defaultLogger;
  const runs = deps.runsRepo ?? createRankingRunsRepo({ logger: deps.logger });
  const matches = deps.matchesRepo ?? createMatchesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  let assembleDeps: ReturnType<typeof createAssembleDeps> | undefined;
  const propertyFacts =
    deps.propertyFacts ??
    ((unitIds: string[]): Promise<Map<string, PropertyFacts>> => {
      assembleDeps ??= createAssembleDeps({ config: deps.config, logger: log });
      return loadPropertyFacts(unitIds, assembleDeps);
    });

  /** Anchor names / labels, best-effort; IR21: always a string, the id when nothing resolves. */
  async function anchorDisplays(list: ReadonlyArray<Pick<RankingRunRecord, 'anchorKind' | 'anchorId'>>): Promise<(run: Pick<RankingRunRecord, 'anchorKind' | 'anchorId'>) => string> {
    const found = new Map<string, string>();
    const tenantIds = [...new Set(list.filter((r) => r.anchorKind === 'tenant').map((r) => r.anchorId))];
    const unitIds = [...new Set(list.filter((r) => r.anchorKind === 'unit').map((r) => r.anchorId))];
    try {
      if (tenantIds.length > 0) {
        for (const [id, contact] of await contacts.getDisplaysByIds(tenantIds)) {
          const name = contactDisplayName(contact);
          if (name !== undefined) found.set(`tenant#${id}`, name);
        }
      }
      if (unitIds.length > 0) {
        for (const [id, unit] of await units.getDisplaysByIds(unitIds)) {
          const label = propertyLabel(unit);
          if (label !== undefined) found.set(`unit#${id}`, label);
        }
      }
    } catch (err) {
      log.warn({ err, tenants: tenantIds.length, units: unitIds.length }, 'rankings admin: anchor display read failed');
    }
    return (run) => found.get(`${run.anchorKind}#${run.anchorId}`) ?? run.anchorId;
  }

  const router = Router();
  router.use(requireRole('admin'));

  router.get('/runs', async (req, res) => {
    const range = dateRange(req.query as Record<string, unknown>);
    if ('error' in range) {
      res.status(400).json({ error: range.error });
      return;
    }
    const anchorKind = optionalString(req.query['anchorKind']);
    const anchorId = optionalString(req.query['anchorId']);
    if (
      (anchorKind === undefined) !== (anchorId === undefined) ||
      (anchorKind !== undefined && anchorKind !== 'unit' && anchorKind !== 'tenant')
    ) {
      res.status(400).json({ error: 'invalid_anchor' });
      return;
    }
    const cursor = optionalString(req.query['cursor']);
    const page = await runs.listRuns({
      entityKey:
        anchorKind === undefined || anchorId === undefined
          ? rankingRunEntityKey()
          : rankingRunEntityKey({ kind: anchorKind, id: anchorId }),
      ...(range.from !== undefined && { from: range.from }),
      ...(range.to !== undefined && { to: range.to }),
      ...(cursor !== undefined && { cursor }),
      limit: parseLimit(req.query['limit']),
    });
    const displayOf = await anchorDisplays(page.entries.flatMap((entry) => (entry.expired ? [] : [entry.run])));
    res.json({
      runs: page.entries.map((entry) => {
        if (entry.expired) return { runId: entry.runId, expired: true as const };
        const run = entry.run;
        return {
          runId: run.runId,
          expired: false as const,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          anchorKind: run.anchorKind,
          anchorId: run.anchorId,
          anchorDisplay: displayOf(run),
          direction: run.direction,
          batchIndex: run.batchIndex,
          candidateCount: run.candidateCount,
          driver: run.driver,
          model: run.model,
          costUsd: run.costUsd,
          latencyMs: run.latencyMs,
          outcome: run.outcome,
          ...(run.failure !== undefined && { failure: run.failure }),
          environment: run.environment,
        };
      }),
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
      // PR34: a run on this page stayed unread after S2's retries.
      ...(page.incomplete === true && { incomplete: true as const }),
    });
  });

  router.get('/runs/:runId', async (req, res) => {
    const runId = String(req.params['runId'] ?? '').trim();
    const run = runId.length === 0 ? undefined : await runs.getRun(runId);
    if (run === undefined) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    const keyOf = (candidateId: string): { tenantId: string; unitId: string } =>
      run.anchorKind === 'unit'
        ? { tenantId: candidateId, unitId: run.anchorId }
        : { tenantId: run.anchorId, unitId: candidateId };

    let current: Map<string, MatchRow> | undefined;
    try {
      current =
        run.results.length === 0
          ? new Map()
          : await matches.getPairs(run.results.map((r) => keyOf(r.candidateId)), { requireComplete: true });
    } catch (err) {
      log.warn({ runId, err }, 'rankings admin: current match read incomplete');
      current = undefined;
    }

    // Spec D10 rev 7: only a property-anchor run reads its property's open
    // flags; a tenant-anchor run reads none (no `flags` entries, never
    // `flagsUnavailable`).
    let flags: RankingReadFlag[] = [];
    let flagsUnavailable = false;
    if (run.anchorKind === 'unit') {
      const unitId = run.anchorId;
      try {
        const unitFacts = (await propertyFacts([unitId])).get(unitId);
        if (unitFacts !== undefined) {
          const open = openFlags(await runs.getOpenCandidateFlags(unitId), unitFacts.freeTextByField);
          flags = open.map((r) => ({ unitId: r.unitId, field: r.field, reason: r.reason, runId: r.runId, raisedAt: r.raisedAt }));
        }
      } catch (err) {
        log.warn({ runId, err }, 'rankings admin: open flag read failed');
        flagsUnavailable = true;
        flags = [];
      }
    }

    const pairs = run.results.map((result) => {
      const key = keyOf(result.candidateId);
      const match = current?.get(matchPairKey(key.tenantId, key.unitId));
      const currentRunId = match === undefined ? null : match.runId;
      const capped = result.cappedAtRun?.capped === true;
      const scored = result.returned && result.score !== undefined;
      return {
        candidateId: result.candidateId,
        handle: result.handle,
        display: result.display,
        returned: result.returned,
        ...(scored && { score: result.score, band: capped ? ('weak' as const) : bandOf(result.score as number) }),
        cappedAtRun: capped,
        capReason: result.cappedAtRun?.capReason ?? null,
        for: result.for ?? [],
        against: result.against ?? [],
        missing: result.missing ?? [],
        unknowns: result.unknowns ?? [],
        failedRequirements: result.failedRequirements ?? [],
        fairHousingFlags: result.fairHousingFlags ?? [],
        currentRunId,
        sinceRescored: currentRunId !== null && currentRunId !== run.runId,
      };
    });

    let input: string | null = null;
    if (run.inputGzip !== undefined) {
      try {
        input = gunzipBase64(run.inputGzip);
      } catch (err) {
        log.warn({ runId, err }, 'rankings admin: run input could not be decompressed');
      }
    }
    const displayOf = await anchorDisplays([run]);
    const { inputGzip: _input, itemId: _itemId, handles: _handles, results: _results, ...fields } = run;
    res.json({
      run: fields,
      anchorDisplay: displayOf(run),
      input,
      pairs,
      flags,
      ...(current === undefined && { currentUnavailable: true }),
      ...(flagsUnavailable && { flagsUnavailable: true }),
    });
  });

  router.get('/cost', async (req, res) => {
    const given = dateRange(req.query as Record<string, unknown>);
    if ('error' in given) {
      res.status(400).json({ error: given.error });
      return;
    }
    // PR34 / R2B6: a missing bound is filled (to = today; from = 12 ISO weeks before to).
    const range = costRange(given, deps.now?.() ?? new Date());
    let incomplete = false;
    const groups = new Map<string, { week: string; environment: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number }>();
    let totalUsd = 0;
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;
    do {
      const page = await runs.listRuns({
        entityKey: rankingRunEntityKey(),
        ...(range.from !== undefined && { from: range.from }),
        ...(range.to !== undefined && { to: range.to }),
        limit: MAX_PAGE_SIZE,
        ...(cursor !== undefined && { cursor }),
      });
      if (page.incomplete === true) incomplete = true;
      for (const entry of page.entries) {
        if (entry.expired) continue;
        const { run } = entry;
        const week = isoWeekOf(run.startedAt);
        const key = `${week}#${run.environment}`;
        const group = groups.get(key) ?? { week, environment: run.environment, runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        group.runs += 1;
        group.inputTokens += run.usage?.inputTokens ?? 0;
        group.outputTokens += run.usage?.outputTokens ?? 0;
        group.costUsd += run.costUsd;
        groups.set(key, group);
        totalUsd += run.costUsd;
      }
      cursor = page.nextCursor;
      pages += 1;
      if (cursor !== undefined && pages >= MAX_COST_PAGES) {
        truncated = true;
        log.warn({ pages }, 'rankings admin: cost totals truncated at the page cap');
        break;
      }
    } while (cursor !== undefined);
    res.json({
      environment: deps.config.appEnv,
      weeks: [...groups.values()]
        .sort((a, b) => b.week.localeCompare(a.week) || a.environment.localeCompare(b.environment))
        .map((group) => ({ ...group, costUsd: round6(group.costUsd) })),
      totalUsd: round6(totalUsd),
      truncated,
      // PR34: a run in range stayed unread after S2's retries - the totals may be low.
      ...(incomplete && { incomplete: true as const }),
    });
  });

  return router;
}
