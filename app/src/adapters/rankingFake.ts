// WP1 B2a spec D6, plan PR8: the fake and console ranking drivers share ONE
// rules module (this file). No network. Both are REFUSED under
// NODE_ENV=production (lib/config.ts, S2): either would write made-up scores
// into a real matches store (charter 7.4).
//
// FAKE RULES (deterministic, from the cards): start at 70; minus 25 for each
// failed check the fake can read structurally - the property's rent
// (final_rent, else rent_min, else rent_max) above the tenant's maximum
// portion; a recorded No pets with non-empty tenant pets text
// (failedRequirements no_pets); a recorded no_evictions_on_program with
// non-empty tenant evictions text (failedRequirements
// no_evictions_on_program) - plus 10 when the tenant's area preference text
// appears in the property's area or address; clamped to 0-100; one reason
// per rule fired. Voucher size never fails: a pool cannot hold that pair.
//
// The two tenant matching inputs are found THROUGH THE LIST (plan WI8): the
// maximum portion is the one `kind: 'dollars'` entry, the area preference
// the one `kind: 'text'` entry marked for completeness; the card keys both
// by their label. This file spells no input key.
//
// SEAMS (dev/test only): an anchor or candidate card whose `notes` holds
// [fake:fail-batch] makes every batch holding it fail ('driver'); a
// candidate whose notes hold [fake:omit] is left out of the output; a
// property whose notes hold [fake:unlawful:<field>] gets an unlawful flag on
// <field> for every pair. The output goes through the PRODUCTION parser, so
// every parse rule (the unlawful free-text rule included) applies.
//
// The console driver (local development only) logs counts and sizes only -
// never a name, an address or Notes text, the extraction console driver's
// rule - then scores with the same rules and seams, stamping model
// 'console', so local dev without a key still ranks.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { TENANT_MATCHING_INPUTS } from '../lib/tenantMatchingInputs.js';
import type { RankingBatchInput, RankingCall, RankingCallMeta, RankingDriver } from '../services/ranking/driverTypes.js';
import { parseRankingText } from '../services/ranking/parse.js';
import type { Card } from '../services/ranking/types.js';

export const FAKE_BASE_SCORE = 70;
export const FAKE_RULE_PENALTY = 25;
export const FAKE_AREA_BONUS = 10;
export const FAKE_SEAM_FAIL_BATCH = '[fake:fail-batch]';
export const FAKE_SEAM_OMIT = '[fake:omit]';
const FAKE_SEAM_UNLAWFUL = /\[fake:unlawful:([a-z_]+(?::[a-z_]+)?)\]/g;

export interface FakeInputLabels {
  maxPortion: string;
  area: string;
}

/**
 * The card labels of the two inputs the fake reads, found through
 * TENANT_MATCHING_INPUTS. Throws when the list no longer has exactly one
 * dollars entry and one text entry marked for completeness. R2F12: called in
 * the fake and console driver CONSTRUCTORS - never at module load (the
 * production worker imports this module through adapters/ranking.ts and must
 * not crash for a driver production refuses) and never inside rankBatch
 * (which must not throw, FB27).
 */
export function fakeInputLabels(): Readonly<FakeInputLabels> {
  const dollars = TENANT_MATCHING_INPUTS.filter((entry) => entry.kind === 'dollars');
  const area = TENANT_MATCHING_INPUTS.filter((entry) => entry.kind === 'text' && entry.completeness);
  if (dollars.length !== 1 || area.length !== 1) {
    throw new Error(
      `rankingFake: expected one dollars entry and one text entry marked for completeness in TENANT_MATCHING_INPUTS, found ${dollars.length} and ${area.length}`,
    );
  }
  return Object.freeze({ maxPortion: dollars[0]!.label, area: area[0]!.label });
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function addressText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).filter((part): part is string => typeof part === 'string').join(' ');
  }
  return '';
}

