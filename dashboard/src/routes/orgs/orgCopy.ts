// orgCopy - the organization lists' shared client vocabulary (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D3-D13): kind nouns and field labels, the client mirror of the server's
// comparison normalization, the rewrite-status helpers, and staff copy for
// every /api/organizations answer and every D5 refusal.
//
// `ApiError.message` is the RAW machine code and is never rendered. Every
// failure goes through orgErrorCopy(); an unknown code falls back to the
// generic retry sentence, so a newer server can never put a snake_case token in
// front of staff (the suggestionResolutionErrorMessage rule).
import {
  ApiError,
  type HolderRecord,
  type NotOnListResolution,
  type OrgCheckResult,
  type OrgEntry,
  type OrgKind,
  type OrgNotOnListBody,
  type OrgRecordField,
  type OrgRef,
  type OrgRewriteState,
  type OrgUsageCounts,
} from '../../api/index.js';
import { CONTACT_TYPE_LABEL } from '../contact/contactProfile.js';

/** The kinds each field offers (plan 3.2 KINDS_FOR_FIELD, branch A). */
export const HOUSING_AUTHORITY_KINDS: readonly OrgKind[] = ['housing_authority'];
export const AGENCY_KINDS: readonly OrgKind[] = ['agency'];

/** Lowercase noun per kind. */
export const KIND_NOUN: Readonly<Record<OrgKind, string>> = {
  housing_authority: 'housing authority',
  agency: 'agency',
};

/** Plural title per kind - the Settings section headings. */
export const KIND_PLURAL_TITLE: Readonly<Record<OrgKind, string>> = {
  housing_authority: 'Housing authorities',
  agency: 'Agencies',
};

/** The tenant-form field each kind is entered under. */
export const KIND_FIELD_LABEL: Readonly<Record<OrgKind, string>> = {
  housing_authority: 'Housing authority',
  agency: 'Agency',
};

/** Staff label per record field. */
export const FIELD_LABEL: Readonly<Record<OrgRecordField, string>> = {
  housingAuthority: 'Housing authority',
  agency: 'Agency',
  accepted_authorities: 'Property housing authorities',
};

/** "a housing authority" / "an agency". */
export function withArticle(kind: OrgKind): string {
  return kind === 'agency' ? 'an agency' : 'a housing authority';
}

export function otherKindOf(kind: OrgKind): OrgKind {
  return kind === 'agency' ? 'housing_authority' : 'agency';
}

/** The kind a record field accepts. */
export function kindForField(field: OrgRecordField): OrgKind {
  return field === 'agency' ? 'agency' : 'housing_authority';
}

/**
 * HAND MIRROR of app/src/lib/orgNames.ts `normalizeOrgText` (spec D4). First
 * the typographic forms (review LOW-1: an iPhone's smart punctuation, a pasted
 * name): remove the invisible format characters - the soft hyphen, the
 * zero-width and direction marks, the bidi embeddings and isolates, the word
 * joiner and invisible operators, the BOM; fold the curly single quotes and
 * the prime to ', the curly double quotes and the double prime to ", the
 * Unicode hyphens and dashes and the minus sign to -. Then lowercase; `&` to
 * "and"; the characters . , ( ) - / ' " _ to spaces; collapse whitespace;
 * trim. The pickers use it to MATCH; the server decides what is stored. Keep
 * the two (and both test suites) in step.
 */
