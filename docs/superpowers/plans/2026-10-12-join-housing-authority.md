# Implementation plan - /join housing authority dropdown, Onboarding start, lead backfill

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md`
  (revision 4, APPROVED by Cameron 2026-10-12). Decisions are cited as D1-D11.
- Branch `feat/join-housing-authority`, worktree `W:\tmp\join-housing-authority`,
  cut from main @19607658. Mission records:
  `docs/superpowers/reviews/2026-10-12-join-housing-authority/`.
- Spec review: 3 rounds, CLOSED (round 3 terminal) -
  `docs/superpowers/reviews/2026-10-12-join-housing-authority/design-review/adjudications.md`.
- Status: PLAN SKELETON (planner) - sections 0-3 are BINDING; the slice
  sections (4-9) are filled from section drafts.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for
  the stated reason), implement, run it GREEN, commit. One commit per task
  unless the task says otherwise. A case marked (PIN) is a regression pin
  already green on unchanged code; every task still has at least one real
  RED case.
- Commits: a separate `git status` read first, check
  `.git/worktrees/join-housing-authority/MERGE_HEAD` is absent, explicit
  paths only (never `git add -A`), ASCII message ending with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the
  authoring model's name).
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for new files;
  for a pre-existing file with non-ASCII, only ADDED lines must be ASCII.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit/Write tools DECODE `\u` escapes - a regex or
  string that must contain a literal backslash-u sequence is written with
  a different technique (a character class built in code) or verified with
  `grep -n '\\u'` after the edit.
- Run app tests from `app/` with `npx vitest run test/<file>`, dashboard
  tests from `dashboard/` with `npx vitest run src/<path>`. Never pipe a
  test or gate command.
- Never run Playwright outside the e2e workspace; never touch the live
  stack (`:5174` / `:8080`). The backfill script runs ONLY with
  `--env local --lane <L>` against a hermetic lane the builder started.
- Do not restart the shared DynamoDB Local container.

## 1. Global constraints (copied from the spec)

- Public list read: `GET /public/housing-authorities` -> `200 { names: string[] }`,
  housing_authority kind only, exact stored names, sorted case-insensitively
  (English collation), unique; `Cache-Control: no-store`; reads
  `orgListRepo.peek()`, falling back to `buildStartingEntries` in memory;
  NEVER writes the list item; read failure = the generic 500 (D1).
- Its limit: 60 requests per 60 000 ms per IP, hard-coded, route-level, on
  a router mounted with `app.use('/public', ...)` immediately BEFORE the
  existing `/public` mount; the shared 5-per-minute limiter is untouched (D2).
- Sign-up `housingAuthority`: absent or null = none; else a string of 1 to
  120 chars after the existing body trim, or the generic 400; when present,
  the POST reads the list (D1's source) and refuses a value that is not
  character-for-character a housing_authority entry name with
  `400 { error: 'housing_authority_not_listed' }`, before any write, for new
  and existing phones alike (D3).
- `unitId` present-and-not-null AND `housingAuthority` present-and-not-null
  -> generic 400, whatever the unit's state (D4).
- Every NEW contact created by the sign-up handler gets
  `housing_fair_signup_v2: true`; a new contact from a request with NO
  `unitId` starts `status: 'onboarding'` and holds the given authority; a
  request WITH a `unitId` keeps `needs_review` and no authority (D5).
- An existing phone gets no authority, status or marker write; today's
  welcome rule is unchanged (D6).
- Every post-change `housing_fair_signup` audit event: `signupVersion: 2`,
  `housingAuthority: <name the request carried> | null`; the log line gains
  boolean `withAuthority` (D7).
- `/join` UI copy (exact strings): label "Housing authority"; help "The
  organization that runs your voucher."; option "Not sure"; loading option
  "Loading..."; placeholder "Choose one"; failed note "The list of housing
  authorities could not be loaded."; not-listed message "The housing
  authority list was updated. Choose the housing authority again."; 429
  message "Too many sign-ups from this network in the last minute. Wait a
  minute, then send again."; button "Sign up another person". Default
  "Atlanta Housing Authority" when that exact name is listed, else "Not
  sure". List read timeout 10 000 ms (D8, D9).
- Backfill: `app/scripts/backfill-join-housing-authority.ts`, the D10 rules
  verbatim; audit event `housing_authority_backfill`
  `{ field: 'housingAuthority', from: '', to: 'Atlanta Housing Authority' }`,
  no actor; the write is `contactsRepo.update` with `expect`
  `[{ attr: 'housingAuthority', value: null }, { attr: 'type', value: 'tenant' }]`
  and `notDeleted: true` (D10).

## 2. Binding interfaces

These names and signatures are fixed; every section uses them exactly. A
section writer who finds one unworkable reports it as a CONTRACT ISSUE at
the top of its draft rather than changing it silently.

### 2.1 App: `app/src/services/publicOrgList.ts` (NEW)

```ts
import type { OrgEntry } from '../lib/orgNames.js';
import type { OrgListRepo } from '../repos/orgListRepo.js';

/** D2: the list read's own per-IP limit. */
export const PUBLIC_LIST_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;

/** D3: the distinct refusal code for an unlisted authority. */
export const HOUSING_AUTHORITY_NOT_LISTED = 'housing_authority_not_listed' as const;

/** D1: the stored list via peek(), else the starting list in memory. Never writes. */
export function loadPublicOrgEntries(repo: OrgListRepo, now?: () => string): Promise<readonly OrgEntry[]>;

