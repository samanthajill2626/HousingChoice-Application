// WP1 B2a spec D4 "The call" and D8.1: the text of one ranking call.
//
// - system = RUBRIC_TEXT, then the worked examples, byte-stable for a given
//   pair of versions (RUBRIC_VERSION, EXAMPLES_VERSION). Each example is
//   rendered with renderUserContent - the renderer the real user content
//   uses - so the examples look exactly like a real call.
// - user = a direction line, one instruction line, "INPUT:", then one JSON
//   object: { anchor: { card, missing }, homesSeen, candidates }.
//   * candidates carry handles c1..cn in pool order; record ids never reach
//     the text (handles map back through RankingBatchInput.handles).
//   * each candidate carries ONE authority fact, "matched" or "unconfirmed"
//     (charter section 20 item 18): the authority names are off both cards.
//   * homesSeen holds every distinct home any tenant card in the call lists
//     under propertiesSeen, written ONCE as { handle, label, card } with
//     handles h1..hn in first-reference order; each propertiesSeen entry's
//     `home` (the unitId S3 puts there) is replaced by its reference
//     (PR20): "anchor" for the property ANCHOR itself (its card is the
//     anchor card, written once), the c handle for a seen home that is a
//     candidate in the same call (a tenant anchor), and the h handle in
//     homesSeen for any other home.
// - promptFingerprint (PR18) = sha256 over the system text, a newline, and
//   the stable JSON of the schema sent on the call (keys sorted), so a
//   schema change - and each landlord-switch state - has its own
//   fingerprint. Recorded on every run.
import { createHash } from 'node:crypto';
import { PROPERTIES_SEEN_KEY } from './cards.js';
import { RANKING_EXAMPLES, type RankingExample } from './examples.js';
import { RUBRIC_TEXT } from './rubric.js';
import { rankingSchema } from './schema.js';
import type { AuthorityFact, Card, Direction, MissingFlag, PairHistory } from './types.js';

/** The entry key naming a seen home on S3's tenant card (PropertiesSeenEntry.home, PR20). */
export const SEEN_HOME_KEY = 'home';
/** PR20: how a seen home that IS the property anchor is referenced in the call. */
export const ANCHOR_HOME_HANDLE = 'anchor';

export interface WireHome {
  handle: string;
  label: string;
  card: Card;
}

export interface WireCandidate {
  handle: string;
  card: Card;
  missing: string[];
  /** Charter section 20 item 18: the pair's authority fact (pool.ts pairAuthorityFact). */
  authority: AuthorityFact;
  pairHistory: PairHistory;
}

export interface RankingWire {
  anchor: { card: Card; missing: string[] };
  homesSeen: WireHome[];
  candidates: WireCandidate[];
}

/** What S3's propertyFacts gives for the pair's property. */
export interface PropertyFactsLike {
  recordedRequirementKeys: readonly string[];
  freeTextByField: Readonly<Record<string, string>>;
}

export interface RankingBatchCandidateSource {
  candidateId: string;
  /** The pair's property: the anchor unit for a property anchor, the candidate unit for a tenant anchor. */
  unitId: string;
  card: Card;
  missing: readonly MissingFlag[];
  /** Charter section 20 item 18: the pair's authority fact (pool.ts pairAuthorityFact). */
  authority: AuthorityFact;
  pairHistory: PairHistory;
  propertyFacts: PropertyFactsLike;
}

export interface RankingBatchSource {
  direction: Direction;
  batchIndex: number;
  landlordCard: boolean;
  anchor: { card: Card; missing: readonly MissingFlag[] };
  candidates: readonly RankingBatchCandidateSource[];
  /** Every home any tenant card in the batch references (S3's assemble), keyed by unitId. */
  homes: ReadonlyMap<string, { label: string; card: Card }>;
}

export interface RankingHandle {
  handle: string;
  candidateId: string;
  unitId: string;
}

export interface RankingBatchInput {
  direction: Direction;
  batchIndex: number;
  landlordCard: boolean;
  system: string;
  user: string;
  promptFingerprint: string;
  wire: RankingWire;
  handles: readonly RankingHandle[];
  /** Per handle: the free text of that pair's property card (the unlawful-flag rule). */
  freeTextByHandle: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** Per home reference a seen entry uses (h, c or "anchor"): its label. */
  homeLabelByHandle: ReadonlyMap<string, string>;
}

/** Spec D8.1: the exact JSON one pair was scored from (S5 gzips it onto the match). */
export interface RankingPairSnapshot {
  direction: Direction;
  anchor: { card: Card; missing: string[] };
  candidate: WireCandidate;
  homes: WireHome[];
}

/** A batch that cannot be written (a seen home the batch does not carry). S5 records it as a failed batch. */
export class RankingPromptError extends Error {}

/**
 * Every framing string of the call, in ONE frozen object (R2F3): the user
 * message's direction and instruction lines and the system text's examples
 * framing. S4.11 pins sha256 of JSON.stringify(PROMPT_FRAMING) beside
 * RUBRIC_VERSION, so an edit to any of them is a version decision.
 */
