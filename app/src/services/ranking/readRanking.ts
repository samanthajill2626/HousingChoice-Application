// Reading a ranking (WP1 B2a spec D9; charter 10.3, 8, 9): what the Rankings
// page (and later B3's composer) shows for one anchor, derived on read from
// the stored matches, the CURRENT pool and cards, the anchor's last job and
// the open unlawful flags. Opening a page calls no model; only a press of
// Rank does (services/ranking/job.ts claimRanking).
//
// Nothing here is stored: band, cap state, priority effect and sort position
// are derived on every read, so a threshold or setting change needs no
// re-rank (charter 10.1). One band (bandOf), one cap (capOf), one open check
// (flags.ts) - the job's cappedAtRun and the counterfactual check call the
// same functions (PR7).
//
// Pairs are read BY KEY from the base table for every pool member
// (matchesRepo.getPairs, requireComplete), never through the eventually
// consistent byUnit index.
//
// PR17: a 503 comes from the anchor's own reads; a candidate whose reads are
// incomplete is a row marked `unverified` showing its stored match, and the
// read never throws on one.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from '../../lib/config.js';
import type { Logger } from '../../lib/logger.js';
import type { ContactItem } from '../../repos/contactsRepo.js';
import { createMatchesRepo, matchPairKey, type MatchRow, type MatchesRepo } from '../../repos/matchesRepo.js';
import {
  createRankingRunsRepo,
  type RankingJobRecord,
  type RankingRunsRepo,
  type UnlawfulFlagRecord,
} from '../../repos/rankingRunsRepo.js';
import type { UnitItem } from '../../repos/unitsRepo.js';
import {
  assembleRanking,
  createAssembleDeps,
  poolTooLargeMissing,
  propertyDisplay,
  tenantDisplay,
  type AssembleResult,
  type AssembledCandidate,
} from './assemble.js';
import { bandOf, type Band } from './bands.js';
import { capOf, flagFieldsOfKind } from './cap.js';
import { EXAMPLES_VERSION } from './examples.js';
import { openFlags } from './flags.js';
import { jobView, type RankingJobView } from './job.js';
import { mapWithConcurrency, sortRecencyAt, type PoolFailure } from './pool.js';
import { RUBRIC_VERSION } from './rubric.js';
import type { AnchorKind, AnchorNote, AnchorRef, MissingFlag } from './types.js';

export type OutOfDateReason = 'card' | 'pairHistory' | 'age' | 'version' | 'failedBatch' | 'unverified';
export type PriorityStrength = AppConfig['rankingPriorityStrength'];

export const RANKING_UNAVAILABLE_MESSAGE = 'The ranking could not be read. Try again.';

const DAY_MS = 86_400_000;
const BAND_RANK: Record<Band, number> = { strong: 3, good: 2, possible: 1, weak: 0 };

export interface RankingReadMatch {
  score: number;
  band: Band;
  capped: boolean;
  capReason: 'requirement not met' | null;
  for: MatchRow['for'];
  against: MatchRow['against'];
  missing: MatchRow['missing'];
  failedRequirements: string[];
  fairHousingFlags: MatchRow['fairHousingFlags'];
  computedAt: string;
  model: string;
  runId: string;
  outOfDate: OutOfDateReason[];
}

export interface RankingReadRow {
  candidateId: string;
  tenantId: string;
  unitId: string;
  display: string;
  /** Tenants (a property anchor): SMS consent, a flag only - never a pool rule (D1). */
  hasConsent?: boolean;
  /** Properties (a tenant anchor): read here, never sent to the model (charter 9.2). */
  priority?: boolean;
  notRankedYet: boolean;
  /** No match, and the anchor's last job listed this candidate (failedBatches or notScored, PR13). */
  notScored: boolean;
  match: RankingReadMatch | null;
}

export interface RankingReadFlag {
  unitId: string;
  field: string;
  reason: string;
  runId: string;
  raisedAt: string;
}

export interface RankingReadAnchor {
  kind: AnchorKind;
  id: string;
  display: string;
  anchorNotes: AnchorNote[];
  missing: MissingFlag[];
  /** Some stored match's anchor-side fingerprint differs from the current anchor card. */
  cardChanged: boolean;
}

export type RankingRead =
  | {
      kind: 'ok';
      anchor: RankingReadAnchor;
      job: RankingJobView | null;
      rows: RankingReadRow[];
      flags: RankingReadFlag[];
      /** RANKING_POOL_WINDOW_DAYS, for the include-older copy (PR26). */
      poolWindowDays: number;
      /** PR16: the pool is over RANKING_MAX_POOL; rows is then empty. BA3: `message` is the pool's POOL_MESSAGES text. */
      poolTooLarge?: { size: number; message: string };
    }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; message: string };

