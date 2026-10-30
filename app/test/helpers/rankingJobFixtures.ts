// Shared builders for the WP1 B2a ranking JOB and READ tests (plan S5; S6
// reuses them). Not S3's rankingFixtures.ts (the in-memory gatherer world):
// these are the gatherer's OUTPUT - AssembledRanking / VerifiedCandidate /
// UnverifiedCandidate values built with every field and no cast, so the
// compiler checks them against S3's published shapes (IR36) - plus S2 records
// (jobs, runs, matches, flags) and stand-ins for S4's prompt and driver, so a
// test can say which batch fails or which candidate the model leaves out.
// Fixed clocks, synthetic ids, made-up names and addresses, no network.
import type { ContactItem } from '../../src/repos/contactsRepo.js';
import { gzipBase64, type MatchRow } from '../../src/repos/matchesRepo.js';
import {
  RANKING_JOBS_QUEUED_ENTITY,
  RANKING_JOBS_RUNNING_ENTITY,
  rankingJobItemId,
  rankingRunItemId,
  unlawfulFlagEntityKey,
  unlawfulFlagItemId,
  type RankingJobRecord,
  type RankingRunRecord,
  type UnlawfulFlagInput,
  type UnlawfulFlagRecord,
} from '../../src/repos/rankingRunsRepo.js';
import type { UnitItem } from '../../src/repos/unitsRepo.js';
import type {
  AssembledAnchor,
  AssembledCandidate,
  AssembledRanking,
  SeenHomeCard,
  UnverifiedCandidate,
  VerifiedCandidate,
} from '../../src/services/ranking/assemble.js';
import type { PropertyFacts } from '../../src/services/ranking/cards.js';
import type { RankingCallMeta, RankingDriver } from '../../src/services/ranking/driverTypes.js';
import { EXAMPLES_VERSION } from '../../src/services/ranking/examples.js';
import type { ParsedCandidate } from '../../src/services/ranking/parse.js';
import {
  RankingPromptError,
  type RankingBatchInput,
  type RankingPairSnapshot,
  type RankingPrompt,
  type buildRankingPrompt,
} from '../../src/services/ranking/prompt.js';
import { RUBRIC_VERSION } from '../../src/services/ranking/rubric.js';

export const T0 = '2026-10-28T12:00:00.000Z';
export const T0_MS = Date.parse(T0);
export const DAY_MS = 86_400_000;
export const TTL_DAYS = 180;
export const ANCHOR_UNIT = 'unit-anchor';
export const ANCHOR_TENANT = 'tenant-anchor';
export const PRESS_REQUEST_ID = 'req-press-1';
export const PRESS_TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

export function isoAt(offsetMs: number): string {
  return new Date(T0_MS + offsetMs).toISOString();
}

export function facts(over: Partial<PropertyFacts> = {}): PropertyFacts {
  return {
    recordedRequirementKeys: ['no_pets', 'qualifications'],
    freeTextByField: { qualifications: 'Two years of rental history.' },
    ...over,
  };
}

export function tenantRecord(contactId: string, over: Partial<ContactItem> = {}): ContactItem {
  return {
    contactId,
    type: 'tenant',
    status: 'searching',
    last_heard_from_at: isoAt(-DAY_MS),
    created_at: isoAt(-30 * DAY_MS),
    ...over,
  };
}

export function unitRecord(unitId: string, over: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId,
    landlordId: 'landlord-1',
    status: 'available',
    address: { line1: `${unitId} Elm St`, city: 'Atlanta' },
    ...over,
  };
}

export function unitAnchor(over: Partial<AssembledAnchor> = {}): AssembledAnchor {
  return {
    ref: { kind: 'unit', id: ANCHOR_UNIT },
    record: unitRecord(ANCHOR_UNIT, { address: { line1: '12 Oak St', city: 'Atlanta' } }),
    display: '12 Oak St, Atlanta',
    card: { address: '12 Oak St, Atlanta' },
    missing: [],
    anchorNotes: [],
    fingerprint: 'uc-anchor',
    propertyFacts: facts(),
    authorities: { mapped: [], unmapped: [] },
    ...over,
  };
}