/** D1: housing_authority names only, unique, sorted (localeCompare 'en', sensitivity 'base', then a plain compare as tie-break). */
export function housingAuthorityNames(entries: readonly OrgEntry[]): string[];
```

### 2.2 App: `app/src/routes/public.ts`

- `PublicRouterDeps` gains `orgListRepo?: OrgListRepo` (default
  `createOrgListRepo({ logger })`). The sign-up handler uses it for D3.
- NEW export:

  ```ts
  export interface PublicHousingAuthoritiesDeps {
    logger?: Logger;
    orgListRepo?: OrgListRepo;
    /** Test seam: the limiter's client-key resolver. */
    rateLimitKeyOf?: (req: Request) => string;
  }
  export function createPublicHousingAuthoritiesRouter(deps?: PublicHousingAuthoritiesDeps): Router;
  ```

  It defines ONLY `GET /housing-authorities`, with
  `createRateLimit({ ...PUBLIC_LIST_RATE_LIMIT, logger, keyOf })` as that
  route's own middleware.
- `app/src/app.ts` mounts it with `app.use('/public', createPublicHousingAuthoritiesRouter({ logger: log, ...(deps.public?.orgListRepo !== undefined && { orgListRepo: deps.public.orgListRepo }) }))`
  immediately before the existing `/public` mount. No other mount changes.
- Contact attribute names: `housing_fair_signup_v2` (boolean true),
  `housingAuthority` (existing). Audit payload keys: `signupVersion` (number
  2), `housingAuthority` (string | null). Log key: `withAuthority`.

### 2.3 Dashboard: `dashboard/src/routes/public/publicApi.ts`

```ts
export interface HousingFairInput {
  // ...existing fields...
  /** D8: the chosen authority's exact name; omitted for "Not sure". */
  housingAuthority?: string;
}
/** D1: GET /public/housing-authorities -> names. Throws ApiError on failure. */
export function getHousingAuthorities(signal?: AbortSignal): Promise<string[]>;
```

`submitHousingFair` adds `housingAuthority` to the body only when it is
defined.

### 2.4 Dashboard: `IntakeForm` props (all optional; the flyer passes none)

```ts
export interface IntakeFormProps {
  onSubmit: (input: Omit<HousingFairInput, 'unitId' | 'housingAuthority'>) => Promise<void>;
  submitLabel?: string;
  /** Rendered after "Voucher size", before the consent box. */
  extraField?: React.ReactNode;
  /** Disables the submit button (list loading, or "Choose one" showing). */
  submitBlocked?: boolean;
  /** Maps a thrown submit error to copy; null/undefined -> today's message. */
  errorMessage?: (err: unknown) => string | null | undefined;
  /** Focus "First name" on mount (after "Sign up another person"). */
  autoFocusFirstName?: boolean;
}
```

With none of the new props, IntakeForm renders and behaves exactly as
today (the flyer). `HousingFairIntake` owns the list state, the select
value, the not-listed recovery, and the "Sign up another person" remount
(a React `key` on IntakeForm); it adds `housingAuthority` to the input in
its own `onSubmit` closure.

### 2.5 Backfill script exports (`app/scripts/backfill-join-housing-authority.ts`)

```ts
export const BACKFILL_AUTHORITY = 'Atlanta Housing Authority';
export const BACKFILL_AUDIT_TYPE = 'housing_authority_backfill';
export type LeftOutReason = 'skipped' | 'signed_up_again' | 'authority_history';
/** D10 candidate test on the stored item alone. */
export function isCandidate(contact: ContactItem): boolean;
/** D10 audit rules over a candidate's WHOLE history (newest first or any order). */
export function leftOutReasonFromAudit(events: readonly AuditEvent[]): Exclude<LeftOutReason, 'skipped'> | null;
export interface BackfillOptions { apply: boolean; skip: ReadonlySet<string>; }
export interface BackfillReport { /* targets, leftOut, unknownSkips, written, skipped, failed, warnings */ }
export function runJoinAuthorityBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillReport>;
```

`BackfillDeps` is the writer's to define (stage-resolved repos, an injected
`print` for the operator report, `now`). The CLI `main` follows
`app/scripts/clean-org-names.ts` (`parseStageArgs` with `--apply` as a flag
and `--skip` as a value, `resolveStageClient`).

## 3. Slices and task numbering

| Slice | Content | Tasks |
|---|---|---|
| S1 | App: `publicOrgList.ts`, the list router, the mount, the edge guard | 1.x |
| S2 | App: the sign-up field, refusals, Onboarding start, marker, audit/log, stale comments in `public.ts` | 2.x |
| S3 | Dashboard: `publicApi.ts`, `IntakeForm` props, `/join` select, recovery, 429, "Sign up another person" | 3.x |
| S4 | Backfill script + its test + the RUNBOOK entry | 4.x |
| S5 | E2E (`public-pages.spec.ts`), stale statements in docs/e2e (spec section 7), perf templates | 5.x |
| S6 | Completion: sync main once, the five gates (AGENTS.md), handback | 6.x |

S1 before S2 (S2's D3 check uses `loadPublicOrgEntries`). S3 needs S1's
route for its live behavior but its unit tests mock `publicApi`. S4 is
independent of S1-S3. S5 last before S6.

## 4-9. Slice sections

(Filled from the section drafts.)