export interface RowContext {
  now: Date;
  maxAgeDays: number;
  /** The model a NEW match would carry (currentRankingModel). */
  model: string;
  /** The anchor's last job record (its lists decide notScored / failedBatch). */
  job: RankingJobRecord | undefined;
  /** Per property: the fields of its OPEN unlawful flags. */
  openFieldsByUnit: ReadonlyMap<string, string[]>;
  /** Properties whose flag read failed: their rows read unverified (PR17). */
  unreadFlagUnits: ReadonlySet<string>;
}

/** D6: matches record the driver actually used - the model id for anthropic, else 'fake' / 'console'. */
export function currentRankingModel(config: Pick<AppConfig, 'rankingDriver' | 'aiRankingModel'>): string {
  return config.rankingDriver === 'anthropic' ? config.aiRankingModel : config.rankingDriver;
}

/** PR13: the last job listed the candidate - a failed call, an omission, or an unreadable card. */
export function inLastJob(job: RankingJobRecord | undefined, candidateId: string): boolean {
  if (job === undefined) return false;
  return (
    (job.failedBatches ?? []).some((failed) => failed.candidateIds.includes(candidateId)) ||
    (job.notScored ?? []).some((entry) => entry.candidateId === candidateId)
  );
}

function isUnverified(candidate: AssembledCandidate, ctx: RowContext): boolean {
  return candidate.unverified || ctx.unreadFlagUnits.has(candidate.unitId);
}

/**
 * D9's out-of-date reasons, in a fixed order. `card` / `pairHistory` compare
 * fingerprints only (D13 decides what moves them); a candidate with no
 * current fingerprints (S3 `unverified`) skips both. `failedBatch`: listed by
 * the anchor's last job AND computed before that job started - a pair
 * re-scored since, from the other anchor, is not flagged. `unverified`: the
 * candidate's reads, or its property's flag read, came back incomplete.
 */
export function outOfDateReasons(candidate: AssembledCandidate, row: MatchRow, ctx: RowContext): OutOfDateReason[] {
  const reasons: OutOfDateReason[] = [];
  if (!candidate.unverified) {
    if (
      row.fingerprints.tenantCard !== candidate.fingerprints.tenantCard ||
      row.fingerprints.unitCard !== candidate.fingerprints.unitCard
    ) {
      reasons.push('card');
    }
    if (row.fingerprints.pairHistory !== candidate.fingerprints.pairHistory) reasons.push('pairHistory');
  }
  const computedMs = Date.parse(row.computedAt);
  if (!Number.isFinite(computedMs) || ctx.now.getTime() - computedMs > ctx.maxAgeDays * DAY_MS) reasons.push('age');
  if (row.rubricVersion !== RUBRIC_VERSION || row.examplesVersion !== EXAMPLES_VERSION || row.model !== ctx.model) {
    reasons.push('version');
  }
  const startedAt = ctx.job?.startedAt;
  if (
    startedAt !== undefined &&
    inLastJob(ctx.job, candidate.candidateId) &&
    Number.isFinite(computedMs) &&
    computedMs < Date.parse(startedAt)
  ) {
    reasons.push('failedBatch');
  }
  if (isUnverified(candidate, ctx)) reasons.push('unverified');
  return reasons;
}

function deriveMatch(candidate: AssembledCandidate, row: MatchRow, ctx: RowContext): RankingReadMatch {
  // PR17: with no facts, every failed cap-eligible key counts as recorded;
  // with no facts or an unread flag list, no flag counts as open.
  const facts = candidate.propertyFacts;
  const flagsKnown = facts !== null && !ctx.unreadFlagUnits.has(candidate.unitId);
  const cap = capOf({
    failedRequirements: row.failedRequirements,
    accommodationFields: flagFieldsOfKind(row.fairHousingFlags, 'accommodation'),
    recordedRequirementKeys: facts === null ? row.failedRequirements : facts.recordedRequirementKeys,
    openUnlawfulFields: flagsKnown ? (ctx.openFieldsByUnit.get(candidate.unitId) ?? []) : [],
  });
  return {
    score: row.score,
    band: cap.capped ? 'weak' : bandOf(row.score),
    capped: cap.capped,
    capReason: cap.capReason,
    for: row.for,
    against: row.against,
    missing: row.missing,
    failedRequirements: row.failedRequirements,
    fairHousingFlags: row.fairHousingFlags,
    computedAt: row.computedAt,
    model: row.model,
    runId: row.runId,
    outOfDate: outOfDateReasons(candidate, row, ctx),
  };
}

