// WP1 B2a spec D5 (charter 7.4): parse the ranking call's response text.
// NEVER throws: a whole-output problem returns { ok: false } (the driver
// maps it to failure 'parse', and the batch gets no match for anyone). Per
// candidate:
// - score: a finite number, clamped to 0-100 and rounded; anything else and
//   the candidate gets no result (listed in unscoredHandles; plan C5);
// - for / against: valid reasons only (a known source and non-empty text),
//   each text trimmed and cut to 80 characters, the first three kept (C4);
// - unknowns: non-empty trimmed strings, the first five kept;
// - failedRequirements: the requirement enum only, once each; credit and
//   income keys dropped whatever arrives;
// - fairHousingFlags: kind and field in the enums; an `unlawful` flag whose
//   field is not a free-text field, or holds no text on that pair's property
//   card, is dropped AND counted (droppedUnlawfulFlags); an `accommodation`
//   flag is kept on any enum field (PR44); duplicates once.
// A handle returned twice (every copy discarded), an unknown handle and a
// candidate the model did not return all get no result: a default or
// guessed score is never written.
import { EXCLUDED_REQUIREMENT_KEYS, RANKED_REQUIREMENT_KEYS } from './cardFields.js';
import {
  RANKING_SOURCES,
  flagFieldsFor,
  unlawfulFieldsFor,
  type RankingSource,
} from './schema.js';

export const MAX_REASONS = 3;
export const MAX_REASON_CHARS = 80;
export const MAX_UNKNOWNS = 5;
/** An unknown handle is listed on the run cut to this length (it is model text). */
const MAX_LISTED_HANDLE_CHARS = 20;

export type FlagKind = 'unlawful' | 'accommodation';

export interface RankingReason {
  text: string;
  source: RankingSource;
}

export interface RankingFlag {
  kind: FlagKind;
  field: string;
}

export interface ParsedCandidate {
  score: number;
  for: RankingReason[];
  against: RankingReason[];
  unknowns: string[];
  failedRequirements: string[];
  fairHousingFlags: RankingFlag[];
}

export interface ParsedRanking {
  /** One result per scored handle, in handle (pool) order. */
  byHandle: Map<string, ParsedCandidate>;
  droppedUnlawfulFlags: number;
  // The three lists are ALWAYS set by parseRankingText; optional in the type
  // only so a stub driver's output of { byHandle, droppedUnlawfulFlags }
  // type-checks (plan C12).
  duplicateHandles?: string[];
  unknownHandles?: string[];
  unscoredHandles?: string[];
}

export interface RankingParseContext {
  /** The batch's handles, c1..cn in pool order. */
  handles: readonly string[];
  /** Per handle: the free text of that pair's property card (propertyFacts.freeTextByField). */
  freeTextByHandle: ReadonlyMap<string, Readonly<Record<string, string>>>;
  landlordCard: boolean;
}

export type RankingParseResult = { ok: true; value: ParsedRanking } | { ok: false; message: string };