export function tenantAnchor(over: Partial<AssembledAnchor> = {}): AssembledAnchor {
  return {
    ref: { kind: 'tenant', id: ANCHOR_TENANT },
    record: tenantRecord(ANCHOR_TENANT, { firstName: 'Ada', lastName: 'Example' }),
    display: 'Ada Example',
    card: { firstName: 'Ada' },
    missing: [],
    anchorNotes: [],
    fingerprint: 'tc-anchor',
    propertyFacts: null,
    authorities: { mapped: [], unmapped: [] },
    ...over,
  };
}

/** A verified tenant candidate of the unit anchor (a property's ranking). */
export function tenantCandidate(tenantId: string, over: Partial<VerifiedCandidate> = {}): VerifiedCandidate {
  return {
    tenantId,
    unitId: ANCHOR_UNIT,
    candidateId: tenantId,
    display: `Tenant ${tenantId}`,
    record: tenantRecord(tenantId),
    hasConsent: true,
    unverified: false,
    card: { notes: '' },
    missing: [],
    authority: 'matched',
    pairHistory: { sends: [], declined: null, tours: [], daysSinceLastSend: null },
    fingerprints: { tenantCard: `tc-${tenantId}`, unitCard: 'uc-anchor', pairHistory: `ph-${tenantId}` },
    propertyFacts: facts(),
    ...over,
  };
}

/** A tenant candidate whose own reads came back incomplete (spec D2.3). */
export function unverifiedTenant(tenantId: string, over: Partial<UnverifiedCandidate> = {}): UnverifiedCandidate {
  return {
    tenantId,
    unitId: ANCHOR_UNIT,
    candidateId: tenantId,
    display: `Tenant ${tenantId}`,
    record: tenantRecord(tenantId),
    hasConsent: true,
    unverified: true,
    card: null,
    missing: null,
    pairHistory: null,
    fingerprints: null,
    propertyFacts: facts(),
    ...over,
  };
}

/** A verified property candidate of the tenant anchor (a tenant's ranking). */
export function propertyCandidate(unitId: string, over: Partial<VerifiedCandidate> = {}): VerifiedCandidate {
  return {
    tenantId: ANCHOR_TENANT,
    unitId,
    candidateId: unitId,
    display: `${unitId} Elm St, Atlanta`,
    record: unitRecord(unitId),
    priority: false,
    unverified: false,
    card: { address: `${unitId} Elm St, Atlanta` },
    missing: [],
    authority: 'matched',
    pairHistory: { sends: [], declined: null, tours: [], daysSinceLastSend: null },
    fingerprints: { tenantCard: 'tc-anchor', unitCard: `uc-${unitId}`, pairHistory: `ph-${unitId}` },
    propertyFacts: facts(),
    ...over,
  };
}

/** A property candidate whose reads came back incomplete: no facts (S3 C8). */
export function unverifiedProperty(unitId: string, over: Partial<UnverifiedCandidate> = {}): UnverifiedCandidate {
  return {
    tenantId: ANCHOR_TENANT,
    unitId,
    candidateId: unitId,
    display: `${unitId} Elm St, Atlanta`,
    record: unitRecord(unitId),
    priority: false,
    unverified: true,
    card: null,
    missing: null,
    pairHistory: null,
    fingerprints: null,
    propertyFacts: null,
    ...over,
  };
}

export function assembled(
  anchor: AssembledAnchor,
  candidates: AssembledCandidate[],
  homes: Map<string, SeenHomeCard> = new Map(),
): AssembledRanking {
  return {
    ok: true,
    direction: anchor.ref.kind === 'unit' ? 'tenants_for_property' : 'properties_for_tenant',
    anchor,
    candidates,
    homes,
    unverifiedCount: candidates.filter((candidate) => candidate.unverified).length,
  };
}

export function parsed(over: Partial<ParsedCandidate> = {}): ParsedCandidate {
  return {
    score: 72,
    for: [{ text: 'voucher size fits', source: 'voucher_size' }],
    against: [],
    unknowns: [],
    failedRequirements: [],
    fairHousingFlags: [],
    ...over,
  };
}

export type PromptInput = Parameters<typeof buildRankingPrompt>[0];

/** What the stub prompt hands the stub driver: the batch's candidate ids in order. */
export interface StubBatchInput {
  candidateIds: string[];
  batchIndex: number;
  landlordCard: boolean;
}