export function normalizeOrgText(raw: string): string {
  return raw
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,()\-\/'"_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Spec D3: on the list = exactly the name of an entry of an accepted kind. */
export function isOnList(
  entries: readonly { kind: OrgKind; name: string }[],
  value: string,
  kinds: readonly OrgKind[],
): boolean {
  return entries.some((e) => kinds.includes(e.kind) && e.name === value);
}

/** The inline message when a picker's list failed to load (R2 ruling 6). */
export function orgListLoadError(kinds: readonly OrgKind[]): string {
  return kinds.includes('housing_authority') ? "Couldn't load housing authorities" : "Couldn't load agencies";
}

// --- Text typed in a picker but never picked (code review R1-ADV-FE-1) -------
// The note under a picker left holding such text tells the truth for its host
// (code review R2-FE-6): a form says what its Save will do with the text (the
// same verdict Save acts on - useTypedOrgText), the blast composer that typed
// text is never a filter, and a host that never uses typed text the default.

/** Under a picker whose host never uses typed text (the Settle dialogs). */
export const ORG_TYPED_NOT_SAVED = 'Not saved - pick a name from the list, or clear the text.';

/** Under a FORM picker holding text its Save would refuse. */
export const ORG_TYPED_NOT_SAVED_FORM = 'Not saved - pick a name from the list, add it as new, or clear the text.';

/** Under a FORM picker holding text its Save will commit as that entry's name. */
export function orgTypedWillUse(name: string): string {
  return `Save will use ${name}.`;
}

/** Under the blast composer's picker: only a pick sets the filter (spec D7). */
export const ORG_TYPED_NOT_A_FILTER = 'Not used as a filter - pick a name from the list, or clear the text.';

/** Beside the composer's disabled "Preview recipients" while its housing
 *  authority filter holds typed text (code review R2-FE-3). */
export const ORG_FILTER_TYPED_HINT = 'Pick the housing authority from the list, or clear the text.';

/** Under a form picker whose typed text stopped a Save (role="alert"). */
export const ORG_TYPED_BLOCKED = 'Pick a name from the list, add it as new, or clear the text.';

/** Under a form picker whose Save came before its list loaded (role="alert", code review R2-FE-1). */
export const ORG_LIST_STILL_LOADING = 'Still loading the list - try again in a moment.';

/** Under a FORM picker holding text while no list has loaded: nothing can
 *  settle it, so Save refuses it until it is cleared (code review R3-FE-3). */
export const ORG_TYPED_LIST_FAILED = 'Not saved - the list did not load.';

/** Under a form picker whose Save came while no list had loaded (role="alert",
 *  code review R3-FE-3): never saved without the text, never dropped silently. */
export const ORG_TYPED_LIST_NOT_LOADED = 'The list did not load - clear the text to save without it.';

/** A picker's list as a form holds it (useOrgList's state). */
export interface OrgListView {
  entries: readonly OrgEntry[];
  /** True until the first read settles. */
  loading: boolean;
  /** True when the latest read failed - with no list in hand the pickers
   *  are disabled, except one holding typed text (code review R3-FE-3,
   *  R4-3). */
  error: boolean;
}

/**
 * Nothing is known about a picker's list: its first read is still in flight,
 * or a read failed with nothing in hand (no read ever landed). A failed
 * RE-read keeps the last list in hand (useOrgList), so that list is known.
 * Every host passes this as its OrgPicker's `loading`: while the list is
 * unknown the picker marks no stored value "Not on the list" - it cannot
 * know (code review R3-FE-5) - and offers no add step.
 */
export function orgListUnknown(list: OrgListView): boolean {
  return list.loading || (list.error && list.entries.length === 0);
}

/** What a form's Save does with one picker's typed text. */
export type TypedOrgText =
  | { status: 'empty' }
  | { status: 'resolved'; name: string }
  | { status: 'blocked' }
  /** The list has not loaded yet: nothing can be settled (Save refuses, R2-FE-1). */
  | { status: 'loading' }
  /** The list failed to load with nothing in hand (no read ever landed):
   *  nothing can be settled, so Save refuses until the text is cleared - the
   *  picker stays usable while it holds text (code review R3-FE-3). */
  | { status: 'unavailable' };

/**
 * A form never drops text typed in a picker but never picked (R1-ADV-FE-1). On
 * Save, text that normalizes equal to exactly one entry NAME of `kinds` - or,
 * failing that, to a spelling exactly one such entry carries - is committed as
 * that entry's exact name, as a pick would be ('resolved'). Anything else - a
 * spelling two entries share ("AHA"), part of a name, the other kind's name,
 * unknown text - stops the save ('blocked'). Never fuzzy: close names belong
 * to "Is this really new?". Blank text is nothing typed ('empty'). THE one
 * rule: a form's Save and the note under its picker both read it, through
 * useTypedOrgText (code review R2-FE-6). The blast composer never uses this:
 * only a pick or a clear changes its filter (D7).
 * Typed text is never dropped silently, and a Save never waits on a picker
 * staff cannot use (code review R2-FE-1, R3-FE-3). Before the first read
 * lands nothing can be settled yet ('loading' - refused, with its own words,
 * never as unknown text). A RE-read that fails keeps the last list in hand
 * (useOrgList), and the text settles against it as usual. A read that fails
 * with nothing in hand leaves nothing to settle against ('unavailable' -
 * refused until the text is cleared); the picker stays usable while it holds
 * text (useTypedOrgText `disabled`), so the refusal never locks the form.
 */
export function settleTypedOrgText(list: OrgListView, kinds: readonly OrgKind[], text: string): TypedOrgText {
  if (text.trim() === '') return { status: 'empty' };
  if (list.loading) return { status: 'loading' };
  if (orgListUnknown(list)) return { status: 'unavailable' };
  const q = normalizeOrgText(text);
  const ofKinds = list.entries.filter((e) => kinds.includes(e.kind));
  const byName = ofKinds.filter((e) => normalizeOrgText(e.name) === q);
  const matches =
    byName.length > 0 ? byName : ofKinds.filter((e) => e.spellings.some((s) => normalizeOrgText(s) === q));
  const [only] = matches;
  return matches.length === 1 && only !== undefined ? { status: 'resolved', name: only.name } : { status: 'blocked' };
}

/** Why Save refuses the text this verdict is about (the picker's role="alert"), or null. */
export function typedOrgRefusal(verdict: TypedOrgText): string | null {
  switch (verdict.status) {
    case 'blocked':
      return ORG_TYPED_BLOCKED;
    case 'loading':
      return ORG_LIST_STILL_LOADING;
    case 'unavailable':
      return ORG_TYPED_LIST_NOT_LOADED;
    default:
      return null;
  }
}

/** Save refuses the text this verdict is about. */
export function refusesSave(verdict: TypedOrgText): boolean {
  return typedOrgRefusal(verdict) !== null;
}

/**
 * The note under a FORM picker left holding typed text: what its Save will
 * do with that text, from the verdict Save itself acts on (code review
 * R2-FE-6) - so the note never says "Not saved" for text Save then commits.
 * null: nothing to say (no text; or the list is still loading, so nothing is
 * known about the text yet).
 */
export function typedOrgNote(verdict: TypedOrgText): string | null {
  switch (verdict.status) {
    case 'resolved':
      return orgTypedWillUse(verdict.name);
    case 'blocked':
      return ORG_TYPED_NOT_SAVED_FORM;
    case 'unavailable':
      return ORG_TYPED_LIST_FAILED;
    default:
      return null;
  }
}

function names(refs: readonly { name: string }[]): string {
  return refs.map((r) => r.name).join(', ');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// --- Refusals ----------------------------------------------------------------

/** The sentence for an unknown or missing code. */
export const ORG_GENERIC_ERROR = 'Something went wrong - please try again.';

const ORG_ERROR_COPY: Readonly<Record<string, string>> = {
  org_not_on_list: 'That name is not on the list - pick one from the list or add it.',
  org_name_empty: 'Type a name first.',
  org_name_too_long: 'Names can be at most 120 characters.',
  // One code also covers a name holding an invisible format character (a soft hyphen, a
  // zero-width space, a bidi mark), so the sentence has to name those or a pasted name
  // reads as unexplainable. Keep it equal to nameProblemCopy's org_name_invalid.
  org_name_invalid:
    'A name needs at least one letter or digit, and no line breaks, control characters or invisible characters (a pasted name can carry one - retype it).',
  org_notes_too_long: 'Notes can be at most 500 characters.',
  org_name_taken: 'That name is already on the list.',
  org_name_compound: 'That names more than one organization, so it cannot be one entry. Use Split instead.',
  org_spelling_refused: 'That spelling cannot be added.',
  org_spelling_shared: 'That spelling already belongs to another entry.',
  org_spellings_full: 'An entry can have at most 20 spellings.',
  org_in_use: 'Records still hold this name, so it cannot be changed this way.',
  org_not_found: 'That entry is no longer on the list - reload to see the current list.',
  org_rewrite_running: 'Another update is still running - try again when it finishes.',
  org_rewrite_not_rerunnable: 'There is no failed or stalled update to run again.',
  // One code for both Run again refusals (build ruling B-2): the target name
  // left the list or changed kind, or a from-text has since become a listed name.
  org_rewrite_target_gone:
    'The list changed since this update started, so it cannot run again - start a new one from the list.',
  org_value_is_name_variant: 'That value is a listed name written differently - settle it with Use and that name.',
  org_list_full: 'The list is full - delete unused entries before adding more.',
  org_list_busy: 'The list is busy right now - try again in a moment.',
  one_change_per_request: 'Make one change at a time.',
};

/** Staff copy for a code alone (no body). */
export function orgErrorMessage(code: string): string {
  return ORG_ERROR_COPY[code] ?? ORG_GENERIC_ERROR;
}

function refsOf(value: unknown): OrgRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is OrgRef =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as Record<string, unknown>)['orgId'] === 'string' &&
      typeof (v as Record<string, unknown>)['name'] === 'string',
  );
}

