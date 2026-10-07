// The organization lists (housing authorities and agencies) - the PURE rules.
// Spec: docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// (D3 on the list, D4 matching, D5 write checks, D12 spellings, D13 limits).
// No I/O here: repos/orgListRepo.ts stores the list and services/orgNames.ts
// applies these rules to writes.

export type OrgKind = 'housing_authority' | 'agency';

export interface OrgEntry {
  orgId: string;
  kind: OrgKind;
  /** The stored full name. Records hold this exact text (spec D3). */
  name: string;
  /** Alternate spellings; shared only with entries of the SAME kind (D4). */
  spellings: string[];
  notes?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** The record fields that hold organization names (branch A). */
export type OrgField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'audience_filter';

export const KINDS_FOR_FIELD: Readonly<Record<OrgField, readonly OrgKind[]>> = {
  housingAuthority: ['housing_authority'],
  accepted_authorities: ['housing_authority'],
  audience_filter: ['housing_authority'],
  agency: ['agency'],
};

export const ORG_NAME_MAX = 120;
export const ORG_SPELLING_MAX = 120;
export const ORG_SPELLINGS_PER_ENTRY_MAX = 20;
export const ORG_NOTES_MAX = 500;

/**
 * The comparison form only - never stored. Lowercase; `&` to "and"; the
 * characters . , ( ) - / ' " _ to spaces; collapse whitespace; trim (D4).
 */
export function normalizeOrgText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,()\-\/'"_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * D3: a stored value is on the list for a field exactly when it is
 * character-for-character the name of an entry of an accepted kind.
 */
export function isOnListFor(
  entries: readonly OrgEntry[],
  value: string,
  kinds: readonly OrgKind[],
): boolean {
  return entries.some((e) => kinds.includes(e.kind) && e.name === value);
}

export type OrgResolution =
  | { status: 'match'; entry: OrgEntry; via: 'name' | 'spelling' }
  | { status: 'ambiguous'; candidates: OrgEntry[] }
  | { status: 'other_kind'; entries: OrgEntry[] }
  | { status: 'compound'; spans: OrgEntry[][] }
  | { status: 'unknown'; close: OrgEntry[] };

function matchesText(e: OrgEntry, normalized: string): boolean {
  return (
    normalizeOrgText(e.name) === normalized ||
    e.spellings.some((s) => normalizeOrgText(s) === normalized)
  );
}

/** D4: resolve free text against the entries of the accepted kinds. */
export function resolveOrgText(
  entries: readonly OrgEntry[],
  text: string,
  kinds: readonly OrgKind[],
): OrgResolution {
  const n = normalizeOrgText(text);
  if (n === '') return { status: 'unknown', close: [] };
  const inKind = entries.filter((e) => kinds.includes(e.kind));
  const byName = inKind.find((e) => normalizeOrgText(e.name) === n);
  if (byName) return { status: 'match', entry: byName, via: 'name' };
  const bySpelling = inKind.filter((e) => e.spellings.some((s) => normalizeOrgText(s) === n));
  if (bySpelling.length === 1) return { status: 'match', entry: bySpelling[0]!, via: 'spelling' };
  if (bySpelling.length > 1) return { status: 'ambiguous', candidates: bySpelling };
  const otherKind = entries.filter((e) => !kinds.includes(e.kind) && matchesText(e, n));
  if (otherKind.length > 0) return { status: 'other_kind', entries: otherKind };
  const spans = compoundSpans(entries, n);
  if (spans !== null) return { status: 'compound', spans };
  return { status: 'unknown', close: closeNames(inKind, n) };
}

function phraseIndex(entries: readonly OrgEntry[]): Map<string, OrgEntry[]> {
  const index = new Map<string, OrgEntry[]>();
  for (const e of entries) {
    for (const text of [e.name, ...e.spellings]) {
      const key = normalizeOrgText(text);
      if (key === '') continue;
      const list = index.get(key) ?? [];
      if (!list.includes(e)) list.push(e);
      index.set(key, list);
    }
  }
  return index;
}

/**
 * D4 COMPOUND. `normalized` (already normalized) is not itself a name or
 * spelling, and scanning it left to right - taking at each position the
 * LONGEST phrase that is a name or spelling - gives two or more
 * non-overlapping spans with no single entry matched by every span. Returns
 * each span's entries, else null.
 */
export function compoundSpans(
  entries: readonly OrgEntry[],
  normalized: string,
): OrgEntry[][] | null {
  const index = phraseIndex(entries);
  if (normalized === '' || index.has(normalized)) return null;
  const words = normalized.split(' ');
  const maxLen = Math.max(1, ...[...index.keys()].map((k) => k.split(' ').length));
  const spans: OrgEntry[][] = [];
  let i = 0;
  while (i < words.length) {
    let advanced = false;
    for (let len = Math.min(maxLen, words.length - i); len >= 1; len -= 1) {
      const hit = index.get(words.slice(i, i + len).join(' '));
      if (hit) {
        spans.push(hit);
        i += len;
        advanced = true;
        break;
      }
    }
    if (!advanced) i += 1;
  }
  if (spans.length < 2) return null;
  const common = spans.reduce<OrgEntry[]>(
    (acc, span) => acc.filter((e) => span.includes(e)),
    spans[0]!,
  );
  return common.length === 0 ? spans : null;
}

const GENERIC_WORDS = new Set([
  'of', 'the', 'and', 'housing', 'authority', 'county', 'city', 'department',
  'program', 'inc', 'georgia', 'ga',
]);

function initialsOf(name: string): string {
  return normalizeOrgText(name)
    .split(' ')
    .filter((w) => w !== 'of' && w !== 'the' && w !== 'and')
    .map((w) => w[0] ?? '')
    .join('');
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * Up to `limit` entries that look like `normalized` - for prompts ONLY, never
 * applied automatically (D4). Scores: initials equality 0.9; the share of
 * typed words (2+ chars) that begin a word of the name or a spelling, counted
 * only when a matched word is not generic; edit similarity when 0.75 or
 * more. Kept at a best score of 0.5 or more, highest first. A text longer
 * than ORG_NAME_MAX (120) characters scores nothing: no name or spelling is
 * that long (D13), and the edit distance costs |text| x |target| per text, so
 * an unbounded text must never reach it (spec section 6).
 */
export function closeNames(
  candidates: readonly OrgEntry[],
  normalized: string,
  limit = 3,
): OrgEntry[] {
  if (normalized === '' || normalized.length > ORG_NAME_MAX) return [];
  const typed = normalized.split(' ').filter((w) => w.length >= 2);
  const compact = normalized.replace(/ /g, '');
  const scored = candidates.map((e) => {
    let best = 0;
    for (const text of [e.name, ...e.spellings]) {
      const target = normalizeOrgText(text);
      const targetWords = target.split(' ');
      const matched = typed.filter((w) => targetWords.some((t) => t.startsWith(w)));
      if (typed.length > 0 && matched.some((w) => !GENERIC_WORDS.has(w))) {
        best = Math.max(best, matched.length / typed.length);
      }
      const longest = Math.max(normalized.length, target.length, 1);
      const similarity = 1 - levenshtein(normalized, target) / longest;
      if (similarity >= 0.75) best = Math.max(best, similarity);
    }
    if (compact.length >= 2 && initialsOf(e.name) === compact) best = Math.max(best, 0.9);
    return { e, best };
  });
  return scored
    .filter((s) => s.best >= 0.5)
    .sort((a, b) => b.best - a.best || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map((s) => s.e);
}

export interface OrgRef {
  orgId: string;
  kind: OrgKind;
  name: string;
}

export interface OrgNotOnList {
  error: 'org_not_on_list';
  field: OrgField;
  text: string;
  candidates: OrgRef[];
  close: OrgRef[];
  otherKind?: OrgRef[];
  compound?: OrgRef[][];
}

function ref(e: OrgEntry): OrgRef {
  return { orgId: e.orgId, kind: e.kind, name: e.name };
}

function notOnList(field: OrgField, text: string, r: OrgResolution): OrgNotOnList {
  return {
    error: 'org_not_on_list',
    field,
    text,
    candidates: r.status === 'ambiguous' ? r.candidates.map(ref) : [],
    close: r.status === 'unknown' ? r.close.map(ref) : [],
    ...(r.status === 'other_kind' && { otherKind: r.entries.map(ref) }),
    ...(r.status === 'compound' && { compound: r.spans.map((s) => s.map(ref)) }),
  };
}

export type ScalarCheck = { ok: true; value: string | null } | { ok: false; error: OrgNotOnList };

/**
 * D5 for one field. `current` is what the record holds now. Blank clears
 * (value null). An unchanged value passes even when it is not on the list.
 * An exact name is kept; a unique spelling (or the name in another case) is
 * stored as the entry's exact name; anything else is refused.
 */
export function checkScalarWrite(
  entries: readonly OrgEntry[],
  field: OrgField,
  next: string,
  current: string | undefined,
): ScalarCheck {
  const trimmed = next.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (current !== undefined && trimmed === current) return { ok: true, value: current };
  const kinds = KINDS_FOR_FIELD[field];
  if (isOnListFor(entries, trimmed, kinds)) return { ok: true, value: trimmed };
  const r = resolveOrgText(entries, trimmed, kinds);
  if (r.status === 'match') return { ok: true, value: r.entry.name };
  return { ok: false, error: notOnList(field, trimmed, r) };
}

export type ListCheck = { ok: true; value: string[] } | { ok: false; error: OrgNotOnList };

/**
 * D5 for a list field. Members are trimmed, blanks dropped, duplicates
 * dropped (first wins). A member the record already holds, or equal to
 * `legacyJurisdiction`, passes unchanged (both compared after trimming both
 * sides); every other member must resolve to an entry name. The first failing
 * member is reported. CALLERS pass `legacyJurisdiction` ONLY while the stored
 * unit has no `accepted_authorities` (planner ruling R1-F1); otherwise
 * undefined.
 */
export function checkListWrite(
  entries: readonly OrgEntry[],
  field: OrgField,
  next: readonly string[],
  current: readonly string[] | undefined,
  legacyJurisdiction: string | undefined,
): ListCheck {
  const held = new Set((current ?? []).map((c) => c.trim()));
  const legacy = legacyJurisdiction?.trim();
  const out: string[] = [];
  for (const raw of next) {
    const member = raw.trim();
    if (member === '') continue;
    let value: string;
    if (held.has(member) || (legacy !== undefined && legacy !== '' && member === legacy)) {
      value = member;
    } else {
      const check = checkScalarWrite(entries, field, member, undefined);
      if (!check.ok) return check;
      value = check.value as string;
    }
    if (!out.includes(value)) out.push(value);
  }
  return { ok: true, value: out };
}

/**
 * `org_name_invalid`: checkNewName returns it for a name that normalizes to
 * '' (for example "-" or "()", D13). The other `org_name_invalid` case - a
 * newline or other control character - is applied by services/orgNames.ts
 * BEFORE it calls checkNewName (plan 3.5).
 */
export type NameProblem =
  | { code: 'org_name_empty' }
  | { code: 'org_name_too_long' }
  | { code: 'org_name_taken'; entry: OrgEntry }
  | { code: 'org_name_compound'; spans: OrgEntry[][] }
  | { code: 'org_name_invalid' };

/**
 * D13 + D12: a new name (add, Add as new, rename). Refused when blank, over
 * 120 chars, nothing once normalized, equal (normalized) to any OTHER entry's
 * name or spelling of either kind, or compound. `excludeOrgId` is the entry
 * being renamed - its own name and spellings do not count against it.
 */
export function checkNewName(
  entries: readonly OrgEntry[],
  name: string,
  opts: { excludeOrgId?: string } = {},
): NameProblem | null {
  const trimmed = name.trim();
  if (trimmed === '') return { code: 'org_name_empty' };
  if (trimmed.length > ORG_NAME_MAX) return { code: 'org_name_too_long' };
  const n = normalizeOrgText(trimmed);
  // D13: punctuation alone - nothing a lookup or a rewrite could ever match.
  if (n === '') return { code: 'org_name_invalid' };
  const others = entries.filter((e) => e.orgId !== opts.excludeOrgId);
  const taken = others.find((e) => matchesText(e, n));
  if (taken) return { code: 'org_name_taken', entry: taken };
  const spans = compoundSpans(others, n);
  if (spans !== null) return { code: 'org_name_compound', spans };
  return null;
}

/** `invalid` (a control character, spec D13) is never returned by
 *  checkSpelling: services/orgNames.ts applies that rule first (plan 3.5). */
export type SpellingProblem =
  | { problem: 'empty' }
  | { problem: 'too_long' }
  | { problem: 'too_many' }
  | { problem: 'duplicate' }
  | { problem: 'equals_name'; entries: OrgEntry[] }
  | { problem: 'cross_kind'; entries: OrgEntry[] }
  | { problem: 'compound' }
  | { problem: 'shared_same_kind'; entries: OrgEntry[] }
  | { problem: 'invalid' };

/**
 * D12: can `spelling` be added to `target`? null = yes. `shared_same_kind`
 * is allowed only for an admin with an explicit confirm; automatic additions
 * (rename keeping the old name, Use with "Remember this spelling") treat
 * EVERY problem as a skip. Merge's transfer does not use this check (D11).
 */
export function checkSpelling(
  entries: readonly OrgEntry[],
  target: OrgEntry,
  spelling: string,
): SpellingProblem | null {
  const trimmed = spelling.trim();
  if (trimmed === '') return { problem: 'empty' };
  if (trimmed.length > ORG_SPELLING_MAX) return { problem: 'too_long' };
  const n = normalizeOrgText(trimmed);
  // D13: a spelling with no letters or digits ("-", "()") matches nothing.
  if (n === '') return { problem: 'empty' };
  if (matchesText(target, n)) return { problem: 'duplicate' };
  if (target.spellings.length >= ORG_SPELLINGS_PER_ENTRY_MAX) return { problem: 'too_many' };
  const others = entries.filter((e) => e.orgId !== target.orgId);
  const nameHits = others.filter((e) => normalizeOrgText(e.name) === n);
  if (nameHits.length > 0) return { problem: 'equals_name', entries: nameHits };
  const spellingHits = others.filter((e) => e.spellings.some((s) => normalizeOrgText(s) === n));
  const crossKind = spellingHits.filter((e) => e.kind !== target.kind);
  if (crossKind.length > 0) return { problem: 'cross_kind', entries: crossKind };
  if (compoundSpans(entries, n) !== null) return { problem: 'compound' };
  if (spellingHits.length > 0) return { problem: 'shared_same_kind', entries: spellingHits };
  return null;
}