/** Stands in for prompt.ts's buildRankingPrompt: handles c1..cn in batch order (IR14). */
export function stubBuildPrompt(input: PromptInput): RankingPrompt {
  const handles = input.candidates.map((c, i) => ({ handle: `c${i + 1}`, candidateId: c.candidateId, display: c.display }));
  const batch: StubBatchInput = {
    candidateIds: input.candidates.map((c) => c.candidateId),
    batchIndex: input.batchIndex,
    landlordCard: input.landlordCard,
  };
  return {
    batchInput: batch as unknown as RankingBatchInput,
    userText: JSON.stringify({ candidates: handles }),
    promptFingerprint: 'fp-test',
    handles,
    snapshotOf: (candidateId: string) => ({ candidateId, anchorCard: 'as sent' }) as unknown as RankingPairSnapshot,
  };
}

/** A prompt builder that throws S4's RankingPromptError for a batch holding `candidateId`. */
export function throwingBuildPrompt(candidateId: string): (input: PromptInput) => RankingPrompt {
  return (input) => {
    if (input.candidates.some((c) => c.candidateId === candidateId)) {
      throw new RankingPromptError('stub: a referenced seen home is not in homes');
    }
    return stubBuildPrompt(input);
  };
}

export interface StubDriverOptions {
  /** A failure kind for this batch (by its candidate ids), or undefined to score it. */
  failFor?: (candidateIds: string[]) => 'refusal' | 'parse' | 'truncated' | 'timeout' | 'driver' | undefined;
  /** Candidates the model "does not return". */
  omit?: readonly string[];
  /** The parsed result per candidate; parsed() otherwise. */
  resultFor?: (candidateId: string) => ParsedCandidate;
  /** Awaited before answering (hold a batch in flight). */
  gate?: () => Promise<void>;
  /** A contract break: the driver throws for this batch. */
  throwFor?: (candidateIds: string[]) => boolean;
  model?: string;
}

export interface StubDriver extends RankingDriver {
  calls: string[][];
  inputs: StubBatchInput[];
  inFlight(): number;
  maxInFlight(): number;
}