function bodyOf(err: ApiError): Record<string, unknown> {
  return typeof err.body === 'object' && err.body !== null ? (err.body as Record<string, unknown>) : {};
}

/** The 422 every D5 writer answers with, narrowed; null for anything else. */
export function orgNotOnListBody(err: unknown): OrgNotOnListBody | null {
  if (!(err instanceof ApiError) || err.status !== 422 || err.code !== 'org_not_on_list') return null;
  const b = bodyOf(err);
  const text = b['text'];
  const field = b['field'];
  if (typeof text !== 'string' || typeof field !== 'string') return null;
  return {
    error: 'org_not_on_list',
    field: field as OrgNotOnListBody['field'],
    text,
    candidates: refsOf(b['candidates']),
    close: refsOf(b['close']),
    ...(Array.isArray(b['otherKind']) && { otherKind: refsOf(b['otherKind']) }),
    ...(Array.isArray(b['compound']) && { compound: (b['compound'] as unknown[]).map(refsOf) }),
  };
}

/** A form's sentence for a refused value - never the raw code. */
export function notOnListMessage(body: OrgNotOnListBody): string {
  const kind: OrgKind = body.field === 'agency' ? 'agency' : 'housing_authority';
  if (body.candidates.length > 0) {
    return `${body.text} is a spelling of more than one ${KIND_NOUN[kind]} (${names(body.candidates)}) - pick one.`;
  }
  if (body.otherKind !== undefined && body.otherKind.length > 0) {
    return `${body.text} is ${withArticle(otherKindOf(kind))}, not ${withArticle(kind)}.`;
  }
  if (body.compound !== undefined && body.compound.length > 0) {
    return `${body.text} names more than one organization - pick each one in its own field.`;
  }
  if (body.close.length > 0) return `${body.text} is not on the list. Did you mean ${names(body.close)}?`;
  return `${body.text} is not on the list - pick a name from the list or add it.`;
}