export function buildRow(candidate: AssembledCandidate, row: MatchRow | undefined, ctx: RowContext): RankingReadRow {
  const base = {
    candidateId: candidate.candidateId,
    tenantId: candidate.tenantId,
    unitId: candidate.unitId,
    display: candidate.display,
    ...(candidate.hasConsent !== undefined && { hasConsent: candidate.hasConsent }),
    ...(candidate.priority !== undefined && { priority: candidate.priority }),
  };
  if (row === undefined) {
    const notScored = inLastJob(ctx.job, candidate.candidateId);
    return { ...base, notRankedYet: !notScored, notScored, match: null };
  }
  return { ...base, notRankedYet: false, notScored: false, match: deriveMatch(candidate, row, ctx) };
}

/**
 * The property anchor's tie order (spec D9, FB19): last heard from, else
 * created_at - S3's sortRecencyAt, NOT the pool window's poolRecencyAt (whose
 * import exception would sort a never-heard imported tenant last). Its
 * candidates are tenants.
 */
function recencyMs(candidate: AssembledCandidate): number | null {
  const at = sortRecencyAt(candidate.record as ContactItem);
  if (at === null) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** Newest first; a candidate with no instant sorts after every one with one. */
function compareRecency(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

interface SortItem {
  row: RankingReadRow;
  candidate: AssembledCandidate;
  poolIndex: number;
}

function compareMatched(a: SortItem, b: SortItem, kind: AnchorKind, strength: PriorityStrength): number {
  const ma = a.row.match as RankingReadMatch;
  const mb = b.row.match as RankingReadMatch;
  if (kind === 'unit') {
    // Property anchor (candidates are tenants): band, then score, then last
    // heard from. Priority is the anchor's own attribute and does not apply.
    // A capped pair reads Weak and sorts last within it (charter 7.4).
    return (
      BAND_RANK[mb.band] - BAND_RANK[ma.band] ||
      Number(ma.capped) - Number(mb.capped) ||
      mb.score - ma.score ||
      compareRecency(recencyMs(a.candidate), recencyMs(b.candidate))
    );
  }
  // Tenant anchor (candidates are properties): band after the priority
  // strength, then priority on before off, then score, then property label.
  // A capped pair gets no lift and no priority tie preference.
  const liftA = a.row.priority === true && !ma.capped;
  const liftB = b.row.priority === true && !mb.capped;
  if (strength === 'always_first' && liftA !== liftB) return liftA ? -1 : 1;
  const up = (lift: boolean): number => (strength === 'one_band_up' && lift ? 1 : 0);
  const rankA = Math.min(BAND_RANK.strong, BAND_RANK[ma.band] + up(liftA));
  const rankB = Math.min(BAND_RANK.strong, BAND_RANK[mb.band] + up(liftB));
  return (
    rankB - rankA ||
    Number(ma.capped) - Number(mb.capped) ||
    Number(liftB) - Number(liftA) ||
    mb.score - ma.score ||
    a.row.display.localeCompare(b.row.display)
  );
}

/**
 * Charter 9.2's sort. Members with no match sort last, in pool order, in both
 * directions. Ties beyond every key keep pool order (the sort is stable).
 */
export function sortRows(
  entries: ReadonlyArray<{ row: RankingReadRow; candidate: AssembledCandidate }>,
  kind: AnchorKind,
  strength: PriorityStrength,
): RankingReadRow[] {
  const items: SortItem[] = entries.map((entry, poolIndex) => ({ ...entry, poolIndex }));
  items.sort((a, b) => {
    const aMatched = a.row.match !== null;
    const bMatched = b.row.match !== null;
    if (aMatched !== bMatched) return aMatched ? -1 : 1;
    if (!aMatched) return a.poolIndex - b.poolIndex;
    return compareMatched(a, b, kind, strength) || a.poolIndex - b.poolIndex;
  });
  return items.map((item) => item.row);
}

/** S3's display rule for a record the pool failure hands back (PR16). */
export function anchorDisplayOf(anchor: AnchorRef, record: ContactItem | UnitItem | undefined): string {
  if (record === undefined) return anchor.id;
  return anchor.kind === 'unit' ? propertyDisplay(record as UnitItem) : tenantDisplay(record as ContactItem);
}