function rentOf(property: Card): number | undefined {
  for (const key of ['final_rent', 'rent_min', 'rent_max']) {
    const value = property[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

interface FakeReason {
  text: string;
  source: string;
}

interface FakeEntry {
  candidateId: string;
  score: number;
  for: FakeReason[];
  against: FakeReason[];
  unknowns: string[];
  failedRequirements: string[];
  fairHousingFlags: Array<{ kind: 'unlawful'; field: string }>;
}

function fakePairEntry(handle: string, tenant: Card, property: Card, labels: Readonly<FakeInputLabels>): FakeEntry {
  let score = FAKE_BASE_SCORE;
  const forReasons: FakeReason[] = [];
  const against: FakeReason[] = [];
  const failedRequirements: string[] = [];
  const rent = rentOf(property);
  const maxPortion = tenant[labels.maxPortion];
  if (rent !== undefined && typeof maxPortion === 'number' && rent > maxPortion) {
    score -= FAKE_RULE_PENALTY;
    against.push({ text: 'rent above max portion', source: 'rent' });
  }
  if (property['no_pets'] === true && textOf(tenant['pets']).length > 0) {
    score -= FAKE_RULE_PENALTY;
    against.push({ text: 'no pets, has pets', source: 'pets' });
    failedRequirements.push('no_pets');
  }
  if (property['no_evictions_on_program'] === true && textOf(tenant['evictions']).length > 0) {
    score -= FAKE_RULE_PENALTY;
    against.push({ text: 'eviction history', source: 'evictions' });
    failedRequirements.push('no_evictions_on_program');
  }
  const area = textOf(tenant[labels.area]).toLowerCase();
  if (area.length > 0) {
    const where = `${textOf(property['area'])} ${addressText(property['address'])}`.toLowerCase();
    if (where.includes(area)) {
      score += FAKE_AREA_BONUS;
      forReasons.push({ text: 'in preferred area', source: 'area' });
    }
  }
  const fairHousingFlags = [...textOf(property['notes']).matchAll(FAKE_SEAM_UNLAWFUL)].map((match) => ({
    kind: 'unlawful' as const,
    field: match[1]!,
  }));
  return {
    candidateId: handle,
    score: Math.min(100, Math.max(0, score)),
    for: forReasons,
    against,
    unknowns: [],
    failedRequirements,
    fairHousingFlags,
  };
}

function fakeRankingText(
  input: RankingBatchInput,
  labels: Readonly<FakeInputLabels>,
): { ok: true; text: string } | { ok: false; message: string } {
  const anchor = input.wire.anchor.card;
  const failing = [anchor, ...input.wire.candidates.map((c) => c.card)].some((card) => textOf(card['notes']).includes(FAKE_SEAM_FAIL_BATCH));
  if (failing) return { ok: false, message: `fake ranking driver: ${FAKE_SEAM_FAIL_BATCH} seam` };
  const entries: FakeEntry[] = [];
  for (const candidate of input.wire.candidates) {
    if (textOf(candidate.card['notes']).includes(FAKE_SEAM_OMIT)) continue;
    const tenant = input.direction === 'tenants_for_property' ? candidate.card : anchor;
    const property = input.direction === 'tenants_for_property' ? anchor : candidate.card;
    entries.push(fakePairEntry(candidate.handle, tenant, property, labels));
  }
  return { ok: true, text: JSON.stringify({ candidates: entries }) };
}

async function rankWithFakeRules(
  input: RankingBatchInput,
  driver: 'fake' | 'console',
  now: () => number,
  labels: Readonly<FakeInputLabels>,
): Promise<RankingCall> {
  const started = now();
  const meta: RankingCallMeta = { driver, model: driver, promptFingerprint: input.promptFingerprint, latencyMs: 0 };
  const built = fakeRankingText(input, labels);
  if (!built.ok) {
    meta.latencyMs = now() - started;
    return { ok: false, meta, failure: 'driver', message: built.message };
  }
  meta.rawText = built.text;
  const parsed = parseRankingText(built.text, {
    handles: input.handles.map((h) => h.handle),
    freeTextByHandle: input.freeTextByHandle,
    landlordCard: input.landlordCard,
  });
  meta.latencyMs = now() - started;
  return parsed.ok ? { ok: true, meta, output: parsed.value } : { ok: false, meta, failure: 'parse', message: parsed.message };
}

export class FakeRankingDriver implements RankingDriver {
  readonly kind = 'fake' as const;
  private readonly now: () => number;
  private readonly labels: Readonly<FakeInputLabels>;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.labels = fakeInputLabels();
  }

  rankBatch(input: RankingBatchInput): Promise<RankingCall> {
    return rankWithFakeRules(input, 'fake', this.now, this.labels);
  }
}

export class ConsoleRankingDriver implements RankingDriver {
  readonly kind = 'console' as const;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly labels: Readonly<FakeInputLabels>;

  constructor(opts: { logger?: Logger; now?: () => number } = {}) {
    this.log = opts.logger ?? defaultLogger;
    this.now = opts.now ?? Date.now;
    this.labels = fakeInputLabels();
  }

  rankBatch(input: RankingBatchInput): Promise<RankingCall> {
    // Counts and sizes only: never a name, an address or Notes text.
    this.log.info(
      {
        batchIndex: input.batchIndex,
        candidates: input.wire.candidates.length,
        homesSeen: input.wire.homesSeen.length,
        userChars: input.user.length,
      },
      'console ranking driver: scoring with the fake rules (offline)',
    );
    return rankWithFakeRules(input, 'console', this.now, this.labels);
  }
}