/** "<spelling> is now shared with <names> - ..." (spec D12's confirm wording). */
export function sharedSpellingCopy(spelling: string, entries: readonly OrgRef[]): string {
  return `${spelling} is now shared with ${names(entries)} - it will no longer be applied automatically.`;
}

/** Staff copy for any /api/organizations failure, using the body when it helps. */
export function orgErrorCopy(err: unknown): string {
  if (!(err instanceof ApiError)) return ORG_GENERIC_ERROR;
  const b = bodyOf(err);
  switch (err.code) {
    case 'org_not_on_list': {
      const body = orgNotOnListBody(err);
      return body !== null ? notOnListMessage(body) : orgErrorMessage(err.code);
    }
    case 'org_name_taken': {
      const [entry] = refsOf([b['entry']]);
      return entry !== undefined ? `That name is already on the list as ${entry.name}.` : orgErrorMessage(err.code);
    }
    case 'org_name_compound': {
      const spans = Array.isArray(b['spans'])
        ? (b['spans'] as unknown[]).map(refsOf).filter((span) => span.length > 0)
        : [];
      if (spans.length === 0) return orgErrorMessage(err.code);
      const parts = spans.map((span) => span.map((r) => r.name).join(' or ')).join(' and ');
      return `That names more than one organization (${parts}), so it cannot be one entry. Use Split instead.`;
    }
    case 'org_in_use': {
      const uses = b['uses'];
      if (typeof uses === 'object' && uses !== null) {
        const active = (uses as Record<string, unknown>)['active'];
        const deleted = (uses as Record<string, unknown>)['deleted'];
        if (typeof active === 'number' && typeof deleted === 'number') {
          const total = active + deleted;
          return `${plural(total, 'record still holds', 'records still hold')} this name (${deleted} deleted), so it cannot be changed this way.`;
        }
      }
      return orgErrorMessage(err.code);
    }
    case 'org_spelling_refused': {
      const spelling = b['spelling'];
      const problem = b['problem'];
      if (typeof spelling === 'string' && typeof problem === 'string') {
        return `${spelling} cannot be a spelling: ${spellingProblemCopy(problem, refsOf(b['entries']))}.`;
      }
      return orgErrorMessage(err.code);
    }
    case 'org_spelling_shared': {
      const spelling = b['spelling'];
      const entries = refsOf(b['entries']);
      return typeof spelling === 'string' && entries.length > 0
        ? sharedSpellingCopy(spelling, entries)
        : orgErrorMessage(err.code);
    }
    case 'org_value_is_name_variant': {
      // Spec D10: only "Use <that entry>" may settle it (the row offers nothing else).
      const [entry] = refsOf([b['entry']]);
      return entry !== undefined
        ? `That value is ${entry.name} written differently - settle it with Use ${entry.name}.`
        : orgErrorMessage(err.code);
    }
    default:
      return orgErrorMessage(err.code);
  }
}

