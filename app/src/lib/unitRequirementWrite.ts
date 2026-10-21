// property requirements (spec docs/superpowers/specs/2026-10-20-property-requirements-design.md
// D1, D5, D13; plan 2.4): what ONE unit create or PATCH writes for the
// requirement items, computed purely from the stored unit (a CONSISTENT read;
// none on create), the validated body and the landlord of record's contact.
// The units router (routes/units.ts) is the only caller: POST /api/units once,
// PATCH /api/units/:unitId once per fenced attempt (each attempt recomputes
// from its own read). The rules live in lib/requirements.ts; this module only
// sequences them:
//   1. deposit_conflict (D1): the stored record merged with the body holds a
//      one-month deposit and a fixed amount, whenever the body carries a
//      Deposit key;
//   2. the legacy `pets` partner (D1): a STORED boolean `pets` met by a write
//      touching some Pets keys also writes `no_pets` / `pets` in the new shape
//      with their interpreted values, so nothing else in the item changes;
//   3. the classification (D5, nextRequirementSources): after a landlord
//      change the map starts EMPTY - every item never touched against the new
//      landlord - before this write's own items are classified;
//   4. the audit field list (D13; plan review PR1-10): the unit keys whose
//      STORED value the write changes - a SET to a value different from the
//      read (or of a key the read lacked), or a REMOVE of a key the read held
//      - partner keys included, never requirement_sources. A body key re-sent
//      with its stored value is not listed. (The route uses it on the fenced
//      path only; the plain path keeps Object.keys(validation.fields).)
// The map is written WHOLE and only when it changes (an empty map REMOVEs);
// on create it rides in the Put when non-empty.
import { isDeepStrictEqual } from 'node:util';
import {
  hasDepositConflict,
  nextRequirementSources,
  parseRequirementsSnapshot,
  readRequirementSources,
  REQUIREMENT_ITEMS,
  REQUIREMENT_UNIT_KEYS,
  type RequirementItemId,
  type RequirementSources,
  type RequirementsSnapshot,
} from './requirements.js';

const REQUIREMENT_KEY_SET: ReadonlySet<string> = new Set(REQUIREMENT_UNIT_KEYS);

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function keysOfItem(id: RequirementItemId): string[] {
  return REQUIREMENT_ITEMS.find((item) => item.id === id)?.fields.map((field) => field.key) ?? [];
}

function writesItem(fields: Record<string, unknown>, id: RequirementItemId): boolean {
  return keysOfItem(id).some((key) => hasKey(fields, key));
}

/** D5: the validated body writes at least one requirement key (the PATCH read path). */
export function touchesRequirements(fields: Record<string, unknown>): boolean {
  return Object.keys(fields).some((key) => REQUIREMENT_KEY_SET.has(key));
}

/** `record` with `patch` applied the way the repos apply one: null REMOVEs, undefined is skipped. Mutates neither. */
export function applyUnitPatch(
  record: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** D1: the body carries a Deposit key and the record it leaves holds both a one-month deposit and a fixed amount. `stored` undefined = create. */
export function depositConflictAfter(
  stored: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
): boolean {
  if (!writesItem(fields, 'deposit')) return false;
  return hasDepositConflict(applyUnitPatch(stored ?? {}, fields), 'unit');
}

/**
 * D5 / plan 2.4: take `requirements_snapshot` OFF a create body before the
 * field allowlist sees it (it is never stored) and parse it. A body without
 * the key, or one that is not an object, passes through untouched (the
 * validator answers the latter).
 */
export function splitRequirementsSnapshot(
  body: unknown,
): { ok: true; body: unknown; snapshot?: RequirementsSnapshot } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: true, body };
  if (!hasKey(body as Record<string, unknown>, 'requirements_snapshot')) return { ok: true, body };
  const { requirements_snapshot: raw, ...rest } = body as Record<string, unknown>;
  const parsed = parseRequirementsSnapshot(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, body: rest, snapshot: parsed.snapshot };
}