export const PROMPT_FRAMING = Object.freeze({
  directionLines: Object.freeze({
    tenants_for_property: 'DIRECTION: tenants_for_property - the anchor is a property; every candidate is a tenant.',
    properties_for_tenant: 'DIRECTION: properties_for_tenant - the anchor is a tenant; every candidate is a property.',
  } satisfies Record<Direction, string>),
  instructionLine: 'Score every candidate. Return exactly one entry per candidate handle, with the handle as candidateId.',
  inputLine: 'INPUT:',
  examplesHeading: 'WORKED EXAMPLES (synthetic people and homes; each shows an input and a good output)',
  examplePrefix: 'EXAMPLE',
  outputLine: 'OUTPUT:',
});

export function renderUserContent(direction: Direction, wire: RankingWire): string {
  return [PROMPT_FRAMING.directionLines[direction], PROMPT_FRAMING.instructionLine, PROMPT_FRAMING.inputLine, JSON.stringify(wire)].join('\n');
}

function renderExample(example: RankingExample, n: number): string {
  const wire: RankingWire = { anchor: example.anchor, homesSeen: example.homesSeen, candidates: example.candidates };
  return [
    `${PROMPT_FRAMING.examplePrefix} ${n}: ${example.title}`,
    renderUserContent(example.direction, wire),
    PROMPT_FRAMING.outputLine,
    JSON.stringify(example.output),
  ].join('\n');
}

/** The worked examples exactly as the system text carries them (R2F3: S4.11 pins this beside EXAMPLES_VERSION). */
export function renderExamplesText(): string {
  return RANKING_EXAMPLES.map((example, i) => renderExample(example, i + 1)).join('\n\n');
}

let systemCache: string | undefined;
export function buildRankingSystemPrompt(): string {
  systemCache ??= [RUBRIC_TEXT, '', PROMPT_FRAMING.examplesHeading, '', renderExamplesText()].join('\n');
  return systemCache;
}

/** JSON with every object's keys sorted, so the same value always gives the same bytes (PR18). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const fingerprintCache = new Map<boolean, string>();
/** PR18: sha256 over the system text, a newline, and the stable JSON of the schema this call sends. */
export function rankingPromptFingerprint(opts: { landlordCard: boolean }): string {
  let fingerprint = fingerprintCache.get(opts.landlordCard);
  if (fingerprint === undefined) {
    fingerprint = createHash('sha256')
      .update(buildRankingSystemPrompt(), 'utf8')
      .update('\n', 'utf8')
      .update(stableJson(rankingSchema({ landlordCard: opts.landlordCard })), 'utf8')
      .digest('hex');
    fingerprintCache.set(opts.landlordCard, fingerprint);
  }
  return fingerprint;
}