/** Why a name cannot be added (POST /check `nameProblem`, spec D13). */
export function nameProblemCopy(problem: string, check?: OrgCheckResult): string {
  switch (problem) {
    case 'org_name_empty':
      return 'Type a name first.';
    case 'org_name_too_long':
      return 'Names can be at most 120 characters.';
    case 'org_name_invalid':
      return 'A name needs at least one letter or digit, and no line breaks, control characters or invisible characters (a pasted name can carry one - retype it).';
    case 'org_name_compound':
      return 'It names more than one organization, so it cannot be one entry.';
    case 'org_name_taken': {
      if (check?.match !== undefined) return `It is already on the list as ${check.match.name}.`;
      if (check !== undefined && check.candidates.length > 0) {
        return `It is already a spelling of ${names(check.candidates)}.`;
      }
      if (check?.otherKind !== undefined && check.otherKind.length > 0) {
        return `It is already on the list as ${names(check.otherKind)}.`;
      }
      return 'That name is already on the list.';
    }
    default:
      return 'That name cannot be added.';
  }
}

/** Why a spelling cannot be kept or remembered (spec D12) - a clause, no period. */
export function spellingProblemCopy(problem: string, related: readonly OrgRef[] = []): string {
  const who = names(related);
  switch (problem) {
    case 'empty':
      return 'it has no letters or digits';
    case 'too_long':
      return 'it is longer than 120 characters';
    case 'too_many':
      return 'the entry already has 20 spellings';
    case 'duplicate':
      return 'the entry already has it';
    case 'equals_name':
      return who !== '' ? `it is the name of ${who}` : "it is another entry's name";
    case 'cross_kind':
      return who !== '' ? `it is a spelling of ${who}, on the other list` : 'it belongs to an entry on the other list';
    case 'compound':
      return 'it names more than one organization';
    case 'shared_same_kind':
      return who !== ''
        ? `it is also a spelling of ${who}, and a shared spelling is never applied automatically`
        : 'another entry already has it, and a shared spelling is never applied automatically';
    case 'invalid':
      return 'it contains a line break, a control character or an invisible character';
    default:
      return 'it cannot be used';
  }
}