export function stubDriver(opts: StubDriverOptions = {}): StubDriver {
  const calls: string[][] = [];
  const inputs: StubBatchInput[] = [];
  let inFlight = 0;
  let max = 0;
  return {
    kind: 'fake',
    calls,
    inputs,
    inFlight: () => inFlight,
    maxInFlight: () => max,
    async rankBatch(input) {
      const batch = input as unknown as StubBatchInput;
      const ids = batch.candidateIds;
      calls.push(ids);
      inputs.push(batch);
      inFlight += 1;
      max = Math.max(max, inFlight);
      try {
        if (opts.gate !== undefined) await opts.gate();
        if (opts.throwFor?.(ids) === true) throw new Error('stub driver exploded');
        const meta: RankingCallMeta = {
          driver: 'fake',
          model: opts.model ?? 'fake',
          rawText: '{"candidates":[]}',
          usage: { inputTokens: 1000, outputTokens: 500 },
          latencyMs: 7,
        };
        const failure = opts.failFor?.(ids);
        if (failure !== undefined) return { ok: false, meta, failure, message: `stub ${failure}` };
        const byHandle = new Map<string, ParsedCandidate>();
        ids.forEach((id, i) => {
          if (!(opts.omit ?? []).includes(id)) byHandle.set(`c${i + 1}`, opts.resultFor?.(id) ?? parsed());
        });
        return { ok: true, meta, output: { byHandle, droppedUnlawfulFlags: 0 } };
      } finally {
        inFlight -= 1;
      }
    },
  };
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every pending promise continuation run. */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

export function queuedJob(over: Partial<RankingJobRecord> = {}): RankingJobRecord {
  const anchorKind = over.anchorKind ?? 'unit';
  const anchorId = over.anchorId ?? (anchorKind === 'unit' ? ANCHOR_UNIT : ANCHOR_TENANT);
  const requestedAt = over.requestedAt ?? T0;
  return {
    itemId: rankingJobItemId(anchorKind, anchorId),
    anchorKind,
    anchorId,
    status: 'queued',
    generation: 'gen-1',
    includeOlder: false,
    requestedBy: 'usr-1',
    requestedAt,
    requestId: PRESS_REQUEST_ID,
    traceparent: PRESS_TRACEPARENT,
    attempts: 0,
    queuedExpiresAt: new Date(Date.parse(requestedAt) + 600_000).toISOString(),
    batchesDone: [],
    failedBatches: [],
    notScored: [],
    runIds: [],
    expires_at: Math.floor(Date.parse(requestedAt) / 1000) + TTL_DAYS * 86_400,
    entityKey: RANKING_JOBS_QUEUED_ENTITY,
    sortKey: requestedAt,
    ...over,
  };
}

export function runningJob(over: Partial<RankingJobRecord> = {}): RankingJobRecord {
  const leaseExpiresAt = over.leaseExpiresAt ?? isoAt(90_000);
  return queuedJob({
    status: 'running',
    startedAt: T0,
    leaseExpiresAt,
    entityKey: RANKING_JOBS_RUNNING_ENTITY,
    sortKey: leaseExpiresAt,
    ...over,
  });
}

export function matchRow(over: Partial<MatchRow> & { tenantId: string; unitId: string }): MatchRow {
  return {
    schema: 2,
    score: 72,
    for: [],
    against: [],
    missing: [],
    failedRequirements: [],
    fairHousingFlags: [],
    stage: 1,
    rubricVersion: RUBRIC_VERSION,
    examplesVersion: EXAMPLES_VERSION,
    promptFingerprint: 'fp-test',
    model: 'fake',
    runId: 'run-old',
    jobGeneration: 'gen-0',
    computedAt: isoAt(-DAY_MS),
    anchorSide: 'unit',
    fingerprints: { tenantCard: `tc-${over.tenantId}`, unitCard: 'uc-anchor', pairHistory: `ph-${over.tenantId}` },
    inputSnapshot: '',
    expires_at: 0,
    ...over,
  };
}

/** A stored flag record (S2 builds the keys from the input the same way). */
export function flagRecord(input: UnlawfulFlagInput): UnlawfulFlagRecord {
  return {
    ...input,
    itemId: unlawfulFlagItemId(input.unitId, input.field),
    entityKey: unlawfulFlagEntityKey(input.unitId),
    sortKey: input.field,
  };
}

export function rankingRun(over: Partial<RankingRunRecord> = {}): RankingRunRecord {
  const runId = over.runId ?? 'run-1';
  return {
    itemId: rankingRunItemId(runId),
    runId,
    kind: 'ranking',
    anchorKind: 'unit',
    anchorId: ANCHOR_UNIT,
    direction: 'tenants_for_property',
    jobGeneration: 'gen-1',
    batchIndex: 0,
    candidateCount: 2,
    driver: 'fake',
    model: 'fake',
    rubricVersion: RUBRIC_VERSION,
    examplesVersion: EXAMPLES_VERSION,
    promptFingerprint: 'fp-test',
    usage: { inputTokens: 1000, outputTokens: 500 },
    costUsd: 0,
    latencyMs: 7,
    startedAt: T0,
    finishedAt: isoAt(7),
    outcome: 'scored',
    rawText: '{"candidates":[]}',
    inputGzip: gzipBase64('the user message'),
    handles: [
      { handle: 'c1', candidateId: 't-1', display: 'Tenant t-1' },
      { handle: 'c2', candidateId: 't-2', display: 'Tenant t-2' },
    ],
    results: [
      {
        handle: 'c1', candidateId: 't-1', display: 'Tenant t-1', returned: true, score: 85,
        for: [{ text: 'voucher size fits', source: 'voucher_size' }], against: [], unknowns: [], missing: [],
        failedRequirements: [], fairHousingFlags: [], cappedAtRun: { capped: false, capReason: null },
      },
      {
        handle: 'c2', candidateId: 't-2', display: 'Tenant t-2', returned: true, score: 70,
        for: [], against: [{ text: 'no pets, has a cat', source: 'pets' }], unknowns: ['move-in date'],
        missing: [{ key: 'payment_standard', text: 'Payment standard' }, { text: 'move-in date' }],
        failedRequirements: ['no_pets'], fairHousingFlags: [], cappedAtRun: { capped: true, capReason: 'requirement not met' },
      },
    ],
    matchesWritten: { count: 2, at: isoAt(8) },
    droppedUnlawfulFlags: 0,
    environment: 'local',
    expires_at: Math.floor(T0_MS / 1000) + TTL_DAYS * 86_400,
    ...over,
  };
}
