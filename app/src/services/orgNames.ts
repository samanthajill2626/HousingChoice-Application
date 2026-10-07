// The organization lists - the SERVICE layer (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D5, D10, D12, D13; plan sections 3.4, 3.4b, 3.5). The pure rules live in
// lib/orgNames.ts, the stored item in repos/orgListRepo.ts.
//
// This module also owns what every org service and the /api/organizations
// router share: the refusal type (OrgHttpError - bodies are
// `{ error: code, ...extras }`, plan 3.5), the control-character rule the S1
// checks do not carry (names and spellings are rendered one per line into the
// AI list block, so a newline or other control character is refused - D13),
// the problem -> refusal mappings, and the rewrite-lock test (D11).
import {
  checkNewName,
  checkSpelling,
  type NameProblem,
  type OrgEntry,
  type OrgRef,
  type SpellingProblem,
} from '../lib/orgNames.js';
import {
  OrgListBusyError,
  OrgListFullError,
  ORG_REWRITE_STALE_MS,
  type OrgRewriteState,
} from '../repos/orgListRepo.js';

/** A refusal: its HTTP status and body (plan 3.5). The router sends it as is. */
export class OrgHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string } & Record<string, unknown>,
  ) {
    super(body.error);
    this.name = 'OrgHttpError';
  }
}

/** The public reference to an entry that refusals and resolutions carry. */
export function toOrgRef(e: OrgEntry): OrgRef {
  return { orgId: e.orgId, kind: e.kind, name: e.name };
}

/**
 * Spec D13: true when `text` holds a newline or another control character -
 * the C0 controls (tab and newline included), DEL, the C1 controls, and the
 * Unicode line and paragraph separators. Char codes rather than a regex keep
 * this file ASCII.
 */
export function hasOrgControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

/** checkNewName (lib) behind the control-character rule. */
export function checkNewOrgName(
  entries: readonly OrgEntry[],
  name: string,
  opts: { excludeOrgId?: string } = {},
): NameProblem | null {
  if (hasOrgControlChar(name.trim())) return { code: 'org_name_invalid' };
  return checkNewName(entries, name, opts);
}

/** checkSpelling (lib) behind the control-character rule. */
export function checkOrgSpelling(
  entries: readonly OrgEntry[],
  target: OrgEntry,
  spelling: string,
): SpellingProblem | null {
  if (hasOrgControlChar(spelling.trim())) return { problem: 'invalid' };
  return checkSpelling(entries, target, spelling);
}

/** A new-name problem as its plan-3.5 refusal. */
export function nameProblemError(problem: NameProblem): OrgHttpError {
  switch (problem.code) {
    case 'org_name_empty':
    case 'org_name_too_long':
    case 'org_name_invalid':
      return new OrgHttpError(400, { error: problem.code });
    case 'org_name_taken':
      return new OrgHttpError(409, { error: 'org_name_taken', entry: toOrgRef(problem.entry) });
    case 'org_name_compound':
      return new OrgHttpError(409, {
        error: 'org_name_compound',
        spans: problem.spans.map((span) => span.map(toOrgRef)),
      });
  }
}

/** An admin spelling-edit problem as its plan-3.5 refusal. */
export function spellingProblemError(spelling: string, problem: SpellingProblem): OrgHttpError {
  switch (problem.problem) {
    case 'shared_same_kind':
      return new OrgHttpError(409, {
        error: 'org_spelling_shared',
        spelling,
        entries: problem.entries.map(toOrgRef),
      });
    case 'too_many':
      return new OrgHttpError(409, { error: 'org_spellings_full' });
    case 'equals_name':
    case 'cross_kind':
      return new OrgHttpError(409, {
        error: 'org_spelling_refused',
        spelling,
        problem: problem.problem,
        entries: problem.entries.map(toOrgRef),
      });
    default:
      return new OrgHttpError(409, { error: 'org_spelling_refused', spelling, problem: problem.problem });
  }
}

/** Spec D11: a rewrite holds the lock while `running` with a heartbeat under 15 minutes old. */
export function isOrgRewriteRunning(last: OrgRewriteState | undefined, nowMs: number): boolean {
  if (last === undefined || last.status !== 'running') return false;
  return nowMs - Date.parse(last.heartbeatAt) < ORG_REWRITE_STALE_MS;
}

/** 409 org_rewrite_running, carrying the rewrite that holds the lock. */
export function rewriteRunningError(last: OrgRewriteState): OrgHttpError {
  return new OrgHttpError(409, { error: 'org_rewrite_running', lastRewrite: last });
}

/** The refusal for any org failure a route answers (plan 3.5); undefined for anything else. */
export function asOrgHttpError(err: unknown): OrgHttpError | undefined {
  if (err instanceof OrgHttpError) return err;
  if (err instanceof OrgListFullError) return new OrgHttpError(409, { error: 'org_list_full' });
  if (err instanceof OrgListBusyError) return new OrgHttpError(503, { error: 'org_list_busy' });
  return undefined;
}