// --- The latest rewrite (spec D11) -------------------------------------------

/** Mirrors plan 3.2 ORG_REWRITE_STALE_MS: an older heartbeat stops blocking. */
export const ORG_REWRITE_STALE_MS = 15 * 60 * 1000;

/** A running rewrite whose heartbeat is 15 minutes old or more. */
export function isRewriteStalled(lr: OrgRewriteState, nowMs: number = Date.now()): boolean {
  if (lr.status !== 'running') return false;
  const beat = Date.parse(lr.heartbeatAt);
  return Number.isNaN(beat) || nowMs - beat >= ORG_REWRITE_STALE_MS;
}

/** Running with a fresh heartbeat: the Settings section polls while true. */
export function isRewriteLive(lr: OrgRewriteState | undefined, nowMs: number = Date.now()): boolean {
  return lr !== undefined && lr.status === 'running' && !isRewriteStalled(lr, nowMs);
}

/**
 * A failed rewrite its job refused to run because the list changed since it
 * started - the stored error is `org_rewrite_target_gone: <why>` (the job's
 * claim, app/src/services/orgRewrite.ts). Run again re-checks the same
 * definition against the same list, so it could only refuse as well (code
 * review R3-BE-4).
 */
function isOutgrownRewrite(lr: OrgRewriteState): boolean {
  return lr.status === 'failed' && (lr.error ?? '').startsWith('org_rewrite_target_gone');
}

/** "Run again" (admin): a failed or stalled rewrite - never the cleanup
 *  script's (D11), and never one the list outgrew (R3-BE-4). */
export function canRunAgain(lr: OrgRewriteState | undefined, nowMs: number = Date.now()): boolean {
  if (lr === undefined || lr.action === 'cleanup' || isOutgrownRewrite(lr)) return false;
  return lr.status === 'failed' || isRewriteStalled(lr, nowMs);
}

/** "renaming A to B", "the one-time cleanup", ... */
export function describeRewrite(lr: OrgRewriteState): string {
  const from = lr.fromTexts[0] ?? '';
  const to = lr.toName ?? '';
  switch (lr.action) {
    case 'rename':
      return `renaming ${from} to ${to}`;
    case 'merge':
      return `merging ${from} into ${to}`;
    case 'use':
      return `changing ${from} to ${to}`;
    case 'move_to_agency':
      return `moving ${from} to Agency as ${to}`;
    case 'move_to_housing_authority':
      return `moving ${from} to Housing authority as ${to}`;
    case 'split':
      return `splitting ${from} into ${to} + ${lr.agencyName ?? ''}`;
    case 'clear':
      return `clearing ${from}`;
    case 'cleanup':
      return 'the one-time cleanup';
    default:
      return 'an update';
  }
}

/** Labels for the count keys plan 3.2 pins on `lastRewrite.counts`. */
const COUNT_LABEL: Readonly<Record<string, string>> = {
  housingAuthority: 'Housing authority fields',
  agency: 'Agency fields',
  accepted_authorities: 'Property lists',
  skipped: 'Skipped (changed meanwhile)',
  conflicts: 'Conflicts left as they were',
};

function humanizeKey(key: string): string {
  return capitalize(key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
}

/** "Housing authority fields: 3, Skipped (changed meanwhile): 1" - zeros left out. */
export function rewriteCountsText(counts: Record<string, number> | undefined): string {
  if (counts === undefined) return '';
  return Object.entries(counts)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([key, n]) => `${COUNT_LABEL[key] ?? humanizeKey(key)}: ${n}`)
    .join(', ');
}