/**
 * D1: the partner keys a write must add when the STORED `pets` is a legacy
 * boolean and the body touches the Pets item - `false` reads as No pets
 * checked with blank details, `true` as No pets unchecked with details
 * "Allowed". Only keys the body leaves out, and only those whose stored value
 * this changes.
 */
function legacyPetsPartner(
  stored: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const storedPets = stored['pets'];
  if (typeof storedPets !== 'boolean' || !writesItem(fields, 'pets')) return {};
  const partner: Record<string, unknown> = {};
  if (!hasKey(fields, 'no_pets')) {
    if (storedPets === false && stored['no_pets'] !== true) partner['no_pets'] = true;
    if (storedPets === true && hasKey(stored, 'no_pets')) partner['no_pets'] = null;
  }
  if (!hasKey(fields, 'pets')) partner['pets'] = storedPets ? 'Allowed' : null;
  return partner;
}

function sameSources(a: RequirementSources, b: RequirementSources): boolean {
  const ids = Object.keys(a) as RequirementItemId[];
  return ids.length === Object.keys(b).length && ids.every((id) => a[id] === b[id]);
}

/**
 * D13 (plan review PR1-10): the keys of `patch` whose STORED value the write
 * changes - a SET to a value different from `before` (or of a key `before`
 * lacks), or a REMOVE (null) of a key `before` holds. Patch order;
 * requirement_sources never listed.
 */
export function changedKeys(before: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  return Object.entries(patch)
    .filter(([key, value]) => {
      if (key === 'requirement_sources' || value === undefined) return false;
      if (value === null) return hasKey(before, key);
      return !hasKey(before, key) || !isDeepStrictEqual(before[key], value);
    })
    .map(([key]) => key);
}

export interface RequirementWriteInput {
  /** The consistent read of the stored unit (the caller's copy); undefined on create. */
  stored: Record<string, unknown> | undefined;
  /** validateUnitBody's fields (null = REMOVE). */
  fields: Record<string, unknown>;
  /** The landlord of record's contact AFTER this write (the new one on a change); undefined = none. */
  landlord: Record<string, unknown> | undefined;
  /** PATCH only: this write changes the landlord of record, so the map is reset first (D5). */
  landlordChanged: boolean;
  /** D5: the New form's snapshot (create only). */
  snapshot?: RequirementsSnapshot;
}

export type RequirementWritePlan =
  | {
      ok: true;
      /** What the repo writes: the body, the partner keys, and requirement_sources (map, or null = REMOVE) when it changes. */
      patch: Record<string, unknown>;
      /** D13 (PR1-10): the unit keys whose stored value this write changes (changedKeys), body order then partner order; never requirement_sources. */
      auditFields: string[];
      /** The whole map after this write (what the property will hold). */
      sources: RequirementSources;
    }
  | { ok: false; error: 'deposit_conflict' };

export function planRequirementWrite(input: RequirementWriteInput): RequirementWritePlan {
  const before = input.stored ?? {};
  if (depositConflictAfter(input.stored, input.fields)) return { ok: false, error: 'deposit_conflict' };
  const patch: Record<string, unknown> = { ...input.fields, ...legacyPetsPartner(before, input.fields) };
  const auditFields = changedKeys(before, patch);
  const after = applyUnitPatch(before, patch);
  const held = readRequirementSources(before['requirement_sources']);
  const sources = nextRequirementSources({
    before,
    after,
    current: input.landlordChanged ? {} : held,
    landlord: input.landlord,
    ...(input.snapshot !== undefined && { snapshot: input.snapshot }),
  });
  const nonEmpty = Object.keys(sources).length > 0;
  if (input.stored === undefined) {
    if (nonEmpty) patch['requirement_sources'] = sources;
  } else if (input.landlordChanged) {
    if (nonEmpty || hasKey(before, 'requirement_sources')) {
      patch['requirement_sources'] = nonEmpty ? sources : null;
    }
  } else if (!sameSources(sources, held)) {
    patch['requirement_sources'] = nonEmpty ? sources : null;
  }
  return { ok: true, patch, auditFields, sources };
}