function isEntry(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A copy of the card with each propertiesSeen entry's `home` replaced by its handle (key order kept). */
function rewriteSeen(card: Card, handleFor: (unitId: string) => string): Card {
  const seen = card[PROPERTIES_SEEN_KEY];
  if (!Array.isArray(seen)) return card;
  const entries = (seen as unknown[]).map((entry) => {
    if (!isEntry(entry)) return entry;
    const ref = entry[SEEN_HOME_KEY];
    return typeof ref === 'string' ? { ...entry, [SEEN_HOME_KEY]: handleFor(ref) } : entry;
  });
  return { ...card, [PROPERTIES_SEEN_KEY]: entries };
}

export function buildRankingBatch(src: RankingBatchSource): RankingBatchInput {
  const handles: RankingHandle[] = src.candidates.map((c, i) => ({ handle: `c${i + 1}`, candidateId: c.candidateId, unitId: c.unitId }));
  // Only a tenant anchor has property candidates a seen entry can name.
  const candidateHandleByUnit = new Map<string, string>();
  if (src.direction === 'properties_for_tenant') {
    for (const h of handles) candidateHandleByUnit.set(h.unitId, h.handle);
  }
  // PR20: for a property anchor every candidate's unitId IS the anchor unit
  // (the pair's property), so a seen entry naming it is the anchor itself.
  const anchorUnitId = src.direction === 'tenants_for_property' ? src.candidates[0]?.unitId : undefined;
  const homesSeen: WireHome[] = [];
  const homeHandleByUnit = new Map<string, string>();
  const homeLabelByHandle = new Map<string, string>();
  const handleFor = (unitId: string): string => {
    if (anchorUnitId !== undefined && unitId === anchorUnitId) {
      const label = src.homes.get(unitId)?.label;
      if (label !== undefined) homeLabelByHandle.set(ANCHOR_HOME_HANDLE, label);
      return ANCHOR_HOME_HANDLE;
    }
    const asCandidate = candidateHandleByUnit.get(unitId);
    if (asCandidate !== undefined) {
      const label = src.homes.get(unitId)?.label;
      if (label !== undefined) homeLabelByHandle.set(asCandidate, label);
      return asCandidate;
    }
    const known = homeHandleByUnit.get(unitId);
    if (known !== undefined) return known;
    const home = src.homes.get(unitId);
    if (home === undefined) {
      throw new RankingPromptError('ranking prompt: a properties-seen entry names a home the batch does not carry');
    }
    const handle = `h${homesSeen.length + 1}`;
    homeHandleByUnit.set(unitId, handle);
    homeLabelByHandle.set(handle, home.label);
    homesSeen.push({ handle, label: home.label, card: home.card });
    return handle;
  };
  const anchorCard = rewriteSeen(src.anchor.card, handleFor);
  const candidates: WireCandidate[] = src.candidates.map((c, i) => ({
    handle: handles[i]!.handle,
    card: rewriteSeen(c.card, handleFor),
    missing: c.missing.map((flag) => flag.label),
    authority: c.authority,
    pairHistory: c.pairHistory,
  }));
  const wire: RankingWire = {
    anchor: { card: anchorCard, missing: src.anchor.missing.map((flag) => flag.label) },
    homesSeen,
    candidates,
  };
  const freeTextByHandle = new Map<string, Readonly<Record<string, string>>>(
    src.candidates.map((c, i) => [handles[i]!.handle, c.propertyFacts.freeTextByField] as const),
  );
  return {
    direction: src.direction,
    batchIndex: src.batchIndex,
    landlordCard: src.landlordCard,
    system: buildRankingSystemPrompt(),
    user: renderUserContent(src.direction, wire),
    promptFingerprint: rankingPromptFingerprint({ landlordCard: src.landlordCard }),
    wire,
    handles,
    freeTextByHandle,
    homeLabelByHandle,
  };
}

function homeRefs(card: Card): string[] {
  const seen = card[PROPERTIES_SEEN_KEY];
  if (!Array.isArray(seen)) return [];
  const out: string[] = [];
  for (const entry of seen as unknown[]) {
    if (!isEntry(entry)) continue;
    const ref = entry[SEEN_HOME_KEY];
    if (typeof ref === 'string' && !out.includes(ref)) out.push(ref);
  }
  return out;
}

export function snapshotOf(batch: RankingBatchInput, handle: string): RankingPairSnapshot | undefined {
  const candidate = batch.wire.candidates.find((c) => c.handle === handle);
  if (candidate === undefined) return undefined;
  const refs: string[] = [];
  for (const ref of [...homeRefs(batch.wire.anchor.card), ...homeRefs(candidate.card)]) {
    if (!refs.includes(ref)) refs.push(ref);
  }
  const homes: WireHome[] = [];
  for (const ref of refs) {
    if (ref === ANCHOR_HOME_HANDLE) {
      homes.push({ handle: ref, label: batch.homeLabelByHandle.get(ref) ?? '', card: batch.wire.anchor.card });
      continue;
    }
    const seen = batch.wire.homesSeen.find((h) => h.handle === ref);
    if (seen !== undefined) {
      homes.push(seen);
      continue;
    }
    const asCandidate = batch.wire.candidates.find((c) => c.handle === ref);
    if (asCandidate !== undefined) {
      homes.push({ handle: ref, label: batch.homeLabelByHandle.get(ref) ?? '', card: asCandidate.card });
    }
  }
  return { direction: batch.direction, anchor: batch.wire.anchor, candidate, homes };
}

// ---------------------------------------------------------------------------
// The job-facing wrapper (plan C12): the names S5 codes against.
// ---------------------------------------------------------------------------

export interface RankingPromptHandle {
  handle: string;
  candidateId: string;
  display: string;
}

export interface RankingPrompt {
  /** What driver.rankBatch takes. */
  batchInput: RankingBatchInput;
  /** The user message as sent (S5 gzips it onto the run, spec D11). */
  userText: string;
  promptFingerprint: string;
  /** c1..cn in batch (= pool) order, with the display each candidate was sent under. */
  handles: RankingPromptHandle[];
  /** Spec D8.1 for one candidate; throws RankingPromptError for an id not in the batch. */
  snapshotOf(candidateId: string): RankingPairSnapshot;
}

export interface RankingPromptInput {
  direction: Direction;
  batchIndex: number;
  landlordCard: boolean;
  anchor: { card: Card; missing: readonly MissingFlag[] };
  candidates: ReadonlyArray<RankingBatchCandidateSource & { display: string }>;
  homes: ReadonlyMap<string, { label: string; card: Card }>;
}

export function buildRankingPrompt(input: RankingPromptInput): RankingPrompt {
  const batchInput = buildRankingBatch(input);
  const handles: RankingPromptHandle[] = batchInput.handles.map((h, i) => ({
    handle: h.handle,
    candidateId: h.candidateId,
    display: input.candidates[i]!.display,
  }));
  return {
    batchInput,
    userText: batchInput.user,
    promptFingerprint: batchInput.promptFingerprint,
    handles,
    snapshotOf(candidateId: string): RankingPairSnapshot {
      const handle = handles.find((h) => h.candidateId === candidateId)?.handle;
      const snapshot = handle === undefined ? undefined : snapshotOf(batchInput, handle);
      if (snapshot === undefined) throw new RankingPromptError('ranking prompt: no candidate with that id in this batch');
      return snapshot;
    },
  };
}