/** The Settings status line for the latest rewrite. */
export function rewriteStatusText(lr: OrgRewriteState, nowMs: number = Date.now()): string {
  const what = describeRewrite(lr);
  const counts = rewriteCountsText(lr.counts);
  const tail = counts === '' ? '' : ` ${counts}.`;
  const cleanupHint = lr.action === 'cleanup' ? ' Re-run the cleanup script to finish it.' : '';
  if (lr.status === 'running') {
    return isRewriteStalled(lr, nowMs)
      ? `An update stopped responding: ${what}.${cleanupHint}`
      : `Updating records: ${what}.`;
  }
  if (lr.status === 'failed') {
    // Not offered Run again (canRunAgain): say why, and what to do instead.
    const outgrown = isOutgrownRewrite(lr) ? ` ${orgErrorMessage('org_rewrite_target_gone')}` : '';
    return `The last update failed: ${what}.${tail}${cleanupHint}${outgrown}`;
  }
  return `Last update finished: ${what}.${tail}`;
}

// --- Settings counts, resolutions, holders (spec D10) ------------------------

/** "3 tenants, 1 other contact, 2 properties (+2 deleted)"; '-' while unknown. */
export function usageText(u: OrgUsageCounts | undefined): string {
  if (u === undefined) return '-';
  const base = `${plural(u.tenants, 'tenant', 'tenants')}, ${plural(u.otherContacts, 'other contact', 'other contacts')}, ${plural(u.properties, 'property', 'properties')}`;
  return u.deleted > 0 ? `${base} (+${u.deleted} deleted)` : base;
}

/** "3 tenants, 1 other contact, 2 properties, 2 deleted" - for a confirm sentence. */
export function usageBreakdown(u: OrgUsageCounts): string {
  return `${plural(u.tenants, 'tenant', 'tenants')}, ${plural(u.otherContacts, 'other contact', 'other contacts')}, ${plural(u.properties, 'property', 'properties')}, ${u.deleted} deleted`;
}

/** Every record holding the name, deleted included; undefined while unknown. */
export function usageTotal(u: OrgUsageCounts | undefined): number | undefined {
  return u === undefined ? undefined : u.tenants + u.otherContacts + u.properties + u.deleted;
}

/** What a "Not on the list" value is (its D4 resolution), in staff words. */
export function resolutionText(res: NotOnListResolution, field: OrgRecordField): string {
  const kind = kindForField(field);
  switch (res.status) {
    case 'match':
      return res.match !== undefined ? `Matches ${res.match.name}` : 'Matches one name';
    case 'ambiguous':
      return `Shared spelling: ${(res.candidates ?? []).map((r) => r.name).join(' or ')}`;
    case 'other_kind':
      return `${capitalize(withArticle(otherKindOf(kind)))}: ${names(res.otherKind ?? [])}`;
    case 'compound':
      return `Names more than one: ${(res.compound ?? []).map((span) => span.map((r) => r.name).join(' or ')).join(' + ')}`;
    default:
      return (res.close ?? []).length > 0 ? `Unknown - close to ${names(res.close ?? [])}` : 'Unknown';
  }
}

/** A holder's link text: the contact's name or the property's address. */
export function holderLabel(r: HolderRecord): string {
  if (r.kind === 'contact') return r.name !== null && r.name !== '' ? r.name : 'Unnamed contact';
  return r.address !== null && r.address !== '' ? r.address : `Property ${r.unitId}`;
}

/** "Tenant", "Partner", ... or "Property". */
export function holderKindLabel(r: HolderRecord): string {
  if (r.kind === 'unit') return 'Property';
  return (CONTACT_TYPE_LABEL as Readonly<Record<string, string | undefined>>)[r.type] ?? r.type;
}

/** The record's own page - both render deleted records (R5 reference 9.1). */
export function holderHref(r: HolderRecord): string {
  return r.kind === 'contact'
    ? `/contacts/${encodeURIComponent(r.contactId)}`
    : `/listings/${encodeURIComponent(r.unitId)}`;
}