const SOURCES: ReadonlySet<string> = new Set(RANKING_SOURCES);
const REQUIREMENTS: ReadonlySet<string> = new Set(RANKED_REQUIREMENT_KEYS);
const NEVER_REPORTED: ReadonlySet<string> = new Set(EXCLUDED_REQUIREMENT_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readReasons(raw: unknown): RankingReason[] {
  if (!Array.isArray(raw)) return [];
  const out: RankingReason[] = [];
  for (const item of raw as unknown[]) {
    if (out.length === MAX_REASONS) break;
    if (!isRecord(item)) continue;
    const source = item['source'];
    const textRaw = item['text'];
    if (typeof source !== 'string' || !SOURCES.has(source)) continue;
    if (typeof textRaw !== 'string') continue;
    const text = textRaw.trim().slice(0, MAX_REASON_CHARS).trim();
    if (text.length === 0) continue;
    out.push({ text, source: source as RankingSource });
  }
  return out;
}

function readUnknowns(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw as unknown[]) {
    if (out.length === MAX_UNKNOWNS) break;
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

function readFailed(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'string') continue;
    if (NEVER_REPORTED.has(item) || !REQUIREMENTS.has(item)) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function readFlags(
  raw: unknown,
  freeText: Readonly<Record<string, string>>,
  landlordCard: boolean,
): { flags: RankingFlag[]; dropped: number } {
  if (!Array.isArray(raw)) return { flags: [], dropped: 0 };
  const allowed = new Set(flagFieldsFor(landlordCard));
  const unlawfulAllowed = new Set(unlawfulFieldsFor(landlordCard));
  const flags: RankingFlag[] = [];
  let dropped = 0;
  for (const item of raw as unknown[]) {
    if (!isRecord(item)) continue;
    const kind = item['kind'];
    const field = item['field'];
    if (kind === 'unlawful') {
      const text = typeof field === 'string' && Object.prototype.hasOwnProperty.call(freeText, field) ? freeText[field] : undefined;
      if (typeof field !== 'string' || !unlawfulAllowed.has(field) || typeof text !== 'string' || text.trim().length === 0) {
        dropped += 1;
        continue;
      }
    } else if (kind === 'accommodation') {
      // PR44 (FA5 reversed): an accommodation may name ANY field of the flag
      // enum (spec D5) and is kept as returned - a modification need against
      // `accessibility` or a pets rule in `lease_terms` is a real signal. Only
      // a field of a requirement item affects the cap (cap.ts, PR40). A field
      // outside the enum is dropped.
      if (typeof field !== 'string' || !allowed.has(field)) continue;
    } else {
      continue;
    }
    if (flags.some((flag) => flag.kind === kind && flag.field === field)) continue;
    flags.push({ kind, field });
  }
  return { flags, dropped };
}

export function parseRankingText(text: string, ctx: RankingParseContext): RankingParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    // A fixed message: a SyntaxError's own message can quote the text (PII).
    return { ok: false, message: 'ranking output is not valid JSON' };
  }
  if (!isRecord(root) || !Array.isArray(root['candidates'])) {
    return { ok: false, message: 'ranking output has no candidates list' };
  }
  const known = new Set(ctx.handles);
  const entriesByHandle = new Map<string, Record<string, unknown>[]>();
  const unknownHandles: string[] = [];
  for (const item of root['candidates'] as unknown[]) {
    if (!isRecord(item)) continue;
    const id = item['candidateId'];
    if (typeof id !== 'string') continue;
    const handle = id.trim();
    if (!known.has(handle)) {
      const listed = handle.slice(0, MAX_LISTED_HANDLE_CHARS);
      if (!unknownHandles.includes(listed)) unknownHandles.push(listed);
      continue;
    }
    const list = entriesByHandle.get(handle) ?? [];
    list.push(item);
    entriesByHandle.set(handle, list);
  }
  const byHandle = new Map<string, ParsedCandidate>();
  const duplicateHandles: string[] = [];
  const unscoredHandles: string[] = [];
  let droppedUnlawfulFlags = 0;
  for (const handle of ctx.handles) {
    const list = entriesByHandle.get(handle);
    if (list === undefined) continue;
    if (list.length > 1) {
      duplicateHandles.push(handle);
      continue;
    }
    const item = list[0]!;
    const score = item['score'];
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      unscoredHandles.push(handle);
      continue;
    }
    const flags = readFlags(item['fairHousingFlags'], ctx.freeTextByHandle.get(handle) ?? {}, ctx.landlordCard);
    droppedUnlawfulFlags += flags.dropped;
    byHandle.set(handle, {
      score: Math.min(100, Math.max(0, Math.round(score))),
      for: readReasons(item['for']),
      against: readReasons(item['against']),
      unknowns: readUnknowns(item['unknowns']),
      failedRequirements: readFailed(item['failedRequirements']),
      fairHousingFlags: flags.flags,
    });
  }
  return {
    ok: true,
    value: { byHandle, droppedUnlawfulFlags, duplicateHandles, unknownHandles, unscoredHandles },
  };
}
