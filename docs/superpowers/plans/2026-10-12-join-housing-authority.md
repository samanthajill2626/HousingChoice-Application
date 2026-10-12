# Implementation plan - /join housing authority dropdown, Onboarding start, lead backfill

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md`
  (revision 4, APPROVED by Cameron 2026-10-12). Decisions are cited as D1-D11.
- Branch `feat/join-housing-authority`, worktree `W:\tmp\join-housing-authority`,
  cut from main @19607658. Mission records:
  `docs/superpowers/reviews/2026-10-12-join-housing-authority/`.
- Spec review: 3 rounds, CLOSED (round 3 terminal) -
  `docs/superpowers/reviews/2026-10-12-join-housing-authority/design-review/adjudications.md`.
- Status: PLAN (assembled 2026-10-12 from four opus section drafts + the
  planner's S6). Sections 0-4 are BINDING; section 4 (assembly rulings)
  wins over any slice text it contradicts. The section drafts themselves are
  gitignored and are never the authority.

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

## 4. Assembly rulings (planner, BINDING over the section text below)

Four opus section writers drafted S1-S2, S3, S4 and S5; the planner wrote
S6. The record of these rulings is
`docs/superpowers/reviews/2026-10-12-join-housing-authority/plan-research/plan-assembly-rulings.md`.
Each section opens with its writer's "CONTRACT ISSUES" check; every item
there is resolved here. Where a section's prose and this list disagree,
this list wins.

- AR-1 (S1-S2 contract issue 1, ACCEPTED): Task 1.3 adds
  `orgListRepo: world.orgListRepo` to the harness `public` deps in
  `app/test/helpers/twilioWebhookHarness.ts`, so no harness test builds the
  DynamoDB-backed org list repo. No binding name changes.
- AR-2 (S3 and S4 additive exports, ACCEPTED): S3 adds
  `HOUSING_AUTHORITY_NOT_LISTED` to `publicApi.ts`, an
  `ApiError(0, 'invalid_response')` for a malformed list body, the
  presentational `HousingAuthoritySelect.tsx` (it never fetches), and a
  `.help` CSS class. S4 adds `doc` and `env` to `BackfillDeps` (the
  candidate read is a base-table Scan) and the helper exports its section
  lists. The binding names in section 2 are unchanged.
- AR-3 (perf templates, S3 note vs S5 decision): NO task. S5's evidence
  stands: `/join` and `/p/:unitId` are excluded from the measured registry
  (`e2e/performance/routes.ts:117-118`), only an undeclared `/api/*` path
  becomes `unmatched_api` (`e2e/performance/templates.ts:285-303`), and the
  mutation catalog skips GETs. Spec section 7's perf line is conditional
  ("if a measured page requests it") and no measured page does. Task 5.3
  runs the inventory tests as a check.
- AR-4 (S1-S2 finding F1, ACCEPTED as a spec precision note): Express
  answers `OPTIONS /public/housing-authorities` itself
  (`200 Allow: GET, HEAD`) without reaching either limiter. It reads
  nothing; no task depends on it. Spec D2 carries a one-line note.
- AR-5 (DynamoDB Local): before any `npm run db:start`, check `docker ps`.
  If the shared container is running, do NOT start, stop or restart it
  (AGENTS.md; Cameron's standing rule). `db:start` is only for a container
  that is not running at all. The `ALLOW_SKIP_DYNAMO_TESTS=1` route is for
  the fake-only app test files S1-S2 names; it is never a gate, and a
  SKIPPED DynamoDB-backed test (S4) is never GREEN.
- AR-6 (e2e sessions, S5 note 5): the e2e preflight refuses a session booted
  at a different commit (`e2e/support/preflight.ts:87-128`). Every targeted
  e2e run boots a session at the current HEAD; stop it before each commit;
  S6's live self-QA boots its session after the last code commit.
- AR-7 (the not-listed message, S3 design note): the message is IntakeForm's
  error line and clears on the next text edit or send, not on picking an
  authority. Accepted as written (the spec requires no more).
- AR-8 (order): S1 -> S2 -> S3 -> S4 -> S5 -> S6. S4 is independent of
  S1-S3 but runs after them so its gates see the final app code.

## 5. S1 + S2 - App server (Tasks 1.1-1.3, 2.1-2.4)

### CONTRACT ISSUES

1. (minor, resolved in this draft) The skeleton's S1 content line lists
   `publicOrgList.ts`, the list router, the mount and the edge guard, but not
   the test harness. `app/test/helpers/twilioWebhookHarness.ts:5431-5450`
   builds the `public` deps WITHOUT an org list repo. Once app.ts mounts the
   list router with `deps.public?.orgListRepo` (skeleton 2.2), every harness
   app would otherwise build the DynamoDB-backed default
   (`createOrgListRepo`, `app/src/repos/orgListRepo.ts:150`) for both the GET
   and (after S2) the sign-up check. Task 1.3 adds
   `orgListRepo: world.orgListRepo` to the harness `public` deps. No binding
   name or signature changes.

No other binding item is unworkable against the code. Notes that are not
contract issues are at the end of this draft ("Notes for the planner and the
other slices").

### Facts the tasks below rely on (verified in the code)

- Express is 5.2.1 (router 2.2.0): a rejected promise from an async route
  handler is forwarded to the error handler, which answers the generic
  `500 { error: 'internal server error' }` (`app/src/lib/errors.ts:171-201`).
  A router mounted at `/public` that matches nothing calls `next()`, so the
  request reaches the next `app.use('/public', ...)`.
- `createRateLimit` (`app/src/middleware/rateLimit.ts:81`) owns its own
  window map per call; options `{ max, windowMs, logger?, keyOf? }`; a refused
  request gets `429 { error: 'rate_limited' }` plus `Retry-After`.
- Every JSON body is deep-trimmed by `trimJsonBody` before any route
  (`app/src/app.ts:142`), so the route sees `'  X  '` as `'X'`.
- `world.orgListRepo` in the harness is `createOrgListFake()`
  (`app/test/helpers/orgListFake.ts`): it starts EMPTY (`peek()` -> null);
  `get()` would create the starting list; `putForSeed()` stores an item.
- `world.contacts` holds created contacts; `world.auditEvents` holds
  `{ entityKey, event_type, actorId?, payload? }` (exact enumerable keys);
  `world.sent` holds welcome sends; `world.conversations` is a Map;
  `capture.lines` holds parsed log lines (`l['msg']`).
- The harness defaults the shared `/public` limit to 5 per minute; every new
  test that sends more than 5 `/public` requests passes
  `env: { PUBLIC_RATE_LIMIT_MAX: '100' }` (or a deliberately small value).
- No other app test, fixture or helper asserts the exact created-contact shape
  or the exact `housing_fair_signup` payload (grep of `app/test` for
  `housing_fair_signup`, `housing-fair`, `/public/`: only
  `publicIntake.test.ts`, the harness, and `cloudfrontBehaviors.test.ts`).
  The e2e and docs statements are S5's.
- The starting list's twelve housing authority names in D1 order
  (`localeCompare('en', { sensitivity: 'base' })`) are: Atlanta Housing
  Authority, Augusta Housing Authority, College Park Housing Authority,
  Decatur Housing Authority, DeKalb County Housing Authority, East Point
  Housing Authority, Fulton County Housing Authority, Georgia Department of
  Community Affairs, Georgia Housing Voucher Program (DBHDD), Jonesboro
  Housing Authority, Macon-Bibb County Housing Authority, Marietta Housing
  Authority. (Agencies on the starting list include "Step Up".)

### How to run the tests in these slices

- Always from the app workspace, one file at a time, never piped:
  `cd "W:/tmp/join-housing-authority/app" && npx vitest run test/<file>`
- These files use only in-memory fakes. The app's vitest `globalSetup`
  (`app/test/globalSetup.ts`) THROWS when DynamoDB Local is unreachable. If a
  run aborts there before any test runs, start DynamoDB Local with
  `npm run db:start` from the worktree root (never restart the shared
  container), or for these fake-only files re-run with the deliberate
  unit-only flag:
  `cd "W:/tmp/join-housing-authority/app" && ALLOW_SKIP_DYNAMO_TESTS=1 npx vitest run test/<file>`
- Several old lines in `app/src/routes/public.ts`, `app/src/app.ts`,
  `app/test/publicIntake.test.ts` and the harness contain non-ASCII
  characters (U+2014 em dash, U+2192 arrow, U+00A7 section sign). Do not
  retype them. Every Edit below uses an ASCII-only anchor, except one place
  (Task 2.3, step 4) that says exactly how to copy the old lines.

### Commit procedure used by every task (written out in each task)

1. `cd "W:/tmp/join-housing-authority" && git status` - read it; the only
   changes must be the task's files.
2. `cd "W:/tmp/join-housing-authority" && test -e "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE_HEAD PRESENT - STOP" || echo "no merge in progress"`
   - must print `no merge in progress`.
3. ASCII checks (new files: `tr` count must print 0; touched files: the added
   lines must count 0 non-ASCII characters).
4. `git add` with explicit paths, then `git commit` with an ASCII message
   whose last paragraph is the trailer
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (use the
   authoring model's name if different).

---

### S1 - the public housing authority list read (Tasks 1.1-1.3)

#### Task 1.1 - `publicOrgList.ts`: the never-writing public read of the list

Files:
- Create `app/src/services/publicOrgList.ts`
- Create `app/test/publicOrgList.test.ts`

Step 1 - write the failing test. Create `app/test/publicOrgList.test.ts`:

```ts
// join-housing-authority D1-D3 (docs/superpowers/specs/2026-10-12-join-housing-authority-design.md):
// services/publicOrgList.ts - the public read of the organization list. The
// stored list via peek(), else the starting list IN MEMORY (never a write);
// housing authority names only, unique, sorted case-insensitively.
import { describe, expect, it, vi } from 'vitest';
import type { OrgEntry, OrgKind } from '../src/lib/orgNames.js';
import { STARTING_ORG_LIST } from '../src/lib/orgStartingList.js';
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  PUBLIC_LIST_RATE_LIMIT,
  housingAuthorityNames,
  loadPublicOrgEntries,
} from '../src/services/publicOrgList.js';
import { createOrgListFake } from './helpers/orgListFake.js';

function entry(kind: OrgKind, name: string, orgId = `org-${name}`): OrgEntry {
  return {
    orgId,
    kind,
    name,
    spellings: [],
    createdAt: '2026-10-12T00:00:00.000Z',
    createdBy: 'test',
    updatedAt: '2026-10-12T00:00:00.000Z',
    updatedBy: 'test',
  };
}

/** The starting list's housing authority names in D1 order. */
const STARTING_AUTHORITY_NAMES = [
  'Atlanta Housing Authority',
  'Augusta Housing Authority',
  'College Park Housing Authority',
  'Decatur Housing Authority',
  'DeKalb County Housing Authority',
  'East Point Housing Authority',
  'Fulton County Housing Authority',
  'Georgia Department of Community Affairs',
  'Georgia Housing Voucher Program (DBHDD)',
  'Jonesboro Housing Authority',
  'Macon-Bibb County Housing Authority',
  'Marietta Housing Authority',
];

describe('publicOrgList constants (D2, D3)', () => {
  it('the list limit is 60 per 60 000 ms and the refusal code is housing_authority_not_listed', () => {
    expect(PUBLIC_LIST_RATE_LIMIT).toEqual({ max: 60, windowMs: 60_000 });
    expect(HOUSING_AUTHORITY_NOT_LISTED).toBe('housing_authority_not_listed');
  });
});

describe('housingAuthorityNames (D1)', () => {
  it('keeps housing_authority names only and drops agencies and exact duplicates', () => {
    expect(
      housingAuthorityNames([
        entry('housing_authority', 'Decatur Housing Authority'),
        entry('agency', 'Step Up'),
        entry('housing_authority', 'Atlanta Housing Authority'),
        entry('housing_authority', 'Atlanta Housing Authority', 'org-duplicate'),
      ]),
    ).toEqual(['Atlanta Housing Authority', 'Decatur Housing Authority']);
  });

  it('sorts case-insensitively, not by code unit', () => {
    // A plain sort would put "Banana" before "apple" (uppercase sorts first).
    expect(
      housingAuthorityNames([
        entry('housing_authority', 'zeta Housing Authority'),
        entry('housing_authority', 'Banana Housing Authority'),
        entry('housing_authority', 'apple Housing Authority'),
      ]),
    ).toEqual(['apple Housing Authority', 'Banana Housing Authority', 'zeta Housing Authority']);
  });

  it('breaks a case-only tie with a plain compare, whatever the input order', () => {
    const upper = entry('housing_authority', 'ABC Housing Authority');
    const lower = entry('housing_authority', 'abc Housing Authority');
    expect(housingAuthorityNames([lower, upper])).toEqual([
      'ABC Housing Authority',
      'abc Housing Authority',
    ]);
    expect(housingAuthorityNames([upper, lower])).toEqual([
      'ABC Housing Authority',
      'abc Housing Authority',
    ]);
  });

  it('leaves the entries it is given in their order, and no entries gives no names', () => {
    const entries = [entry('housing_authority', 'b Authority'), entry('housing_authority', 'a Authority')];
    housingAuthorityNames(entries);
    expect(entries.map((e) => e.name)).toEqual(['b Authority', 'a Authority']);
    expect(housingAuthorityNames([])).toEqual([]);
  });
});

describe('loadPublicOrgEntries (D1)', () => {
  it('returns the STORED entries when the item exists', async () => {
    const repo = createOrgListFake();
    const stored = [entry('housing_authority', 'Only Housing Authority'), entry('agency', 'Only Agency')];
    await repo.putForSeed({ settingId: 'org-list', version: 3, entries: stored });
    expect(await loadPublicOrgEntries(repo)).toEqual(stored);
  });

  it('falls back to the starting list in memory on an empty store and never creates the item', async () => {
    const repo = createOrgListFake();
    const get = vi.spyOn(repo, 'get');
    const mutate = vi.spyOn(repo, 'mutate');
    const putForSeed = vi.spyOn(repo, 'putForSeed');

    const entries = await loadPublicOrgEntries(repo, () => '2026-10-12T09:00:00.000Z');

    expect(entries.map((e) => [e.kind, e.name])).toEqual(STARTING_ORG_LIST.map((s) => [s.kind, s.name]));
    expect(entries.every((e) => e.createdAt === '2026-10-12T09:00:00.000Z')).toBe(true);
    expect(await repo.peek()).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(putForSeed).not.toHaveBeenCalled();
  });

  it('propagates a read failure (the routes turn it into the generic 500)', async () => {
    const repo = createOrgListFake();
    vi.spyOn(repo, 'peek').mockRejectedValue(new Error('settings table unavailable'));
    await expect(loadPublicOrgEntries(repo)).rejects.toThrow('settings table unavailable');
  });

  it('the starting list read through housingAuthorityNames gives the twelve authorities in order', async () => {
    const names = housingAuthorityNames(await loadPublicOrgEntries(createOrgListFake()));
    expect(names).toEqual(STARTING_AUTHORITY_NAMES);
  });
});
```

Step 2 - run it RED:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicOrgList.test.ts`
Expected: the file FAILS TO LOAD - vitest reports it cannot resolve
`../src/services/publicOrgList.js` (the module does not exist yet); no test
runs; exit code 1.

Step 3 - implement. Create `app/src/services/publicOrgList.ts`:

```ts
// The PUBLIC read of the organization list (join-housing-authority spec
// docs/superpowers/specs/2026-10-12-join-housing-authority-design.md D1-D3).
// One source and one rule for the two public uses: GET
// /public/housing-authorities (the /join form's dropdown) and the sign-up's
// list check in POST /public/housing-fair (routes/public.ts).
//
// NEVER WRITES. The org list repo's get() creates the stored item from the
// starting list on an empty store; the public, unauthenticated surface must
// not be what creates it. So this reads with peek() and, when no item is
// stored, builds the starting list IN MEMORY - the same names get() would
// store - and leaves the store empty.
import { randomUUID } from 'node:crypto';
import { KINDS_FOR_FIELD, type OrgEntry } from '../lib/orgNames.js';
import { buildStartingEntries } from '../lib/orgStartingList.js';
import type { OrgListRepo } from '../repos/orgListRepo.js';

/** D2: the list read's own per-IP limit (hard-coded, the /unit-media precedent). */
export const PUBLIC_LIST_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;

/** D3: the distinct refusal code for a housing authority that is not on the list. */
export const HOUSING_AUTHORITY_NOT_LISTED = 'housing_authority_not_listed' as const;

/** D1: the stored list via peek(), else the starting list in memory. Never writes. */
export async function loadPublicOrgEntries(
  repo: OrgListRepo,
  now: () => string = () => new Date().toISOString(),
): Promise<readonly OrgEntry[]> {
  const stored = await repo.peek();
  if (stored !== null) return stored.entries;
  return buildStartingEntries(now(), () => randomUUID());
}

/**
 * D1: the exact stored `name` of every housing authority entry - no ids,
 * spellings, notes, audit fields or agencies - unique, sorted
 * case-insensitively in English collation (localeCompare 'en', sensitivity
 * 'base'), with a plain code-unit compare breaking ties so the order is total.
 * The kinds are KINDS_FOR_FIELD.housingAuthority: the same kinds the sign-up's
 * list check (isOnListFor) accepts, so every name served here is accepted there.
 */
export function housingAuthorityNames(entries: readonly OrgEntry[]): string[] {
  const kinds = KINDS_FOR_FIELD.housingAuthority;
  const names = new Set<string>();
  for (const entry of entries) {
    if (kinds.includes(entry.kind)) names.add(entry.name);
  }
  return [...names].sort(
    (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0),
  );
}
```

Step 4 - run it GREEN:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicOrgList.test.ts`
Expected: 1 file passed, 9 tests passed, 0 failed.

Step 5 - commit.
1. `cd "W:/tmp/join-housing-authority" && git status` - only the two new
   files are listed (untracked).
2. `cd "W:/tmp/join-housing-authority" && test -e "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE_HEAD PRESENT - STOP" || echo "no merge in progress"`
3. `cd "W:/tmp/join-housing-authority" && tr -d '\11\12\15\40-\176' < app/src/services/publicOrgList.ts | wc -c`
   and the same for `app/test/publicOrgList.test.ts` - each prints 0.
4. `cd "W:/tmp/join-housing-authority" && git add app/src/services/publicOrgList.ts app/test/publicOrgList.test.ts`
5. `cd "W:/tmp/join-housing-authority" && git commit -m "feat(public): publicOrgList - the never-writing public read of the org list" -m "join-housing-authority D1-D3: loadPublicOrgEntries reads the stored list with peek() and falls back to the starting list in memory; housingAuthorityNames returns the housing authority names only, unique, sorted case-insensitively. Constants for the list limit (60/min) and the not-listed refusal code." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 1.2 - `createPublicHousingAuthoritiesRouter` with its own 60-per-minute limit

Files:
- Modify `app/src/routes/public.ts`
- Create `app/test/publicHousingAuthoritiesRouter.test.ts`

Step 1 - write the failing test. Create
`app/test/publicHousingAuthoritiesRouter.test.ts`:

```ts
// join-housing-authority D1/D2: createPublicHousingAuthoritiesRouter on a bare
// Express app - the one GET route, its response, and its OWN per-client limit
// (60 per 60 s). The full-app behavior (its mount ahead of the shared /public
// limiter in app.ts) is tested in publicIntake.test.ts.
import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { OrgListRepo } from '../src/repos/orgListRepo.js';
import { createPublicHousingAuthoritiesRouter } from '../src/routes/public.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createOrgListFake } from './helpers/orgListFake.js';

const LIST = '/public/housing-authorities';

/** The starting list's housing authority names in D1 order. */
const STARTING_AUTHORITY_NAMES = [
  'Atlanta Housing Authority',
  'Augusta Housing Authority',
  'College Park Housing Authority',
  'Decatur Housing Authority',
  'DeKalb County Housing Authority',
  'East Point Housing Authority',
  'Fulton County Housing Authority',
  'Georgia Department of Community Affairs',
  'Georgia Housing Voucher Program (DBHDD)',
  'Jonesboro Housing Authority',
  'Macon-Bibb County Housing Authority',
  'Marietta Housing Authority',
];

function listApp(orgListRepo: OrgListRepo, rateLimitKeyOf?: (req: Request) => string) {
  const app = express();
  app.use(
    '/public',
    createPublicHousingAuthoritiesRouter({
      logger: createLogger({ destination: createLogCapture().stream }),
      orgListRepo,
      ...(rateLimitKeyOf !== undefined && { rateLimitKeyOf }),
    }),
  );
  return app;
}

describe('createPublicHousingAuthoritiesRouter (D1)', () => {
  it('answers GET /housing-authorities with { names } and Cache-Control: no-store, writing nothing', async () => {
    const repo = createOrgListFake();
    const res = await request(listApp(repo)).get(LIST);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ names: STARTING_AUTHORITY_NAMES });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await repo.peek()).toBeNull();
  });

  it('defines only that GET: another method or path is not handled by this router', async () => {
    const app = listApp(createOrgListFake());
    expect((await request(app).post(LIST).send({})).status).toBe(404);
    expect((await request(app).get(`${LIST}/extra`)).status).toBe(404);
    expect((await request(app).get('/public/units/u-1/flyer')).status).toBe(404);
  });

  it('forwards a list read failure to the error handler (status 500)', async () => {
    const repo = createOrgListFake();
    vi.spyOn(repo, 'peek').mockRejectedValue(new Error('settings table unavailable'));
    expect((await request(listApp(repo)).get(LIST)).status).toBe(500);
  });
});

describe('createPublicHousingAuthoritiesRouter - its own limit (D2)', () => {
  it('allows 60 reads per client in a window, refuses the 61st with 429 + Retry-After; another client is unaffected', async () => {
    const app = listApp(createOrgListFake(), (req) => String(req.headers['x-client'] ?? 'none'));
    for (let i = 0; i < 60; i += 1) {
      const res = await request(app).get(LIST).set('x-client', 'a');
      expect(res.status, `read ${i + 1}`).toBe(200);
    }
    const limited = await request(app).get(LIST).set('x-client', 'a');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await request(app).get(LIST).set('x-client', 'b')).status).toBe(200);
  });

  it('a refused read does not touch the list store', async () => {
    const repo = createOrgListFake();
    const app = listApp(repo, () => 'one-client');
    for (let i = 0; i < 60; i += 1) {
      expect((await request(app).get(LIST)).status, `read ${i + 1}`).toBe(200);
    }
    const peekAfterLimit = vi.spyOn(repo, 'peek');
    expect((await request(app).get(LIST)).status).toBe(429);
    expect(peekAfterLimit).not.toHaveBeenCalled();
  });
});
```

Step 2 - run it RED:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicHousingAuthoritiesRouter.test.ts`
Expected: all 5 tests fail with a TypeError saying
`createPublicHousingAuthoritiesRouter` is not a function (the export does
not exist yet); exit code 1.

Step 3 - implement in `app/src/routes/public.ts` (five Edits; every anchor is
ASCII and unique).

Edit 3a - the express import. Replace:
```ts
import { Router, type Response } from 'express';
```
with:
```ts
import { Router, type Request, type Response } from 'express';
```

Edit 3b - the rate limiter import. Replace:
```ts
import { resolveWithSettings } from '../messages/index.js';
```
with:
```ts
import { resolveWithSettings } from '../messages/index.js';
import { createRateLimit } from '../middleware/rateLimit.js';
```

Edit 3c - the org list repo import. Replace:
```ts
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
```
with:
```ts
import { createOrgListRepo, type OrgListRepo } from '../repos/orgListRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
```

Edit 3d - the publicOrgList import. Replace:
```ts
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
```
with:
```ts
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import {
  PUBLIC_LIST_RATE_LIMIT,
  housingAuthorityNames,
  loadPublicOrgEntries,
} from '../services/publicOrgList.js';
```

Edit 3e - the file header's route list. Replace these two lines (header
lines 20-21):
```ts
//        -> 404 { error, contact_number }   (missing/deleted/not-shareable;
//           flyer-full-info: the teaser/reveal split + the /details route are gone)
```
with:
```ts
//        -> 404 { error, contact_number }   (missing/deleted/not-shareable;
//           flyer-full-info: the teaser/reveal split + the /details route are gone)
//   GET  /public/housing-authorities   (join-housing-authority D1/D2; built by
//        createPublicHousingAuthoritiesRouter below and mounted in app.ts AHEAD
//        of this router, with its own 60-per-minute per-IP limit)
//        -> 200 { names: string[] }   (the housing authority names on the org
//           list, sorted; Cache-Control: no-store; never writes the list)
```

Edit 3f - the new router, appended after `createPublicRouter`. Replace the
end of the file:
```ts
  return router;
}
```
with:
```ts
  return router;
}

export interface PublicHousingAuthoritiesDeps {
  logger?: Logger;
  orgListRepo?: OrgListRepo;
  /** Test seam: the limiter's client-key resolver. */
  rateLimitKeyOf?: (req: Request) => string;
}

/**
 * GET /public/housing-authorities (join-housing-authority D1, D2) - the /join
 * form's housing authority dropdown. Its OWN router so app.ts can mount it
 * IMMEDIATELY BEFORE the shared /public mount: it defines this one GET route,
 * with a hard-coded 60-per-minute per-IP limiter on the route alone, so the
 * read never consumes - and is never blocked by - the shared limiter in front
 * of createPublicRouter. Every other request matches nothing here and falls
 * through to that mount unchanged.
 *
 * 200 { names }: the exact stored names of the housing authority entries,
 * sorted (services/publicOrgList.ts). Nothing else leaves: no ids, spellings,
 * notes, audit fields or agencies. It never writes the list item (peek, else
 * the starting list in memory). A read failure propagates to the app's error
 * handler: the generic 500. no-store: nothing may cache a stale list.
 */
export function createPublicHousingAuthoritiesRouter(deps: PublicHousingAuthoritiesDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const orgList = deps.orgListRepo ?? createOrgListRepo({ logger: deps.logger });
  const router = Router();
  router.get(
    '/housing-authorities',
    createRateLimit({ ...PUBLIC_LIST_RATE_LIMIT, logger: log, keyOf: deps.rateLimitKeyOf }),
    async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const entries = await loadPublicOrgEntries(orgList);
      res.json({ names: housingAuthorityNames(entries) });
    },
  );
  return router;
}
```

Step 4 - run it GREEN:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicHousingAuthoritiesRouter.test.ts`
Expected: 1 file passed, 5 tests passed, 0 failed.
Then the regression file, unchanged so far:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
Expected: 29 tests passed, 0 failed (the router is not mounted yet).

Step 5 - commit.
1. `cd "W:/tmp/join-housing-authority" && git status` - only
   `app/src/routes/public.ts` (modified) and
   `app/test/publicHousingAuthoritiesRouter.test.ts` (untracked).
2. `cd "W:/tmp/join-housing-authority" && test -e "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE_HEAD PRESENT - STOP" || echo "no merge in progress"`
3. `cd "W:/tmp/join-housing-authority" && tr -d '\11\12\15\40-\176' < app/test/publicHousingAuthoritiesRouter.test.ts | wc -c`
   prints 0, and
   `cd "W:/tmp/join-housing-authority" && git diff -U0 -- app/src/routes/public.ts | grep '^+' | LC_ALL=C grep -c $'[^\t -~]'`
   prints 0.
4. `cd "W:/tmp/join-housing-authority" && git add app/src/routes/public.ts app/test/publicHousingAuthoritiesRouter.test.ts`
5. `cd "W:/tmp/join-housing-authority" && git commit -m "feat(public): GET /housing-authorities router with its own 60/min limit" -m "join-housing-authority D1/D2: createPublicHousingAuthoritiesRouter defines only GET /housing-authorities, answers { names } with Cache-Control: no-store, never writes the org list, and carries its own per-IP limiter (60 per minute) on that route alone. Not mounted yet." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 1.3 - mount the list read ahead of the shared /public limiter

Files:
- Modify `app/src/routes/public.ts` (`PublicRouterDeps.orgListRepo`)
- Modify `app/src/app.ts` (import + mount)
- Modify `app/test/helpers/twilioWebhookHarness.ts` (`public` deps)
- Modify `app/test/publicIntake.test.ts` (imports + two new describe blocks)
- Proof only (no edit): `app/test/cloudfrontBehaviors.test.ts`

Step 1 - write the failing tests in `app/test/publicIntake.test.ts`.

Edit 1a - the vitest import. Replace:
```ts
import { describe, expect, it } from 'vitest';
```
with:
```ts
import { describe, expect, it, vi } from 'vitest';
```

Edit 1b - the org types import. Replace:
```ts
import type { ContactItem } from '../src/repos/contactsRepo.js';
```
with:
```ts
import type { OrgEntry, OrgKind } from '../src/lib/orgNames.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
```

Edit 1c - append two describe blocks at the END of the file. Anchor (the
current last six lines of the file):
```ts
    expect(res.body.flyer.media).toEqual([
      '/unit-media/unit-photo/stored',
      'https://legacy.example/p.jpg',
    ]);
  });
});
```
Replace with those same six lines followed by:
```ts

// ---------------------------------------------------------------------------
// join-housing-authority D1/D2: GET /public/housing-authorities through the
// FULL app - its mount ahead of the shared /public limiter, the origin-secret
// chain, the generic 500, and the two independent limits.
// ---------------------------------------------------------------------------

const LIST = '/public/housing-authorities';

describe('GET /public/housing-authorities - the public list read (D1)', () => {
  /** The starting list's housing authority names in D1 order. */
  const STARTING_AUTHORITY_NAMES = [
    'Atlanta Housing Authority',
    'Augusta Housing Authority',
    'College Park Housing Authority',
    'Decatur Housing Authority',
    'DeKalb County Housing Authority',
    'East Point Housing Authority',
    'Fulton County Housing Authority',
    'Georgia Department of Community Affairs',
    'Georgia Housing Voucher Program (DBHDD)',
    'Jonesboro Housing Authority',
    'Macon-Bibb County Housing Authority',
    'Marietta Housing Authority',
  ];

  function listEntry(kind: OrgKind, name: string): OrgEntry {
    return {
      orgId: `org-${name}`,
      kind,
      name,
      spellings: [`${name} spelling`],
      notes: 'internal note',
      createdAt: '2026-10-12T00:00:00.000Z',
      createdBy: 'test',
      updatedAt: '2026-10-12T00:00:00.000Z',
      updatedBy: 'test',
    };
  }

  it('serves the starting list from memory on an empty store: authority names only, sorted, no-store, nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ names: STARTING_AUTHORITY_NAMES });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await world.orgListRepo.peek()).toBeNull();
  });

  it('serves the STORED list: housing_authority names only, case-insensitive order, no ids/spellings/notes/agencies', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed({
      settingId: 'org-list',
      version: 7,
      entries: [
        listEntry('housing_authority', 'zeta Housing Authority'),
        listEntry('agency', 'Alpha Agency'),
        listEntry('housing_authority', 'Banana Housing Authority'),
        listEntry('housing_authority', 'apple Housing Authority'),
      ],
    });
    const get = vi.spyOn(world.orgListRepo, 'get');
    const mutate = vi.spyOn(world.orgListRepo, 'mutate');
    const putForSeed = vi.spyOn(world.orgListRepo, 'putForSeed');

    const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      names: ['apple Housing Authority', 'Banana Housing Authority', 'zeta Housing Authority'],
    });
    const serialized = JSON.stringify(res.body);
    for (const leaked of ['org-', 'spelling', 'internal note', 'Alpha Agency', 'createdBy']) {
      expect(serialized, leaked).not.toContain(leaked);
    }
    expect(get).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(putForSeed).not.toHaveBeenCalled();
  });

  it('a list read failure is the generic 500', async () => {
    const { app, world } = makeWebhookHarness();
    vi.spyOn(world.orgListRepo, 'peek').mockRejectedValue(new Error('settings table unavailable'));
    const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
  });

  it('sits behind the origin-secret validator like every /public route', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).get(LIST)).status).toBe(403);
  });
});

describe('GET /public/housing-authorities - its own limit, independent of the shared /public limit (D2)', () => {
  it('stays readable after the shared /public limit is exhausted, and does not touch that window', async () => {
    const { app } = makeWebhookHarness({
      env: { PUBLIC_RATE_LIMIT_MAX: '2', PUBLIC_RATE_LIMIT_WINDOW_MS: '60000' },
    });
    const bad = { firstName: 'A', lastName: 'B' }; // 400 at the handler
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(400);
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(400);
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(429);

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
      expect(res.status, `list read ${i + 1}`).toBe(200);
    }
    // The shared window is still exhausted: the list reads neither reset nor used it.
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(429);
  });

  it('allows 60 reads per minute per IP, refuses the 61st, and never consumes or is blocked by the shared limit', async () => {
    const { app } = makeWebhookHarness({
      env: { PUBLIC_RATE_LIMIT_MAX: '2', PUBLIC_RATE_LIMIT_WINDOW_MS: '60000' },
    });
    for (let i = 0; i < 60; i += 1) {
      const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
      expect(res.status, `list read ${i + 1}`).toBe(200);
    }
    const limited = await request(app).get(LIST).set('x-origin-verify', SECRET);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(limited.headers['retry-after']).toBeDefined();

    // The shared limit still has BOTH of its 2 slots: 61 list reads consumed
    // none, and the exhausted list limit does not block the other routes.
    const bad = { firstName: 'A', lastName: 'B' };
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(400);
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(400);
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(429);
  });

  it('(PIN) another method on the list path falls through to the shared /public mount and its limiter', async () => {
    const { app } = makeWebhookHarness({
      env: { PUBLIC_RATE_LIMIT_MAX: '1', PUBLIC_RATE_LIMIT_WINDOW_MS: '60000' },
    });
    // Not the list route: it passes the shared limiter (its single slot) and matches nothing.
    const post = await request(app).post(LIST).set('x-origin-verify', SECRET).send({});
    expect(post.status).toBe(404);
    // Proof it went through the shared limiter: the flyer route is now limited.
    const flyer = await request(app).get('/public/units/nope/flyer').set('x-origin-verify', SECRET);
    expect(flyer.status).toBe(429);
  });
});
```

Step 2 - run it RED:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
Expected: the 29 existing tests pass; of the 7 new tests, 5 FAIL and 2 pass:
- "serves the starting list ..." - `expected 404 to be 200` (no route
  mounted; the request falls through the shared limiter to a 404);
- "serves the STORED list ..." - `expected 404 to be 200`;
- "a list read failure is the generic 500" - `expected 404 to be 500`;
- "stays readable after the shared /public limit is exhausted ..." -
  `list read 1: expected 429 to be 200` (today the shared limiter fronts it);
- "allows 60 reads per minute ..." - `list read 1: expected 404 to be 200`;
- "sits behind the origin-secret validator" passes (403 today too - a pin);
- "(PIN) another method on the list path ..." passes (a pin).
Exit code 1.

Step 3 - implement.

Edit 3a - `app/src/routes/public.ts`, the deps interface. Replace:
```ts
  settingsRepo?: SettingsRepo;
  sendMessageService?: SendMessageService;
```
with:
```ts
  settingsRepo?: SettingsRepo;
  sendMessageService?: SendMessageService;
  /**
   * join-housing-authority D1/D3: the organization list. The sign-up's housing
   * authority check reads it (peek only - the public surface never creates
   * it), and app.ts hands the SAME repo to createPublicHousingAuthoritiesRouter.
   * Default createOrgListRepo().
   */
  orgListRepo?: OrgListRepo;
```

Edit 3b - `app/src/app.ts`, the import. Replace:
```ts
import { createPublicRouter, type PublicRouterDeps } from './routes/public.js';
```
with:
```ts
import {
  createPublicHousingAuthoritiesRouter,
  createPublicRouter,
  type PublicRouterDeps,
} from './routes/public.js';
```

Edit 3c - `app/src/app.ts`, the mount, IMMEDIATELY BEFORE the existing
`/public` mount. Replace:
```ts
  const mediaServeStore = createMediaStore({ config });
  app.use(
    '/public',
    createRateLimit({
```
with:
```ts
  const mediaServeStore = createMediaStore({ config });
  // join-housing-authority D1/D2: the public housing authority list read
  // (GET /public/housing-authorities), mounted IMMEDIATELY BEFORE the shared
  // /public mount below. It defines that one GET route, with its own
  // hard-coded 60-per-minute per-IP limiter on the route alone (the
  // /unit-media precedent: no env var). Every other /public request matches
  // nothing here and falls through to the shared mount and its limiter
  // exactly as before; the list read never consumes, and is never blocked by,
  // the shared limit. Same prefix, so the edge classification
  // (EDGE_MUTATING_PREFIXES) and CloudFront's /public/* behavior cover it.
  app.use(
    '/public',
    createPublicHousingAuthoritiesRouter({
      logger: log,
      ...(deps.public?.orgListRepo !== undefined && { orgListRepo: deps.public.orgListRepo }),
    }),
  );
  app.use(
    '/public',
    createRateLimit({
```

Edit 3d - `app/test/helpers/twilioWebhookHarness.ts`, the `public` deps (the
world's org list fake for both /public mounts). Replace:
```ts
      unitsRepo: world.unitsRepo,
      auditRepo: world.auditRepo,
      // The housing-fair welcome reads the operator's welcomeText override (with
```
with:
```ts
      unitsRepo: world.unitsRepo,
      auditRepo: world.auditRepo,
      // join-housing-authority: the org list the public list read
      // (GET /public/housing-authorities) and the sign-up's housing authority
      // check read - the SAME fake the /api org routes use. app.ts hands it to
      // both /public mounts.
      orgListRepo: world.orgListRepo,
      // The housing-fair welcome reads the operator's welcomeText override (with
```

Step 4 - run GREEN:
1. `cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
   Expected: 36 tests passed, 0 failed.
2. The edge guard still passes (D2: no new prefix; the second
   `app.use('/public'` is the already-classified `/public`):
   `cd "W:/tmp/join-housing-authority/app" && npx vitest run test/cloudfrontBehaviors.test.ts`
   Expected: 9 tests passed, 0 failed.
3. `cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicOrgList.test.ts`
   and
   `cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicHousingAuthoritiesRouter.test.ts`
   Expected: 9 and 5 passed.
4. Typecheck (vitest strips types):
   `cd "W:/tmp/join-housing-authority/app" && npx tsc -p tsconfig.json --noEmit`
   and
   `cd "W:/tmp/join-housing-authority/app" && npx tsc -p tsconfig.test.json --noEmit`
   Expected: both exit 0 with no output.
5. Lint the S1 files:
   `cd "W:/tmp/join-housing-authority" && npx eslint app/src/services/publicOrgList.ts app/src/routes/public.ts app/src/app.ts app/test/publicOrgList.test.ts app/test/publicHousingAuthoritiesRouter.test.ts app/test/publicIntake.test.ts app/test/helpers/twilioWebhookHarness.ts`
   Expected: exit 0, no errors. If any error appears, attribute it by the
   AGENTS.md gate 5 baseline comparison (same command at the merge base);
   only errors absent there are this slice's and must be fixed.

Step 5 - commit.
1. `cd "W:/tmp/join-housing-authority" && git status` - only
   `app/src/routes/public.ts`, `app/src/app.ts`,
   `app/test/helpers/twilioWebhookHarness.ts` and
   `app/test/publicIntake.test.ts` (all modified).
2. `cd "W:/tmp/join-housing-authority" && test -e "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE_HEAD PRESENT - STOP" || echo "no merge in progress"`
3. `cd "W:/tmp/join-housing-authority" && git diff -U0 -- app/src/routes/public.ts app/src/app.ts app/test/helpers/twilioWebhookHarness.ts app/test/publicIntake.test.ts | grep '^+' | LC_ALL=C grep -c $'[^\t -~]'`
   prints 0.
4. `cd "W:/tmp/join-housing-authority" && git add app/src/routes/public.ts app/src/app.ts app/test/helpers/twilioWebhookHarness.ts app/test/publicIntake.test.ts`
5. `cd "W:/tmp/join-housing-authority" && git commit -m "feat(app): mount the housing authority list read ahead of the shared /public limiter" -m "join-housing-authority D1/D2: GET /public/housing-authorities is mounted with app.use('/public') immediately before the shared /public mount, so it has its own 60/min limit and never consumes or is blocked by the shared one. PublicRouterDeps gains orgListRepo; the test harness hands the world's org list fake to both /public mounts. The edge guard test still passes (no new prefix)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### S2 - the sign-up changes in `POST /public/housing-fair` (Tasks 2.1-2.4)

Before Task 2.1, confirm S1 is in: lines 7-8 of
`app/test/publicIntake.test.ts` read
`import { describe, expect, it, vi } from 'vitest';` and
`import type { OrgEntry, OrgKind } from '../src/lib/orgNames.js';` (Task 1.3,
Edits 1a/1b), and `app/src/routes/public.ts` imports
`createOrgListRepo, type OrgListRepo` and the three `publicOrgList` names
(Task 1.2, Edits 3c/3d). If any is missing, apply that edit first.

#### Task 2.1 - the `housingAuthority` shape check and the unitId + authority refusal (D3 shape, D4)

Files:
- Modify `app/src/routes/public.ts` (`HousingFairFields`,
  `parseHousingFairBody`, one import)
- Modify `app/test/publicIntake.test.ts` (one new describe block)

Step 1 - write the failing tests. Append at the END of
`app/test/publicIntake.test.ts`. Anchor (the current last four lines of the
file, from Task 1.3):
```ts
    const flyer = await request(app).get('/public/units/nope/flyer').set('x-origin-verify', SECRET);
    expect(flyer.status).toBe(429);
  });
});
```
Replace with those same four lines followed by:
```ts

// ---------------------------------------------------------------------------
// join-housing-authority D3-D7: the sign-up's housingAuthority.
// ---------------------------------------------------------------------------

describe('POST /public/housing-fair - housingAuthority shape and the flyer refusal (D3, D4)', () => {
  function harness() {
    return makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
  }

  it('refuses a non-string, an empty, a blank and an over-long housingAuthority with the generic 400, writing nothing', async () => {
    const { app, world } = harness();
    for (const bad of [
      42,
      true,
      ['Atlanta Housing Authority'],
      { name: 'Atlanta Housing Authority' },
      '',
      '   ', // trimmed to '' by the body trim
      'A'.repeat(121), // ORG_NAME_MAX is 120
    ]) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', SECRET)
        .send(signupBody({ housingAuthority: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body, JSON.stringify(bad)).toEqual({ error: 'invalid request' });
    }
    expect(world.contacts).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('refuses unitId + housingAuthority with the generic 400 whatever the unit is, without reading the unit', async () => {
    const { app, world } = harness();
    world.units.set('unit-flyer', { unitId: 'unit-flyer', landlordId: 'll-1', status: 'available', beds: 2 });
    world.units.set('unit-placed', { unitId: 'unit-placed', landlordId: 'll-1', status: 'placed', beds: 2 });
    const getById = vi.spyOn(world.unitsRepo, 'getById');
    const bodies: unknown[] = [];
    for (const unitId of ['unit-flyer', 'no-such-unit', 'unit-placed']) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', SECRET)
        .send(signupBody({ unitId, housingAuthority: 'Atlanta Housing Authority' }));
      expect(res.status, unitId).toBe(400);
      bodies.push(res.body);
    }
    // Identical for a shareable, a missing and a non-shareable unit: no oracle.
    expect(bodies).toEqual([
      { error: 'invalid request' },
      { error: 'invalid request' },
      { error: 'invalid request' },
    ]);
    expect(world.contacts).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(getById).not.toHaveBeenCalled();
  });
});
```

Step 2 - run it RED:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
Expected: the 36 earlier tests pass; both new tests FAIL - the first with
`42: expected 200 to be 400` (the field is ignored today), the second with
`unit-flyer: expected 200 to be 400`. Exit code 1.

Step 3 - implement in `app/src/routes/public.ts`.

Edit 3a - the import. Replace:
```ts
import { normalizeToE164 } from '../lib/phone.js';
```
with:
```ts
import { ORG_NAME_MAX } from '../lib/orgNames.js';
import { normalizeToE164 } from '../lib/phone.js';
```

Edit 3b - the fields interface. Replace:
```ts
  /** Optional flyer unit-of-interest (validated as shareable in the handler). */
  unitId?: string;
}
```
with:
```ts
  /** Optional flyer unit-of-interest (validated as shareable in the handler). */
  unitId?: string;
  /** join-housing-authority D3: the /join form's choice; shape-checked here, list-checked in the handler. */
  housingAuthority?: string;
}
```

Edit 3c - the parser's doc comment. Replace:
```ts
 * rejected, voucherSize (optional) is an integer 0..12.
```
with:
```ts
 * rejected, voucherSize (optional) is an integer 0..12, housingAuthority
 * (optional; join-housing-authority D3) is a string of 1 to ORG_NAME_MAX
 * characters after the app-wide body trim - whether it is ON the list is the
 * handler's check - and a request carrying both a unitId and a
 * housingAuthority is refused outright (D4).
```

Edit 3d - the parser body. Replace:
```ts
    unitId = u;
  }

  return {
    firstName,
    lastName,
    phone,
    ...(voucherSize !== undefined && { voucherSize }),
    ...(unitId !== undefined && { unitId }),
  };
}
```
with:
```ts
    unitId = u;
  }

  // join-housing-authority D3: the optional housing authority the /join form
  // chose. Absent or null = none. Present: a string of 1 to ORG_NAME_MAX
  // characters AFTER the app-wide JSON body trim (app.ts trimJsonBody), else
  // the generic error. Whether it is ON the list is decided in the handler,
  // before any write - not here.
  let housingAuthority: string | undefined;
  if ('housingAuthority' in b && b['housingAuthority'] !== undefined && b['housingAuthority'] !== null) {
    const h = b['housingAuthority'];
    if (typeof h !== 'string' || h.length === 0 || h.length > ORG_NAME_MAX) {
      return { error: 'invalid request' };
    }
    housingAuthority = h;
  }

  // D4: a flyer sign-up (a present, non-null unitId) never carries a housing
  // authority - the flyer page shows no select. Refused with the generic error,
  // keyed on the PRESENCE of unitId and decided before the unit is ever read,
  // so the refusal reveals nothing about whether the unit exists or is shareable.
  if (unitId !== undefined && housingAuthority !== undefined) {
    return { error: 'invalid request' };
  }

  return {
    firstName,
    lastName,
    phone,
    ...(voucherSize !== undefined && { voucherSize }),
    ...(unitId !== undefined && { unitId }),
    ...(housingAuthority !== undefined && { housingAuthority }),
  };
}
```

Step 4 - run it GREEN:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
Expected: 38 tests passed, 0 failed.

Step 5 - commit.
1. `cd "W:/tmp/join-housing-authority" && git status` - only
   `app/src/routes/public.ts` and `app/test/publicIntake.test.ts` (modified).
2. `cd "W:/tmp/join-housing-authority" && test -e "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE_HEAD PRESENT - STOP" || echo "no merge in progress"`
3. `cd "W:/tmp/join-housing-authority" && git diff -U0 -- app/src/routes/public.ts app/test/publicIntake.test.ts | grep '^+' | LC_ALL=C grep -c $'[^\t -~]'`
   prints 0.
4. `cd "W:/tmp/join-housing-authority" && git add app/src/routes/public.ts app/test/publicIntake.test.ts`
5. `cd "W:/tmp/join-housing-authority" && git commit -m "feat(public): housing-fair parses an optional housingAuthority and refuses it with a unitId" -m "join-housing-authority D3 (shape) and D4: housingAuthority is absent/null or a string of 1-120 characters after the body trim, else the generic 400; a request carrying both a unitId and a housingAuthority is the generic 400 before any unit read. Not stored yet." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 2.2 - the list check before any write (D3 list, `housing_authority_not_listed`)

Files:
- Modify `app/src/routes/public.ts` (imports, the default org list repo, the
  handler's list check)
- Modify `app/test/publicIntake.test.ts` (one new describe block)

Step 1 - write the failing tests. Append at the END of
`app/test/publicIntake.test.ts`. Anchor (the current last four lines of the
file, from Task 2.1):
```ts
    expect(world.sent).toHaveLength(0);
    expect(getById).not.toHaveBeenCalled();
  });
});
```
Replace with those same four lines followed by:
```ts

describe('POST /public/housing-fair - the housing authority must be on the list (D3)', () => {
  function harness() {
    return makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
  }

  function orgEntry(kind: OrgKind, name: string): OrgEntry {
    return {
      orgId: `org-${name}`,
      kind,
      name,
      spellings: [],
      createdAt: '2026-10-12T00:00:00.000Z',
      createdBy: 'test',
      updatedAt: '2026-10-12T00:00:00.000Z',
      updatedBy: 'test',
    };
  }

  it('refuses an unlisted name, a spelling, another case and an agency name with housing_authority_not_listed, writing nothing', async () => {
    const { app, world } = harness();
    for (const value of [
      'Springfield Housing Authority', // not on the list
      'AHA', // a spelling of Atlanta Housing Authority
      'atlanta housing authority', // the name in another case
      'Step Up', // an agency, not a housing authority
      'A'.repeat(120), // the longest shape accepted, still not a name
    ]) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', SECRET)
        .send(signupBody({ housingAuthority: value }));
      expect(res.status, value).toBe(400);
      expect(res.body, value).toEqual({ error: 'housing_authority_not_listed' });
    }
    expect(world.contacts).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(world.auditEvents).toHaveLength(0);
    // The check read the list without creating it.
    expect(await world.orgListRepo.peek()).toBeNull();
  });

  it('refuses an unlisted name for an EXISTING phone too, before any write (no thread, no welcome, no audit, no change)', async () => {
    const { app, world } = harness();
    world.contacts.push({
      contactId: 'c-existing',
      type: 'tenant',
      status: 'searching',
      phone: '+15550102000',
      firstName: 'Keisha',
      lastName: 'Jones',
      housing_fair_welcomed: false,
    } as ContactItem);
    const before = structuredClone(world.contacts[0]);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Springfield Housing Authority' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'housing_authority_not_listed' });
    expect(world.contacts).toEqual([before]);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('checks against the STORED list when there is one (a renamed authority is no longer listed)', async () => {
    const { app, world } = harness();
    await world.orgListRepo.putForSeed({
      settingId: 'org-list',
      version: 4,
      entries: [
        orgEntry('housing_authority', 'Housing Authority of the City of Atlanta'),
        orgEntry('agency', 'Step Up'),
      ],
    });

    const stale = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(stale.status).toBe(400);
    expect(stale.body).toEqual({ error: 'housing_authority_not_listed' });
    expect(world.contacts).toHaveLength(0);

    const current = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Housing Authority of the City of Atlanta' }));
    expect(current.status).toBe(200);
    expect(current.body).toEqual({ ok: true });
    expect(world.contacts).toHaveLength(1);
  });

  it('accepts a listed name, reading the list once with peek() and never creating the item', async () => {
    const { app, world } = harness();
    const peek = vi.spyOn(world.orgListRepo, 'peek');
    const get = vi.spyOn(world.orgListRepo, 'get');
    const mutate = vi.spyOn(world.orgListRepo, 'mutate');
    const putForSeed = vi.spyOn(world.orgListRepo, 'putForSeed');

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(peek).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(putForSeed).not.toHaveBeenCalled();
    peek.mockRestore();
    expect(await world.orgListRepo.peek()).toBeNull();
  });

  it('a list read failure is the generic 500 and nothing is written', async () => {
    const { app, world } = harness();
    vi.spyOn(world.orgListRepo, 'peek').mockRejectedValue(new Error('settings table unavailable'));
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    expect(world.contacts).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
  });

  it('(PIN) reads no list when no housingAuthority is sent (absent or null)', async () => {
    const { app, world } = harness();
    const peekWithoutAuthority = vi.spyOn(world.orgListRepo, 'peek');
    const absent = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    const nulled = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '(555) 010-2001', housingAuthority: null }));
    expect(absent.status).toBe(200);
    expect(nulled.status).toBe(200);
    expect(peekWithoutAuthority).not.toHaveBeenCalled();
  });
});
```

Step 2 - run it RED:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
Expected: the 38 earlier tests pass; of the 6 new tests, 5 FAIL and 1
passes:
- "refuses an unlisted name ..." - `Springfield Housing Authority: expected 200 to be 400`;
- "refuses an unlisted name for an EXISTING phone ..." - `expected 200 to be 400`;
- "checks against the STORED list ..." - `expected 200 to be 400`;
- "accepts a listed name, reading the list once ..." - the peek spy was
  called 0 times, expected 1;
- "a list read failure is the generic 500 ..." - `expected 200 to be 500`;
- "(PIN) reads no list ..." passes.
Exit code 1.

Step 3 - implement in `app/src/routes/public.ts`.

Edit 3a - the orgNames import (added in Task 2.1). Replace:
```ts
import { ORG_NAME_MAX } from '../lib/orgNames.js';
```
with:
```ts
import { KINDS_FOR_FIELD, ORG_NAME_MAX, isOnListFor } from '../lib/orgNames.js';
```

Edit 3b - the publicOrgList import (added in Task 1.2). Replace:
```ts
import {
  PUBLIC_LIST_RATE_LIMIT,
  housingAuthorityNames,
  loadPublicOrgEntries,
} from '../services/publicOrgList.js';
```
with:
```ts
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  PUBLIC_LIST_RATE_LIMIT,
  housingAuthorityNames,
  loadPublicOrgEntries,
} from '../services/publicOrgList.js';
```

Edit 3c - the default repo inside `createPublicRouter`. Replace:
```ts
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
```
with:
```ts
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  // join-housing-authority D3: the list a sign-up's housing authority is checked
  // against (read with peek() only - the public surface never creates it).
  const orgList = deps.orgListRepo ?? createOrgListRepo({ logger: deps.logger });
```

Edit 3d - the handler's list check, right after the parse. Replace:
```ts
    const { firstName, lastName, phone, voucherSize, unitId } = parsed;
    const marker = phoneMarker(phone);
    mergeContext({}); // keep this request's log lines correlated (no PII added)
```
with:
```ts
    const { firstName, lastName, phone, voucherSize, unitId, housingAuthority } = parsed;
    const marker = phoneMarker(phone);
    mergeContext({}); // keep this request's log lines correlated (no PII added)

    // join-housing-authority D3: the list check, BEFORE the unit or contact
    // reads and before any write, for a new and an existing phone alike. The
    // list is read ONLY when an authority was sent, from the source the public
    // list read serves (peek, else the starting list in memory - never a
    // write). The value must be character-for-character the name of a
    // housing_authority entry: no case, spelling or agency resolution. The
    // distinct code lets the /join form recover; the list is public, so the
    // code reveals nothing. A read failure propagates: the generic 500.
    if (housingAuthority !== undefined) {
      const entries = await loadPublicOrgEntries(orgList);
      if (!isOnListFor(entries, housingAuthority, KINDS_FOR_FIELD.housingAuthority)) {
        res.status(400).json({ error: HOUSING_AUTHORITY_NOT_LISTED });
        return;
      }
    }
```

Step 4 - run it GREEN:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
Expected: 44 tests passed, 0 failed.

Step 5 - commit.
1. `cd "W:/tmp/join-housing-authority" && git status` - only
   `app/src/routes/public.ts` and `app/test/publicIntake.test.ts` (modified).
2. `cd "W:/tmp/join-housing-authority" && test -e "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE_HEAD PRESENT - STOP" || echo "no merge in progress"`
3. `cd "W:/tmp/join-housing-authority" && git diff -U0 -- app/src/routes/public.ts app/test/publicIntake.test.ts | grep '^+' | LC_ALL=C grep -c $'[^\t -~]'`
   prints 0.
4. `cd "W:/tmp/join-housing-authority" && git add app/src/routes/public.ts app/test/publicIntake.test.ts`
5. `cd "W:/tmp/join-housing-authority" && git commit -m "feat(public): housing-fair refuses an unlisted housing authority before any write" -m "join-housing-authority D3: when a housingAuthority is sent, the sign-up reads the org list (peek, else the starting list in memory; never a write) and refuses a value that is not exactly a housing_authority name with 400 housing_authority_not_listed, for new and existing phones alike, before any read of the unit or contact and before any write. A list read failure is the generic 500." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 2.3 - Onboarding start, the stored authority, the v2 marker; stale comments (D5, D6)

Files:
- Modify `app/src/routes/public.ts` (header, create comment, create input)
- Modify `app/test/publicIntake.test.ts` (the existing `needs_review`
  assertion + one new describe block)

Step 1 - write the failing tests.

Edit 1a - the existing first test's title (it asserts the old status).
Replace:
```ts
  it('captures a tenant (needs_review), sends ONE welcome text, returns only { ok: true }', async () => {
```
with:
```ts
  it('captures a tenant (onboarding, with the v2 marker), sends ONE welcome text, returns only { ok: true }', async () => {
```

Edit 1b - its comment. Replace:
```ts
    // A tenant contact was captured for the normalized phone, to the triage queue,
```
with:
```ts
    // A tenant contact was captured for the normalized phone, as Onboarding with the
    // v2 marker (join-housing-authority D5) and no housing authority (none was sent),
```

Edit 1c - its assertion. Replace:
```ts
    expect(contact).toMatchObject({
      type: 'tenant',
      status: 'needs_review',
      firstName: 'Keisha',
      capture_source: 'housing_fair',
```
with:
```ts
    expect(contact).toMatchObject({
      type: 'tenant',
      status: 'onboarding',
      housing_fair_signup_v2: true,
      firstName: 'Keisha',
      capture_source: 'housing_fair',
```
and directly below that `toMatchObject` block, replace:
```ts
    expect(typeof contact?.consent_at).toBe('string');

    // Exactly one welcome text went out, to that phone, with the rendered body.
```
with:
```ts
    expect(typeof contact?.consent_at).toBe('string');
    expect(Object.keys(contact ?? {})).not.toContain('housingAuthority');

    // Exactly one welcome text went out, to that phone, with the rendered body.
```

Edit 1d - append at the END of the file. Anchor (the current last five lines
of the file, from Task 2.2):
```ts
    expect(absent.status).toBe(200);
    expect(nulled.status).toBe(200);
    expect(peekWithoutAuthority).not.toHaveBeenCalled();
  });
});
```
Replace with those same five lines followed by:
```ts

describe('POST /public/housing-fair - new contacts start Onboarding with the marker; existing ones are untouched (D5, D6)', () => {
  function harness() {
    return makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
  }

  it('a /join sign-up with a listed authority creates an onboarding tenant holding it and the marker', async () => {
    const { app, world } = harness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'DeKalb County Housing Authority' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({
      type: 'tenant',
      status: 'onboarding',
      housingAuthority: 'DeKalb County Housing Authority',
      housing_fair_signup_v2: true,
      capture_source: 'housing_fair',
      consent_method: 'web_form',
      consent_version: 'ctia-2026-06',
    });
    expect(contact?.['unit_of_interest']).toBeUndefined();
    // The welcome text is unchanged.
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.body).toBe(WELCOME_TEXT_TEMPLATE.replace('{firstName}', 'Keisha'));
  });

  it('a /join sign-up with no authority (absent or null) creates an onboarding tenant with the marker and no authority', async () => {
    const { app, world } = harness();
    await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '(555) 010-2001', housingAuthority: null }));
    for (const phone of ['+15550102000', '+15550102001']) {
      const contact = world.contacts.find((c) => c.phone === phone);
      expect(contact, phone).toMatchObject({
        type: 'tenant',
        status: 'onboarding',
        housing_fair_signup_v2: true,
        capture_source: 'housing_fair',
      });
      expect(Object.keys(contact ?? {}), phone).not.toContain('housingAuthority');
    }
  });

  it('a null unitId is no unitId: the authority is kept and the contact starts onboarding', async () => {
    const { app, world } = harness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: null, housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(world.contacts.find((c) => c.phone === '+15550102000')).toMatchObject({
      status: 'onboarding',
      housingAuthority: 'Atlanta Housing Authority',
      housing_fair_signup_v2: true,
      capture_source: 'housing_fair',
    });
  });

  it('padded text is trimmed by the body trim and accepted as the listed name it becomes', async () => {
    const { app, world } = harness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: '   Atlanta Housing Authority  ' }));
    expect(res.status).toBe(200);
    expect(world.contacts.find((c) => c.phone === '+15550102000')?.housingAuthority).toBe(
      'Atlanta Housing Authority',
    );
  });

  it('a flyer sign-up for a shareable unit behaves as today (needs_review, flyer, no authority) plus the marker', async () => {
    const { app, world } = harness();
    world.units.set('unit-flyer', { unitId: 'unit-flyer', landlordId: 'll-1', status: 'available', beds: 2 });
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-flyer' }));
    expect(res.status).toBe(200);
    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({
      type: 'tenant',
      status: 'needs_review',
      capture_source: 'flyer',
      unit_of_interest: 'unit-flyer',
      housing_fair_signup_v2: true,
    });
    expect(Object.keys(contact ?? {})).not.toContain('housingAuthority');
    expect(world.sent).toHaveLength(1);
  });

  it('a flyer sign-up for a missing or non-shareable unit keeps needs_review and housing_fair, plus the marker', async () => {
    const { app, world } = harness();
    world.units.set('unit-placed', { unitId: 'unit-placed', landlordId: 'll-1', status: 'placed', beds: 2 });
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'no-such-unit' }));
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '(555) 010-2001', unitId: 'unit-placed' }));
    for (const phone of ['+15550102000', '+15550102001']) {
      const contact = world.contacts.find((c) => c.phone === phone);
      expect(contact, phone).toMatchObject({
        type: 'tenant',
        status: 'needs_review',
        capture_source: 'housing_fair',
        housing_fair_signup_v2: true,
      });
      expect(contact?.['unit_of_interest'], phone).toBeUndefined();
      expect(Object.keys(contact ?? {}), phone).not.toContain('housingAuthority');
    }
  });

  it('a flyer unitId with housingAuthority null is a plain flyer sign-up (needs_review, no authority)', async () => {
    const { app, world } = harness();
    world.units.set('unit-flyer', { unitId: 'unit-flyer', landlordId: 'll-1', status: 'available', beds: 2 });
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-flyer', housingAuthority: null }));
    expect(res.status).toBe(200);
    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({ status: 'needs_review', capture_source: 'flyer', housing_fair_signup_v2: true });
    expect(Object.keys(contact ?? {})).not.toContain('housingAuthority');
  });

  it('(PIN) an existing phone with a valid authority gets no authority, status or marker write (already welcomed: nothing changes)', async () => {
    const { app, world } = harness();
    world.contacts.push({
      contactId: 'c-existing',
      type: 'tenant',
      status: 'searching',
      phone: '+15550102000',
      firstName: 'Keisha',
      lastName: 'Jones',
      housingAuthority: 'Decatur Housing Authority',
      capture_source: 'housing_fair',
      housing_fair_welcomed: true,
    } as ContactItem);
    const welcomed = structuredClone(world.contacts[0]);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.contacts).toEqual([welcomed]);
    expect(world.sent).toHaveLength(0);
  });

  it('(PIN) an existing phone never welcomed gets the welcome and its flag, and nothing else', async () => {
    const { app, world } = harness();
    world.contacts.push({
      contactId: 'c-existing',
      type: 'tenant',
      status: 'needs_review',
      phone: '+15550102000',
      firstName: 'Keisha',
      lastName: 'Jones',
      capture_source: 'housing_fair',
      housing_fair_welcomed: false,
    } as ContactItem);
    const neverWelcomed = structuredClone(world.contacts[0]);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(world.sent).toHaveLength(1);
    expect(world.contacts).toEqual([{ ...neverWelcomed, housing_fair_welcomed: true }]);
  });
});
```

Step 2 - run it RED:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
Expected: the edited first test FAILS (`status: 'needs_review'` received
where `'onboarding'` is expected); of the 9 new tests, 7 FAIL (each on
`status`, `housingAuthority` or `housing_fair_signup_v2` missing) and the two
(PIN) tests pass. Every other earlier test passes. Exit code 1.

Step 3 - implement in `app/src/routes/public.ts`.

Edit 3a - the header's POST line. Replace:
```ts
//   POST /public/housing-fair  { firstName, lastName, phone, voucherSize?, unitId? }
```
with:
```ts
//   POST /public/housing-fair  { firstName, lastName, phone, voucherSize?, unitId?, housingAuthority? }
```

Edit 3b - the header's POST description. Replace:
```ts
//          unit_of_interest on the CREATED contact instead of 'housing_fair'.)
```
with:
```ts
//          unit_of_interest on the CREATED contact instead of 'housing_fair'.
//          join-housing-authority: housingAuthority (absent/null = none) must
//          be the exact name of a listed housing authority, else 400
//          housing_authority_not_listed; sent WITH a unitId it is the generic
//          400. A new contact from a request with NO unitId starts
//          'onboarding' and holds the authority; WITH a unitId it starts
//          'needs_review'. Every new contact carries housing_fair_signup_v2;
//          an existing contact is never changed beyond the welcome flag.)
```

Edit 3c - the create input's status and authority. Replace:
```ts
        status: 'needs_review',
        phone,
        firstName,
        lastName,
        ...(voucherSize !== undefined && { voucherSize }),
```
with:
```ts
        status: unitId === undefined ? 'onboarding' : 'needs_review',
        phone,
        firstName,
        lastName,
        ...(voucherSize !== undefined && { voucherSize }),
        // D5: the /join answer, on a create from a request with no unitId only
        // (D4 already refused a request carrying both), exactly as the list
        // check accepted it. Absent when none was chosen.
        ...(unitId === undefined && housingAuthority !== undefined && { housingAuthority }),
```

Edit 3d - the marker. Replace:
```ts
        captured_at: new Date().toISOString(),
        housing_fair_welcomed: false,
```
with:
```ts
        captured_at: new Date().toISOString(),
        housing_fair_welcomed: false,
        // D5: EVERY contact this endpoint creates from now on - /join and flyer
        // alike - carries the marker: "created after the housing authority
        // question shipped" (not "saw the select"). The lead backfill
        // (scripts/backfill-join-housing-authority.ts) never touches a contact
        // holding it. Never written to an existing contact (D6).
        housing_fair_signup_v2: true,
```

Step 4 - replace the stale create comment (the only edit in these slices
whose old text contains non-ASCII). In `app/src/routes/public.ts`, the five
comment lines directly above `const created = await contacts.create({` are
(lines 252-256 on main @19607658, shifted down by the earlier edits; the
second and fourth line each contain ONE U+2014 EM DASH, shown here as
`<EM DASH>`):
```
      // status 'needs_review' (review decision): fair signups go to the human
      // triage queue (type=tenant, status=needs_review on byTypeStatus) <EM DASH> the
      // team confirms before treating them as fully active. type 'tenant'
      // (the fair is a tenant intake <EM DASH> this is asserted by the form, not a
      // guess from an unknown inbound).
```
Read the file, then call Edit with `old_string` = those five lines copied
EXACTLY from your Read output (do not retype the dash), and `new_string`:
```ts
      // Status (join-housing-authority D5). A request with NO unitId - the /join
      // form, filled in by staff at housing fairs and by the public - starts the
      // tenant lifecycle at 'onboarding', like a manual create in
      // routes/contacts.ts (identity is asserted by the form). No status_source
      // is stamped, so a later placement transition can still derive the
      // lifecycle forward. A request WITH a unitId (the flyer's sign-up box)
      // keeps 'needs_review' and stores no authority, even when the unit is
      // missing or not shareable. type 'tenant': the form is a tenant intake,
      // asserted by the form, not a guess from an unknown inbound.
```
Then confirm no stale statement is left:
`cd "W:/tmp/join-housing-authority" && grep -n "needs_review" app/src/routes/public.ts`
Expected: exactly three hits - the status expression from Edit 3c, the
header line from Edit 3b, and the word `'needs_review'` in the new comment;
none says a NEW /join sign-up is `needs_review` or goes to the triage queue.

Step 5 - run it GREEN:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
Expected: 53 tests passed, 0 failed.

Step 6 - commit.
1. `cd "W:/tmp/join-housing-authority" && git status` - only
   `app/src/routes/public.ts` and `app/test/publicIntake.test.ts` (modified).
2. `cd "W:/tmp/join-housing-authority" && test -e "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE_HEAD PRESENT - STOP" || echo "no merge in progress"`
3. `cd "W:/tmp/join-housing-authority" && git diff -U0 -- app/src/routes/public.ts app/test/publicIntake.test.ts | grep '^+' | LC_ALL=C grep -c $'[^\t -~]'`
   prints 0.
4. `cd "W:/tmp/join-housing-authority" && git add app/src/routes/public.ts app/test/publicIntake.test.ts`
5. `cd "W:/tmp/join-housing-authority" && git commit -m "feat(public): new /join contacts start onboarding with the authority; every new contact gets the v2 marker" -m "join-housing-authority D5/D6: a create from a request with no unitId starts status onboarding and holds the listed housingAuthority; a request with a unitId keeps needs_review and no authority. Every new contact carries housing_fair_signup_v2: true; an existing contact gets no authority, status or marker write. The route header and the create comment no longer say a new sign-up is needs_review; the existing publicIntake assertion now expects onboarding." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 2.4 - audit `signupVersion: 2` + the requested authority; the `withAuthority` log key (D7)

Files:
- Modify `app/src/routes/public.ts` (the audit append and the log line)
- Modify `app/test/publicIntake.test.ts` (one new describe block)

Step 1 - write the failing tests. Append at the END of
`app/test/publicIntake.test.ts`. Anchor (the current last four lines of the
file, from Task 2.3):
```ts
    expect(world.sent).toHaveLength(1);
    expect(world.contacts).toEqual([{ ...neverWelcomed, housing_fair_welcomed: true }]);
  });
});
```
Replace with those same four lines followed by:
```ts

describe('POST /public/housing-fair - audit and log (D7)', () => {
  function harness() {
    return makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
  }

  it('a new /join contact with an authority: the audit records signupVersion 2 and the name; the log carries withAuthority only', async () => {
    const { app, world, capture } = harness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    const contact = world.contacts.find((c) => c.phone === '+15550102000');

    expect(world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup')).toEqual([
      {
        entityKey: `contacts#${contact?.contactId}`,
        event_type: 'housing_fair_signup',
        payload: {
          marker: expect.any(String),
          isNew: true,
          welcomeSent: true,
          viaFlyer: false,
          signupVersion: 2,
          housingAuthority: 'Atlanta Housing Authority',
        },
      },
    ]);

    const lines = capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ isNew: true, welcomeSent: true, viaFlyer: false, withAuthority: true });
    expect(JSON.stringify(lines[0])).not.toContain('Atlanta Housing Authority');
  });

  it('no authority (absent or null): housingAuthority null in the audit, withAuthority false in the log', async () => {
    const { app, world, capture } = harness();
    await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '(555) 010-2001', housingAuthority: null }));

    const payloads = world.auditEvents
      .filter((e) => e.event_type === 'housing_fair_signup')
      .map((e) => e.payload);
    expect(payloads).toEqual([
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: false,
        signupVersion: 2,
        housingAuthority: null,
      },
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: false,
        signupVersion: 2,
        housingAuthority: null,
      },
    ]);
    const lines = capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');
    expect(lines.map((l) => l['withAuthority'])).toEqual([false, false]);
  });

  it('a flyer sign-up: viaFlyer true, signupVersion 2, housingAuthority null', async () => {
    const { app, world, capture } = harness();
    world.units.set('unit-flyer', { unitId: 'unit-flyer', landlordId: 'll-1', status: 'available', beds: 2 });
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-flyer' }));
    expect(world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup').map((e) => e.payload)).toEqual([
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: true,
        signupVersion: 2,
        housingAuthority: null,
      },
    ]);
    const lines = capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');
    expect(lines[0]).toMatchObject({ viaFlyer: true, withAuthority: false });
  });

  it('an existing phone: the audit records the answer it was sent, though nothing is written to the contact', async () => {
    const { app, world, capture } = harness();
    world.contacts.push({
      contactId: 'c-existing',
      type: 'tenant',
      status: 'searching',
      phone: '+15550102000',
      firstName: 'Keisha',
      lastName: 'Jones',
      housing_fair_welcomed: true,
    } as ContactItem);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(world.contacts[0]?.housingAuthority).toBeUndefined();
    expect(world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup')).toEqual([
      {
        entityKey: 'contacts#c-existing',
        event_type: 'housing_fair_signup',
        payload: {
          marker: expect.any(String),
          isNew: false,
          welcomeSent: false,
          viaFlyer: false,
          signupVersion: 2,
          housingAuthority: 'Atlanta Housing Authority',
        },
      },
    ]);
    const lines = capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');
    expect(lines[0]).toMatchObject({ isNew: false, withAuthority: true });
  });
});
```

Step 2 - run it RED:
`cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
Expected: the 53 earlier tests pass; all 4 new tests FAIL - the audit
`toEqual` reports the payload is missing `signupVersion` and
`housingAuthority` (the first assertion to run in each). Exit code 1.

Step 3 - implement in `app/src/routes/public.ts`.

Edit 3a - the audit append. Replace:
```ts
    await audit.append(`contacts#${contactId}`, 'housing_fair_signup', {
      marker,
      isNew: existing === undefined,
      welcomeSent,
      viaFlyer,
    });
```
with:
```ts
    // join-housing-authority D7: every event from now on carries
    // signupVersion 2 (the lead backfill reads it: a pre-change lead who
    // signed up again after the change is left alone) and the authority the
    // REQUEST carried, else null - an organization name, not PII - recorded
    // for an existing contact too, though D6 writes nothing to it.
    await audit.append(`contacts#${contactId}`, 'housing_fair_signup', {
      marker,
      isNew: existing === undefined,
      welcomeSent,
      viaFlyer,
      signupVersion: 2,
      housingAuthority: housingAuthority ?? null,
    });
```

Edit 3b - the log line. Replace:
```ts
    // viaFlyer is a non-PII boolean (whether a shareable unit was attributed).
    log.info(
      { marker, isNew: existing === undefined, welcomeSent, viaFlyer },
      'housing-fair signup captured',
    );
```
with:
```ts
    // viaFlyer is a non-PII boolean (whether a shareable unit was attributed);
    // withAuthority (D7) is a boolean too - the name itself stays out of logs.
    log.info(
      {
        marker,
        isNew: existing === undefined,
        welcomeSent,
        viaFlyer,
        withAuthority: housingAuthority !== undefined,
      },
      'housing-fair signup captured',
    );
```

Step 4 - run GREEN:
1. `cd "W:/tmp/join-housing-authority/app" && npx vitest run test/publicIntake.test.ts`
   Expected: 57 tests passed, 0 failed.
2. `cd "W:/tmp/join-housing-authority/app" && npx vitest run test/cloudfrontBehaviors.test.ts`
   Expected: 9 passed.
3. Typecheck:
   `cd "W:/tmp/join-housing-authority/app" && npx tsc -p tsconfig.json --noEmit`
   and
   `cd "W:/tmp/join-housing-authority/app" && npx tsc -p tsconfig.test.json --noEmit`
   Expected: both exit 0 with no output.
4. Lint the S2 files:
   `cd "W:/tmp/join-housing-authority" && npx eslint app/src/routes/public.ts app/test/publicIntake.test.ts`
   Expected: exit 0, no errors (any error: the AGENTS.md gate 5 baseline
   comparison decides whether it is this slice's).

Step 5 - commit.
1. `cd "W:/tmp/join-housing-authority" && git status` - only
   `app/src/routes/public.ts` and `app/test/publicIntake.test.ts` (modified).
2. `cd "W:/tmp/join-housing-authority" && test -e "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE_HEAD PRESENT - STOP" || echo "no merge in progress"`
3. `cd "W:/tmp/join-housing-authority" && git diff -U0 -- app/src/routes/public.ts app/test/publicIntake.test.ts | grep '^+' | LC_ALL=C grep -c $'[^\t -~]'`
   prints 0.
4. `cd "W:/tmp/join-housing-authority" && git add app/src/routes/public.ts app/test/publicIntake.test.ts`
5. `cd "W:/tmp/join-housing-authority" && git commit -m "feat(public): housing-fair audit records signupVersion 2 and the requested authority; log gains withAuthority" -m "join-housing-authority D7: every housing_fair_signup audit event carries signupVersion: 2 and housingAuthority (the name the request carried, else null), existing contacts included. The 'housing-fair signup captured' log line gains the boolean withAuthority; the name never reaches a log." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Spec section 6 "App" coverage map (S1/S2 bullets)

| Spec bullet | Tests |
|---|---|
| /join sign-up with a listed authority -> onboarding tenant holding it + marker; none -> onboarding + marker, no authority | 2.3 first two new tests, the edited first test |
| padded text trimmed by the middleware and accepted | 2.3 "padded text is trimmed ..." |
| unlisted, spelling, other case, agency -> housing_authority_not_listed, write nothing; non-string, empty, over-long -> generic 400 | 2.2 first test (+ existing-phone test); 2.1 first test |
| unitId + authority -> generic 400 for shareable, missing, non-shareable | 2.1 second test |
| flyer sign-up without an authority as today except the marker | 2.3 three flyer tests |
| existing phone + valid authority: no field change; audit records the answer with signupVersion 2 | 2.3 two (PIN) tests; 2.4 last test |
| list read: authority names only, sorted, never writes; own limit independent both directions; edge guard passes | 1.1, 1.2, 1.3 (both describes); cloudfrontBehaviors run in 1.3 and 2.4 |

Additional coverage beyond the bullets: D3 "reads the list ONLY when an
authority is sent" (2.2 PIN), D3 list read failure = generic 500 (2.2), D1
read failure = generic 500 (1.3), D1 Cache-Control no-store (1.2, 1.3), the
stored list governs over the starting list (2.2), D7 log key without the name
(2.4).

### Notes for the planner and the other slices (not contract issues)

- For S3 (the dashboard contract this server delivers):
  `GET /public/housing-authorities` -> `200 { names: string[] }` with
  `Cache-Control: no-store`; `429 { error: 'rate_limited' }` plus
  `Retry-After` past 60 reads per minute per IP; `500
  { error: 'internal server error' }` on a read failure.
  `POST /public/housing-fair`: `400 { error: 'housing_authority_not_listed' }`
  for an unlisted name; `400 { error: 'invalid request' }` for a bad shape or
  `unitId` + authority; `429 { error: 'rate_limited' }` from the shared limit;
  `400 { error: 'consent_required' }` unchanged.
- For S5 (e2e): the list limit is hard-coded at 60 per minute and the e2e
  launcher cannot raise it (unlike `PUBLIC_RATE_LIMIT_MAX`,
  `scripts/e2e-session.mjs:142`). The e2e suite runs one worker
  (`e2e/playwright.config.ts:141`) and loads `/join` only a handful of times
  (`public-pages.spec.ts:345`, `a2p-compliance.spec.ts:107`,
  `environment-identity.spec.ts:101`), so it is far below 60 per minute; a
  perf run that loads `/join` more than 60 times in a minute would see the
  failed-list state, not a failure.
- One mechanism nuance against the spec's D2 wording is recorded in
  `docs/superpowers/reviews/2026-10-12-join-housing-authority/plan-research/S1-S2-findings.md`
  (an `OPTIONS` request to the list path is answered by Express itself and
  does not fall through). No task depends on it.
- `ContactItem` has an index signature (`app/src/repos/contactsRepo.ts:344`),
  so `housing_fair_signup_v2` needs no type change; S4 reads it as
  `contact['housing_fair_signup_v2'] === true`.

## 6. S3 - Dashboard (Tasks 3.1-3.6)

CONTRACT ISSUES

none. Sections 0-3 are workable against the code as written. Verified:

- 2.4 `onSubmit: (input: Omit<HousingFairInput, 'unitId' | 'housingAuthority'>)`
  stays compatible with the flyer: `FlyerPage.tsx:179` declares its handler as
  `(input: Omit<HousingFairInput, 'unitId'>)`, and that parameter type accepts
  the narrower input (housingAuthority is optional), so `FlyerPage.tsx` is NOT
  edited by this slice (spec: the flyer page does not change).
- 2.3 `getHousingAuthorities(signal?)` fits `request()` (`dashboard/src/api/client.ts:146`):
  `signal` is a RequestOptions field, a non-2xx throws `ApiError` with `status`
  and the server's `error` as `code` (a 429 is `status 429, code 'rate_limited'`,
  `app/src/middleware/rateLimit.ts:118`), a network failure is
  `ApiError(0, 'network_error')`, an abort rethrows the DOMException
  (`client.ts:125`). There is no timeout in `request()`, so the 10 s timeout
  lives in `HousingFairIntake`.

Additive, not changes to the binding names (listed so the reviewer can see them):

- `publicApi.ts` also exports `HOUSING_AUTHORITY_NOT_LISTED = 'housing_authority_not_listed'`
  (the dashboard cannot import the app's constant from `app/src/services/publicOrgList.ts`).
- `getHousingAuthorities` throws `ApiError(0, 'invalid_response')` when the body
  is not `{ names: string[] }` (so the page falls into the D8 failed state
  instead of throwing inside a promise callback).
- New presentational file `dashboard/src/routes/public/HousingAuthoritySelect.tsx`
  (the select, its copy constants, the option-value sentinels and two pure
  helpers). It does NOT fetch: the list read lives in `HousingFairIntake`
  (2.4), so the keyed IntakeForm remount on "Sign up another person" makes no
  list read.
- New CSS class `.help` in `IntakeForm.module.css` (unused by the flyer).

Constraints folded in from outside this slice:

- `e2e/performance/mutationCatalog.test.ts` runs in `npm test` and statically
  scans every dashboard `request()` call (`scanSource`, lines 265-308). Each
  call's options argument must be absent or an inline object literal
  (`methodFromObject`, line 129 throws `unprovable_method` for an identifier),
  and its path must be a string literal or template. `submitHousingFair` must
  keep `request<{ ok: true }>('/public/housing-fair', { method: 'POST', body })`
  verbatim (a positive control, line 347, and a catalog row, line 412). The
  new GET is `request<...>('/public/housing-authorities', { signal })`: an
  inline literal with no `method`, so it classifies `request:GET` and is NOT a
  catalog row (`catalogDiscoveries`, line 323, keeps only non-GET), so the
  catalog count (120, line 380) does not change. Task 3.1 runs that test.
- S5's e2e drives a NATIVE `<select>` (getByLabel('Housing authority'),
  selectOption by label) and asserts that "Sign up another person" makes no
  extra list read after a good load. Both hold by construction here.

Design decisions for this slice (read before 3.1):

- The select is its own small presentational component
  (`HousingAuthoritySelect.tsx`): label, native select, help text, failed-list
  note, aria-describedby wiring. `HousingFairIntake` owns the list state, the
  chosen value, the not-listed recovery and the remount key (2.4), and passes
  the select to IntakeForm as `extraField`.
- Option values: a listed name's value is the exact stored name (the page sends
  it as-is; an e2e reads the plain name with toHaveValue). "Not sure" is `''`.
  The "Choose one" placeholder is `' choose-one'` (leading space). A stored
  organization name is trimmed and never empty (`checkNewName`,
  `app/src/lib/orgNames.ts:348-355`), so neither sentinel can equal a listed name.
- StrictMode (dev and every e2e lane, `dashboard/src/main.tsx:15`): each effect
  run creates its own AbortController and 10 s timer; the cleanup clears the
  timer and aborts; the request callbacks return early when their controller is
  aborted (cleaned up or timed out). No ref-based "already loading" guard -
  that pattern breaks under StrictMode (run 1 aborted, run 2 skipped, the
  select stuck on "Loading..."); Task 3.4 has a test that fails on it.
- `react-hooks/set-state-in-effect` (eslint-plugin-react-hooks 7,
  `eslint.config.mjs` dashboard block): state is set only inside the request's
  `.then` callbacks and the timeout callback, never synchronously in an effect
  body. A re-read is started from an event handler that sets
  `{ kind: 'loading' }` and bumps a request object the effect depends on.
- IntakeForm disables its own inputs while sending; the select is the parent's,
  so `HousingFairIntake` tracks `sending` and disables the select too.
- The not-listed message is IntakeForm's error line (role="alert"), via the
  `errorMessage` prop. Like every IntakeForm error, it clears when a text field
  is edited or on the next send; picking a new authority does not clear it.
  The spec does not require more.
- The /join thank-you heading text keeps its em dash. The rewritten
  `HousingFairIntake.tsx` is pure ASCII and writes it as the JSX entity
  `&mdash;` (renders U+2014, identical text); a test pins the rendered text.
  Never type a `\u` escape for it (the Edit/Write tools decode `\u`).

Notes for S5 (not tasks; S5 owns e2e and docs):

- Every /join load now issues `GET /public/housing-authorities`; under
  StrictMode (every e2e lane) a load issues it TWICE (the first is aborted).
  The D2 limit is 60 per minute per IP, hard-coded, so a lane can afford about
  30 /join loads a minute.
- Existing specs that click "Sign me up" on /join
  (`e2e/tests/dashboard-next/a2p-compliance.spec.ts:123,129`,
  `public-pages.spec.ts:352`) keep working: the button is disabled only until
  the list read settles, and Playwright's click auto-waits for enabled.
- `e2e/support/selectors.md:42-44` (Public form rows) predate this change; its
  success row (`Thanks, we'll text you!`) is already stale against the real
  heading. The new controls: `getByLabel('Housing authority', { exact: true })`
  (native select; option text = exact name, "Not sure", "Choose one",
  "Loading..."), `getByRole('button', { name: 'Sign up another person' })`.
- `e2e/performance/templates.ts`: `/join` now requests
  `GET /public/housing-authorities` (spec section 7).

### 6. S3 - Dashboard: publicApi, IntakeForm props, the /join select, recovery, 429, "Sign up another person"

Worktree `W:\tmp\join-housing-authority`. Dashboard tests run from
`W:/tmp/join-housing-authority/dashboard` with `npx vitest run src/routes/public/<file>`
(never piped). The unit tests mock `./publicApi.js`; nothing here needs S1's
route to be built. Commands below are written so they work in PowerShell and
in Git Bash (forward slashes, `;` between `cd` and the command).

Files this slice touches (and nothing else):

- `dashboard/src/routes/public/publicApi.ts` (modify)
- `dashboard/src/routes/public/publicApi.test.ts` (new)
- `dashboard/src/routes/public/IntakeForm.tsx` (modify; pre-existing non-ASCII lines stay as they are)
- `dashboard/src/routes/public/IntakeForm.module.css` (modify; pre-existing non-ASCII lines stay)
- `dashboard/src/routes/public/IntakeForm.props.test.tsx` (new)
- `dashboard/src/routes/public/FlyerPage.test.tsx` (modify: one added test)
- `dashboard/src/routes/public/HousingAuthoritySelect.tsx` (new)
- `dashboard/src/routes/public/HousingAuthoritySelect.test.tsx` (new)
- `dashboard/src/routes/public/HousingFairIntake.tsx` (rewritten, ASCII)
- `dashboard/src/routes/public/HousingFairIntake.test.tsx` (rewritten, ASCII)
- `dashboard/src/routes/public/HousingFairIntake.recovery.test.tsx` (new)
- `dashboard/src/routes/public/HousingFairIntake.another.test.tsx` (new)

NOT touched: `FlyerPage.tsx`, `IntakeForm.test.tsx`, `dashboard/src/api/client.ts`.
The existing `IntakeForm.test.tsx` and `FlyerPage.test.tsx` cases are the
flyer's regression pins and must stay green, unchanged, after every task.

#### Task 3.1 - publicApi: send housingAuthority, read the housing authority list

Files:
- Create `dashboard/src/routes/public/publicApi.test.ts`
- Modify `dashboard/src/routes/public/publicApi.ts`

Step 1 - Write the failing test. Create
`dashboard/src/routes/public/publicApi.test.ts` with exactly:

```ts
// publicApi - the /join housing authority additions (join-housing-authority
// spec D1, D3, D8): submitHousingFair sends housingAuthority only when it is
// defined, and getHousingAuthorities reads GET /public/housing-authorities.
// The transport (request) is mocked; ApiError stays the real class.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('../../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/client.js')>('../../api/client.js');
  return { ...actual, request: (...a: unknown[]) => request(...a) };
});

import { ApiError } from '../../api/client.js';
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  getHousingAuthorities,
  submitHousingFair,
} from './publicApi.js';

const PERSON = {
  firstName: 'Grace',
  lastName: 'Hopper',
  phone: '+14045559999',
  smsConsent: true,
};

/** The JSON body `request` was called with on call N. */
function bodyOf(call: number): Record<string, unknown> {
  return (request.mock.calls[call]?.[1] as { body: Record<string, unknown> }).body;
}

beforeEach(() => {
  request.mockReset();
});

describe('submitHousingFair', () => {
  it('sends housingAuthority when it is defined', async () => {
    request.mockResolvedValue({ ok: true });
    await submitHousingFair({ ...PERSON, housingAuthority: 'Atlanta Housing Authority' });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe('/public/housing-fair');
    expect(request.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(bodyOf(0)).toEqual({ ...PERSON, housingAuthority: 'Atlanta Housing Authority' });
  });

  it('omits housingAuthority when it is undefined ("Not sure", and every flyer sign-up)', async () => {
    request.mockResolvedValue({ ok: true });
    await submitHousingFair({ ...PERSON, unitId: 'unit-1' });

    expect(bodyOf(0)).toEqual({ ...PERSON, unitId: 'unit-1' });
    expect(Object.keys(bodyOf(0))).not.toContain('housingAuthority');
  });

  it('(PIN) omits voucherSize and unitId when absent and sends them when present', async () => {
    request.mockResolvedValue({ ok: true });
    await submitHousingFair({ ...PERSON });
    await submitHousingFair({ ...PERSON, voucherSize: 2, unitId: 'unit-9' });

    expect(Object.keys(bodyOf(0)).sort()).toEqual(['firstName', 'lastName', 'phone', 'smsConsent']);
    expect(bodyOf(1)).toEqual({ ...PERSON, voucherSize: 2, unitId: 'unit-9' });
  });
});

describe('getHousingAuthorities', () => {
  it('GETs /public/housing-authorities with the caller signal and returns the names', async () => {
    request.mockResolvedValue({ names: ['Atlanta Housing Authority', 'DeKalb Housing Authority'] });
    const controller = new AbortController();

    await expect(getHousingAuthorities(controller.signal)).resolves.toEqual([
      'Atlanta Housing Authority',
      'DeKalb Housing Authority',
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe('/public/housing-authorities');
    const options = request.mock.calls[0]![1] as { method?: string; signal?: AbortSignal; body?: unknown };
    expect(options.signal).toBe(controller.signal);
    expect(options.method === undefined || options.method === 'GET').toBe(true);
    expect(options.body).toBeUndefined();
  });

  it('passes a failed read through as the ApiError (a 429 included)', async () => {
    const tooMany = new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' });
    request.mockRejectedValue(tooMany);

    await expect(getHousingAuthorities()).rejects.toBe(tooMany);
  });

  it('throws ApiError invalid_response for a body that is not { names: string[] }', async () => {
    for (const body of [undefined, {}, { names: 'Atlanta Housing Authority' }, { names: [1, 2] }]) {
      request.mockReset();
      request.mockResolvedValue(body);
      const failure = getHousingAuthorities();
      await expect(failure).rejects.toBeInstanceOf(ApiError);
      await expect(failure).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
});

describe('HOUSING_AUTHORITY_NOT_LISTED', () => {
  it("is the sign-up's refusal code for an unlisted authority (spec D3)", () => {
    expect(HOUSING_AUTHORITY_NOT_LISTED).toBe('housing_authority_not_listed');
  });
});
```

Step 2 - Run it RED:

`cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/publicApi.test.ts`

Expected: 5 failed, 2 passed. "sends housingAuthority when it is defined"
fails on the `toEqual` (the body has no `housingAuthority`); the three
`getHousingAuthorities` cases fail with a TypeError (`getHousingAuthorities`
is not a function); the constant case fails (`undefined`). The "omits" and
"(PIN)" cases pass (today's behavior).

Step 3 - Implement in `dashboard/src/routes/public/publicApi.ts` with the Edit
tool (three edits; every anchor below is ASCII and unique).

Edit 1 - old_string:

```ts
import { request } from '../../api/client.js';
```

new_string:

```ts
import { ApiError, request } from '../../api/client.js';
```

Edit 2 - old_string:

```ts
  /** When present (and a shareable unit), the signup is attributed to the home. */
  unitId?: string;
```

new_string:

```ts
  /** When present (and a shareable unit), the signup is attributed to the home. */
  unitId?: string;
  /** join-housing-authority D8: the chosen housing authority's exact listed
   *  name; omitted for "Not sure". /join only - the flyer never sends it (the
   *  server refuses a unitId together with a housingAuthority, spec D4). */
  housingAuthority?: string;
```

Edit 3 - old_string:

```ts
  if (input.voucherSize !== undefined) body['voucherSize'] = input.voucherSize;
  if (input.unitId !== undefined) body['unitId'] = input.unitId;
  await request<{ ok: true }>('/public/housing-fair', { method: 'POST', body });
}
```

new_string:

```ts
  if (input.voucherSize !== undefined) body['voucherSize'] = input.voucherSize;
  if (input.unitId !== undefined) body['unitId'] = input.unitId;
  if (input.housingAuthority !== undefined) body['housingAuthority'] = input.housingAuthority;
  await request<{ ok: true }>('/public/housing-fair', { method: 'POST', body });
}

/** join-housing-authority D3: the sign-up's refusal code for a housingAuthority
 *  that is not exactly a listed name (the list changed after the page read it).
 *  Mirrors HOUSING_AUTHORITY_NOT_LISTED in app/src/services/publicOrgList.ts. */
export const HOUSING_AUTHORITY_NOT_LISTED = 'housing_authority_not_listed';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** join-housing-authority D1: GET /public/housing-authorities - the exact name
 *  of every housing authority on the organization list, sorted by the server.
 *  Throws ApiError on any failure: a non-2xx (a 429 included), a network
 *  failure, or a body that is not { names: string[] } (code invalid_response).
 *  An abort rethrows the DOMException, as request() does.
 *
 *  Keep the options argument an INLINE object literal and the path a string
 *  literal: e2e/performance/mutationCatalog.test.ts statically classifies every
 *  request() call (this one is request:GET, so it is not a catalog row). */
export async function getHousingAuthorities(signal?: AbortSignal): Promise<string[]> {
  const body = await request<{ names?: unknown } | undefined>('/public/housing-authorities', { signal });
  const names = body?.names;
  if (!isStringArray(names)) {
    throw new ApiError(0, 'invalid_response', 'Unexpected housing authority list response', body);
  }
  return names;
}
```

Do NOT change the `request<{ ok: true }>('/public/housing-fair', { method: 'POST', body })`
line in any way (mutationCatalog positive control).

Step 4 - Run GREEN:

1. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/publicApi.test.ts`
   - expect 7 passed.
2. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public`
   - expect every file passed (the existing IntakeForm/FlyerPage/HousingFairIntake tests unchanged and green).
3. `cd W:/tmp/join-housing-authority/e2e; npx vitest run performance/mutationCatalog.test.ts`
   - expect 4 passed (static scan only; no network, no database).
4. `cd W:/tmp/join-housing-authority/dashboard; npm run typecheck` - expect exit 0.
5. `cd W:/tmp/join-housing-authority; npx eslint dashboard/src/routes/public/publicApi.ts dashboard/src/routes/public/publicApi.test.ts`
   - expect exit 0 (any error in these files is new and blocking).
6. ASCII:
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/publicApi.test.ts | wc -c` prints 0.
   - `git -C W:/tmp/join-housing-authority diff -U0 -- dashboard/src/routes/public/publicApi.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` prints 0
     (publicApi.ts has pre-existing non-ASCII comment lines; only ADDED lines must be ASCII).

Step 5 - Commit:

1. `git -C W:/tmp/join-housing-authority status` - read it on its own. The only
   changes are `publicApi.ts` (modified) and `publicApi.test.ts` (untracked).
   Anything else is not yours: leave it.
2. `test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/join-housing-authority/MERGE_HEAD" && echo MERGE-IN-PROGRESS || echo ok`
   prints `ok` (PowerShell: `Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\join-housing-authority\MERGE_HEAD"` prints `False`).
3. `git -C W:/tmp/join-housing-authority add dashboard/src/routes/public/publicApi.ts dashboard/src/routes/public/publicApi.test.ts`
4. `git -C W:/tmp/join-housing-authority commit -m "feat(join): publicApi sends housingAuthority and reads the housing authority list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 3.2 - IntakeForm: the optional extraField, submitBlocked, errorMessage, autoFocusFirstName (the flyer unchanged)

Files:
- Create `dashboard/src/routes/public/IntakeForm.props.test.tsx`
- Modify `dashboard/src/routes/public/FlyerPage.test.tsx` (one added test, a PIN)
- Modify `dashboard/src/routes/public/IntakeForm.tsx`

Step 1 - Write the tests.

1a. Create `dashboard/src/routes/public/IntakeForm.props.test.tsx` with exactly:

```tsx
// IntakeForm - the optional /join props (join-housing-authority spec D8, D9).
// The flyer passes none of them, so the first block PINS today's behavior with
// no optional prop: no extra field, the submit enabled, nothing focused, and
// today's error copy for ANY thrown error. The second block drives each new
// prop: extraField placement, submitBlocked, errorMessage, autoFocusFirstName.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { IntakeForm } from './IntakeForm.js';

const TODAYS_ERROR = "Sorry, we couldn't send that. Please try again.";

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: /send my info/i });
}

function consentBox(): HTMLElement {
  return screen.getByRole('checkbox', { name: /I agree to receive/i });
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/first name/i), 'Ada');
  await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
  await user.type(screen.getByLabelText(/phone number/i), '4045551234');
}

describe('IntakeForm with none of the optional props (the flyer) - PIN', () => {
  it('renders only its own fields: no select, the submit enabled, nothing focused', () => {
    render(<IntakeForm onSubmit={vi.fn().mockResolvedValue(undefined)} />);

    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByLabelText(/housing authority/i)).toBeNull();
    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/last name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/phone number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/voucher size/i)).toBeInTheDocument();
    expect(consentBox()).toBeInTheDocument();
    // First, last, phone, voucher, consent - and nothing else.
    expect(document.querySelectorAll('input')).toHaveLength(5);
    expect(sendButton()).toBeEnabled();
    expect(document.body).toHaveFocus();
  });

  it("shows today's message for ANY thrown error (a 429 and a not-listed refusal included) and keeps the fields", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }))
      .mockRejectedValueOnce(
        new ApiError(400, 'housing_authority_not_listed', 'housing_authority_not_listed', {
          error: 'housing_authority_not_listed',
        }),
      );
    render(<IntakeForm onSubmit={onSubmit} />);
    await fillRequiredFields(user);
    await user.click(consentBox());

    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(TODAYS_ERROR);

    await user.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent(TODAYS_ERROR);
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Ada');
    expect(consentBox()).toBeChecked();
    for (const call of onSubmit.mock.calls) {
      expect(call[0]).not.toHaveProperty('housingAuthority');
    }
  });
});

describe('IntakeForm optional props (/join)', () => {
  it('extraField renders inside the form, after "Voucher size" and before the consent box', () => {
    render(
      <IntakeForm
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        extraField={
          <div>
            <label htmlFor="extra-field">Extra field</label>
            <input id="extra-field" />
          </div>
        }
      />,
    );
    const voucher = screen.getByLabelText(/voucher size/i);
    const extra = screen.getByLabelText('Extra field');

    expect(voucher.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extra.compareDocumentPosition(consentBox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extra.closest('form')).not.toBeNull();
  });

  it('submitBlocked disables the submit button and an Enter in a field sends nothing', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<IntakeForm onSubmit={onSubmit} submitBlocked />);
    expect(sendButton()).toBeDisabled();

    await fillRequiredFields(user);
    await user.click(consentBox());
    await user.type(screen.getByLabelText(/last name/i), '{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();

    rerender(<IntakeForm onSubmit={onSubmit} submitBlocked={false} />);
    expect(sendButton()).toBeEnabled();
    await user.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("errorMessage maps a thrown error to its copy; null keeps today's message", async () => {
    const user = userEvent.setup();
    const tooMany = new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' });
    const broken = new ApiError(500, 'internal', 'internal', { error: 'internal' });
    const onSubmit = vi.fn().mockRejectedValueOnce(tooMany).mockRejectedValueOnce(broken);
    const errorMessage = vi.fn((err: unknown) => (err === tooMany ? 'Mapped copy for the test.' : null));
    render(<IntakeForm onSubmit={onSubmit} errorMessage={errorMessage} />);
    await fillRequiredFields(user);
    await user.click(consentBox());

    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Mapped copy for the test.');
    expect(errorMessage).toHaveBeenCalledWith(tooMany);
    // The form stays as typed, consent included, and can send again.
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Ada');
    expect(consentBox()).toBeChecked();

    await user.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(TODAYS_ERROR));
    expect(errorMessage).toHaveBeenLastCalledWith(broken);
  });

  it('autoFocusFirstName focuses "First name" on mount', () => {
    render(<IntakeForm onSubmit={vi.fn().mockResolvedValue(undefined)} autoFocusFirstName />);
    expect(screen.getByLabelText(/first name/i)).toHaveFocus();
  });

  it('autoFocusFirstName={false} leaves focus where it was', () => {
    render(<IntakeForm onSubmit={vi.fn().mockResolvedValue(undefined)} autoFocusFirstName={false} />);
    expect(document.body).toHaveFocus();
  });
});
```

1b. Add one test to `dashboard/src/routes/public/FlyerPage.test.tsx` (a PIN:
the flyer shows no select, never sends an authority, and keeps its error copy
for the two new /join-only cases). Use the Edit tool.

old_string (the end of the file; unique):

```tsx
    expect(await screen.findByText(/reply to the text we sent you/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /text us/i })).toBeNull();
  });
});
```

new_string:

```tsx
    expect(await screen.findByText(/reply to the text we sent you/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /text us/i })).toBeNull();
  });

  it('the flyer form has no housing authority select, never sends one, and keeps its error copy (join-housing-authority D8)', async () => {
    const user = userEvent.setup();
    getFlyer.mockResolvedValue(FLYER);
    submitHousingFair
      .mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }))
      .mockRejectedValueOnce(
        new ApiError(400, 'housing_authority_not_listed', 'housing_authority_not_listed', {
          error: 'housing_authority_not_listed',
        }),
      );
    renderPage();

    await user.type(await screen.findByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    await user.type(screen.getByLabelText(/phone number/i), '4045551234');
    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByLabelText(/housing authority/i)).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /I agree to receive/i }));

    // A 429: today's message, not the /join one.
    await user.click(screen.getByRole('button', { name: /i'm interested/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Sorry, we couldn't send that. Please try again.",
    );

    // A not-listed refusal: still today's message.
    await user.click(screen.getByRole('button', { name: /i'm interested/i }));
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Sorry, we couldn't send that. Please try again.",
    );
    expect(screen.queryByText(/too many sign-ups/i)).toBeNull();
    expect(screen.queryByText(/housing authority list was updated/i)).toBeNull();
    for (const call of submitHousingFair.mock.calls) {
      expect(call[0]).toMatchObject({ unitId: 'unit-1' });
      expect(call[0]).not.toHaveProperty('housingAuthority');
    }
  });
});
```

Step 2 - Run RED:

1. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/IntakeForm.props.test.tsx`
   - Expected: 4 failed, 3 passed. Failing: "extraField renders inside the
     form..." (Unable to find a label with the text of: Extra field),
     "submitBlocked disables..." (expected the button to be disabled),
     "errorMessage maps..." (the alert shows today's copy, not
     "Mapped copy for the test."), "autoFocusFirstName focuses..." (focus is
     on body). Passing: both PIN cases and "autoFocusFirstName={false}...".
2. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/FlyerPage.test.tsx`
   - Expected: all passed, the new case included (it is a PIN on today's code).

Step 3 - Implement in `dashboard/src/routes/public/IntakeForm.tsx` with the
Edit tool. IntakeForm.tsx has pre-existing non-ASCII lines (em dashes in
comments, the voucher label and the "Sending" label): do NOT touch them; every
anchor below is an ASCII line.

Edit 1 - old_string:

```tsx
import { useState, type FormEvent } from 'react';
```

new_string:

```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react';
```

Edit 2 - old_string:

```tsx
  onSubmit: (input: Omit<HousingFairInput, 'unitId'>) => Promise<void>;
  /** The submit button's label (e.g. "Send my info" / "Sign up"). */
  submitLabel?: string;
}
```

new_string:

```tsx
  onSubmit: (input: Omit<HousingFairInput, 'unitId' | 'housingAuthority'>) => Promise<void>;
  /** The submit button's label (e.g. "Send my info" / "Sign up"). */
  submitLabel?: string;
  // The props below are optional and /join-only (join-housing-authority spec
  // D8, D9). The flyer passes none of them, and with none of them this form
  // renders and behaves exactly as it always has.
  /** Rendered after "Voucher size", before the consent box (the /join
   *  "Housing authority" select). */
  extraField?: React.ReactNode;
  /** Disables the submit button and ignores a submit (the list is loading, or
   *  the "Choose one" placeholder is showing). */
  submitBlocked?: boolean;
  /** Maps a thrown submit error to its copy; null/undefined keeps today's
   *  message. */
  errorMessage?: (err: unknown) => string | null | undefined;
  /** Focus "First name" on mount (after "Sign up another person"). */
  autoFocusFirstName?: boolean;
}
```

Edit 3 - old_string:

```tsx
export function IntakeForm({ onSubmit, submitLabel = 'Send my info' }: IntakeFormProps): React.JSX.Element {
```

new_string:

```tsx
export function IntakeForm({
  onSubmit,
  submitLabel = 'Send my info',
  extraField,
  submitBlocked = false,
  errorMessage,
  autoFocusFirstName = false,
}: IntakeFormProps): React.JSX.Element {
```

Edit 4 - old_string:

```tsx
  const [phoneError, setPhoneError] = useState<string | null>(null);
```

new_string:

```tsx
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // autoFocusFirstName: move focus to "First name" on mount, so the fresh form
  // after "Sign up another person" is ready to type into. Off by default - a
  // page load never moves focus.
  const firstNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocusFirstName) firstNameRef.current?.focus();
  }, [autoFocusFirstName]);
```

Edit 5 - old_string:

```tsx
  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
```

new_string:

```tsx
  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    // The parent blocks a send. The button is disabled too; this also stops an
    // Enter-key submit.
    if (submitBlocked) return;
```

Edit 6 - old_string:

```tsx
    } catch {
      setError("Sorry, we couldn't send that. Please try again.");
      setPending(false);
    }
```

new_string:

```tsx
    } catch (err) {
      setError(errorMessage?.(err) ?? "Sorry, we couldn't send that. Please try again.");
      setPending(false);
    }
```

Edit 7 - old_string:

```tsx
          id="intake-first"
```

new_string:

```tsx
          ref={firstNameRef}
          id="intake-first"
```

Edit 8 - old_string:

```tsx
          onChange={onField(setVoucher)}
          disabled={pending}
        />
      </div>
```

new_string:

```tsx
          onChange={onField(setVoucher)}
          disabled={pending}
        />
      </div>
      {extraField}
```

Edit 9 - old_string:

```tsx
      <button className={styles.submit} type="submit" disabled={pending}>
```

new_string:

```tsx
      <button className={styles.submit} type="submit" disabled={pending || submitBlocked}>
```

Do not edit `FlyerPage.tsx`: its handler type `Omit<HousingFairInput, 'unitId'>`
still satisfies the new `onSubmit` prop type.

Step 4 - Run GREEN:

1. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/IntakeForm.props.test.tsx` - expect 7 passed.
2. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public`
   - expect every file passed; `IntakeForm.test.tsx` and `FlyerPage.test.tsx`
     (all their pre-existing cases, unchanged) are the flyer's regression pins.
3. `cd W:/tmp/join-housing-authority/dashboard; npm run typecheck` - expect exit 0.
4. `cd W:/tmp/join-housing-authority; npx eslint dashboard/src/routes/public/IntakeForm.tsx dashboard/src/routes/public/IntakeForm.props.test.tsx dashboard/src/routes/public/FlyerPage.test.tsx`
   - expect exit 0. If an error is reported on a line this task did not
     write, run the same `npx eslint <that path>` read-only in the main
     checkout (`W:\AI Projects\Housing Choice\HC Application`); an identical
     error there is pre-existing (name it in the handback), anything else is
     yours and blocking.
5. ASCII:
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/IntakeForm.props.test.tsx | wc -c` prints 0.
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/FlyerPage.test.tsx | wc -c` prints 0.
   - `git -C W:/tmp/join-housing-authority diff -U0 -- dashboard/src/routes/public/IntakeForm.tsx | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` prints 0.

Step 5 - Commit:

1. `git -C W:/tmp/join-housing-authority status` - read it on its own; the only
   changes are `IntakeForm.tsx`, `FlyerPage.test.tsx` (modified) and
   `IntakeForm.props.test.tsx` (untracked).
2. `test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/join-housing-authority/MERGE_HEAD" && echo MERGE-IN-PROGRESS || echo ok` prints `ok`.
3. `git -C W:/tmp/join-housing-authority add dashboard/src/routes/public/IntakeForm.tsx dashboard/src/routes/public/IntakeForm.props.test.tsx dashboard/src/routes/public/FlyerPage.test.tsx`
4. `git -C W:/tmp/join-housing-authority commit -m "feat(join): IntakeForm optional extraField, submitBlocked, errorMessage and autoFocusFirstName; the flyer unchanged" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 3.3 - HousingAuthoritySelect: the /join "Housing authority" field

Files:
- Create `dashboard/src/routes/public/HousingAuthoritySelect.test.tsx`
- Create `dashboard/src/routes/public/HousingAuthoritySelect.tsx`
- Modify `dashboard/src/routes/public/IntakeForm.module.css` (add `.help`)

Step 1 - Write the failing test. Create
`dashboard/src/routes/public/HousingAuthoritySelect.test.tsx` with exactly:

```tsx
// HousingAuthoritySelect - the /join "Housing authority" field
// (join-housing-authority spec D8): its states (ready, loading, failed, the
// "Choose one" placeholder), the exact copy, the option values it reports, its
// accessible wiring, and the two pure helpers HousingFairIntake uses (the
// default rule and what a value sends).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  CHOOSE_ONE_VALUE,
  HousingAuthoritySelect,
  NOT_SURE_VALUE,
  authorityToSend,
  defaultAuthorityChoice,
  type AuthorityList,
} from './HousingAuthoritySelect.js';

const NAMES = ['Atlanta Housing Authority', 'Cobb County Housing Authority', 'DeKalb Housing Authority'];
const READY: AuthorityList = { kind: 'ready', names: NAMES };
const HELP = 'The organization that runs your voucher.';
const FAILED_NOTE = 'The list of housing authorities could not be loaded.';

function authoritySelect(): HTMLSelectElement {
  return screen.getByLabelText('Housing authority') as HTMLSelectElement;
}

function optionLabels(): string[] {
  return Array.from(authoritySelect().options, (o) => o.textContent ?? '');
}

describe('HousingAuthoritySelect', () => {
  it('ready: the names in their order, then "Not sure"; shows the value; the help text describes it', () => {
    render(<HousingAuthoritySelect list={READY} value="Atlanta Housing Authority" onChange={vi.fn()} />);

    expect(authoritySelect().tagName).toBe('SELECT');
    expect(optionLabels()).toEqual([...NAMES, 'Not sure']);
    expect(authoritySelect()).toHaveValue('Atlanta Housing Authority');
    expect(authoritySelect()).toHaveDisplayValue('Atlanta Housing Authority');
    expect(authoritySelect()).toBeEnabled();
    expect(authoritySelect()).toHaveAccessibleDescription(HELP);
    expect(screen.getByText(HELP)).toBeInTheDocument();
    expect(screen.queryByText(FAILED_NOTE)).toBeNull();
  });

  it('ready with "Not sure" shows "Not sure"', () => {
    render(<HousingAuthoritySelect list={READY} value={NOT_SURE_VALUE} onChange={vi.fn()} />);
    expect(authoritySelect()).toHaveDisplayValue('Not sure');
  });

  it('loading: disabled, and "Loading..." is the only option', () => {
    render(<HousingAuthoritySelect list={{ kind: 'loading' }} value={NOT_SURE_VALUE} onChange={vi.fn()} />);

    expect(authoritySelect()).toBeDisabled();
    expect(optionLabels()).toEqual(['Loading...']);
    expect(authoritySelect()).toHaveDisplayValue('Loading...');
    expect(authoritySelect()).toHaveAccessibleDescription(HELP);
  });

  it('failed: only "Not sure", the note under it, and help + note describe the select', () => {
    render(
      <HousingAuthoritySelect list={{ kind: 'failed' }} value="Atlanta Housing Authority" onChange={vi.fn()} />,
    );

    expect(optionLabels()).toEqual(['Not sure']);
    expect(authoritySelect()).toHaveDisplayValue('Not sure');
    expect(authoritySelect()).toBeEnabled();
    expect(screen.getByText(FAILED_NOTE)).toBeInTheDocument();
    expect(authoritySelect()).toHaveAccessibleDescription(`${HELP} ${FAILED_NOTE}`);
  });

  it('the "Choose one" placeholder sits ahead of the names and "Not sure" while it is the value', () => {
    render(<HousingAuthoritySelect list={READY} value={CHOOSE_ONE_VALUE} onChange={vi.fn()} />);

    expect(optionLabels()).toEqual(['Choose one', ...NAMES, 'Not sure']);
    expect(authoritySelect()).toHaveDisplayValue('Choose one');
  });

  it('reports the picked value: a name exactly, "Not sure" as NOT_SURE_VALUE', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HousingAuthoritySelect list={READY} value="Atlanta Housing Authority" onChange={onChange} />);

    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    expect(onChange).toHaveBeenLastCalledWith('DeKalb Housing Authority');
    await user.selectOptions(authoritySelect(), 'Not sure');
    expect(onChange).toHaveBeenLastCalledWith(NOT_SURE_VALUE);
  });

  it('disabled disables it even when the list is ready', () => {
    render(<HousingAuthoritySelect list={READY} value="Atlanta Housing Authority" onChange={vi.fn()} disabled />);
    expect(authoritySelect()).toBeDisabled();
  });
});

describe('defaultAuthorityChoice', () => {
  it('is "Atlanta Housing Authority" only when that exact name is listed, else "Not sure"', () => {
    expect(defaultAuthorityChoice(NAMES)).toBe('Atlanta Housing Authority');
    expect(defaultAuthorityChoice(['atlanta housing authority', 'Atlanta Housing Authority (AHA)'])).toBe(
      NOT_SURE_VALUE,
    );
    expect(defaultAuthorityChoice([])).toBe(NOT_SURE_VALUE);
  });
});

describe('authorityToSend', () => {
  it('sends a listed name exactly; nothing for "Not sure", "Choose one", an unlisted value, or a list that is not ready', () => {
    expect(authorityToSend(READY, 'DeKalb Housing Authority')).toBe('DeKalb Housing Authority');
    expect(authorityToSend(READY, NOT_SURE_VALUE)).toBeUndefined();
    expect(authorityToSend(READY, CHOOSE_ONE_VALUE)).toBeUndefined();
    expect(authorityToSend(READY, 'Fulton County Housing Authority')).toBeUndefined();
    expect(authorityToSend({ kind: 'loading' }, 'DeKalb Housing Authority')).toBeUndefined();
    expect(authorityToSend({ kind: 'failed' }, 'DeKalb Housing Authority')).toBeUndefined();
  });
});

describe('option values', () => {
  it('can never equal a listed name: "Not sure" is empty, "Choose one" starts with a space (stored names are trimmed and non-empty)', () => {
    expect(NOT_SURE_VALUE).toBe('');
    expect(CHOOSE_ONE_VALUE).not.toBe(CHOOSE_ONE_VALUE.trim());
    expect(CHOOSE_ONE_VALUE.trim()).not.toBe('');
  });
});
```

Step 2 - Run RED:

`cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/HousingAuthoritySelect.test.tsx`

Expected: the file fails to load (vitest reports it cannot resolve/load
`./HousingAuthoritySelect.js`); no test runs.

Step 3 - Implement.

3a. Create `dashboard/src/routes/public/HousingAuthoritySelect.tsx` with exactly:

```tsx
// HousingAuthoritySelect - the /join "Housing authority" field
// (join-housing-authority spec D8). Presentational only: HousingFairIntake
// owns the list read, the chosen value and the not-listed recovery, and hands
// this to IntakeForm as its extraField (rendered after "Voucher size", before
// the consent box). It never fetches, so the keyed IntakeForm remount on
// "Sign up another person" reads nothing. The flyer never renders it.
//
// A NATIVE <select> (e2e drives it with getByLabel + selectOption by label).
// Option values: a listed authority's value is its EXACT stored name, so the
// page sends that string as-is and an e2e reads the plain name back with
// toHaveValue. "Not sure" is the empty string (it records no authority); the
// "Choose one" placeholder's value starts with a space. A stored organization
// name is always trimmed and never empty (checkNewName,
// app/src/lib/orgNames.ts), so neither can collide with a listed name.
//
// Accessibility: a real <label> (getByLabel-resolvable); the help text, plus
// the failed-list note when shown, describe the select via aria-describedby.
// Styling reuses IntakeForm's field classes so it matches the other fields.
import styles from './IntakeForm.module.css';

export const HOUSING_AUTHORITY_LABEL = 'Housing authority';
export const HOUSING_AUTHORITY_HELP = 'The organization that runs your voucher.';
export const NOT_SURE_LABEL = 'Not sure';
export const LOADING_LABEL = 'Loading...';
export const CHOOSE_ONE_LABEL = 'Choose one';
export const LIST_FAILED_NOTE = 'The list of housing authorities could not be loaded.';

/** D8: the default when this exact name is listed (else "Not sure"). */
export const DEFAULT_HOUSING_AUTHORITY = 'Atlanta Housing Authority';

/** "Not sure": records no authority. */
export const NOT_SURE_VALUE = '';
/** The "Choose one" placeholder shown after a housing_authority_not_listed
 *  refusal; send stays blocked while it is the value. */
export const CHOOSE_ONE_VALUE = ' choose-one';
const LOADING_VALUE = ' loading';

/** The public list's state, owned by HousingFairIntake. */
export type AuthorityList =
  | { kind: 'loading' }
  | { kind: 'ready'; names: readonly string[] }
  | { kind: 'failed' };

/** D8 default rule: "Atlanta Housing Authority" when that EXACT name is
 *  listed, else "Not sure". */
export function defaultAuthorityChoice(names: readonly string[]): string {
  return names.includes(DEFAULT_HOUSING_AUTHORITY) ? DEFAULT_HOUSING_AUTHORITY : NOT_SURE_VALUE;
}

/** What the sign-up sends: the chosen name only when the list is ready and
 *  the value is one of its names; undefined ("Not sure", "Choose one", a
 *  failed or loading list) sends no housingAuthority. */
export function authorityToSend(list: AuthorityList, value: string): string | undefined {
  if (list.kind !== 'ready') return undefined;
  return list.names.includes(value) ? value : undefined;
}

interface AuthorityOption {
  value: string;
  label: string;
}

function optionsFor(list: AuthorityList, value: string): { selected: string; options: AuthorityOption[] } {
  if (list.kind === 'loading') {
    return { selected: LOADING_VALUE, options: [{ value: LOADING_VALUE, label: LOADING_LABEL }] };
  }
  if (list.kind === 'failed') {
    return { selected: NOT_SURE_VALUE, options: [{ value: NOT_SURE_VALUE, label: NOT_SURE_LABEL }] };
  }
  const options: AuthorityOption[] = [];
  if (value === CHOOSE_ONE_VALUE) options.push({ value: CHOOSE_ONE_VALUE, label: CHOOSE_ONE_LABEL });
  for (const name of list.names) options.push({ value: name, label: name });
  options.push({ value: NOT_SURE_VALUE, label: NOT_SURE_LABEL });
  return { selected: value, options };
}

const SELECT_ID = 'intake-authority';
const HELP_ID = 'intake-authority-help';
const NOTE_ID = 'intake-authority-note';

export interface HousingAuthoritySelectProps {
  list: AuthorityList;
  /** A listed name, NOT_SURE_VALUE or CHOOSE_ONE_VALUE. Ignored while the
   *  list is loading or failed. */
  value: string;
  onChange: (value: string) => void;
  /** Disabled while a sign-up is sending (always disabled while loading). */
  disabled?: boolean;
}

export function HousingAuthoritySelect({
  list,
  value,
  onChange,
  disabled = false,
}: HousingAuthoritySelectProps): React.JSX.Element {
  const { selected, options } = optionsFor(list, value);
  const failed = list.kind === 'failed';
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={SELECT_ID}>
        {HOUSING_AUTHORITY_LABEL}
      </label>
      <select
        id={SELECT_ID}
        className={styles.input}
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || list.kind === 'loading'}
        aria-describedby={failed ? `${HELP_ID} ${NOTE_ID}` : HELP_ID}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p id={HELP_ID} className={styles.help}>
        {HOUSING_AUTHORITY_HELP}
      </p>
      {failed && (
        <p id={NOTE_ID} className={styles.help}>
          {LIST_FAILED_NOTE}
        </p>
      )}
    </div>
  );
}
```

3b. Add the `.help` class to `dashboard/src/routes/public/IntakeForm.module.css`
with the Edit tool (the file's line 1 and line 43 comments carry pre-existing
non-ASCII; the anchor below is ASCII).

old_string:

```css
.error {
  font-size: var(--fs-sm);
  color: var(--c-danger);
}
```

new_string:

```css
.error {
  font-size: var(--fs-sm);
  color: var(--c-danger);
}

/* A field's help line or note (the /join "Housing authority" select). */
.help {
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}
```

Step 4 - Run GREEN:

1. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/HousingAuthoritySelect.test.tsx` - expect 10 passed.
2. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public` - expect every file passed.
3. `cd W:/tmp/join-housing-authority/dashboard; npm run typecheck` - expect exit 0.
4. `cd W:/tmp/join-housing-authority; npx eslint dashboard/src/routes/public/HousingAuthoritySelect.tsx dashboard/src/routes/public/HousingAuthoritySelect.test.tsx`
   - expect exit 0 (new files: any error is yours).
5. ASCII:
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/HousingAuthoritySelect.tsx | wc -c` prints 0.
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/HousingAuthoritySelect.test.tsx | wc -c` prints 0.
   - `git -C W:/tmp/join-housing-authority diff -U0 -- dashboard/src/routes/public/IntakeForm.module.css | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` prints 0.

Step 5 - Commit:

1. `git -C W:/tmp/join-housing-authority status` - read it on its own; the only
   changes are `IntakeForm.module.css` (modified) and the two new
   `HousingAuthoritySelect` files (untracked).
2. `test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/join-housing-authority/MERGE_HEAD" && echo MERGE-IN-PROGRESS || echo ok` prints `ok`.
3. `git -C W:/tmp/join-housing-authority add dashboard/src/routes/public/HousingAuthoritySelect.tsx dashboard/src/routes/public/HousingAuthoritySelect.test.tsx dashboard/src/routes/public/IntakeForm.module.css`
4. `git -C W:/tmp/join-housing-authority commit -m "feat(join): HousingAuthoritySelect, the /join housing authority field" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 3.4 - /join reads the list: Atlanta default, "Not sure", loading, failed, 10 s timeout, StrictMode, abort on unmount

Files:
- Rewrite `dashboard/src/routes/public/HousingFairIntake.test.tsx` (ASCII; its
  five existing cases are kept as PINs, waiting for the list to settle first)
- Rewrite `dashboard/src/routes/public/HousingFairIntake.tsx` (ASCII)

Step 1 - Write the failing tests. Read
`dashboard/src/routes/public/HousingFairIntake.test.tsx`, then replace the
WHOLE file (Write tool) with exactly:

```tsx
// HousingFairIntake (/join) tests. The standalone intake works with NO unit:
// a successful submit (no unitId) -> a generic thank-you, no reveal; plus
// IntakeForm client validation through the page. join-housing-authority D8:
// the "Housing authority" select - the list read on mount, the Atlanta
// default, "Not sure" sending nothing, the loading / failed / 10 s timeout
// states, abort on unmount, and React StrictMode's double effect. The public
// API module is mocked.
import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const getHousingAuthorities = vi.fn();
const submitHousingFair = vi.fn();
vi.mock('./publicApi.js', async () => {
  const actual = await vi.importActual<typeof import('./publicApi.js')>('./publicApi.js');
  return {
    ...actual,
    getHousingAuthorities: (...a: unknown[]) => getHousingAuthorities(...a),
    submitHousingFair: (...a: unknown[]) => submitHousingFair(...a),
  };
});

import { HousingFairIntake } from './HousingFairIntake.js';

const NAMES = ['Atlanta Housing Authority', 'Cobb County Housing Authority', 'DeKalb Housing Authority'];
const EM_DASH = String.fromCharCode(0x2014);
const HELP = 'The organization that runs your voucher.';
const FAILED_NOTE = 'The list of housing authorities could not be loaded.';

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: /sign me up/i });
}

function consentBox(): HTMLElement {
  return screen.getByRole('checkbox', { name: /I agree to receive/i });
}

function authoritySelect(): HTMLSelectElement {
  return screen.getByLabelText('Housing authority') as HTMLSelectElement;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.options, (o) => o.textContent ?? '');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A list read that never answers, but rejects like fetch when aborted. */
function abortableNever(signal: AbortSignal | undefined): Promise<string[]> {
  return new Promise<string[]>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
}

/** Render /join and wait until the list read has settled (send enabled). */
async function renderJoin(): Promise<void> {
  render(<HousingFairIntake />);
  await waitFor(() => expect(sendButton()).toBeEnabled());
}

async function fillPerson(
  user: ReturnType<typeof userEvent.setup>,
  first: string,
  last: string,
  phone: string,
): Promise<void> {
  await user.type(screen.getByLabelText(/first name/i), first);
  await user.type(screen.getByLabelText(/last name/i), last);
  await user.type(screen.getByLabelText(/phone number/i), phone);
}

beforeEach(() => {
  vi.resetAllMocks();
  getHousingAuthorities.mockResolvedValue(NAMES);
  submitHousingFair.mockResolvedValue(undefined);
});

describe('HousingFairIntake (/join)', () => {
  it('submits WITHOUT a unitId and shows a generic thank-you (no reveal)', async () => {
    const user = userEvent.setup();
    await renderJoin();

    await user.type(screen.getByLabelText(/first name/i), 'Grace');
    await user.type(screen.getByLabelText(/last name/i), 'Hopper');
    await user.type(screen.getByLabelText(/phone number/i), '4045559999');
    // A2P/CTIA consent gate - check the required box before submit.
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalled());
    const arg = submitHousingFair.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('unitId');
    expect(arg).toMatchObject({
      firstName: 'Grace',
      lastName: 'Hopper',
      phone: '+14045559999', // normalized to E.164 on submit
      smsConsent: true,
    });

    expect(await screen.findByText(/you're signed up/i)).toBeInTheDocument();
    // No reveal: no address/details ever shown on /join.
    expect(screen.queryByText(/address/i)).not.toBeInTheDocument();
  });

  it('(PIN) the thank-you heading and text are unchanged, and the heading takes focus', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    const heading = await screen.findByRole('heading', { name: /signed up/i });
    expect(heading.textContent).toBe(`Thanks ${EM_DASH} you're signed up!`);
    expect(heading).toHaveFocus();
    expect(
      screen.getByText("We've got your info. A team member will text you about homes that fit your voucher."),
    ).toBeInTheDocument();
  });

  it('blocks submit when names are empty (validation)', async () => {
    const user = userEvent.setup();
    await renderJoin();

    await user.type(screen.getByLabelText(/phone number/i), '4045559999');
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/first and last name/i);
    expect(submitHousingFair).not.toHaveBeenCalled();
  });

  it('blocks submit when the phone is empty (validation)', async () => {
    const user = userEvent.setup();
    await renderJoin();

    await user.type(screen.getByLabelText(/first name/i), 'Grace');
    await user.type(screen.getByLabelText(/last name/i), 'Hopper');
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/phone number/i);
    expect(submitHousingFair).not.toHaveBeenCalled();
  });

  it('marks name + phone fields required (aria-required) and associates the error', async () => {
    const user = userEvent.setup();
    await renderJoin();

    for (const name of [/first name/i, /last name/i, /phone number/i]) {
      expect(screen.getByLabelText(name)).toHaveAttribute('aria-required', 'true');
    }
    // The optional voucher field is NOT required.
    expect(screen.getByLabelText(/voucher size/i)).not.toHaveAttribute('aria-required', 'true');

    // On a validation error the field is marked invalid + describes the alert.
    await user.click(sendButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('id');
    const errorId = alert.getAttribute('id')!;
    const first = screen.getByLabelText(/first name/i);
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).toHaveAttribute('aria-describedby', errorId);
  });

  it('clears the validation error as soon as the user edits a field', async () => {
    const user = userEvent.setup();
    await renderJoin();

    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // Editing any field clears the standing error (corrected field stops erroring).
    await user.type(screen.getByLabelText(/first name/i), 'G');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/first name/i)).toHaveAttribute('aria-invalid', 'false');
  });
});

describe('the "Housing authority" select (join-housing-authority D8)', () => {
  it('reads the list once on mount and preselects Atlanta Housing Authority; the options are the names in order, then "Not sure"', async () => {
    await renderJoin();

    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);
    const select = authoritySelect();
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('Atlanta Housing Authority');
    expect(select).toHaveDisplayValue('Atlanta Housing Authority');
    expect(optionLabels(select)).toEqual([...NAMES, 'Not sure']);
  });

  it('is described by its help text and sits after "Voucher size", before the consent box', async () => {
    await renderJoin();
    const select = authoritySelect();

    expect(select).toHaveAccessibleDescription(HELP);
    const voucher = screen.getByLabelText(/voucher size/i);
    expect(voucher.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(select.compareDocumentPosition(consentBox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sends the default "Atlanta Housing Authority" when left alone', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).toMatchObject({ housingAuthority: 'Atlanta Housing Authority' });
  });

  it("sends the chosen authority's exact name", async () => {
    const user = userEvent.setup();
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).toMatchObject({ housingAuthority: 'DeKalb Housing Authority' });
  });

  it('"Not sure" sends no housingAuthority', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'Not sure');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).not.toHaveProperty('housingAuthority');
  });

  it('defaults to "Not sure" when "Atlanta Housing Authority" is not an exact listed name', async () => {
    const user = userEvent.setup();
    getHousingAuthorities.mockResolvedValue(['Atlanta Housing Authority (AHA)', 'DeKalb Housing Authority']);
    await renderJoin();

    expect(authoritySelect()).toHaveDisplayValue('Not sure');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).not.toHaveProperty('housingAuthority');
  });

  it('while the list loads: the select is disabled and shows "Loading...", and send is blocked', () => {
    getHousingAuthorities.mockImplementation(() => new Promise<string[]>(() => {}));
    render(<HousingFairIntake />);
    const select = authoritySelect();

    expect(select).toBeDisabled();
    expect(select).toHaveDisplayValue('Loading...');
    expect(optionLabels(select)).toEqual(['Loading...']);
    expect(select).toHaveAccessibleDescription(HELP);
    expect(sendButton()).toBeDisabled();
  });

  it('a failed read (a 429 included) leaves only "Not sure" and the note, and the sign-up still works with no authority', async () => {
    const user = userEvent.setup();
    getHousingAuthorities.mockRejectedValue(
      new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }),
    );
    await renderJoin();
    const select = authoritySelect();

    expect(select).toBeEnabled();
    expect(select).toHaveDisplayValue('Not sure');
    expect(optionLabels(select)).toEqual(['Not sure']);
    expect(screen.getByText(FAILED_NOTE)).toBeInTheDocument();
    expect(select).toHaveAccessibleDescription(`${HELP} ${FAILED_NOTE}`);

    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(1));
    expect(submitHousingFair.mock.calls[0]![0]).not.toHaveProperty('housingAuthority');
    expect(await screen.findByRole('heading', { name: /signed up/i })).toBeInTheDocument();
  });

  it('gives up after 10 seconds: aborts the read, then only "Not sure", the note, and send allowed', async () => {
    // src/test/setup.ts pins Date globally; release that pin before taking FULL
    // fake timers, per the convention documented there.
    vi.useRealTimers();
    vi.useFakeTimers();
    try {
      getHousingAuthorities.mockImplementation(() => new Promise<string[]>(() => {}));
      render(<HousingFairIntake />);
      const select = authoritySelect();
      const signal = getHousingAuthorities.mock.calls[0]![0] as AbortSignal;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });
      expect(select).toBeDisabled();
      expect(select).toHaveDisplayValue('Loading...');
      expect(sendButton()).toBeDisabled();
      expect(signal.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(signal.aborted).toBe(true);
      expect(select).toBeEnabled();
      expect(select).toHaveDisplayValue('Not sure');
      expect(optionLabels(select)).toEqual(['Not sure']);
      expect(screen.getByText(FAILED_NOTE)).toBeInTheDocument();
      expect(sendButton()).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the list read on unmount', () => {
    getHousingAuthorities.mockImplementation(() => new Promise<string[]>(() => {}));
    const { unmount } = render(<HousingFairIntake />);
    const signal = getHousingAuthorities.mock.calls[0]![0] as AbortSignal;

    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("survives React StrictMode: the cleaned-up first read is ignored and the second read fills the select", async () => {
    const second = deferred<string[]>();
    getHousingAuthorities
      .mockImplementationOnce((signal?: AbortSignal) => abortableNever(signal))
      .mockImplementationOnce(() => second.promise);
    render(
      <StrictMode>
        <HousingFairIntake />
      </StrictMode>,
    );
    // Let the first run's abort rejection land.
    await act(async () => {});

    expect(getHousingAuthorities).toHaveBeenCalledTimes(2);
    expect((getHousingAuthorities.mock.calls[0]![0] as AbortSignal).aborted).toBe(true);
    expect((getHousingAuthorities.mock.calls[1]![0] as AbortSignal).aborted).toBe(false);
    // The aborted first read must NOT have put the select into the failed state.
    const select = authoritySelect();
    expect(select).toBeDisabled();
    expect(select).toHaveDisplayValue('Loading...');
    expect(screen.queryByText(FAILED_NOTE)).toBeNull();

    await act(async () => {
      second.resolve(NAMES);
    });
    expect(select).toBeEnabled();
    expect(select).toHaveDisplayValue('Atlanta Housing Authority');
    expect(sendButton()).toBeEnabled();
  });

  it('disables the select while the sign-up is sending', async () => {
    const user = userEvent.setup();
    const send = deferred<void>();
    submitHousingFair.mockImplementation(() => send.promise);
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    await waitFor(() => expect(authoritySelect()).toBeDisabled());
    await act(async () => {
      send.resolve();
    });
    expect(await screen.findByRole('heading', { name: /signed up/i })).toBeInTheDocument();
  });
});
```

Step 2 - Run RED:

`cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/HousingFairIntake.test.tsx`

Expected: 12 failed, 6 passed. The six cases in "HousingFairIntake (/join)"
PASS (today's behavior; on today's code `renderJoin` returns at once because
the button is never disabled). All twelve cases in "the Housing authority
select" FAIL: most with
"Unable to find a label with the text of: Housing authority"; "aborts the list
read on unmount" and "gives up after 10 seconds" with a TypeError reading
`mock.calls[0]` (the list is never read); the StrictMode case on
`toHaveBeenCalledTimes(2)` (0 calls).

Step 3 - Implement. Read `dashboard/src/routes/public/HousingFairIntake.tsx`,
then replace the WHOLE file (Write tool) with exactly the content below. The
file becomes pure ASCII: the heading keeps its em dash through the JSX entity
`&mdash;` (it renders the same U+2014 character; the PIN above checks the
rendered text).

```tsx
// HousingFairIntake (/join) - the standalone, unauthenticated housing-fair
// signup. No unit of interest: it submits the IntakeForm WITHOUT a unitId (so
// the backend stamps capture_source:'housing_fair'), then shows a generic
// thank-you. There is NO reveal here (no home to reveal). Tenant-facing copy.
//
// Housing authority (join-housing-authority spec D8). The page reads the
// public list (GET /public/housing-authorities) and hands IntakeForm a
// "Housing authority" select as its extraField. This component owns the list
// state and the chosen value; IntakeForm owns the person's fields.
// - Default: "Atlanta Housing Authority" when that exact name is listed, else
//   "Not sure". "Not sure" sends no housingAuthority.
// - While the list loads the select shows "Loading..." and send is blocked. A
//   read that fails (any error, a 429 included) or takes longer than 10 s
//   leaves only "Not sure" and a note; the sign-up still works.
// The read is aborted on unmount. React StrictMode (dev and every e2e lane)
// runs the effect twice: each run owns its own AbortController and timer, and
// a run that was cleaned up ignores whatever its request later returns, so the
// second run's read is the one that lands. State is set only from the
// request's callbacks and the timeout, never synchronously in the effect.
import { useEffect, useRef, useState } from 'react';
import { getHousingAuthorities, submitHousingFair, type HousingFairInput } from './publicApi.js';
import { IntakeForm } from './IntakeForm.js';
import {
  HousingAuthoritySelect,
  NOT_SURE_VALUE,
  authorityToSend,
  defaultAuthorityChoice,
  type AuthorityList,
} from './HousingAuthoritySelect.js';
import styles from './FlyerPage.module.css';

/** D8: the list read gives up after 10 seconds. */
const HOUSING_AUTHORITY_LIST_TIMEOUT_MS = 10_000;

export function HousingFairIntake(): React.JSX.Element {
  const [done, setDone] = useState(false);
  const [list, setList] = useState<AuthorityList>({ kind: 'loading' });
  const [choice, setChoice] = useState<string>(NOT_SURE_VALUE);
  const [sending, setSending] = useState(false);

  // On submit the form swaps to a thank-you with a new <h1>, but focus would stay
  // on the (removed) submit button - silent to screen readers. Move focus to the
  // done-state heading (tabIndex={-1}) so the conversion is announced.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (done) headingRef.current?.focus();
  }, [done]);

  // D8: read the list once on mount.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      setList({ kind: 'failed' });
      setChoice(NOT_SURE_VALUE);
    }, HOUSING_AUTHORITY_LIST_TIMEOUT_MS);
    getHousingAuthorities(controller.signal).then(
      (names) => {
        if (controller.signal.aborted) return; // cleaned up, or timed out
        clearTimeout(timer);
        setList({ kind: 'ready', names });
        setChoice(defaultAuthorityChoice(names));
      },
      () => {
        if (controller.signal.aborted) return; // cleaned up, or timed out
        clearTimeout(timer);
        setList({ kind: 'failed' });
        setChoice(NOT_SURE_VALUE);
      },
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  async function handleSubmit(input: Omit<HousingFairInput, 'unitId' | 'housingAuthority'>): Promise<void> {
    // No unitId - a plain housing-fair signup. "Not sure" (or no list) sends
    // no housingAuthority key at all.
    const housingAuthority = authorityToSend(list, choice);
    setSending(true);
    try {
      await submitHousingFair(housingAuthority === undefined ? input : { ...input, housingAuthority });
    } finally {
      setSending(false);
    }
    setDone(true);
  }

  if (done) {
    return (
      <section className={styles.card}>
        <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
          Thanks &mdash; you&apos;re signed up!
        </h1>
        <p className={styles.muted}>
          We&apos;ve got your info. A team member will text you about homes that fit your voucher.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <h1 className={styles.title}>Find your next home</h1>
      <p className={styles.muted}>
        Sign up and we&apos;ll text you about homes that fit your voucher.
      </p>
      <IntakeForm
        onSubmit={handleSubmit}
        submitLabel="Sign me up"
        extraField={
          <HousingAuthoritySelect list={list} value={choice} onChange={setChoice} disabled={sending} />
        }
        submitBlocked={list.kind === 'loading'}
      />
    </section>
  );
}
```

Step 4 - Run GREEN:

1. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/HousingFairIntake.test.tsx` - expect 18 passed.
2. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public` - expect every file passed.
3. `cd W:/tmp/join-housing-authority/dashboard; npm run typecheck` - expect exit 0.
4. `cd W:/tmp/join-housing-authority; npx eslint dashboard/src/routes/public/HousingFairIntake.tsx dashboard/src/routes/public/HousingFairIntake.test.tsx`
   - expect exit 0. In particular no `react-hooks/set-state-in-effect`: every
     setState in the list effect is inside a `.then` callback or the timeout
     callback. If the rule still fires, do not add a disable comment - report
     it as a QUESTION in the ledger.
5. ASCII:
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/HousingFairIntake.tsx | wc -c` prints 0.
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/HousingFairIntake.test.tsx | wc -c` prints 0.

Step 5 - Commit:

1. `git -C W:/tmp/join-housing-authority status` - read it on its own; the only
   changes are `HousingFairIntake.tsx` and `HousingFairIntake.test.tsx` (modified).
2. `test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/join-housing-authority/MERGE_HEAD" && echo MERGE-IN-PROGRESS || echo ok` prints `ok`.
3. `git -C W:/tmp/join-housing-authority add dashboard/src/routes/public/HousingFairIntake.tsx dashboard/src/routes/public/HousingFairIntake.test.tsx`
4. `git -C W:/tmp/join-housing-authority commit -m "feat(join): /join reads the housing authority list and preselects Atlanta Housing Authority" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 3.5 - /join recovers from housing_authority_not_listed and names a 429

Files:
- Create `dashboard/src/routes/public/HousingFairIntake.recovery.test.tsx`
- Rewrite `dashboard/src/routes/public/HousingFairIntake.tsx` (ASCII)

Step 1 - Write the failing tests. Create
`dashboard/src/routes/public/HousingFairIntake.recovery.test.tsx` with exactly:

```tsx
// HousingFairIntake (/join) - sign-up failures (join-housing-authority D8).
// housing_authority_not_listed (the list changed after the page read it): the
// page reads the list again, keeps every typed field and the consent box,
// picks NO value ("Choose one"), blocks send until a choice, and says so; a
// failed re-read falls into the failed-list state. A 429 gets its own message.
// Every other failure keeps IntakeForm's message. The public API module is
// mocked.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const getHousingAuthorities = vi.fn();
const submitHousingFair = vi.fn();
vi.mock('./publicApi.js', async () => {
  const actual = await vi.importActual<typeof import('./publicApi.js')>('./publicApi.js');
  return {
    ...actual,
    getHousingAuthorities: (...a: unknown[]) => getHousingAuthorities(...a),
    submitHousingFair: (...a: unknown[]) => submitHousingFair(...a),
  };
});

import { HousingFairIntake } from './HousingFairIntake.js';

const NAMES = ['Atlanta Housing Authority', 'Cobb County Housing Authority', 'DeKalb Housing Authority'];
// The list after a Settings change: DeKalb gone, Fulton added, Atlanta still there.
const NEW_NAMES = ['Atlanta Housing Authority', 'Cobb County Housing Authority', 'Fulton County Housing Authority'];
const NOT_LISTED = 'The housing authority list was updated. Choose the housing authority again.';
const TOO_MANY = 'Too many sign-ups from this network in the last minute. Wait a minute, then send again.';
const TODAYS_ERROR = "Sorry, we couldn't send that. Please try again.";
const FAILED_NOTE = 'The list of housing authorities could not be loaded.';

function notListed(): ApiError {
  return new ApiError(400, 'housing_authority_not_listed', 'housing_authority_not_listed', {
    error: 'housing_authority_not_listed',
  });
}

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: /sign me up/i });
}

function consentBox(): HTMLElement {
  return screen.getByRole('checkbox', { name: /I agree to receive/i });
}

function authoritySelect(): HTMLSelectElement {
  return screen.getByLabelText('Housing authority') as HTMLSelectElement;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.options, (o) => o.textContent ?? '');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Render /join and wait until the list read has settled (send enabled). */
async function renderJoin(): Promise<void> {
  render(<HousingFairIntake />);
  await waitFor(() => expect(sendButton()).toBeEnabled());
}

async function fillPerson(
  user: ReturnType<typeof userEvent.setup>,
  first: string,
  last: string,
  phone: string,
): Promise<void> {
  await user.type(screen.getByLabelText(/first name/i), first);
  await user.type(screen.getByLabelText(/last name/i), last);
  await user.type(screen.getByLabelText(/phone number/i), phone);
}

beforeEach(() => {
  vi.resetAllMocks();
  getHousingAuthorities.mockResolvedValue(NAMES);
  submitHousingFair.mockResolvedValue(undefined);
});

describe('housing_authority_not_listed recovery', () => {
  it('reads the list again, keeps every typed field and the consent box, picks no value, and blocks send until a choice', async () => {
    const user = userEvent.setup();
    const reread = deferred<string[]>();
    getHousingAuthorities.mockResolvedValueOnce(NAMES).mockImplementationOnce(() => reread.promise);
    submitHousingFair.mockRejectedValueOnce(notListed()).mockResolvedValueOnce(undefined);
    await renderJoin();

    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.type(screen.getByLabelText(/voucher size/i), '2');
    await user.click(consentBox());
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_LISTED);
    expect(submitHousingFair.mock.calls[0]![0]).toMatchObject({ housingAuthority: 'DeKalb Housing Authority' });
    // The list is read again; while it loads the select is disabled and send is blocked.
    await waitFor(() => expect(getHousingAuthorities).toHaveBeenCalledTimes(2));
    const select = authoritySelect();
    expect(select).toBeDisabled();
    expect(select).toHaveDisplayValue('Loading...');
    expect(sendButton()).toBeDisabled();

    await act(async () => {
      reread.resolve(NEW_NAMES);
    });
    // No value is picked - not even the Atlanta default, which is still listed.
    expect(select).toBeEnabled();
    expect(select).toHaveDisplayValue('Choose one');
    expect(optionLabels(select)).toEqual(['Choose one', ...NEW_NAMES, 'Not sure']);
    expect(sendButton()).toBeDisabled();
    // Every typed field and the consent box are as they were.
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Grace');
    expect(screen.getByLabelText(/last name/i)).toHaveValue('Hopper');
    expect(screen.getByLabelText(/phone number/i)).toHaveValue('(404) 555-9999');
    expect(screen.getByLabelText(/voucher size/i)).toHaveValue(2);
    expect(consentBox()).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent(NOT_LISTED);

    await user.selectOptions(select, 'Cobb County Housing Authority');
    expect(sendButton()).toBeEnabled();
    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(2));
    expect(submitHousingFair.mock.calls[1]![0]).toMatchObject({
      firstName: 'Grace',
      lastName: 'Hopper',
      phone: '+14045559999',
      voucherSize: 2,
      smsConsent: true,
      housingAuthority: 'Cobb County Housing Authority',
    });
    expect(await screen.findByRole('heading', { name: /signed up/i })).toBeInTheDocument();
  });

  it('after the message, "Not sure" is a choice too: send unblocks and goes out with no authority', async () => {
    const user = userEvent.setup();
    getHousingAuthorities.mockResolvedValueOnce(NAMES).mockResolvedValueOnce(NEW_NAMES);
    submitHousingFair.mockRejectedValueOnce(notListed()).mockResolvedValueOnce(undefined);
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_LISTED);
    const select = authoritySelect();
    await waitFor(() => expect(select).toHaveDisplayValue('Choose one'));
    expect(sendButton()).toBeDisabled();

    await user.selectOptions(select, 'Not sure');
    expect(sendButton()).toBeEnabled();
    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(2));
    expect(submitHousingFair.mock.calls[1]![0]).not.toHaveProperty('housingAuthority');
  });

  it('a failed re-read falls into the failed state: only "Not sure", the note, and the sign-up still works', async () => {
    const user = userEvent.setup();
    getHousingAuthorities
      .mockResolvedValueOnce(NAMES)
      .mockRejectedValueOnce(new ApiError(0, 'network_error', 'Network request failed'));
    submitHousingFair.mockRejectedValueOnce(notListed()).mockResolvedValueOnce(undefined);
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_LISTED);
    await waitFor(() => expect(getHousingAuthorities).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(FAILED_NOTE)).toBeInTheDocument();
    const select = authoritySelect();
    expect(select).toBeEnabled();
    expect(select).toHaveDisplayValue('Not sure');
    expect(optionLabels(select)).toEqual(['Not sure']);
    expect(sendButton()).toBeEnabled();

    await user.click(sendButton());
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(2));
    expect(submitHousingFair.mock.calls[1]![0]).not.toHaveProperty('housingAuthority');
    expect(await screen.findByRole('heading', { name: /signed up/i })).toBeInTheDocument();
  });
});

describe('other sign-up failures', () => {
  it('a 429 says so and keeps the form as it is; the list is not read again', async () => {
    const user = userEvent.setup();
    submitHousingFair.mockRejectedValueOnce(
      new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }),
    );
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(TOO_MANY);
    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);
    expect(authoritySelect()).toHaveDisplayValue('DeKalb Housing Authority');
    expect(authoritySelect()).toBeEnabled();
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Grace');
    expect(consentBox()).toBeChecked();
    expect(sendButton()).toBeEnabled();
  });

  it("(PIN) every other failure keeps today's message", async () => {
    const user = userEvent.setup();
    submitHousingFair
      .mockRejectedValueOnce(new ApiError(500, 'internal', 'internal', { error: 'internal' }))
      .mockRejectedValueOnce(new ApiError(0, 'network_error', 'Network request failed'))
      .mockRejectedValueOnce(new ApiError(400, 'invalid request', 'invalid request', { error: 'invalid request' }));
    await renderJoin();
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.click(consentBox());

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await user.click(sendButton());
      await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(attempt));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(TODAYS_ERROR));
    }
    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);
    expect(authoritySelect()).toHaveDisplayValue('Atlanta Housing Authority');
  });
});
```

Step 2 - Run RED:

`cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/HousingFairIntake.recovery.test.tsx`

Expected: 4 failed, 1 passed. The three not-listed cases and the 429 case
fail on the alert text (it reads "Sorry, we couldn't send that. Please try
again."). The "(PIN) every other failure" case passes.

Step 3 - Implement. Replace the WHOLE of
`dashboard/src/routes/public/HousingFairIntake.tsx` (Write tool) with exactly:

```tsx
// HousingFairIntake (/join) - the standalone, unauthenticated housing-fair
// signup. No unit of interest: it submits the IntakeForm WITHOUT a unitId (so
// the backend stamps capture_source:'housing_fair'), then shows a generic
// thank-you. There is NO reveal here (no home to reveal). Tenant-facing copy.
//
// Housing authority (join-housing-authority spec D8). The page reads the
// public list (GET /public/housing-authorities) and hands IntakeForm a
// "Housing authority" select as its extraField. This component owns the list
// state, the chosen value and the housing_authority_not_listed recovery;
// IntakeForm owns the person's fields.
// - Default: "Atlanta Housing Authority" when that exact name is listed, else
//   "Not sure". "Not sure" sends no housingAuthority.
// - While the list loads the select shows "Loading..." and send is blocked. A
//   read that fails (any error, a 429 included) or takes longer than 10 s
//   leaves only "Not sure" and a note; the sign-up still works.
// - housing_authority_not_listed (the list changed after this page read it):
//   read the list again, keep every typed field and the consent box, show a
//   "Choose one" placeholder and block send until a choice is made.
// - A 429 on the sign-up gets its own message; every other failure keeps
//   IntakeForm's message.
// The read is aborted on unmount. React StrictMode (dev and every e2e lane)
// runs the effect twice: each run owns its own AbortController and timer, and
// a run that was cleaned up ignores whatever its request later returns, so the
// second run's read is the one that lands. State is set only from the
// request's callbacks and the timeout, never synchronously in the effect; a
// re-read is started from a handler (readListAgain).
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  getHousingAuthorities,
  submitHousingFair,
  type HousingFairInput,
} from './publicApi.js';
import { IntakeForm } from './IntakeForm.js';
import {
  CHOOSE_ONE_VALUE,
  HousingAuthoritySelect,
  NOT_SURE_VALUE,
  authorityToSend,
  defaultAuthorityChoice,
  type AuthorityList,
} from './HousingAuthoritySelect.js';
import styles from './FlyerPage.module.css';

/** D8: the list read gives up after 10 seconds. */
const HOUSING_AUTHORITY_LIST_TIMEOUT_MS = 10_000;

const NOT_LISTED_MESSAGE = 'The housing authority list was updated. Choose the housing authority again.';
const TOO_MANY_SIGNUPS_MESSAGE =
  'Too many sign-ups from this network in the last minute. Wait a minute, then send again.';

/** IntakeForm's errorMessage: the two /join-only messages; null keeps
 *  IntakeForm's own message for every other failure. */
function joinErrorMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === HOUSING_AUTHORITY_NOT_LISTED) return NOT_LISTED_MESSAGE;
  if (err.status === 429) return TOO_MANY_SIGNUPS_MESSAGE;
  return null;
}

/** One list read. `choose` (after a not-listed refusal) shows the "Choose
 *  one" placeholder instead of applying the default rule. Every request is a
 *  new object, so the effect (keyed on the object) runs again even when the
 *  mode repeats. */
interface ListRequest {
  readonly seq: number;
  readonly mode: 'default' | 'choose';
}

export function HousingFairIntake(): React.JSX.Element {
  const [done, setDone] = useState(false);
  const [list, setList] = useState<AuthorityList>({ kind: 'loading' });
  const [choice, setChoice] = useState<string>(NOT_SURE_VALUE);
  const [listRequest, setListRequest] = useState<ListRequest>({ seq: 0, mode: 'default' });
  const [sending, setSending] = useState(false);

  // On submit the form swaps to a thank-you with a new <h1>, but focus would stay
  // on the (removed) submit button - silent to screen readers. Move focus to the
  // done-state heading (tabIndex={-1}) so the conversion is announced.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (done) headingRef.current?.focus();
  }, [done]);

  // D8: one list read per ListRequest (the first on mount).
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      setList({ kind: 'failed' });
      setChoice(NOT_SURE_VALUE);
    }, HOUSING_AUTHORITY_LIST_TIMEOUT_MS);
    getHousingAuthorities(controller.signal).then(
      (names) => {
        if (controller.signal.aborted) return; // cleaned up, or timed out
        clearTimeout(timer);
        setList({ kind: 'ready', names });
        setChoice(listRequest.mode === 'choose' ? CHOOSE_ONE_VALUE : defaultAuthorityChoice(names));
      },
      () => {
        if (controller.signal.aborted) return; // cleaned up, or timed out
        clearTimeout(timer);
        setList({ kind: 'failed' });
        setChoice(NOT_SURE_VALUE);
      },
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [listRequest]);

  /** Start a new list read: the select shows "Loading..." and send is blocked
   *  until it settles. Called from handlers only, never from an effect. */
  function readListAgain(mode: ListRequest['mode']): void {
    setList({ kind: 'loading' });
    setListRequest((prev) => ({ seq: prev.seq + 1, mode }));
  }

  async function handleSubmit(input: Omit<HousingFairInput, 'unitId' | 'housingAuthority'>): Promise<void> {
    // No unitId - a plain housing-fair signup. "Not sure" (or no list) sends
    // no housingAuthority key at all.
    const housingAuthority = authorityToSend(list, choice);
    setSending(true);
    try {
      await submitHousingFair(housingAuthority === undefined ? input : { ...input, housingAuthority });
    } catch (err) {
      setSending(false);
      // D8: the list changed after this page read it. Read it again and make
      // the person choose (the effect shows "Choose one" for a `choose` read).
      if (err instanceof ApiError && err.code === HOUSING_AUTHORITY_NOT_LISTED) readListAgain('choose');
      // IntakeForm shows joinErrorMessage(err) (or its own message) and keeps
      // every typed field and the consent box.
      throw err;
    }
    setSending(false);
    setDone(true);
  }

  if (done) {
    return (
      <section className={styles.card}>
        <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
          Thanks &mdash; you&apos;re signed up!
        </h1>
        <p className={styles.muted}>
          We&apos;ve got your info. A team member will text you about homes that fit your voucher.
        </p>
      </section>
    );
  }

  const submitBlocked = list.kind === 'loading' || (list.kind === 'ready' && choice === CHOOSE_ONE_VALUE);

  return (
    <section className={styles.card}>
      <h1 className={styles.title}>Find your next home</h1>
      <p className={styles.muted}>
        Sign up and we&apos;ll text you about homes that fit your voucher.
      </p>
      <IntakeForm
        onSubmit={handleSubmit}
        submitLabel="Sign me up"
        extraField={
          <HousingAuthoritySelect list={list} value={choice} onChange={setChoice} disabled={sending} />
        }
        submitBlocked={submitBlocked}
        errorMessage={joinErrorMessage}
      />
    </section>
  );
}
```

Step 4 - Run GREEN:

1. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/HousingFairIntake.recovery.test.tsx` - expect 5 passed.
2. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public` - expect every file passed (`HousingFairIntake.test.tsx` from 3.4 included).
3. `cd W:/tmp/join-housing-authority/dashboard; npm run typecheck` - expect exit 0.
4. `cd W:/tmp/join-housing-authority; npx eslint dashboard/src/routes/public/HousingFairIntake.tsx dashboard/src/routes/public/HousingFairIntake.recovery.test.tsx`
   - expect exit 0 (same note on `set-state-in-effect` as Task 3.4: no disable comments; a hit is a QUESTION).
5. ASCII:
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/HousingFairIntake.tsx | wc -c` prints 0.
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/HousingFairIntake.recovery.test.tsx | wc -c` prints 0.

Step 5 - Commit:

1. `git -C W:/tmp/join-housing-authority status` - read it on its own; the only
   changes are `HousingFairIntake.tsx` (modified) and
   `HousingFairIntake.recovery.test.tsx` (untracked).
2. `test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/join-housing-authority/MERGE_HEAD" && echo MERGE-IN-PROGRESS || echo ok` prints `ok`.
3. `git -C W:/tmp/join-housing-authority add dashboard/src/routes/public/HousingFairIntake.tsx dashboard/src/routes/public/HousingFairIntake.recovery.test.tsx`
4. `git -C W:/tmp/join-housing-authority commit -m "feat(join): /join recovers from housing_authority_not_listed and names a 429" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

#### Task 3.6 - /join thank-you: "Sign up another person"

Files:
- Create `dashboard/src/routes/public/HousingFairIntake.another.test.tsx`
- Rewrite `dashboard/src/routes/public/HousingFairIntake.tsx` (ASCII)

Step 1 - Write the failing tests. Create
`dashboard/src/routes/public/HousingFairIntake.another.test.tsx` with exactly:

```tsx
// HousingFairIntake (/join) - "Sign up another person" (join-housing-authority
// D9). The thank-you keeps its heading and text and adds the button. It
// returns an empty form (names, phone, voucher blank, the consent box
// unchecked), keeps the select on the previous choice, moves focus to "First
// name", and reads the list again ONLY when the last read failed (then the
// default rule applies). The public API module is mocked.
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const getHousingAuthorities = vi.fn();
const submitHousingFair = vi.fn();
vi.mock('./publicApi.js', async () => {
  const actual = await vi.importActual<typeof import('./publicApi.js')>('./publicApi.js');
  return {
    ...actual,
    getHousingAuthorities: (...a: unknown[]) => getHousingAuthorities(...a),
    submitHousingFair: (...a: unknown[]) => submitHousingFair(...a),
  };
});

import { HousingFairIntake } from './HousingFairIntake.js';

const NAMES = ['Atlanta Housing Authority', 'Cobb County Housing Authority', 'DeKalb Housing Authority'];
const EM_DASH = String.fromCharCode(0x2014);
const FAILED_NOTE = 'The list of housing authorities could not be loaded.';

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: /sign me up/i });
}

function consentBox(): HTMLElement {
  return screen.getByRole('checkbox', { name: /I agree to receive/i });
}

function authoritySelect(): HTMLSelectElement {
  return screen.getByLabelText('Housing authority') as HTMLSelectElement;
}

/** Render /join and wait until the list read has settled (send enabled). */
async function renderJoin(): Promise<void> {
  render(<HousingFairIntake />);
  await waitFor(() => expect(sendButton()).toBeEnabled());
}

async function fillPerson(
  user: ReturnType<typeof userEvent.setup>,
  first: string,
  last: string,
  phone: string,
): Promise<void> {
  await user.type(screen.getByLabelText(/first name/i), first);
  await user.type(screen.getByLabelText(/last name/i), last);
  await user.type(screen.getByLabelText(/phone number/i), phone);
}

/** Fill, consent, send, and wait for the thank-you. */
async function signUp(
  user: ReturnType<typeof userEvent.setup>,
  first: string,
  last: string,
  phone: string,
): Promise<void> {
  await fillPerson(user, first, last, phone);
  await user.click(consentBox());
  await user.click(sendButton());
  await screen.findByRole('heading', { name: /signed up/i });
}

beforeEach(() => {
  vi.resetAllMocks();
  getHousingAuthorities.mockResolvedValue(NAMES);
  submitHousingFair.mockResolvedValue(undefined);
});

describe('"Sign up another person" (join-housing-authority D9)', () => {
  it('the thank-you keeps its heading and text and adds the button', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await signUp(user, 'Grace', 'Hopper', '4045559999');

    const heading = screen.getByRole('heading', { name: /signed up/i });
    expect(heading.textContent).toBe(`Thanks ${EM_DASH} you're signed up!`);
    expect(heading).toHaveFocus();
    expect(
      screen.getByText("We've got your info. A team member will text you about homes that fit your voucher."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign up another person' })).toBeEnabled();
  });

  it('returns an empty form with the consent box unchecked, keeps the chosen authority, focuses First name, and reads nothing', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'DeKalb Housing Authority');
    await fillPerson(user, 'Grace', 'Hopper', '4045559999');
    await user.type(screen.getByLabelText(/voucher size/i), '2');
    await user.click(consentBox());
    await user.click(sendButton());
    await user.click(await screen.findByRole('button', { name: 'Sign up another person' }));

    const first = screen.getByLabelText(/first name/i);
    expect(first).toHaveFocus();
    expect(first).toHaveValue('');
    expect(screen.getByLabelText(/last name/i)).toHaveValue('');
    expect(screen.getByLabelText(/phone number/i)).toHaveValue('');
    expect(screen.getByLabelText(/voucher size/i)).toHaveValue(null);
    expect(consentBox()).not.toBeChecked();
    expect(screen.queryByRole('alert')).toBeNull();
    const select = authoritySelect();
    expect(select).toHaveDisplayValue('DeKalb Housing Authority');
    expect(select).toBeEnabled();
    expect(sendButton()).toBeEnabled();
    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);

    // The next person goes out with the kept authority.
    await signUp(user, 'Alan', 'Turing', '4045558888');
    expect(submitHousingFair).toHaveBeenCalledTimes(2);
    expect(submitHousingFair.mock.calls[1]![0]).toMatchObject({
      firstName: 'Alan',
      lastName: 'Turing',
      phone: '+14045558888',
      smsConsent: true,
      housingAuthority: 'DeKalb Housing Authority',
    });
    expect(submitHousingFair.mock.calls[1]![0]).not.toHaveProperty('voucherSize');
  });

  it('keeps a "Not sure" choice, and the next person also goes out with no authority', async () => {
    const user = userEvent.setup();
    await renderJoin();
    await user.selectOptions(authoritySelect(), 'Not sure');
    await signUp(user, 'Grace', 'Hopper', '4045559999');
    await user.click(screen.getByRole('button', { name: 'Sign up another person' }));

    expect(authoritySelect()).toHaveDisplayValue('Not sure');
    await signUp(user, 'Alan', 'Turing', '4045558888');
    expect(submitHousingFair.mock.calls[1]![0]).not.toHaveProperty('housingAuthority');
    expect(getHousingAuthorities).toHaveBeenCalledTimes(1);
  });

  it('after a failed read, reads the list again and applies the default rule', async () => {
    const user = userEvent.setup();
    getHousingAuthorities
      .mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }))
      .mockResolvedValueOnce(NAMES);
    await renderJoin();
    expect(authoritySelect()).toHaveDisplayValue('Not sure');
    expect(screen.getByText(FAILED_NOTE)).toBeInTheDocument();
    await signUp(user, 'Grace', 'Hopper', '4045559999');
    expect(submitHousingFair.mock.calls[0]![0]).not.toHaveProperty('housingAuthority');

    await user.click(screen.getByRole('button', { name: 'Sign up another person' }));
    await waitFor(() => expect(getHousingAuthorities).toHaveBeenCalledTimes(2));
    const select = authoritySelect();
    await waitFor(() => expect(select).toHaveDisplayValue('Atlanta Housing Authority'));
    expect(select).toBeEnabled();
    expect(screen.queryByText(FAILED_NOTE)).toBeNull();
    expect(screen.getByLabelText(/first name/i)).toHaveFocus();
  });

  it('under StrictMode, makes no list read after a good load (the remount reads nothing)', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <HousingFairIntake />
      </StrictMode>,
    );
    await waitFor(() => expect(sendButton()).toBeEnabled());
    const readsAfterLoad = getHousingAuthorities.mock.calls.length;
    await signUp(user, 'Grace', 'Hopper', '4045559999');
    await user.click(screen.getByRole('button', { name: 'Sign up another person' }));

    expect(screen.getByLabelText(/first name/i)).toHaveFocus();
    expect(authoritySelect()).toHaveDisplayValue('Atlanta Housing Authority');
    expect(getHousingAuthorities).toHaveBeenCalledTimes(readsAfterLoad);
  });

  it('(PIN) a first visit does not move focus into the form', async () => {
    await renderJoin();
    expect(document.body).toHaveFocus();
  });
});
```

Step 2 - Run RED:

`cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/HousingFairIntake.another.test.tsx`

Expected: 5 failed, 1 passed. Every case that looks for the
"Sign up another person" button fails ("Unable to find role button" / its
findBy times out); "(PIN) a first visit does not move focus" passes.

Step 3 - Implement. Replace the WHOLE of
`dashboard/src/routes/public/HousingFairIntake.tsx` (Write tool) with exactly:

```tsx
// HousingFairIntake (/join) - the standalone, unauthenticated housing-fair
// signup. No unit of interest: it submits the IntakeForm WITHOUT a unitId (so
// the backend stamps capture_source:'housing_fair'), then shows a generic
// thank-you. There is NO reveal here (no home to reveal). Tenant-facing copy.
//
// Housing authority (join-housing-authority spec D8, D9). The page reads the
// public list (GET /public/housing-authorities) and hands IntakeForm a
// "Housing authority" select as its extraField. This component owns the list
// state, the chosen value, the housing_authority_not_listed recovery and the
// "Sign up another person" reset; IntakeForm owns the person's fields.
// - Default: "Atlanta Housing Authority" when that exact name is listed, else
//   "Not sure". "Not sure" sends no housingAuthority.
// - While the list loads the select shows "Loading..." and send is blocked. A
//   read that fails (any error, a 429 included) or takes longer than 10 s
//   leaves only "Not sure" and a note; the sign-up still works.
// - housing_authority_not_listed (the list changed after this page read it):
//   read the list again, keep every typed field and the consent box, show a
//   "Choose one" placeholder and block send until a choice is made.
// - A 429 on the sign-up gets its own message; every other failure keeps
//   IntakeForm's message.
// - "Sign up another person": an empty form (IntakeForm remounts on a new
//   key), the select kept on the previous choice, focus on First name. The
//   list read lives HERE, not in the remounting form, so the list is read
//   again only when the last read failed (then the default rule applies).
// The read is aborted on unmount. React StrictMode (dev and every e2e lane)
// runs the effect twice: each run owns its own AbortController and timer, and
// a run that was cleaned up ignores whatever its request later returns, so the
// second run's read is the one that lands. State is set only from the
// request's callbacks and the timeout, never synchronously in the effect; a
// re-read is started from a handler (readListAgain).
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  getHousingAuthorities,
  submitHousingFair,
  type HousingFairInput,
} from './publicApi.js';
import { IntakeForm } from './IntakeForm.js';
import {
  CHOOSE_ONE_VALUE,
  HousingAuthoritySelect,
  NOT_SURE_VALUE,
  authorityToSend,
  defaultAuthorityChoice,
  type AuthorityList,
} from './HousingAuthoritySelect.js';
import styles from './FlyerPage.module.css';

/** D8: the list read gives up after 10 seconds. */
const HOUSING_AUTHORITY_LIST_TIMEOUT_MS = 10_000;

const NOT_LISTED_MESSAGE = 'The housing authority list was updated. Choose the housing authority again.';
const TOO_MANY_SIGNUPS_MESSAGE =
  'Too many sign-ups from this network in the last minute. Wait a minute, then send again.';

/** IntakeForm's errorMessage: the two /join-only messages; null keeps
 *  IntakeForm's own message for every other failure. */
function joinErrorMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === HOUSING_AUTHORITY_NOT_LISTED) return NOT_LISTED_MESSAGE;
  if (err.status === 429) return TOO_MANY_SIGNUPS_MESSAGE;
  return null;
}

/** One list read. `choose` (after a not-listed refusal) shows the "Choose
 *  one" placeholder instead of applying the default rule. Every request is a
 *  new object, so the effect (keyed on the object) runs again even when the
 *  mode repeats. */
interface ListRequest {
  readonly seq: number;
  readonly mode: 'default' | 'choose';
}

export function HousingFairIntake(): React.JSX.Element {
  const [done, setDone] = useState(false);
  const [list, setList] = useState<AuthorityList>({ kind: 'loading' });
  const [choice, setChoice] = useState<string>(NOT_SURE_VALUE);
  const [listRequest, setListRequest] = useState<ListRequest>({ seq: 0, mode: 'default' });
  const [sending, setSending] = useState(false);
  // D9: bumped by "Sign up another person". It is the IntakeForm key, so the
  // form remounts empty (names, phone, voucher blank; consent unchecked).
  const [round, setRound] = useState(0);

  // On submit the form swaps to a thank-you with a new <h1>, but focus would stay
  // on the (removed) submit button - silent to screen readers. Move focus to the
  // done-state heading (tabIndex={-1}) so the conversion is announced.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (done) headingRef.current?.focus();
  }, [done]);

  // D8: one list read per ListRequest (the first on mount).
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      setList({ kind: 'failed' });
      setChoice(NOT_SURE_VALUE);
    }, HOUSING_AUTHORITY_LIST_TIMEOUT_MS);
    getHousingAuthorities(controller.signal).then(
      (names) => {
        if (controller.signal.aborted) return; // cleaned up, or timed out
        clearTimeout(timer);
        setList({ kind: 'ready', names });
        setChoice(listRequest.mode === 'choose' ? CHOOSE_ONE_VALUE : defaultAuthorityChoice(names));
      },
      () => {
        if (controller.signal.aborted) return; // cleaned up, or timed out
        clearTimeout(timer);
        setList({ kind: 'failed' });
        setChoice(NOT_SURE_VALUE);
      },
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [listRequest]);

  /** Start a new list read: the select shows "Loading..." and send is blocked
   *  until it settles. Called from handlers only, never from an effect. */
  function readListAgain(mode: ListRequest['mode']): void {
    setList({ kind: 'loading' });
    setListRequest((prev) => ({ seq: prev.seq + 1, mode }));
  }

  async function handleSubmit(input: Omit<HousingFairInput, 'unitId' | 'housingAuthority'>): Promise<void> {
    // No unitId - a plain housing-fair signup. "Not sure" (or no list) sends
    // no housingAuthority key at all.
    const housingAuthority = authorityToSend(list, choice);
    setSending(true);
    try {
      await submitHousingFair(housingAuthority === undefined ? input : { ...input, housingAuthority });
    } catch (err) {
      setSending(false);
      // D8: the list changed after this page read it. Read it again and make
      // the person choose (the effect shows "Choose one" for a `choose` read).
      if (err instanceof ApiError && err.code === HOUSING_AUTHORITY_NOT_LISTED) readListAgain('choose');
      // IntakeForm shows joinErrorMessage(err) (or its own message) and keeps
      // every typed field and the consent box.
      throw err;
    }
    setSending(false);
    setDone(true);
  }

  function signUpAnotherPerson(): void {
    // D9: the select keeps the previous choice; the list is read again only
    // when the last read failed (that read applies the default rule).
    if (list.kind === 'failed') readListAgain('default');
    setRound((r) => r + 1);
    setDone(false);
  }

  if (done) {
    return (
      <section className={styles.card}>
        <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
          Thanks &mdash; you&apos;re signed up!
        </h1>
        <p className={styles.muted}>
          We&apos;ve got your info. A team member will text you about homes that fit your voucher.
        </p>
        <button type="button" className={styles.cta} onClick={signUpAnotherPerson}>
          Sign up another person
        </button>
      </section>
    );
  }

  const submitBlocked = list.kind === 'loading' || (list.kind === 'ready' && choice === CHOOSE_ONE_VALUE);

  return (
    <section className={styles.card}>
      <h1 className={styles.title}>Find your next home</h1>
      <p className={styles.muted}>
        Sign up and we&apos;ll text you about homes that fit your voucher.
      </p>
      <IntakeForm
        key={round}
        onSubmit={handleSubmit}
        submitLabel="Sign me up"
        extraField={
          <HousingAuthoritySelect list={list} value={choice} onChange={setChoice} disabled={sending} />
        }
        submitBlocked={submitBlocked}
        errorMessage={joinErrorMessage}
        autoFocusFirstName={round > 0}
      />
    </section>
  );
}
```

Step 4 - Run GREEN (this is also the slice's closing check):

1. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public/HousingFairIntake.another.test.tsx` - expect 6 passed.
2. `cd W:/tmp/join-housing-authority/dashboard; npx vitest run src/routes/public`
   - expect every file passed: `publicApi`, `IntakeForm` (both files),
     `FlyerPage`, `HousingAuthoritySelect`, and the three `HousingFairIntake` files.
3. `cd W:/tmp/join-housing-authority/e2e; npx vitest run performance/mutationCatalog.test.ts` - expect 4 passed (unchanged since 3.1; re-run as the slice check).
4. `cd W:/tmp/join-housing-authority/dashboard; npm run typecheck` - expect exit 0.
5. `cd W:/tmp/join-housing-authority; npx eslint dashboard/src/routes/public/publicApi.ts dashboard/src/routes/public/publicApi.test.ts dashboard/src/routes/public/IntakeForm.tsx dashboard/src/routes/public/IntakeForm.props.test.tsx dashboard/src/routes/public/FlyerPage.test.tsx dashboard/src/routes/public/HousingAuthoritySelect.tsx dashboard/src/routes/public/HousingAuthoritySelect.test.tsx dashboard/src/routes/public/HousingFairIntake.tsx dashboard/src/routes/public/HousingFairIntake.test.tsx dashboard/src/routes/public/HousingFairIntake.recovery.test.tsx dashboard/src/routes/public/HousingFairIntake.another.test.tsx`
   - expect exit 0 (attribution rule as in Task 3.2 if anything is reported).
6. ASCII:
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/HousingFairIntake.tsx | wc -c` prints 0.
   - `tr -d '\11\12\15\40-\176' < W:/tmp/join-housing-authority/dashboard/src/routes/public/HousingFairIntake.another.test.tsx | wc -c` prints 0.

Step 5 - Commit:

1. `git -C W:/tmp/join-housing-authority status` - read it on its own; the only
   changes are `HousingFairIntake.tsx` (modified) and
   `HousingFairIntake.another.test.tsx` (untracked).
2. `test -e "W:/AI Projects/Housing Choice/HC Application/.git/worktrees/join-housing-authority/MERGE_HEAD" && echo MERGE-IN-PROGRESS || echo ok` prints `ok`.
3. `git -C W:/tmp/join-housing-authority add dashboard/src/routes/public/HousingFairIntake.tsx dashboard/src/routes/public/HousingFairIntake.another.test.tsx`
4. `git -C W:/tmp/join-housing-authority commit -m "feat(join): /join thank-you adds Sign up another person, keeping the authority" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

Live behavior (the select against S1's real route, two people in a row,
Onboarding + the authority on each contact) is proven by S5's e2e spec and
the S6 gates, not by this slice.

## 7. S4 - Backfill script and RUNBOOK (Tasks 4.1-4.6)

CONTRACT ISSUES: none. Sections 0-3 work against the code as written. Notes (no change to the binding text):
- 2.5 `BackfillReport`: the draft keeps exactly the listed fields (targets, leftOut, unknownSkips, written, skipped, failed, warnings). `skipped` is the count of LOST CONDITIONS (spec D10 "counted as skipped"); the `--skip` reason is `LeftOutReason` 'skipped' on a left-out lead. A missing audit event after a landed write is a `warnings` entry (no extra field).
- 2.5 `BackfillDeps` (the writer's to define) carries `doc` and `env` beside the repos, because the candidate read is a base-table Scan (the clean-org-names shape) and no repo method scans the contacts base table.
- Extra exports beyond 2.5 (all additive): `SCRIPT_NAME`, `touchesHousingAuthority`, the report types and `formatBackfillReport` / `backfillExitCode`, `BackfillRefusedError`, `AUDIT_PAGE_SIZE`, `buildBackfillDeps`, `checkBackfillList`, `scanCandidates`, `readWholeHistory`, `leftOutReasonFor`, `BACKFILL_ARGS`, `parseSkipList`.

### 7. S4 - Backfill script, its test, and the RUNBOOK entry

Spec: D10, D11, and the backfill bullet of section 6. Independent of S1-S3.

Files this slice creates or edits - nothing else:
- `app/scripts/backfill-join-housing-authority.ts` (NEW; grown task by task)
- `app/test/backfillJoinHousingAuthority.test.ts` (NEW; grown task by task)
- `RUNBOOK.md` (Task 4.6 only)

How the two files grow: Task 4.1 creates each file with the Write tool. Every later task (a) REPLACES the file's whole import block (from the first `import` line through the line that ends the last import) with the block given, using the Edit tool, and (b) APPENDS the given code at the END of the file. Nothing else in an earlier task's code changes.

Every test command runs from the app workspace:
`cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts`
(never piped). From Task 4.3 on, the file also has DynamoDB Local tests that SKIP when no container answers on :8000 (the console shows `[backfillJoinHousingAuthority] SKIPPED - no DynamoDB Local`). If you see that line, start it with `npm run db:start` from `W:\tmp\join-housing-authority` (do NOT restart a container that is already up) and re-run: a skipped run is never GREEN.

No `\u` escape appears in any code below (the Edit/Write `\u` trap does not apply).

---

#### Task 4.1 - The pure rules: `isCandidate`, `touchesHousingAuthority`, `leftOutReasonFromAudit`

Files: `app/scripts/backfill-join-housing-authority.ts` (new), `app/test/backfillJoinHousingAuthority.test.ts` (new).

Step 1 - the failing test. Create `app/test/backfillJoinHousingAuthority.test.ts` with exactly:

```ts
// The /join housing authority backfill (spec
// docs/superpowers/specs/2026-10-12-join-housing-authority-design.md, D10
// and D11). The PURE rules first: who is a candidate, and which audit history
// leaves one out - each writer's payload exactly as it appends it today.
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  BACKFILL_AUDIT_TYPE,
  BACKFILL_AUTHORITY,
  isCandidate,
  leftOutReasonFromAudit,
  touchesHousingAuthority,
} from '../scripts/backfill-join-housing-authority.js';

/** A /join lead from before the change, as the sign-up created it: no authority, no marker. */
const LEAD: ContactItem = {
  contactId: 'c-lead',
  type: 'tenant',
  status: 'needs_review',
  phone: '+15550001001',
  firstName: 'Avery',
  lastName: 'Fairlead',
  capture_source: 'housing_fair',
  captured_at: '2026-06-20T14:00:00.000Z',
  created_at: '2026-06-20T14:00:00.000Z',
  housing_fair_welcomed: true,
  consent_method: 'web_form',
};

const event = (event_type: string, payload?: Record<string, unknown>): AuditEvent => ({
  entityKey: 'contacts#c-lead',
  ts: '2026-07-02T00:00:00.000Z#aaaa0000',
  event_type,
  ...(payload !== undefined && { payload }),
});

type EventCase = [what: string, eventType: string, payload: Record<string, unknown>];

/**
 * Every event that records housingAuthority SET or REMOVED, in the payload
 * shape its writer appends (verified on main @19607658). AI extraction and an
 * accepted AI suggestion only ever SET it; the other writers set and remove.
 */
const AUTHORITY_EVENTS: EventCase[] = [
  ['a staff edit sets it (PATCH fields)', 'contact_updated', { fields: ['housingAuthority'], actor: 'user-0001' }],
  ['a staff edit clears it (PATCH fields)', 'contact_updated', { fields: ['status', 'housingAuthority'], actor: 'user-0001' }],
  [
    'the caseworker conversion removes it (every patch key)',
    'contact_updated',
    {
      fields: [
        'type',
        'role',
        'status',
        'type_source',
        'organization',
        'agency',
        'housingAuthority',
        'housingAuthority_source',
        'caseworker_conversion',
      ],
      actor: 'user-0001',
      conversion: 'caseworker',
    },
  ],
  [
    'AI extraction sets it (fields[].field)',
    'ai_extraction_applied',
    {
      fields: [
        { field: 'voucherSize', to: 2 },
        { field: 'housingAuthority', to: 'Atlanta Housing Authority' },
      ],
      conversationId: 'conv-1',
    },
  ],
  [
    'an accepted AI suggestion sets it (target)',
    'ai_suggestion_accepted',
    { actor: 'user-0001', target: 'housingAuthority', from: 'DeKalb County Housing Authority', to: 'Atlanta Housing Authority' },
  ],
  [
    'an org rewrite sets it (Use)',
    'org_name_rewrite',
    { field: 'housingAuthority', from: 'Atlanta (AHA)', to: 'Atlanta Housing Authority', action: 'use', actor: 'user-0001' },
  ],
  [
    'an org rewrite removes it (Clear)',
    'org_name_rewrite',
    { field: 'housingAuthority', from: 'junk', to: '', action: 'clear', actor: 'user-0001' },
  ],
  ['the cleanup rewrites it', 'org_name_cleanup', { field: 'housingAuthority', from: 'Atlanta (AHA)', to: 'Atlanta Housing Authority' }],
  ['the cleanup removes it (moved to Agency)', 'org_name_cleanup', { field: 'housingAuthority', from: 'Hope Atlanta', to: '' }],
  ['this backfill set it', 'housing_authority_backfill', { field: 'housingAuthority', from: '', to: 'Atlanta Housing Authority' }],
];

/** Events that never leave a lead out. */
const UNRELATED_EVENTS: EventCase[] = [
  ['a staff edit of other fields', 'contact_updated', { fields: ['status', 'notes'], actor: 'user-0001' }],
  ['a caseworker review dismissed', 'contact_updated', { fields: ['caseworker_review'], actor: 'user-0001' }],
  ['AI extraction of other fields', 'ai_extraction_applied', { fields: [{ field: 'voucherSize', to: 2 }], conversationId: 'conv-1' }],
  ['an accepted suggestion for another target', 'ai_suggestion_accepted', { actor: 'user-0001', target: 'voucherSize', from: 2, to: 3 }],
  [
    'a dismissed housing authority suggestion (writes nothing)',
    'ai_suggestion_dismissed',
    { actor: 'user-0001', target: 'housingAuthority' },
  ],
  [
    'an org rewrite of the agency',
    'org_name_rewrite',
    { field: 'agency', from: 'Hope Atlanta', to: 'HOPE Atlanta', action: 'use', actor: 'user-0001' },
  ],
  ['the cleanup of the agency', 'org_name_cleanup', { field: 'agency', from: '', to: 'HOPE Atlanta' }],
  [
    'a sign-up BEFORE the change (no signupVersion)',
    'housing_fair_signup',
    { marker: 'mk', isNew: true, welcomeSent: true, viaFlyer: false },
  ],
  ['a phone added', 'contact_phone_added', { actor: 'user-0001', phone: '+15550001002' }],
];

/** A sign-up AFTER the change from a phone that was already a lead (spec D6, D7). */
const RESIGNUP_PAYLOAD = {
  marker: 'mk',
  isNew: false,
  welcomeSent: false,
  viaFlyer: false,
  signupVersion: 2,
  housingAuthority: 'DeKalb County Housing Authority',
};

describe('the constants (spec D10)', () => {
  it('writes Atlanta Housing Authority under its own audit event type', () => {
    expect(BACKFILL_AUTHORITY).toBe('Atlanta Housing Authority');
    expect(BACKFILL_AUDIT_TYPE).toBe('housing_authority_backfill');
  });
});

describe('isCandidate (spec D10: the stored item alone)', () => {
  it('a pre-change /join lead is a candidate, whatever its status', () => {
    expect(isCandidate(LEAD)).toBe(true);
    for (const status of ['onboarding', 'searching', 'on_hold', 'inactive']) {
      expect(isCandidate({ ...LEAD, status })).toBe(true);
    }
    const { status: _status, ...noStatus } = LEAD;
    expect(isCandidate(noStatus as ContactItem)).toBe(true);
  });

  it.each([
    ['a flyer sign-up for a shareable unit', { capture_source: 'flyer' }],
    ['an inbound-text stub', { capture_source: 'inbound_sms' }],
    ['no capture_source', { capture_source: undefined }],
    ['a landlord', { type: 'landlord' }],
    ['a partner (a caseworker)', { type: 'partner' }],
    ['an unknown', { type: 'unknown' }],
    ['a deleted lead', { deleted_at: '2026-09-01T00:00:00.000Z' }],
    ['a lead holding another authority', { housingAuthority: 'DeKalb County Housing Authority' }],
    ['a lead already holding Atlanta Housing Authority', { housingAuthority: 'Atlanta Housing Authority' }],
    ['a contact created after the change (the marker)', { housing_fair_signup_v2: true }],
    ['a marker of any value', { housing_fair_signup_v2: false }],
  ] as Array<[string, Partial<ContactItem>]>)('is not a candidate: %s', (_what, change) => {
    expect(isCandidate({ ...LEAD, ...change } as ContactItem)).toBe(false);
  });
});

describe('leftOutReasonFromAudit (spec D10: the WHOLE history, any order)', () => {
  it('no history, or only unrelated events, leaves nothing out', () => {
    expect(leftOutReasonFromAudit([])).toBeNull();
    expect(leftOutReasonFromAudit(UNRELATED_EVENTS.map(([, type, payload]) => event(type, payload)))).toBeNull();
  });

  it.each(AUTHORITY_EVENTS)('housingAuthority set or removed: %s', (_what, type, payload) => {
    expect(touchesHousingAuthority(event(type, payload))).toBe(true);
    expect(leftOutReasonFromAudit([event('contact_updated', { fields: ['status'] }), event(type, payload)])).toBe(
      'authority_history',
    );
  });

  it.each(UNRELATED_EVENTS)('not an authority write: %s', (_what, type, payload) => {
    expect(touchesHousingAuthority(event(type, payload))).toBe(false);
  });

  it('a sign-up after the change (signupVersion 2) leaves the lead out - and wins over an authority history', () => {
    expect(leftOutReasonFromAudit([event('housing_fair_signup', RESIGNUP_PAYLOAD)])).toBe('signed_up_again');
    expect(
      leftOutReasonFromAudit([event('housing_fair_signup', { ...RESIGNUP_PAYLOAD, housingAuthority: null })]),
    ).toBe('signed_up_again');
    expect(
      leftOutReasonFromAudit([
        event('contact_updated', { fields: ['housingAuthority'] }),
        event('housing_fair_signup', RESIGNUP_PAYLOAD),
      ]),
    ).toBe('signed_up_again');
    // Only the NUMBER 2 marks a post-change sign-up.
    expect(leftOutReasonFromAudit([event('housing_fair_signup', { ...RESIGNUP_PAYLOAD, signupVersion: '2' })])).toBeNull();
  });

  it('a payload in no writer shape is never a match', () => {
    expect(
      leftOutReasonFromAudit([
        event('contact_updated'),
        event('contact_updated', { fields: 'housingAuthority' }),
        event('ai_extraction_applied', { fields: ['housingAuthority'] }),
        event('org_name_rewrite', { field: ['housingAuthority'] }),
      ]),
    ).toBeNull();
  });
});
```

Step 2 - RED: `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts`
Expected: the file FAILS to load - the module `../scripts/backfill-join-housing-authority.js` does not exist yet (`Failed to load url ... Does the file exist?`).

Step 3 - implementation. Create `app/scripts/backfill-join-housing-authority.ts` with exactly:

```ts
// backfill-join-housing-authority - the ONE-TIME backfill of a housing
// authority onto the /join leads that arrived before the form asked for one
// (spec docs/superpowers/specs/2026-10-12-join-housing-authority-design.md,
// D10 and D11). It gives "Atlanta Housing Authority" to every CANDIDATE that
// is not LEFT OUT, and changes nothing else - status included.
//
// CANDIDATES: contacts in the contacts BASE table (phone/email pointer rows
// skipped) with capture_source 'housing_fair', type 'tenant', not deleted, no
// housingAuthority attribute and no housing_fair_signup_v2 marker (every
// contact the sign-up creates after the change carries it - spec D5).
//
// LEFT OUT, and listed with the reason: a candidate named in --skip; one with
// a post-change sign-up (a housing_fair_signup event carrying signupVersion 2,
// spec D7); one whose audit trail shows housingAuthority was ever SET OR
// REMOVED (touchesHousingAuthority). Both audit rules read the WHOLE history:
// auditRepo.listByEntity is one newest-first Query with no cursor, so the run
// pages backward with `before` until a page comes back empty.
//
// THE LIST: the stored org-list item, read with peek() - never created. The
// run REFUSES (exit 1, no contact read, nothing written) when no item is
// stored, when "Atlanta Housing Authority" is not the exact name of a
// housing_authority entry, or - for --apply - while an organization-name
// rewrite is running by the system's own rule (isOrgRewriteRunning: a lock
// with no heartbeat for 15 minutes is free). It never takes the rewrite lock:
// after an apply that wrote, it reads the list again and WARNS when the name
// left the list during the run (the written records then show under Settings >
// Housing authorities & agencies > "Not on the list").
//
// DRY RUN (the default) writes nothing at all - not even the list item.
// --apply writes, per target, ONE conditional contactsRepo.update - the
// authority is set only while the contact still has none, is still a tenant
// and is still not deleted; a lost condition is counted `skipped` - then one
// housing_authority_backfill audit event { field, from: '', to }, no actor.
// Each candidate's history is read right before its write.
//
// TARGET: --env local|dev|prod through scripts/lib/stageClient.ts. An agent
// runs this ONLY with --env local --lane <L> against a hermetic e2e lane it
// started. NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT; the human does, per
// the RUNBOOK.
//
//   npx tsx app/scripts/backfill-join-housing-authority.ts --env dev
//   npx tsx app/scripts/backfill-join-housing-authority.ts --env dev --apply --skip "<contactId>,<contactId>"
//
// PII: the PRINTED report names each lead (first and last name) - the
// operator's recognition aid (Cameron 2026-10-12, a deliberate departure from
// clean-org-names). Structured log lines carry counts and contactIds only,
// never a name or phone.
import type { AuditEvent } from '../src/repos/auditRepo.js';
import { isDeleted, type ContactItem } from '../src/repos/contactsRepo.js';

// ---------------------------------------------------------------------------
// The rules (pure): who is a candidate, and which history leaves one out
// ---------------------------------------------------------------------------

export const SCRIPT_NAME = 'backfill-join-housing-authority';

/** Spec D10: the one authority the backfill writes - an exact housing_authority name. */
export const BACKFILL_AUTHORITY = 'Atlanta Housing Authority';

/** Spec D10: the audit event each backfill write appends. */
export const BACKFILL_AUDIT_TYPE = 'housing_authority_backfill';

/** Why a candidate is left out: listed with the reason, never written. */
export type LeftOutReason = 'skipped' | 'signed_up_again' | 'authority_history';

/** The capture_source only the sign-up route writes (a /join sign-up, or a flyer one for an unshareable unit). */
const JOIN_CAPTURE_SOURCE = 'housing_fair';

/** Spec D5: every contact the sign-up creates after the change carries it. */
const SIGNUP_MARKER = 'housing_fair_signup_v2';

const FIELD = 'housingAuthority';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Spec D10: a pre-change /join lead with no housing authority, judged on the
 * stored item alone - capture_source 'housing_fair', a tenant, not deleted
 * (the repos' rule), no housingAuthority attribute and no sign-up marker (a
 * marker of any value counts as present). Status is not a condition.
 */
export function isCandidate(contact: ContactItem): boolean {
  return (
    contact.capture_source === JOIN_CAPTURE_SOURCE &&
    contact.type === 'tenant' &&
    !isDeleted(contact) &&
    contact[FIELD] === undefined &&
    contact[SIGNUP_MARKER] === undefined
  );
}

/**
 * True when one audit event records housingAuthority being SET or REMOVED,
 * read in each writer's own payload shape (verified on main @19607658):
 *   - contact_updated: `fields` names it - the staff PATCH lists every field
 *     its body carried (routes/contacts.ts; the edit form sends the field only
 *     when it changed), and the caseworker conversion lists every key of its
 *     patch, which always REMOVEs it (services/caseworkerConversion.ts);
 *   - ai_extraction_applied: `fields[].field` names it (services/extraction/apply.ts);
 *   - ai_suggestion_accepted: `target` names it (services/suggestionResolution.ts);
 *   - org_name_rewrite / org_name_cleanup: `field` names it
 *     (services/orgRecords.ts, scripts/clean-org-names.ts);
 *   - housing_authority_backfill: this script's own event, whatever it carries.
 */
export function touchesHousingAuthority(event: AuditEvent): boolean {
  const payload: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
  const fields = payload['fields'];
  switch (event.event_type) {
    case 'contact_updated':
      return Array.isArray(fields) && fields.includes(FIELD);
    case 'ai_extraction_applied':
      return Array.isArray(fields) && fields.some((f: unknown) => isRecord(f) && f['field'] === FIELD);
    case 'ai_suggestion_accepted':
      return payload['target'] === FIELD;
    case 'org_name_rewrite':
    case 'org_name_cleanup':
      return payload['field'] === FIELD;
    case BACKFILL_AUDIT_TYPE:
      return true;
    default:
      return false;
  }
}

/**
 * Spec D10: why a candidate's WHOLE audit history (any order) leaves it out,
 * or null. A post-change sign-up (housing_fair_signup carrying the number
 * signupVersion 2 - on /join or a flyer, erring safe) wins over an authority
 * history: both leave the lead out, and it is the reason the operator most
 * needs to see.
 */
export function leftOutReasonFromAudit(events: readonly AuditEvent[]): Exclude<LeftOutReason, 'skipped'> | null {
  const signedUpAgain = events.some(
    (e) => e.event_type === 'housing_fair_signup' && isRecord(e.payload) && e.payload['signupVersion'] === 2,
  );
  if (signedUpAgain) return 'signed_up_again';
  return events.some(touchesHousingAuthority) ? 'authority_history' : null;
}
```

Step 4 - GREEN: `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts` - every test passes. Then `cd W:\tmp\join-housing-authority\app; npm run typecheck` - exit 0.

Step 5 - commit.
1. ASCII (bash): `cd /w/tmp/join-housing-authority && for f in app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts; do tr -d '\11\12\15\40-\176' < "$f" | wc -c; done` - prints 0 twice.
2. `git -C W:\tmp\join-housing-authority status` - read it on its own: only the two new files.
3. `Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\join-housing-authority\MERGE_HEAD"` - prints False.
4. `git -C W:\tmp\join-housing-authority add app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts`
5. `git -C W:\tmp\join-housing-authority commit -m "feat(backfill): /join housing authority backfill - the candidate and audit-history rules (spec D10)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task 4.2 - The operator report: `formatBackfillReport` and `backfillExitCode`

Files: `app/scripts/backfill-join-housing-authority.ts`, `app/test/backfillJoinHousingAuthority.test.ts`.

Step 1 - the failing test.

(a) Replace the test file's import block with:

```ts
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  BACKFILL_AUDIT_TYPE,
  BACKFILL_AUTHORITY,
  backfillExitCode,
  formatBackfillReport,
  isCandidate,
  leftOutReasonFromAudit,
  touchesHousingAuthority,
  type BackfillLead,
  type BackfillReport,
} from '../scripts/backfill-join-housing-authority.js';
```

(b) Append at the end of the test file:

```ts
// ---------------------------------------------------------------------------
// The report the operator reads (pure). Names go to the PRINTED report only.
// ---------------------------------------------------------------------------

const lead = (contactId: string, firstName: string, lastName: string, signedUpAt: string, status: string): BackfillLead => ({
  contactId,
  firstName,
  lastName,
  signedUpAt,
  status,
});

const DRY_REPORT: BackfillReport = {
  targets: [
    { ...lead('c-1', 'Avery', 'Fairlead', '2026-06-20T14:00:00.000Z', 'needs_review'), outcome: 'would_write' },
    { ...lead('c-2', 'Blake', '', '2026-08-15T23:30:00.000Z', 'on_hold'), outcome: 'would_write' },
  ],
  leftOut: [
    { ...lead('c-3', 'Drew', 'Dekalbson', '2026-06-01T09:00:00.000Z', 'needs_review'), reason: 'skipped' },
    { ...lead('c-4', 'Emery', 'Again', '2026-06-10T09:00:00.000Z', 'onboarding'), reason: 'signed_up_again' },
    { ...lead('c-5', '', '', '', ''), reason: 'authority_history' },
  ],
  unknownSkips: [],
  written: 0,
  skipped: 0,
  failed: 0,
  warnings: [],
};

describe('formatBackfillReport (spec D10: name, sign-up date, status, contactId - oldest first)', () => {
  it('dry run: each target on its own line, then the count; then the left-out leads with the reason', () => {
    expect(formatBackfillReport(DRY_REPORT, false)).toEqual([
      'DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
      '  Avery Fairlead  signed up 2026-06-20  status needs_review  contactId c-1',
      '  Blake  signed up 2026-08-15  status on_hold  contactId c-2',
      'Would update: 2 lead(s). Failed: 0.',
      'Left out (3 lead(s), oldest sign-up first):',
      '  Drew Dekalbson  signed up 2026-06-01  status needs_review  contactId c-3  - named in --skip',
      '  Emery Again  signed up 2026-06-10  status onboarding  contactId c-4  - signed up again after the change',
      '  (no name)  signed up unknown  status (none)  contactId c-5  - its housing authority was set or removed before - left empty on purpose',
    ]);
  });

  it('apply: each outcome, the counts, the unknown --skip ids and every warning', () => {
    const applied: BackfillReport = {
      ...DRY_REPORT,
      targets: [
        { ...lead('c-1', 'Avery', 'Fairlead', '2026-06-20T14:00:00.000Z', 'needs_review'), outcome: 'written' },
        { ...lead('c-2', 'Blake', '', '2026-08-15T23:30:00.000Z', 'on_hold'), outcome: 'skipped' },
        { ...lead('c-6', 'Gray', 'Failson', '2026-09-01T12:00:00.000Z', 'needs_review'), outcome: 'failed' },
      ],
      leftOut: [],
      unknownSkips: ['contact-typo', 'contact-xyz'],
      written: 1,
      skipped: 1,
      failed: 1,
      warnings: ['first warning', 'second warning'],
    };
    expect(formatBackfillReport(applied, true)).toEqual([
      'Leads given "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
      '  Avery Fairlead  signed up 2026-06-20  status needs_review  contactId c-1',
      '  Blake  signed up 2026-08-15  status on_hold  contactId c-2  - SKIPPED: it changed after the run read it (nothing written)',
      '  Gray Failson  signed up 2026-09-01  status needs_review  contactId c-6  - FAILED: nothing written (an ERROR line names this contactId); re-run',
      'Written: 1. Skipped (changed after the read): 1. Failed: 1.',
      'Left out: none.',
      '--skip ids that are not candidates (ignored): contact-typo, contact-xyz',
      'WARNING: first warning',
      'WARNING: second warning',
    ]);
  });

  it('a dry run counts only the leads it would write; a failed lead is listed and counted apart', () => {
    const dryFailed: BackfillReport = {
      ...DRY_REPORT,
      targets: [
        { ...lead('c-1', 'Avery', 'Fairlead', '2026-06-20T14:00:00.000Z', 'needs_review'), outcome: 'would_write' },
        { ...lead('c-6', 'Gray', 'Failson', '2026-09-01T12:00:00.000Z', 'needs_review'), outcome: 'failed' },
      ],
      failed: 1,
    };
    const lines = formatBackfillReport(dryFailed, false);
    expect(lines).toContain(
      '  Gray Failson  signed up 2026-09-01  status needs_review  contactId c-6  - FAILED: nothing written (an ERROR line names this contactId); re-run',
    );
    expect(lines).toContain('Would update: 1 lead(s). Failed: 1.');
  });

  it('no target and nothing left out', () => {
    expect(formatBackfillReport({ ...DRY_REPORT, targets: [], leftOut: [] }, false)).toEqual([
      'DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
      '  (none)',
      'Would update: 0 lead(s). Failed: 0.',
      'Left out: none.',
    ]);
  });
});

describe('backfillExitCode (spec D10: 0 clean, 1 with failures)', () => {
  it('a completed run exits 0 - warnings included - and 1 once any lead failed', () => {
    expect(backfillExitCode(DRY_REPORT)).toBe(0);
    expect(backfillExitCode({ ...DRY_REPORT, warnings: ['a warning'] })).toBe(0);
    expect(backfillExitCode({ ...DRY_REPORT, failed: 1 })).toBe(1);
  });
});
```

Step 2 - RED: `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts`
Expected: the 4.1 cases pass; the new cases fail because `formatBackfillReport` / `backfillExitCode` are not exported yet (`TypeError: ... is not a function`, or an import error naming the missing export).

Step 3 - implementation. Append at the end of `app/scripts/backfill-join-housing-authority.ts` (the import block does not change):

```ts
// ---------------------------------------------------------------------------
// The report (pure): what a run returns, and what the operator reads
// ---------------------------------------------------------------------------

/** One candidate as the report shows it. Names reach the PRINTED report only, never a log line. */
export interface BackfillLead {
  contactId: string;
  /** '' when the record has none. */
  firstName: string;
  /** '' when the record has none. */
  lastName: string;
  /** captured_at, else created_at (ISO 8601); '' when it has neither. The sort key. */
  signedUpAt: string;
  /** As stored (needs_review, on_hold, ...); '' when absent. */
  status: string;
}

/**
 * What became of one target: would_write (dry run); written; skipped (its
 * write lost its condition - the lead changed after the read, nothing
 * written); failed (its history read or its write threw - nothing written;
 * the run exits 1).
 */
export type TargetOutcome = 'would_write' | 'written' | 'skipped' | 'failed';

export interface BackfillTarget extends BackfillLead {
  outcome: TargetOutcome;
}

export interface LeftOutLead extends BackfillLead {
  reason: LeftOutReason;
}

export interface BackfillReport {
  /** Every lead the run set, would set, or failed on - oldest sign-up first. */
  targets: BackfillTarget[];
  /** Candidates left out, with the reason - oldest sign-up first. */
  leftOut: LeftOutLead[];
  /** --skip ids that named no candidate, sorted: reported, otherwise ignored. */
  unknownSkips: string[];
  /** Apply: targets written. */
  written: number;
  /** Apply: targets whose write lost its condition (changed after the read). */
  skipped: number;
  /** Targets whose history read or write failed: nothing written for them. */
  failed: number;
  /** Printed as WARNING lines: the post-apply list check, a missing audit event. */
  warnings: string[];
}

const REASON_TEXT: Readonly<Record<LeftOutReason, string>> = {
  skipped: 'named in --skip',
  signed_up_again: 'signed up again after the change',
  authority_history: 'its housing authority was set or removed before - left empty on purpose',
};

const OUTCOME_SUFFIX: Readonly<Record<TargetOutcome, string>> = {
  would_write: '',
  written: '',
  skipped: '  - SKIPPED: it changed after the run read it (nothing written)',
  failed: '  - FAILED: nothing written (an ERROR line names this contactId); re-run',
};

/** "2026-06-20" from an ISO stamp (UTC); "unknown" when there is none. */
function signUpDate(signedUpAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(signedUpAt) ? signedUpAt.slice(0, 10) : 'unknown';
}

function leadLine(lead: BackfillLead): string {
  const name = `${lead.firstName} ${lead.lastName}`.trim();
  return (
    `  ${name === '' ? '(no name)' : name}  signed up ${signUpDate(lead.signedUpAt)}` +
    `  status ${lead.status === '' ? '(none)' : lead.status}  contactId ${lead.contactId}`
  );
}

/**
 * Spec D10: what the CLI prints - each target on its own line (name, sign-up
 * date, status, contactId), oldest first, then the count; then the left-out
 * leads the same way with the reason; then unknown --skip ids and warnings.
 */
export function formatBackfillReport(report: BackfillReport, apply: boolean): string[] {
  const lines: string[] = [
    apply
      ? `Leads given "${BACKFILL_AUTHORITY}" (oldest sign-up first; dates are UTC):`
      : `DRY RUN - nothing written. Leads that WOULD get "${BACKFILL_AUTHORITY}" (oldest sign-up first; dates are UTC):`,
  ];
  if (report.targets.length === 0) lines.push('  (none)');
  for (const t of report.targets) lines.push(`${leadLine(t)}${OUTCOME_SUFFIX[t.outcome]}`);
  const wouldWrite = report.targets.filter((t) => t.outcome === 'would_write').length;
  lines.push(
    apply
      ? `Written: ${report.written}. Skipped (changed after the read): ${report.skipped}. Failed: ${report.failed}.`
      : `Would update: ${wouldWrite} lead(s). Failed: ${report.failed}.`,
  );
  if (report.leftOut.length === 0) {
    lines.push('Left out: none.');
  } else {
    lines.push(`Left out (${report.leftOut.length} lead(s), oldest sign-up first):`);
    for (const l of report.leftOut) lines.push(`${leadLine(l)}  - ${REASON_TEXT[l.reason]}`);
  }
  if (report.unknownSkips.length > 0) {
    lines.push(`--skip ids that are not candidates (ignored): ${report.unknownSkips.join(', ')}`);
  }
  for (const w of report.warnings) lines.push(`WARNING: ${w}`);
  return lines;
}

/** Spec D10: 0 completed clean (warnings included); 1 completed with failures. Refusals and usage are the CLI's. */
export function backfillExitCode(report: BackfillReport): 0 | 1 {
  return report.failed > 0 ? 1 : 0;
}
```

Step 4 - GREEN: `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts` - all pass. `cd W:\tmp\join-housing-authority\app; npm run typecheck` - exit 0.

Step 5 - commit: the ASCII check (bash, as in 4.1) prints 0 twice; `git -C W:\tmp\join-housing-authority status` read on its own (only the two files modified); `Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\join-housing-authority\MERGE_HEAD"` prints False;
`git -C W:\tmp\join-housing-authority add app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts`;
`git -C W:\tmp\join-housing-authority commit -m "feat(backfill): /join housing authority backfill - the operator report and exit code (spec D10)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task 4.3 - The reads: list refusals, the candidate Scan, a candidate's whole audit history

Files: `app/scripts/backfill-join-housing-authority.ts`, `app/test/backfillJoinHousingAuthority.test.ts`.

Step 1 - the failing test.

(a) Replace the test file's import block with:

```ts
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import { getTableSpec } from '../src/lib/tables.js';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createOrgListRepo, type OrgListItem, type OrgListRepo, type OrgRewriteState } from '../src/repos/orgListRepo.js';
import {
  BACKFILL_AUDIT_TYPE,
  BACKFILL_AUTHORITY,
  BackfillRefusedError,
  backfillExitCode,
  buildBackfillDeps,
  checkBackfillList,
  formatBackfillReport,
  isCandidate,
  leftOutReasonFor,
  leftOutReasonFromAudit,
  readWholeHistory,
  scanCandidates,
  touchesHousingAuthority,
  type BackfillDeps,
  type BackfillLead,
  type BackfillReport,
} from '../scripts/backfill-join-housing-authority.js';
```

(b) Append at the end of the test file:

```ts
// ---------------------------------------------------------------------------
// The reads (spec D10). The DynamoDB Local part self-skips like
// cleanOrgNames.test.ts. No app path creates a candidate any more (every new
// sign-up carries the marker; no seed writes capture_source 'housing_fair'),
// so these tests write pre-change-shaped leads directly.
// ---------------------------------------------------------------------------

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}
const reachable = await endpointReachable();
if (!reachable) console.warn(`[backfillJoinHousingAuthority] SKIPPED - no DynamoDB Local at ${endpoint}.`);

const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const created: string[] = [];
const silent = createLogger({ level: 'silent' });
const READ_COMMANDS = new Set(['ScanCommand', 'QueryCommand', 'GetCommand']);
const NO_SKIP: ReadonlySet<string> = new Set();
const LIST_AT = '2026-10-06T00:00:00.000Z';

const NO_LIST_REFUSAL =
  'backfill-join-housing-authority: REFUSED - this environment has no organization list yet: the deployed app creates it on its first read. ' +
  'Open Settings > Housing authorities & agencies once, then re-run. No contact was read and nothing was written.';
const NOT_LISTED_REFUSAL =
  'backfill-join-housing-authority: REFUSED - "Atlanta Housing Authority" is not the exact name of a housing authority on this ' +
  "environment's organization list (renamed, merged, deleted or made an agency). Check Settings > Housing authorities & agencies " +
  'before going on. No contact was read and nothing was written.';
const RUNNING_REFUSAL =
  'backfill-join-housing-authority: REFUSED - an organization-name rewrite is running (action rename, started ' +
  '2026-10-12T12:00:00.000Z, last heartbeat 2026-10-12T12:00:00.000Z). Wait for it to finish (Settings > Housing ' +
  'authorities & agencies shows it); a rewrite whose process was killed stops blocking 15 minutes after its last ' +
  'heartbeat. No contact was read and nothing was written.';

async function dropCreatedTables(): Promise<void> {
  for (const table of created.splice(0)) await deleteTableIfExists(client, table);
}

/** The starting list with fixed ids: Atlanta Housing Authority is a housing_authority entry (lib/orgStartingList.ts). */
function startingEntries(): OrgEntry[] {
  let n = 0;
  return buildStartingEntries(LIST_AT, () => `org-${(n += 1)}`);
}

/** The starting list with its Atlanta Housing Authority entry changed - or removed (null). */
function withAtlanta(change: (entry: OrgEntry) => OrgEntry | null): OrgEntry[] {
  return startingEntries().flatMap((entry) => {
    if (entry.name !== 'Atlanta Housing Authority') return [entry];
    const next = change(entry);
    return next === null ? [] : [next];
  });
}

function listItem(entries: OrgEntry[], lastRewrite?: OrgRewriteState): OrgListItem {
  return { settingId: 'org-list', version: 1, entries, ...(lastRewrite !== undefined && { lastRewrite }) };
}

/** A client that records every command's class name, then sends it for real. */
function recordingClient(inner: DynamoDBDocumentClient): { doc: DynamoDBDocumentClient; sent: string[] } {
  const sent: string[] = [];
  const recording = {
    send: async (command: { constructor: { name: string } }) => {
      sent.push(command.constructor.name);
      return await inner.send(command as never);
    },
    destroy: () => {},
  } as unknown as DynamoDBDocumentClient;
  return { doc: recording, sent };
}

interface World {
  env: NodeJS.ProcessEnv;
  orgList: OrgListRepo;
  /** A contacts row exactly as given. */
  put(item: Record<string, unknown>): Promise<void>;
  /** A pre-change /join lead - the shape the sign-up created before this change - with changes (undefined drops a field). */
  lead(contactId: string, fields?: Record<string, unknown>): Promise<void>;
  /** One audit event with an explicit sort key, so the paging order is fixed. */
  audit(contactId: string, ts: string, eventType: string, payload: Record<string, unknown>): Promise<void>;
  get(contactId: string): Promise<Record<string, unknown> | undefined>;
  scanTable(base: 'contacts' | 'settings' | 'audit_events'): Promise<string[]>;
  backfillEvents(): Promise<Record<string, unknown>[]>;
  /** The real deps on this world (overridable); `printed` collects the report lines. */
  deps(opts?: { overrides?: Partial<BackfillDeps>; onDoc?: DynamoDBDocumentClient; logger?: Logger }): {
    deps: BackfillDeps;
    printed: string[];
  };
}

/** Fresh contacts, settings and audit tables under their own prefix; the list stored as given (null = none). */
async function newWorld(orgList: OrgListItem | null = listItem(startingEntries())): Promise<World> {
  const env: NodeJS.ProcessEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  for (const base of ['contacts', 'settings', 'audit_events'] as const) {
    await ensureTable(client, getTableSpec(base), tableName(base, env));
    created.push(tableName(base, env));
  }
  const orgListRepo = createOrgListRepo({ doc, env, logger: silent });
  if (orgList !== null) await orgListRepo.putForSeed(orgList);
  const put = async (item: Record<string, unknown>): Promise<void> => {
    await doc.send(new PutCommand({ TableName: tableName('contacts', env), Item: item }));
  };
  const scanItems = async (base: string): Promise<Record<string, unknown>[]> =>
    (await doc.send(new ScanCommand({ TableName: tableName(base, env) }))).Items ?? [];
  return {
    env,
    orgList: orgListRepo,
    put,
    lead: (contactId, fields = {}) =>
      put({
        contactId,
        type: 'tenant',
        status: 'needs_review',
        firstName: 'Lead',
        lastName: contactId,
        capture_source: 'housing_fair',
        captured_at: '2026-07-01T15:00:00.000Z',
        created_at: '2026-07-01T15:00:00.000Z',
        housing_fair_welcomed: true,
        consent_method: 'web_form',
        ...fields,
      }),
    audit: async (contactId, ts, eventType, payload) => {
      await doc.send(
        new PutCommand({
          TableName: tableName('audit_events', env),
          Item: { entityKey: `contacts#${contactId}`, ts, event_type: eventType, payload },
        }),
      );
    },
    get: async (contactId) =>
      (await doc.send(new GetCommand({ TableName: tableName('contacts', env), Key: { contactId } }))).Item,
    scanTable: async (base) => (await scanItems(base)).map((item) => JSON.stringify(item)).sort(),
    backfillEvents: async () => (await scanItems('audit_events')).filter((e) => e['event_type'] === BACKFILL_AUDIT_TYPE),
    deps: (opts = {}) => {
      const printed: string[] = [];
      const deps: BackfillDeps = {
        ...buildBackfillDeps(
          { doc: opts.onDoc ?? doc, env },
          { logger: opts.logger ?? silent, print: (line) => printed.push(line) },
        ),
        ...opts.overrides,
      };
      return { deps, printed };
    },
  };
}

describe('checkBackfillList - the refusals, before any contact is read (spec D10)', () => {
  const AT = '2026-10-12T12:00:00.000Z';
  const running: OrgRewriteState = {
    jobId: 'job-rename',
    action: 'rename',
    fromTexts: ['Old Name'],
    fields: ['housingAuthority', 'accepted_authorities'],
    toName: 'New Name',
    status: 'running',
    heartbeatAt: AT,
    startedAt: AT,
    startedBy: 'user-0001',
  };
  const on = (item: OrgListItem | null, nowIso = AT): Pick<BackfillDeps, 'orgList' | 'now'> => ({
    orgList: { peek: async () => item },
    now: () => Date.parse(nowIso),
  });
  const outcomeOf = (deps: Pick<BackfillDeps, 'orgList' | 'now'>, apply: boolean): Promise<unknown> =>
    checkBackfillList(deps, apply).then(
      () => 'passed',
      (err: unknown) => err,
    );

  it('passes a stored list that names Atlanta Housing Authority exactly - for a dry run and an apply', async () => {
    expect(await outcomeOf(on(listItem(startingEntries())), false)).toBe('passed');
    expect(await outcomeOf(on(listItem(startingEntries())), true)).toBe('passed');
  });

  it('refuses when no list is stored - a dry run too: it never falls back to the starting list', async () => {
    for (const apply of [false, true]) {
      const outcome = await outcomeOf(on(null), apply);
      expect(outcome).toBeInstanceOf(BackfillRefusedError);
      expect((outcome as Error).message).toBe(NO_LIST_REFUSAL);
    }
  });

  const notExact: Array<[string, OrgEntry[]]> = [
    ['renamed', withAtlanta((e) => ({ ...e, name: 'Atlanta Housing Authority (AHA)' }))],
    ['in another case', withAtlanta((e) => ({ ...e, name: 'atlanta housing authority' }))],
    ['made an agency', withAtlanta((e) => ({ ...e, kind: 'agency' }))],
    [
      'only a spelling of another name',
      withAtlanta((e) => ({ ...e, name: 'Housing Authority of the City of Atlanta', spellings: ['Atlanta Housing Authority'] })),
    ],
    ['deleted', withAtlanta(() => null)],
  ];
  it.each(notExact)('refuses when Atlanta Housing Authority is not an exact housing authority name: %s', async (_what, entries) => {
    for (const apply of [false, true]) {
      const outcome = await outcomeOf(on(listItem(entries)), apply);
      expect(outcome).toBeInstanceOf(BackfillRefusedError);
      expect((outcome as Error).message).toBe(NOT_LISTED_REFUSAL);
    }
  });

  it('refuses an apply while a rewrite is running (heartbeat 5 minutes old); a dry run goes ahead', async () => {
    const deps = on(listItem(startingEntries(), running), '2026-10-12T12:05:00.000Z');
    const outcome = await outcomeOf(deps, true);
    expect(outcome).toBeInstanceOf(BackfillRefusedError);
    expect((outcome as Error).message).toBe(RUNNING_REFUSAL);
    expect(await outcomeOf(deps, false)).toBe('passed');
  });

  it('a STALE running rewrite (no heartbeat for over 15 minutes) does not refuse an apply; nor does a finished one', async () => {
    expect(await outcomeOf(on(listItem(startingEntries(), running), '2026-10-12T12:16:00.000Z'), true)).toBe('passed');
    for (const status of ['done', 'failed'] as const) {
      expect(await outcomeOf(on(listItem(startingEntries(), { ...running, status }), '2026-10-12T12:01:00.000Z'), true)).toBe(
        'passed',
      );
    }
  });
});

describe('readWholeHistory and leftOutReasonFor (pure seams)', () => {
  it('stops with an error rather than loop forever on a store whose pages do not move back', async () => {
    const stuck = { listByEntity: async () => [event('contact_updated', { fields: ['status'] })] };
    await expect(readWholeHistory(stuck, 'contacts#c-lead', 2)).rejects.toThrow('audit history paging did not advance');
  });

  it('a lead named in --skip is left out before its history is read', async () => {
    let reads = 0;
    const audit: BackfillDeps['audit'] = {
      append: async () => {},
      listByEntity: async () => {
        reads += 1;
        return [];
      },
    };
    expect(await leftOutReasonFor({ audit }, 'c-skip', new Set(['c-skip']))).toBe('skipped');
    expect(reads).toBe(0);
    expect(await leftOutReasonFor({ audit }, 'c-other', new Set(['c-skip']))).toBeNull();
    expect(reads).toBe(1);
  });
});

describe.skipIf(!reachable)('the reads against DynamoDB Local (spec D10)', () => {
  afterEach(dropCreatedTables, 120_000);

  it('scanCandidates selects exactly the pre-change /join leads - each condition, pointer rows skipped - oldest sign-up first', async () => {
    const w = await newWorld();
    await w.lead('c-new', { captured_at: '2026-08-15T23:30:00.000Z', status: 'on_hold' });
    await w.lead('c-old', { captured_at: '2026-06-20T14:00:00.000Z' });
    // No captured_at: the sign-up date is created_at.
    await w.lead('c-created-only', { captured_at: undefined, created_at: '2026-07-04T10:00:00.000Z', status: 'inactive' });
    // No date at all: listed last.
    await w.lead('c-undated', { captured_at: undefined, created_at: undefined });
    // Not candidates - one condition each.
    await w.lead('c-flyer', { capture_source: 'flyer', unit_of_interest: 'u-1' });
    await w.lead('c-inbound', { capture_source: 'inbound_sms' });
    await w.lead('c-no-source', { capture_source: undefined });
    await w.lead('c-landlord', { type: 'landlord', status: 'active' });
    await w.lead('c-partner', { type: 'partner', status: 'active', role: 'Caseworker' });
    await w.lead('c-deleted', { deleted_at: '2026-09-01T00:00:00.000Z' });
    await w.lead('c-has-authority', { housingAuthority: 'DeKalb County Housing Authority' });
    await w.lead('c-has-atlanta', { housingAuthority: 'Atlanta Housing Authority' });
    await w.lead('c-marker', { housing_fair_signup_v2: true, status: 'onboarding' });
    // Pointer rows are skipped by their id prefix, whatever they carry.
    await w.put({
      contactId: 'phoneref#+15550001001',
      phone: '+15550001001',
      phone_ref: true,
      phone_ref_owner: 'c-old',
      capture_source: 'housing_fair',
      type: 'tenant',
    });
    await w.put({
      contactId: 'emailref#lead@example.com',
      email: 'lead@example.com',
      email_ref: true,
      email_ref_owner: 'c-old',
      capture_source: 'housing_fair',
      type: 'tenant',
    });

    const { deps } = w.deps();
    const scan = await scanCandidates(deps);
    expect(scan.leads.map((l) => l.contactId)).toEqual(['c-old', 'c-created-only', 'c-new', 'c-undated']);
    expect(scan.leads[0]).toEqual({
      contactId: 'c-old',
      firstName: 'Lead',
      lastName: 'c-old',
      signedUpAt: '2026-06-20T14:00:00.000Z',
      status: 'needs_review',
    });
    expect(scan.leads[1]).toMatchObject({ signedUpAt: '2026-07-04T10:00:00.000Z', status: 'inactive' });
    expect(scan.leads[2]).toMatchObject({ signedUpAt: '2026-08-15T23:30:00.000Z', status: 'on_hold' });
    expect(scan.leads[3]).toMatchObject({ signedUpAt: '' });
    expect(scan).toMatchObject({ contactsScanned: 13, pointerRows: 2 });
    // The Scan paging loop: two rows a page finds the same leads.
    expect(await scanCandidates({ ...deps, scanLimit: 2 })).toEqual(scan);
  }, 120_000);

  it('leftOutReasonFor reads every recorded shape through the store: a set or removed authority and a post-change sign-up leave a lead out; nothing else does', async () => {
    const w = await newWorld();
    const ts = '2026-08-01T12:00:00.000Z#aaaa0001';
    for (const [i, [, type, payload]] of AUTHORITY_EVENTS.entries()) await w.audit(`c-auth-${i}`, ts, type, payload);
    for (const [i, [, type, payload]] of UNRELATED_EVENTS.entries()) await w.audit(`c-other-${i}`, ts, type, payload);
    await w.audit('c-again', ts, 'housing_fair_signup', RESIGNUP_PAYLOAD);
    const { deps } = w.deps();
    for (const [i, [what]] of AUTHORITY_EVENTS.entries()) {
      expect([what, await leftOutReasonFor(deps, `c-auth-${i}`, NO_SKIP)]).toEqual([what, 'authority_history']);
    }
    for (const [i, [what]] of UNRELATED_EVENTS.entries()) {
      expect([what, await leftOutReasonFor(deps, `c-other-${i}`, NO_SKIP)]).toEqual([what, null]);
    }
    expect(await leftOutReasonFor(deps, 'c-again', NO_SKIP)).toBe('signed_up_again');
    expect(await leftOutReasonFor(deps, 'c-no-history', NO_SKIP)).toBeNull();
  }, 120_000);

  it('leftOutReasonFor pages backward past one page until a page comes back empty: an event on the OLDEST page still counts', async () => {
    const w = await newWorld();
    // Oldest first: the staff edit that cleared the authority, then four unrelated edits.
    await w.audit('c-deep', '2026-07-01T10:00:00.000Z#aaaa0001', 'contact_updated', {
      fields: ['housingAuthority'],
      actor: 'user-0001',
    });
    const later = ['2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'];
    for (const [i, day] of later.entries()) {
      const payload = { fields: ['status'], actor: 'user-0001' };
      await w.audit('c-deep', `${day}T10:00:00.000Z#bbbb000${i}`, 'contact_updated', payload);
      await w.audit('c-clean', `${day}T10:00:00.000Z#bbbb000${i}`, 'contact_updated', payload);
    }
    const { deps } = w.deps();
    const befores: Array<string | undefined> = [];
    const audit: BackfillDeps['audit'] = {
      append: (entityKey, eventType, payload) => deps.audit.append(entityKey, eventType, payload),
      listByEntity: (entityKey, opts) => {
        if (entityKey === 'contacts#c-deep') befores.push(opts?.before);
        return deps.audit.listByEntity(entityKey, opts);
      },
    };
    expect(await leftOutReasonFor({ audit, auditPageSize: 2 }, 'c-deep', NO_SKIP)).toBe('authority_history');
    // Pages of two, newest first: [07-05, 07-04], [07-03, 07-02], [07-01], then the empty page that ends it.
    expect(befores).toEqual([
      undefined,
      '2026-07-04T10:00:00.000Z#bbbb0002',
      '2026-07-02T10:00:00.000Z#bbbb0000',
      '2026-07-01T10:00:00.000Z#aaaa0001',
    ]);
    // A long history with nothing in it is read to its end too.
    expect(await leftOutReasonFor({ audit, auditPageSize: 2 }, 'c-clean', NO_SKIP)).toBeNull();
  }, 120_000);
});
```

Step 2 - RED: confirm DynamoDB Local is up (see the slice header), then `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts`
Expected: the 4.1 and 4.2 cases pass; the new cases fail because `checkBackfillList`, `scanCandidates`, `readWholeHistory`, `leftOutReasonFor`, `buildBackfillDeps` and `BackfillRefusedError` are not exported yet (`TypeError: ... is not a function` / `toBeInstanceOf` of undefined, or an import error naming the missing export).

Step 3 - implementation.

(a) Replace the script's import block with:

```ts
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { isOnListFor, KINDS_FOR_FIELD } from '../src/lib/orgNames.js';
import { createAuditRepo, type AuditEvent, type AuditRepo } from '../src/repos/auditRepo.js';
import {
  createContactsRepo,
  EMAIL_REF_PREFIX,
  isDeleted,
  PHONE_REF_PREFIX,
  type ContactItem,
  type ContactsRepo,
} from '../src/repos/contactsRepo.js';
import { createOrgListRepo, type OrgListRepo } from '../src/repos/orgListRepo.js';
import { isOrgRewriteRunning } from '../src/services/orgNames.js';
```

(b) Append at the end of the script:

```ts
// ---------------------------------------------------------------------------
// The reads: the list check, the candidates, a candidate's whole history
// ---------------------------------------------------------------------------

/**
 * The run refused before it read any contact (spec D10): no organization list
 * is stored, "Atlanta Housing Authority" is not an exact housing_authority
 * name on it, or - for --apply - an organization-name rewrite is running.
 * Nothing was written. Exit 1.
 */
export class BackfillRefusedError extends Error {}

/** The audit history page size (listByEntity's Limit). */
export const AUDIT_PAGE_SIZE = 100;

export interface BackfillDeps {
  /** The stage's client: the contacts base-table Scan runs on it. */
  doc: DynamoDBDocumentClient;
  /** The stage's env (its TABLE_PREFIX): every table name resolves from it. */
  env: NodeJS.ProcessEnv;
  orgList: Pick<OrgListRepo, 'peek'>;
  contacts: Pick<ContactsRepo, 'update'>;
  audit: Pick<AuditRepo, 'append' | 'listByEntity'>;
  /** One line of the operator report (the CLI prints it). Names go here, never to the logger. */
  print: (line: string) => void;
  /** Wall clock in ms: the rewrite lock's staleness test (isOrgRewriteRunning). */
  now: () => number;
  logger: Logger;
  /** Test seam: the Scan page size (unset = DynamoDB's own page). */
  scanLimit?: number;
  /** Test seam: the audit history page size (unset = AUDIT_PAGE_SIZE). */
  auditPageSize?: number;
}

/** The real deps: every repo on the stage's doc client and env - never the ambient TABLE_PREFIX. */
export function buildBackfillDeps(
  stage: { doc: DynamoDBDocumentClient; env: NodeJS.ProcessEnv },
  opts: { logger?: Logger; print?: (line: string) => void; now?: () => number } = {},
): BackfillDeps {
  const logger = opts.logger ?? defaultLogger;
  const { doc, env } = stage;
  return {
    doc,
    env,
    orgList: createOrgListRepo({ doc, env, logger }),
    contacts: createContactsRepo({ doc, env, logger }),
    audit: createAuditRepo({ doc, env, logger }),
    print: opts.print ?? ((line: string) => console.log(line)),
    now: opts.now ?? Date.now,
    logger,
  };
}

const NOTHING_DONE = 'No contact was read and nothing was written.';

/**
 * Spec D10: the list checks, BEFORE any contact is read. The stored item only
 * (peek - never created, never the starting list); for --apply, the system's
 * own rewrite-lock rule. Throws BackfillRefusedError.
 */
export async function checkBackfillList(deps: Pick<BackfillDeps, 'orgList' | 'now'>, apply: boolean): Promise<void> {
  const item = await deps.orgList.peek();
  if (item === null) {
    throw new BackfillRefusedError(
      `${SCRIPT_NAME}: REFUSED - this environment has no organization list yet: the deployed app creates it on its first read. ` +
        `Open Settings > Housing authorities & agencies once, then re-run. ${NOTHING_DONE}`,
    );
  }
  if (!isOnListFor(item.entries, BACKFILL_AUTHORITY, KINDS_FOR_FIELD.housingAuthority)) {
    throw new BackfillRefusedError(
      `${SCRIPT_NAME}: REFUSED - "${BACKFILL_AUTHORITY}" is not the exact name of a housing authority on this ` +
        "environment's organization list (renamed, merged, deleted or made an agency). Check Settings > Housing authorities & agencies " +
        `before going on. ${NOTHING_DONE}`,
    );
  }
  const held = item.lastRewrite;
  if (apply && held !== undefined && isOrgRewriteRunning(held, deps.now())) {
    throw new BackfillRefusedError(
      `${SCRIPT_NAME}: REFUSED - an organization-name rewrite is running (action ${held.action}, started ` +
        `${held.startedAt}, last heartbeat ${held.heartbeatAt}). Wait for it to finish (Settings > Housing ` +
        'authorities & agencies shows it); a rewrite whose process was killed stops blocking 15 minutes after its last ' +
        `heartbeat. ${NOTHING_DONE}`,
    );
  }
}

/** Every item of one BASE table (deleted rows included), page by page - the clean-org-names loop. */
async function* scanAll(
  doc: DynamoDBDocumentClient,
  table: string,
  limit: number | undefined,
): AsyncGenerator<Record<string, unknown>> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        ConsistentRead: true,
        ...(limit !== undefined && { Limit: limit }),
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const item of (page.Items ?? []) as Record<string, unknown>[]) yield item;
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function toLead(contact: ContactItem): BackfillLead {
  const capturedAt = text(contact.captured_at);
  return {
    contactId: contact.contactId,
    firstName: text(contact['firstName']),
    lastName: text(contact['lastName']),
    signedUpAt: capturedAt !== '' ? capturedAt : text(contact.created_at),
    status: text(contact.status),
  };
}

/** Oldest sign-up first; a lead with no date last; then by contactId. */
function compareLeads(a: BackfillLead, b: BackfillLead): number {
  if (a.signedUpAt !== b.signedUpAt) {
    if (a.signedUpAt === '') return 1;
    if (b.signedUpAt === '') return -1;
    return a.signedUpAt < b.signedUpAt ? -1 : 1;
  }
  return a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0;
}

export interface CandidateScan {
  /** The candidates (spec D10), oldest sign-up first. */
  leads: BackfillLead[];
  /** Contacts read (pointer rows not counted). */
  contactsScanned: number;
  /** phone/email pointer rows - skipped. */
  pointerRows: number;
}

/** Spec D10: one consistent Scan of the contacts BASE table (pointer rows skipped, as the cleanup does). */
export async function scanCandidates(deps: Pick<BackfillDeps, 'doc' | 'env' | 'scanLimit'>): Promise<CandidateScan> {
  const scan: CandidateScan = { leads: [], contactsScanned: 0, pointerRows: 0 };
  for await (const row of scanAll(deps.doc, tableName('contacts', deps.env), deps.scanLimit)) {
    const contactId = String(row['contactId'] ?? '');
    if (contactId.startsWith(PHONE_REF_PREFIX) || contactId.startsWith(EMAIL_REF_PREFIX)) {
      scan.pointerRows += 1;
      continue;
    }
    scan.contactsScanned += 1;
    const contact = row as ContactItem;
    if (isCandidate(contact)) scan.leads.push(toLead(contact));
  }
  scan.leads.sort(compareLeads);
  return scan;
}

/**
 * Spec D10: an entity's WHOLE audit history. listByEntity is one newest-first
 * Query with no cursor, so this pages backward with `before` = the oldest ts
 * seen until a page comes back empty. A page that does not move back (a store
 * ignoring `before`) throws rather than loop forever.
 */
export async function readWholeHistory(
  audit: Pick<AuditRepo, 'listByEntity'>,
  entityKey: string,
  pageSize: number,
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await audit.listByEntity(entityKey, { limit: pageSize, ...(before !== undefined && { before }) });
    if (page.length === 0) return events;
    events.push(...page);
    const oldest = page.reduce((min, e) => (e.ts < min ? e.ts : min), page[0]!.ts);
    if (before !== undefined && oldest >= before) {
      throw new Error(`${SCRIPT_NAME}: audit history paging did not advance for ${entityKey}`);
    }
    before = oldest;
  }
}

/**
 * Why one candidate is left out, or null when it is a target: --skip first
 * (no history read), then its whole history (leftOutReasonFromAudit).
 */
export async function leftOutReasonFor(
  deps: Pick<BackfillDeps, 'audit' | 'auditPageSize'>,
  contactId: string,
  skip: ReadonlySet<string>,
): Promise<LeftOutReason | null> {
  if (skip.has(contactId)) return 'skipped';
  const events = await readWholeHistory(deps.audit, `contacts#${contactId}`, deps.auditPageSize ?? AUDIT_PAGE_SIZE);
  return leftOutReasonFromAudit(events);
}
```

Step 4 - GREEN: `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts` - all pass, and the output has NO `SKIPPED - no DynamoDB Local` line. `cd W:\tmp\join-housing-authority\app; npm run typecheck` - exit 0.

Step 5 - commit: the ASCII check (bash, as in 4.1) prints 0 twice; `git -C W:\tmp\join-housing-authority status` read on its own; `Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\join-housing-authority\MERGE_HEAD"` prints False;
`git -C W:\tmp\join-housing-authority add app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts`;
`git -C W:\tmp\join-housing-authority commit -m "feat(backfill): /join housing authority backfill - list refusals, candidate Scan, whole-history reads (spec D10)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task 4.4 - The run: dry run, guarded apply, audit events, the post-apply warning

Files: `app/scripts/backfill-join-housing-authority.ts`, `app/test/backfillJoinHousingAuthority.test.ts`.

Step 1 - the failing test.

(a) Replace the test file's import block with the 4.3 block plus three names - exactly:

```ts
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import { getTableSpec } from '../src/lib/tables.js';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createOrgListRepo, type OrgListItem, type OrgListRepo, type OrgRewriteState } from '../src/repos/orgListRepo.js';
import {
  BACKFILL_AUDIT_TYPE,
  BACKFILL_AUTHORITY,
  BackfillRefusedError,
  backfillExitCode,
  buildBackfillDeps,
  checkBackfillList,
  formatBackfillReport,
  isCandidate,
  leftOutReasonFor,
  leftOutReasonFromAudit,
  readWholeHistory,
  runJoinAuthorityBackfill,
  scanCandidates,
  touchesHousingAuthority,
  type BackfillDeps,
  type BackfillLead,
  type BackfillReport,
} from '../scripts/backfill-join-housing-authority.js';
import { createLogCapture } from './helpers/logCapture.js';
```

(b) Append at the end of the test file:

```ts
// ---------------------------------------------------------------------------
// The run (spec D10): dry run by default, --apply writes
// ---------------------------------------------------------------------------

const RENAMED_WARNING = (written: number): string =>
  '"Atlanta Housing Authority" is no longer the exact name of a housing authority on the organization list (renamed, ' +
  `merged away, deleted or made an agency during the run): the ${written} record(s) written show under Settings > ` +
  'Housing authorities & agencies > "Not on the list" - settle them there.';
const REREAD_WARNING =
  'the organization list could not be read again after the apply, so the run could not confirm "Atlanta Housing ' +
  'Authority" is still on it - check Settings > Housing authorities & agencies > "Not on the list".';
const AUDIT_WARNING = (contactId: string): string =>
  `the housing_authority_backfill audit event for contactId ${contactId} could not be written (its housing authority was set).`;

/**
 * The world the run tests share. Targets: c-old, c-mid, c-new. Left out:
 * c-skip (the tests name it in --skip), c-again (signed up again after the
 * change), c-cleared (staff cleared its authority once). Not candidates:
 * c-marker, c-held, c-flyer.
 */
async function seedLeads(w: World): Promise<void> {
  await w.lead('c-old', { firstName: 'Avery', lastName: 'Fairlead', captured_at: '2026-06-20T14:00:00.000Z' });
  // A sign-up from BEFORE the change leaves no one out.
  await w.audit('c-old', '2026-06-20T14:00:01.000Z#aaaa0001', 'housing_fair_signup', {
    marker: 'mk',
    isNew: true,
    welcomeSent: true,
    viaFlyer: false,
  });
  await w.lead('c-mid', {
    firstName: 'Blake',
    lastName: 'Boothwick',
    captured_at: undefined,
    created_at: '2026-07-04T10:00:00.000Z',
    status: 'on_hold',
  });
  await w.lead('c-new', {
    firstName: 'Casey',
    lastName: 'Quillfeather',
    captured_at: '2026-08-15T23:30:00.000Z',
    status: 'onboarding',
  });
  await w.lead('c-skip', { firstName: 'Drew', lastName: 'Dekalbson', captured_at: '2026-06-01T09:00:00.000Z' });
  await w.lead('c-again', { firstName: 'Emery', lastName: 'Again', captured_at: '2026-06-10T09:00:00.000Z' });
  await w.audit('c-again', '2026-10-13T15:00:00.000Z#aaaa0001', 'housing_fair_signup', RESIGNUP_PAYLOAD);
  await w.lead('c-cleared', { firstName: 'Finley', lastName: 'Cleared', captured_at: '2026-07-10T09:00:00.000Z' });
  await w.audit('c-cleared', '2026-07-20T15:00:00.000Z#aaaa0001', 'contact_updated', {
    fields: ['housingAuthority'],
    actor: 'user-0001',
  });
  await w.lead('c-marker', { housing_fair_signup_v2: true, status: 'onboarding' });
  await w.lead('c-held', { housingAuthority: 'DeKalb County Housing Authority' });
  await w.lead('c-flyer', { capture_source: 'flyer' });
}

const TARGET_LEADS: BackfillLead[] = [
  { contactId: 'c-old', firstName: 'Avery', lastName: 'Fairlead', signedUpAt: '2026-06-20T14:00:00.000Z', status: 'needs_review' },
  { contactId: 'c-mid', firstName: 'Blake', lastName: 'Boothwick', signedUpAt: '2026-07-04T10:00:00.000Z', status: 'on_hold' },
  { contactId: 'c-new', firstName: 'Casey', lastName: 'Quillfeather', signedUpAt: '2026-08-15T23:30:00.000Z', status: 'onboarding' },
];
const LEFT_OUT = [
  {
    contactId: 'c-skip',
    firstName: 'Drew',
    lastName: 'Dekalbson',
    signedUpAt: '2026-06-01T09:00:00.000Z',
    status: 'needs_review',
    reason: 'skipped',
  },
  {
    contactId: 'c-again',
    firstName: 'Emery',
    lastName: 'Again',
    signedUpAt: '2026-06-10T09:00:00.000Z',
    status: 'needs_review',
    reason: 'signed_up_again',
  },
  {
    contactId: 'c-cleared',
    firstName: 'Finley',
    lastName: 'Cleared',
    signedUpAt: '2026-07-10T09:00:00.000Z',
    status: 'needs_review',
    reason: 'authority_history',
  },
];
const SKIP: ReadonlySet<string> = new Set(['c-skip']);
const GUARDED_WRITE = {
  expect: [
    { attr: 'housingAuthority', value: null },
    { attr: 'type', value: 'tenant' },
  ],
  notDeleted: true,
};

const freshRewrite = (): OrgRewriteState => {
  const at = new Date().toISOString();
  return {
    jobId: 'job-rename',
    action: 'rename',
    fromTexts: ['Old Name'],
    fields: ['housingAuthority', 'accepted_authorities'],
    toName: 'New Name',
    status: 'running',
    heartbeatAt: at,
    startedAt: at,
    startedBy: 'user-0001',
  };
};

describe.skipIf(!reachable)('runJoinAuthorityBackfill against DynamoDB Local (spec D10)', () => {
  afterEach(dropCreatedTables, 120_000);

  it('dry run: the targets and the left-out leads oldest first, the unknown --skip ids and the printed report - and NOTHING written, not even the list item', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const before = {
      contacts: await w.scanTable('contacts'),
      settings: await w.scanTable('settings'),
      audit: await w.scanTable('audit_events'),
    };
    const recorder = recordingClient(doc);
    const { deps, printed } = w.deps({ onDoc: recorder.doc });
    const report = await runJoinAuthorityBackfill(deps, { apply: false, skip: new Set(['c-skip', 'c-flyer', 'c-nobody']) });
    expect(report).toEqual({
      targets: TARGET_LEADS.map((l) => ({ ...l, outcome: 'would_write' })),
      leftOut: LEFT_OUT,
      unknownSkips: ['c-flyer', 'c-nobody'],
      written: 0,
      skipped: 0,
      failed: 0,
      warnings: [],
    });
    expect(printed).toEqual(formatBackfillReport(report, false));
    expect(printed[1]).toBe('  Avery Fairlead  signed up 2026-06-20  status needs_review  contactId c-old');
    // WRITES NOTHING, three ways: only reads were sent, the list was read once, no item changed.
    expect(recorder.sent).toContain('ScanCommand');
    expect(recorder.sent.filter((name) => !READ_COMMANDS.has(name))).toEqual([]);
    expect(recorder.sent.filter((name) => name === 'GetCommand')).toHaveLength(1);
    expect(await w.scanTable('contacts')).toEqual(before.contacts);
    expect(await w.scanTable('settings')).toEqual(before.settings);
    expect(await w.scanTable('audit_events')).toEqual(before.audit);
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it('apply: one guarded write and one audit event per target, nothing else changed; a re-run writes nothing new', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const leftAlone = ['c-skip', 'c-again', 'c-cleared', 'c-marker', 'c-held', 'c-flyer'];
    const before = new Map(await Promise.all(leftAlone.map(async (id) => [id, await w.get(id)] as const)));
    const oldBefore = await w.get('c-old');
    const recorder = recordingClient(doc);
    const base = w.deps({ onDoc: recorder.doc });
    const updates: unknown[] = [];
    const deps: BackfillDeps = {
      ...base.deps,
      contacts: {
        update: async (contactId, patch, opts) => {
          updates.push([contactId, patch, opts]);
          return base.deps.contacts.update(contactId, patch, opts);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report).toEqual({
      targets: TARGET_LEADS.map((l) => ({ ...l, outcome: 'written' })),
      leftOut: LEFT_OUT,
      unknownSkips: [],
      written: 3,
      skipped: 0,
      failed: 0,
      warnings: [],
    });
    expect(base.printed).toEqual(formatBackfillReport(report, true));
    // The binding write (plan section 1): contactsRepo.update with the three guards.
    expect(updates).toEqual([
      ['c-old', { housingAuthority: 'Atlanta Housing Authority' }, GUARDED_WRITE],
      ['c-mid', { housingAuthority: 'Atlanta Housing Authority' }, GUARDED_WRITE],
      ['c-new', { housingAuthority: 'Atlanta Housing Authority' }, GUARDED_WRITE],
    ]);
    // The ONE change is the authority: status and every other attribute exactly as before.
    expect(await w.get('c-old')).toEqual({ ...oldBefore, housingAuthority: 'Atlanta Housing Authority' });
    expect(await w.get('c-mid')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority', status: 'on_hold' });
    expect(await w.get('c-new')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority', status: 'onboarding' });
    for (const id of leftAlone) expect(await w.get(id)).toEqual(before.get(id));
    // One housing_authority_backfill event per target: exactly { field, from: '', to }, no actor.
    const events = await w.backfillEvents();
    expect(events.map((e) => e['entityKey']).sort()).toEqual(['contacts#c-mid', 'contacts#c-new', 'contacts#c-old']);
    for (const e of events) {
      expect(e['payload']).toEqual({ field: 'housingAuthority', from: '', to: 'Atlanta Housing Authority' });
      expect(e['actorId']).toBeUndefined();
    }
    // Two list reads: the check before, the re-read after (still listed: no warning).
    expect(recorder.sent.filter((name) => name === 'GetCommand')).toHaveLength(2);
    expect(backfillExitCode(report)).toBe(0);

    // A re-run with the same --skip writes nothing new.
    const again = await runJoinAuthorityBackfill(w.deps().deps, { apply: true, skip: SKIP });
    expect(again).toMatchObject({ targets: [], written: 0, skipped: 0, failed: 0, warnings: [] });
    expect(again.leftOut.map((l) => l.contactId)).toEqual(['c-skip', 'c-again', 'c-cleared']);
    expect(await w.backfillEvents()).toHaveLength(3);
    // A skipped lead stays a candidate: a run WITHOUT the --skip would write it (the RUNBOOK says keep the list).
    const noSkip = await runJoinAuthorityBackfill(w.deps().deps, { apply: false, skip: new Set() });
    expect(noSkip.targets.map((t) => t.contactId)).toEqual(['c-skip']);
  }, 120_000);

  it('a lead that changed between the read and the write is skipped, never overwritten - each guard: authority, type, deleted', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const base = w.deps();
    const key = (contactId: string) => ({ TableName: tableName('contacts', w.env), Key: { contactId } });
    const deps: BackfillDeps = {
      ...base.deps,
      contacts: {
        update: async (contactId, patch, opts) => {
          // Staff acted after the run read the lead.
          if (contactId === 'c-old') {
            await doc.send(
              new UpdateCommand({
                ...key(contactId),
                UpdateExpression: 'SET housingAuthority = :v',
                ExpressionAttributeValues: { ':v': 'DeKalb County Housing Authority' },
              }),
            );
          }
          if (contactId === 'c-mid') {
            await doc.send(
              new UpdateCommand({
                ...key(contactId),
                UpdateExpression: 'SET #t = :v',
                ExpressionAttributeNames: { '#t': 'type' },
                ExpressionAttributeValues: { ':v': 'landlord' },
              }),
            );
          }
          if (contactId === 'c-new') {
            await doc.send(
              new UpdateCommand({
                ...key(contactId),
                UpdateExpression: 'SET deleted_at = :v',
                ExpressionAttributeValues: { ':v': '2026-10-13T00:00:00.000Z' },
              }),
            );
          }
          return base.deps.contacts.update(contactId, patch, opts);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report.targets.map((t) => [t.contactId, t.outcome])).toEqual([
      ['c-old', 'skipped'],
      ['c-mid', 'skipped'],
      ['c-new', 'skipped'],
    ]);
    expect(report).toMatchObject({ written: 0, skipped: 3, failed: 0, warnings: [] });
    expect(await w.get('c-old')).toMatchObject({ housingAuthority: 'DeKalb County Housing Authority' });
    expect((await w.get('c-mid'))?.['housingAuthority']).toBeUndefined();
    expect((await w.get('c-new'))?.['housingAuthority']).toBeUndefined();
    expect(await w.backfillEvents()).toEqual([]);
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it('a lead whose history read or write fails is counted failed - nothing written for it - and the run goes on: exit 1, no name in any log line', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const base = w.deps({ logger: log });
    const deps: BackfillDeps = {
      ...base.deps,
      contacts: {
        update: async (contactId, patch, opts) => {
          if (contactId === 'c-mid') throw new Error('ProvisionedThroughputExceededException');
          return base.deps.contacts.update(contactId, patch, opts);
        },
      },
      audit: {
        append: (entityKey, eventType, payload) => base.deps.audit.append(entityKey, eventType, payload),
        listByEntity: async (entityKey, opts) => {
          if (entityKey === 'contacts#c-new') throw new Error('ThrottlingException');
          return base.deps.audit.listByEntity(entityKey, opts);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report.targets.map((t) => [t.contactId, t.outcome])).toEqual([
      ['c-old', 'written'],
      ['c-mid', 'failed'],
      ['c-new', 'failed'],
    ]);
    expect(report).toMatchObject({ written: 1, skipped: 0, failed: 2 });
    expect((await w.get('c-mid'))?.['housingAuthority']).toBeUndefined();
    expect((await w.get('c-new'))?.['housingAuthority']).toBeUndefined();
    expect(capture.atLevel(50).map((l) => l['contactId']).sort()).toEqual(['c-mid', 'c-new']);
    expect(capture.atLevel(40).some((l) => String(l['msg']).includes('COMPLETED WITH FAILURES'))).toBe(true);
    // Names reach the printed report only - never a structured log line.
    expect(base.printed.some((l) => l.includes('Avery Fairlead'))).toBe(true);
    for (const name of ['Fairlead', 'Boothwick', 'Quillfeather']) {
      expect(capture.lines.some((l) => JSON.stringify(l).includes(name))).toBe(false);
    }
    expect(backfillExitCode(report)).toBe(1);
  }, 120_000);

  it('an audit event that cannot be written after its write landed is a WARNING, not a failure: exit 0', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const base = w.deps();
    const deps: BackfillDeps = {
      ...base.deps,
      audit: {
        listByEntity: (entityKey, opts) => base.deps.audit.listByEntity(entityKey, opts),
        append: async (entityKey, eventType, payload) => {
          if (entityKey === 'contacts#c-mid') throw new Error('Rate exceeded');
          await base.deps.audit.append(entityKey, eventType, payload);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report).toMatchObject({ written: 3, failed: 0, warnings: [AUDIT_WARNING('c-mid')] });
    expect(await w.get('c-mid')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority' });
    expect((await w.backfillEvents()).map((e) => e['entityKey']).sort()).toEqual(['contacts#c-new', 'contacts#c-old']);
    expect(base.printed).toContain(`WARNING: ${AUDIT_WARNING('c-mid')}`);
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it('warns after an apply when Atlanta Housing Authority left the list during the run (renamed) - the writes stand, exit 0', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const base = w.deps();
    let renamed = false;
    const deps: BackfillDeps = {
      ...base.deps,
      contacts: {
        update: async (contactId, patch, opts) => {
          if (!renamed) {
            renamed = true;
            await w.orgList.putForSeed(listItem(withAtlanta((e) => ({ ...e, name: 'Atlanta Housing Authority (AHA)' }))));
          }
          return base.deps.contacts.update(contactId, patch, opts);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report.written).toBe(3);
    expect(report.warnings).toEqual([RENAMED_WARNING(3)]);
    expect(base.printed.at(-1)).toBe(`WARNING: ${RENAMED_WARNING(3)}`);
    expect(await w.get('c-old')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority' });
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it('warns when the list cannot be read again after the apply - the writes stand, exit 0', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const base = w.deps();
    let peeks = 0;
    const deps: BackfillDeps = {
      ...base.deps,
      orgList: {
        peek: async () => {
          peeks += 1;
          if (peeks > 1) throw new Error('settings table unavailable');
          return base.deps.orgList.peek();
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report).toMatchObject({ written: 3, failed: 0, warnings: [REREAD_WARNING] });
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it.each([
    { what: 'no organization list is stored (a dry run)', list: (): OrgListItem | null => null, apply: false },
    {
      what: 'Atlanta Housing Authority was renamed (a dry run)',
      list: (): OrgListItem | null => listItem(withAtlanta((e) => ({ ...e, name: 'Atlanta Housing Authority (AHA)' }))),
      apply: false,
    },
    {
      what: 'a rewrite is running (an apply)',
      list: (): OrgListItem | null => listItem(startingEntries(), freshRewrite()),
      apply: true,
    },
  ])('refuses before reading any contact when $what: one list read, nothing written, nothing printed', async ({ list, apply }) => {
    const w = await newWorld(list());
    await seedLeads(w);
    const before = {
      contacts: await w.scanTable('contacts'),
      settings: await w.scanTable('settings'),
      audit: await w.scanTable('audit_events'),
    };
    const recorder = recordingClient(doc);
    const { deps, printed } = w.deps({ onDoc: recorder.doc });
    await expect(runJoinAuthorityBackfill(deps, { apply, skip: NO_SKIP })).rejects.toBeInstanceOf(BackfillRefusedError);
    expect(recorder.sent).toEqual(['GetCommand']);
    expect(printed).toEqual([]);
    expect(await w.scanTable('contacts')).toEqual(before.contacts);
    expect(await w.scanTable('settings')).toEqual(before.settings);
    expect(await w.scanTable('audit_events')).toEqual(before.audit);
  }, 120_000);

  it('an apply goes ahead over a STALE running rewrite (no heartbeat for 15 minutes) - and never touches the lock', async () => {
    const stale = new Date(Date.now() - 16 * 60_000).toISOString();
    const killed: OrgRewriteState = { ...freshRewrite(), jobId: 'job-killed', heartbeatAt: stale, startedAt: stale };
    const w = await newWorld(listItem(startingEntries(), killed));
    await seedLeads(w);
    const report = await runJoinAuthorityBackfill(w.deps().deps, { apply: true, skip: SKIP });
    expect(report).toMatchObject({ written: 3, failed: 0 });
    expect((await w.orgList.peek())?.lastRewrite).toEqual(killed);
  }, 120_000);
});
```

Step 2 - RED: DynamoDB Local up, then `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts`
Expected: every earlier case passes; every new case fails because `runJoinAuthorityBackfill` is not exported yet (`TypeError: runJoinAuthorityBackfill is not a function`, or an import error naming it).

Step 3 - implementation.

(a) Replace the script's import block with:

```ts
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { isOnListFor, KINDS_FOR_FIELD } from '../src/lib/orgNames.js';
import { createAuditRepo, type AuditEvent, type AuditRepo } from '../src/repos/auditRepo.js';
import {
  createContactsRepo,
  EMAIL_REF_PREFIX,
  isDeleted,
  PHONE_REF_PREFIX,
  type ContactItem,
  type ContactsRepo,
} from '../src/repos/contactsRepo.js';
import { createOrgListRepo, type OrgListItem, type OrgListRepo } from '../src/repos/orgListRepo.js';
import { isOrgRewriteRunning } from '../src/services/orgNames.js';
```

(b) Append at the end of the script:

```ts
// ---------------------------------------------------------------------------
// The run (dry run by default; --apply writes)
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /** Write. false = the dry run: nothing is written at all. */
  apply: boolean;
  /** --skip: contactIds to leave out. An id that names no candidate is reported, otherwise ignored. */
  skip: ReadonlySet<string>;
}

/**
 * One target's write (spec D10): ONE conditional update that sets the
 * authority only while the contact still has none, is still a tenant and is
 * still not deleted - a lost condition is `skipped` - then its
 * housing_authority_backfill event. The event follows the landed write, so a
 * failed append is a warning, never a failure (a re-run finds the lead
 * holding an authority and cannot write it). Never throws.
 */
async function writeOne(deps: BackfillDeps, contactId: string, report: BackfillReport): Promise<TargetOutcome> {
  try {
    await deps.contacts.update(
      contactId,
      { [FIELD]: BACKFILL_AUTHORITY },
      {
        expect: [
          { attr: FIELD, value: null },
          { attr: 'type', value: 'tenant' },
        ],
        notDeleted: true,
      },
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      report.skipped += 1;
      deps.logger.info({ contactId }, `${SCRIPT_NAME} - the contact changed after the run read it; skipped, nothing written`);
      return 'skipped';
    }
    report.failed += 1;
    deps.logger.error({ err, contactId }, `${SCRIPT_NAME} - the write FAILED; nothing written for this contact`);
    return 'failed';
  }
  report.written += 1;
  try {
    await deps.audit.append(`contacts#${contactId}`, BACKFILL_AUDIT_TYPE, { field: FIELD, from: '', to: BACKFILL_AUTHORITY });
  } catch (err) {
    report.warnings.push(
      `the ${BACKFILL_AUDIT_TYPE} audit event for contactId ${contactId} could not be written (its housing authority was set).`,
    );
    deps.logger.warn({ err, contactId }, `${SCRIPT_NAME} - audit event could NOT be written (the write landed); continuing`);
  }
  deps.logger.info({ contactId }, `${SCRIPT_NAME} - housing authority set`);
  return 'written';
}

/**
 * Spec D10: after an apply that wrote, the name must still be an exact
 * housing_authority name. The run never takes the rewrite lock, so a rename,
 * merge, delete or kind change during the run is caught here - a warning.
 */
async function warnIfNameLeftList(deps: BackfillDeps, report: BackfillReport): Promise<void> {
  let item: OrgListItem | null;
  try {
    item = await deps.orgList.peek();
  } catch (err) {
    report.warnings.push(
      `the organization list could not be read again after the apply, so the run could not confirm "${BACKFILL_AUTHORITY}" ` +
        'is still on it - check Settings > Housing authorities & agencies > "Not on the list".',
    );
    deps.logger.warn({ err }, `${SCRIPT_NAME} - could not read the organization list again after the apply`);
    return;
  }
  if (item !== null && isOnListFor(item.entries, BACKFILL_AUTHORITY, KINDS_FOR_FIELD.housingAuthority)) return;
  report.warnings.push(
    `"${BACKFILL_AUTHORITY}" is no longer the exact name of a housing authority on the organization list (renamed, ` +
      `merged away, deleted or made an agency during the run): the ${report.written} record(s) written show under Settings > ` +
      'Housing authorities & agencies > "Not on the list" - settle them there.',
  );
  deps.logger.warn({ written: report.written }, `${SCRIPT_NAME} - the backfilled name left the organization list during the run`);
}

/**
 * Spec D10: the backfill. Refuses (BackfillRefusedError) before any contact
 * is read; then reads the candidates, and for each - oldest first - reads its
 * whole history right before its write; then (apply) re-checks the list,
 * prints the report through deps.print and returns it. A failed history read
 * or write is counted `failed` (exit 1) and the run goes on; only the list
 * read and the contacts Scan abort it, both before any write.
 */
export async function runJoinAuthorityBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillReport> {
  const log = deps.logger;
  await checkBackfillList(deps, opts.apply);
  const scan = await scanCandidates(deps);
  log.info(
    { contactsScanned: scan.contactsScanned, pointerRows: scan.pointerRows, candidates: scan.leads.length, apply: opts.apply },
    `${SCRIPT_NAME} - candidates read`,
  );
  const candidateIds = new Set(scan.leads.map((l) => l.contactId));
  const report: BackfillReport = {
    targets: [],
    leftOut: [],
    unknownSkips: [...opts.skip].filter((id) => !candidateIds.has(id)).sort(),
    written: 0,
    skipped: 0,
    failed: 0,
    warnings: [],
  };

  for (const lead of scan.leads) {
    let reason: LeftOutReason | null;
    try {
      reason = await leftOutReasonFor(deps, lead.contactId, opts.skip);
    } catch (err) {
      report.failed += 1;
      report.targets.push({ ...lead, outcome: 'failed' });
      log.error({ err, contactId: lead.contactId }, `${SCRIPT_NAME} - could not read the audit history; nothing written for this contact`);
      continue;
    }
    if (reason !== null) {
      report.leftOut.push({ ...lead, reason });
      log.info({ contactId: lead.contactId, reason }, `${SCRIPT_NAME} - left out`);
      continue;
    }
    if (!opts.apply) {
      report.targets.push({ ...lead, outcome: 'would_write' });
      log.info({ contactId: lead.contactId }, `${SCRIPT_NAME} - DRY RUN: would set the housing authority`);
      continue;
    }
    report.targets.push({ ...lead, outcome: await writeOne(deps, lead.contactId, report) });
  }

  if (opts.apply && report.written > 0) await warnIfNameLeftList(deps, report);

  const counts = {
    candidates: scan.leads.length,
    targets: report.targets.length,
    leftOut: report.leftOut.length,
    unknownSkips: report.unknownSkips.length,
    written: report.written,
    skipped: report.skipped,
    failed: report.failed,
    warnings: report.warnings.length,
    apply: opts.apply,
  };
  const suffix = opts.apply ? '' : ' (DRY RUN - nothing written)';
  if (report.failed > 0) {
    log.warn(
      counts,
      `${SCRIPT_NAME} - COMPLETED WITH FAILURES${suffix}: ${report.failed} lead(s) FAILED and were left as they were (see the ERROR lines naming them). Re-run (idempotent).`,
    );
  } else if (report.warnings.length > 0) {
    log.warn(counts, `${SCRIPT_NAME} - done${suffix}, with ${report.warnings.length} warning(s): read the WARNING lines of the report`);
  } else {
    log.info(counts, `${SCRIPT_NAME} - done${suffix}`);
  }
  for (const line of formatBackfillReport(report, opts.apply)) deps.print(line);
  return report;
}
```

Step 4 - GREEN: `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts` - all pass, no `SKIPPED` line. `cd W:\tmp\join-housing-authority\app; npm run typecheck` - exit 0.

Step 5 - commit: the ASCII check (bash, as in 4.1) prints 0 twice; `git -C W:\tmp\join-housing-authority status` read on its own; `Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\join-housing-authority\MERGE_HEAD"` prints False;
`git -C W:\tmp\join-housing-authority add app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts`;
`git -C W:\tmp\join-housing-authority commit -m "feat(backfill): /join housing authority backfill - dry run, guarded apply, audit events, rename warning (spec D10)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task 4.5 - The CLI: `--env` / `--lane` / `--apply` / `--skip`, exit codes 0/1/2

Files: `app/scripts/backfill-join-housing-authority.ts`, `app/test/backfillJoinHousingAuthority.test.ts`.

Step 1 - the failing test.

(a) Replace the test file's import block with:

```ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import { getTableSpec } from '../src/lib/tables.js';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createOrgListRepo, type OrgListItem, type OrgListRepo, type OrgRewriteState } from '../src/repos/orgListRepo.js';
import {
  BACKFILL_ARGS,
  BACKFILL_AUDIT_TYPE,
  BACKFILL_AUTHORITY,
  BackfillRefusedError,
  backfillExitCode,
  buildBackfillDeps,
  checkBackfillList,
  formatBackfillReport,
  isCandidate,
  leftOutReasonFor,
  leftOutReasonFromAudit,
  parseSkipList,
  readWholeHistory,
  runJoinAuthorityBackfill,
  scanCandidates,
  touchesHousingAuthority,
  type BackfillDeps,
  type BackfillLead,
  type BackfillReport,
} from '../scripts/backfill-join-housing-authority.js';
import { parseStageArgs } from '../scripts/lib/stageClient.js';
import { createLogCapture } from './helpers/logCapture.js';
```

(b) Append at the end of the test file:

```ts
// ---------------------------------------------------------------------------
// The CLI (spec D10: --env local|dev|prod, --lane with local only, dry run by
// default, --apply, --skip; unknown or repeated arguments are usage, exit 2)
// ---------------------------------------------------------------------------

describe('the CLI', () => {
  it('dry run by default; --apply writes; --skip takes ONE comma-separated value; anything else is a usage error', () => {
    const dry = parseStageArgs(['--env', 'prod'], BACKFILL_ARGS);
    if ('usage' in dry) throw new Error('expected a parse');
    expect(dry.target).toBe('prod');
    expect(dry.flags.has('--apply')).toBe(false);
    expect(parseSkipList(dry.values.get('--skip'))).toEqual(new Set());
    const lane = parseStageArgs(['--env', 'local', '--lane', '4', '--apply', '--skip', 'contact-a,contact-b'], BACKFILL_ARGS);
    if ('usage' in lane) throw new Error('expected a parse');
    expect(lane).toMatchObject({ target: 'local', lane: 4 });
    expect(lane.flags.has('--apply')).toBe(true);
    expect(parseSkipList(lane.values.get('--skip'))).toEqual(new Set(['contact-a', 'contact-b']));
    for (const argv of [
      ['--env', 'dev', '--dry-run'],
      ['--env', 'dev', '--lane', '2'],
      ['--env', 'dev', '--apply', '--apply'],
      ['--env', 'dev', '--skip', 'contact-a', '--skip', 'contact-b'],
      ['--env', 'dev', '--skip'],
      ['--env', 'dev', '--skip', '--apply'],
      ['--apply'],
    ]) {
      expect(parseStageArgs(argv, BACKFILL_ARGS)).toEqual({ usage: true });
    }
  });

  it('parseSkipList trims each id; an empty id (an empty value, a stray comma) is a usage error', () => {
    expect(parseSkipList(undefined)).toEqual(new Set());
    expect(parseSkipList('contact-a')).toEqual(new Set(['contact-a']));
    expect(parseSkipList(' contact-a , contact-b ')).toEqual(new Set(['contact-a', 'contact-b']));
    for (const raw of ['', ' ', ',', 'contact-a,', 'contact-a,,contact-b']) {
      expect(parseSkipList(raw)).toBeUndefined();
    }
  });

  it('resolves the stage before any read, exits 2 on usage, maps a refusal and the exit code, and destroys the client', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'backfill-join-housing-authority.ts'), 'utf8');
    expect(source).toContain('parseStageArgs(process.argv.slice(2), BACKFILL_ARGS)');
    expect(source).toContain('process.exit(2)');
    expect(source.indexOf('resolveStageClient(')).toBeGreaterThan(-1);
    expect(source.indexOf('resolveStageClient(')).toBeLessThan(source.indexOf('await runJoinAuthorityBackfill('));
    expect(source).toContain('err instanceof BackfillRefusedError');
    expect(source).toContain('process.exitCode = backfillExitCode(report)');
    expect(source).toContain('stage.doc.destroy()');
    expect(source).toContain('FAILED: ${err instanceof Error ? err.message : String(err)}');
  });
});
```

Step 2 - RED: `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts`
Expected: earlier cases pass; the three CLI cases fail - `BACKFILL_ARGS` / `parseSkipList` are not exported yet (`TypeError: parseSkipList is not a function`; `parseStageArgs` throws reading `values` of undefined), and the source has no `parseStageArgs(process.argv.slice(2), BACKFILL_ARGS)`.

Step 3 - implementation.

(a) Replace the script's import block with:

```ts
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { isOnListFor, KINDS_FOR_FIELD } from '../src/lib/orgNames.js';
import { createAuditRepo, type AuditEvent, type AuditRepo } from '../src/repos/auditRepo.js';
import {
  createContactsRepo,
  EMAIL_REF_PREFIX,
  isDeleted,
  PHONE_REF_PREFIX,
  type ContactItem,
  type ContactsRepo,
} from '../src/repos/contactsRepo.js';
import { createOrgListRepo, type OrgListItem, type OrgListRepo } from '../src/repos/orgListRepo.js';
import { isOrgRewriteRunning } from '../src/services/orgNames.js';
import { parseStageArgs, resolveStageClient, type StageClient } from './lib/stageClient.js';
```

(b) Append at the end of the script:

```ts
// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

/** The argument names the CLI accepts beside --env and --lane (parseStageArgs refuses any other, and any repeat). */
export const BACKFILL_ARGS = { values: ['--skip'], flags: ['--apply'] };

/**
 * --skip's value: contactIds, comma-separated, each trimmed; absent = none.
 * An empty id (an empty value, a stray comma) is a usage error: undefined.
 */
export function parseSkipList(raw: string | undefined): ReadonlySet<string> | undefined {
  if (raw === undefined) return new Set();
  const ids = raw.split(',').map((id) => id.trim());
  return ids.some((id) => id === '') ? undefined : new Set(ids);
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith(`${SCRIPT_NAME}.ts`);
if (invokedDirectly) {
  const parsed = parseStageArgs(process.argv.slice(2), BACKFILL_ARGS);
  const skip = 'usage' in parsed ? undefined : parseSkipList(parsed.values.get('--skip'));
  if ('usage' in parsed || skip === undefined) {
    console.error(
      `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--apply] [--skip "<contactId>[,<contactId>...]"]\n` +
        '  DRY RUN by default; --apply writes. --skip leaves the named leads out (ONE comma-separated value - quote it).\n' +
        '  Unknown or repeated arguments and an empty --skip id are refused. --lane selects a hermetic e2e lane (local only).',
    );
    process.exit(2);
  }
  const apply = parsed.flags.has('--apply');
  void (async () => {
    // STEP 1 - resolve the target on its own: a refusal here (account guard,
    // STS, an ambient AWS_ENDPOINT_URL*) happens BEFORE any table is read.
    let stage: StageClient;
    try {
      stage = await resolveStageClient(parsed.target, {}, parsed.lane !== undefined ? { lane: parsed.lane } : {});
    } catch (err) {
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED before the run started (no table was read or written)`);
      process.exitCode = 1;
      return;
    }
    // STEP 2 - the run. It prints its own report.
    try {
      defaultLogger.info(
        { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix, apply, skip: skip.size },
        `${SCRIPT_NAME} - starting`,
      );
      const report = await runJoinAuthorityBackfill(buildBackfillDeps(stage), { apply, skip });
      process.exitCode = backfillExitCode(report);
    } catch (err) {
      if (err instanceof BackfillRefusedError) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      // The list read or the contacts Scan failed: the run stopped before any write.
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      stage.doc.destroy();
    }
  })();
}
```

Step 4 - GREEN: `cd W:\tmp\join-housing-authority\app; npx vitest run test/backfillJoinHousingAuthority.test.ts` - all pass, no `SKIPPED` line. `cd W:\tmp\join-housing-authority\app; npm run typecheck` - exit 0. Lint the two files (from the worktree root): `cd W:\tmp\join-housing-authority; npx eslint app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts` - exit 0.

Step 5 - commit: the ASCII check (bash, as in 4.1) prints 0 twice; `git -C W:\tmp\join-housing-authority status` read on its own; `Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\join-housing-authority\MERGE_HEAD"` prints False;
`git -C W:\tmp\join-housing-authority add app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts`;
`git -C W:\tmp\join-housing-authority commit -m "feat(backfill): /join housing authority backfill CLI - --apply, --skip, stage resolution, exit codes (spec D10)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### Task 4.6 - The RUNBOOK entry (spec D11)

Files: `RUNBOOK.md`.

A docs task: no RED/GREEN test; the verification steps below replace them.

Step 1 - with the Edit tool, in `RUNBOOK.md`, replace the exact line

```markdown
### Caseworkers (`feat/caseworkers`): NOTHING is owed at deploy - the conversion's repair, and putting a mistaken conversion back
```

with the new section, a blank line, and that same line again - i.e. the new section sits right AFTER "Organization names cleanup" and BEFORE "Caseworkers". The new section, exactly:

```markdown
### /join leads: the housing authority backfill (`feat/join-housing-authority`): owed on dev AND prod after this branch deploys - dry run, read the list, then `--apply`

**NOT YET RUN - owed on dev AND prod once this branch has deployed there; take dev all the way through before prod.** No Terraform, no secrets, no env var, no schema or index change. Spec: `docs/superpowers/specs/2026-10-12-join-housing-authority-design.md`, D10 and D11. Run it AFTER that environment's deploy: until the deploy, `/join` keeps creating leads with no housing authority, and a run before it cannot reach those (it is safe at any time and re-runnable, but after the deploy one pass catches them all).

What `app/scripts/backfill-join-housing-authority.ts` does: before this branch every `/join` sign-up arrived with no housing authority, so a property blast filtered on Atlanta Housing Authority never reaches those leads. The script gives "Atlanta Housing Authority" to the existing `/join` leads that still have none, and changes NOTHING else - status, names and every other field stay as they are, so most backfilled leads stay Needs review, and a lead staff parked On hold or Inactive gets the authority too. A lead is a CANDIDATE when it has `capture_source` `housing_fair`, is a tenant, is not deleted, holds no housing authority and has no `housing_fair_signup_v2` marker (every contact the sign-up creates after the deploy carries it, so a lead who answered "Not sure" on the new form is never touched). Nothing stored tells a flyer sign-up for a property that was no longer available apart from a `/join` lead - both are `housing_fair` leads - so the names and dates in the report are a recognition aid, not a guarantee.

Three kinds of candidate are LEFT OUT - nothing written - and listed with the reason:
- `named in --skip` - you named it (step 2);
- `signed up again after the change` - the same phone signed up again after the deploy (on `/join` or a flyer); its answer to the new question is kept in its audit history and is not overridden;
- `its housing authority was set or removed before - left empty on purpose` - its history shows the housing authority was set or removed at some point (a staff edit, the caseworker conversion, an AI write or an accepted AI suggestion, an organization-name rewrite or the 2026-10 cleanup, or an earlier run of this script), so the empty value is a decision.

Target handling is the automation scripts' (above): `--env local|dev|prod` resolves the tables AND the credentials itself (`app/scripts/lib/stageClient.ts`); `dev`/`prod` run the account guard on the `housingchoice` profile BEFORE any table is read, pin the regional endpoint and refuse to start while an `AWS_ENDPOINT_URL*` variable is set. Unknown or repeated arguments (`--skip` twice included), `--lane` with `dev`/`prod`, and an empty id in `--skip` are usage errors (exit 2, nothing run).

**The refusals** (exit 1; no contact read, nothing written; the message is the last line):
- `REFUSED - this environment has no organization list yet` - the deployed app creates the list on its first read: open Settings > Housing authorities & agencies once, then re-run. A dry run refuses too (it never falls back to the starting list).
- `REFUSED - "Atlanta Housing Authority" is not the exact name of a housing authority on this environment's organization list` - it was renamed, merged, deleted or made an agency. Look at Settings > Housing authorities & agencies before going on; do not change the list just to let the script run.
- `--apply` only: `REFUSED - an organization-name rewrite is running` - wait for it to finish (the Settings page shows it); a rewrite whose process was killed stops blocking 15 minutes after its last heartbeat. A dry run is not blocked.

The apply does NOT take the rewrite lock: do not rename, merge, delete or re-kind Atlanta Housing Authority on Settings while it runs (seconds at today's volume). If that happens anyway, the apply ends with the first WARNING under step 3.

1. **Dry run (the DEFAULT; writes nothing, not even the list):** `npx tsx app/scripts/backfill-join-housing-authority.ts --env dev`. After its JSON log lines (counts and contactIds only - never a name), it prints the report:
   - `DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):`, then one line per lead: first and last name (`(no name)` when it has none), `signed up <YYYY-MM-DD>` (when it signed up, else when the record was created, as a UTC date; `unknown` when it has neither), `status <status>` as stored (`needs_review`, `on_hold`, ...), and `contactId <id>`;
   - `Would update: N lead(s). Failed: F.` - a lead whose audit history could not be read is listed with `- FAILED: nothing written (an ERROR line names this contactId); re-run` and counted in F; the run exits 1;
   - `Left out (M lead(s), oldest sign-up first):` - the same lines, each ending with its reason - or `Left out: none.`;
   - `--skip ids that are not candidates (ignored): ...` when a `--skip` id names no candidate (a typo, a lead that already holds an authority, or not a `/join` lead).
2. **Read the target list.** Leave out anyone known NOT to hold an Atlanta voucher (for example a DeKalb or DCA voucher holder): copy their `contactId` (the last item on the line; the same id is in their contact page's address) into ONE comma-separated, quoted `--skip` value, and re-run the dry run until both lists are right: `npx tsx app/scripts/backfill-join-housing-authority.ts --env dev --skip "contact-1111,contact-2222"`. **Keep that `--skip` value for every later run on that environment:** a skipped lead stays a candidate, so a run without it gives that lead Atlanta Housing Authority. To take a lead out for good, set its real housing authority on its contact page (it is then no longer a candidate).
3. **Apply** with the same `--skip`: `npx tsx app/scripts/backfill-join-housing-authority.ts --env dev --apply --skip "contact-1111,contact-2222"`. Per target it makes ONE conditional write - the housing authority is set only while the lead still has none, is still a tenant and is still not deleted - and appends one `housing_authority_backfill` audit event `{ field: 'housingAuthority', from: '', to: 'Atlanta Housing Authority' }` with no actor. Each lead's history is read right before its write. The report heads its list `Leads given "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):`, then `Written: N. Skipped (changed after the read): S. Failed: F.`, the left-out list and the unknown `--skip` ids as in step 1. What can follow a lead or end the report:
   - a line ending `- SKIPPED: it changed after the run read it (nothing written)` - staff set an authority, re-typed or deleted the lead while the run worked: nothing to do;
   - a line ending `- FAILED: nothing written (an ERROR line names this contactId); re-run` - its history read or its write failed; the run went on with the others and exits 1 (`COMPLETED WITH FAILURES` on the done log line): fix the cause and re-run;
   - `WARNING: "Atlanta Housing Authority" is no longer the exact name of a housing authority on the organization list ...` - the name left the list during the run: the records just written show under Settings > Housing authorities & agencies > "Not on the list"; settle them there;
   - `WARNING: the organization list could not be read again after the apply ...` - look at "Not on the list" yourself;
   - `WARNING: the housing_authority_backfill audit event for contactId <id> could not be written ...` - that lead's authority WAS set; only its history event is missing. Expected never.
4. **Re-run the dry run with the same `--skip`:** it must show `Would update: 0 lead(s).`, with the skipped leads under Left out. A lead that shows up again had its write SKIPPED or FAILED in step 3: apply again (idempotent - a lead holding an authority, the marker, a post-deploy sign-up or an authority history is never touched).
5. **Then prod**, the same four steps after prod's deploy, with prod's own `--skip` list.

Cost: one consistent Scan of the contacts table, then per candidate one audit-history Query per 100 events, and on an apply one conditional write and one audit event per target - seconds at today's volume. Exit codes: 0 the run completed clean (WARNING lines included - read them); 1 it was refused, a lead FAILED, the run stopped before any write (`backfill-join-housing-authority - FAILED: <the error>` - the list or the contacts Scan could not be read), or the target could not be resolved (nothing read); 2 usage.

**No agent runs it against dev or prod; an agent rehearses on a lane: `--env local --lane <L>`.** Never a bare `--env local` - that is the live local stack. No app path creates a candidate any more (every new sign-up gets the marker, and no seed writes `capture_source` `housing_fair`), so a rehearsal writes pre-change-shaped leads into the lane's contacts table directly.
```

Step 2 - verify:
1. `cd W:\tmp\join-housing-authority; git diff --stat` - only `RUNBOOK.md` changed.
2. ASCII on the ADDED lines (bash; RUNBOOK.md has pre-existing non-ASCII elsewhere): `cd /w/tmp/join-housing-authority && git diff -U0 RUNBOOK.md | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` - prints 0.
3. `cd /w/tmp/join-housing-authority && grep -n '^### /join leads: the housing authority backfill' RUNBOOK.md` - one hit, and the very next `### ` heading after it is the Caseworkers one; the Organization names cleanup section is the one before it.
4. Every message the RUNBOOK quotes matches the code: `grep -n 'REFUSED - this environment has no organization list yet\|is not the exact name of a housing authority on this\|an organization-name rewrite is running (action\|is no longer the exact name of a housing authority\|could not be read again after the apply\|SKIPPED: it changed after the run read it\|FAILED: nothing written (an ERROR line' app/scripts/backfill-join-housing-authority.ts` - all seven present.

Step 3 - commit: `git -C W:\tmp\join-housing-authority status` read on its own (only `RUNBOOK.md`); `Test-Path "W:\AI Projects\Housing Choice\HC Application\.git\worktrees\join-housing-authority\MERGE_HEAD"` prints False;
`git -C W:\tmp\join-housing-authority add RUNBOOK.md`;
`git -C W:\tmp\join-housing-authority commit -m "docs(runbook): the /join housing authority backfill - dry run, read the list, apply; dev then prod (spec D11)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

#### S4 verification notes (for the reviewer; no task)

Audit shapes verified against the code (main @19607658 = this branch's base), each matching spec D10:
- `contact_updated` `{ fields: string[], actor, ... }`: staff PATCH `app/src/routes/contacts.ts:653-657` (key PRESENCE adds `housingAuthority` to changedFields; '' maps to null = REMOVE) and `:1950-1954` (the append); the edit form sends the key only when it changed (`dashboard/src/routes/contact/ContactEditForm.tsx:391-393`, the same rule since the form's first commit 2026-06-18). Caseworker conversion `app/src/services/caseworkerConversion.ts:555-565` (patch always holds `housingAuthority: null`), `:592` (`fields: Object.keys(patch)`), `:426-433` (the append); its repair path appends `fields: []` (`:526`) on a contact that is already a partner (never a candidate).
- `ai_extraction_applied` `{ fields: [{ field, from, to, reason? }], conversationId }`: `app/src/services/extraction/apply.ts:201`, `:302-307`, `:505-508`. Writes only an EMPTY field (never removes).
- `ai_suggestion_accepted` `{ actor?, target, from, to }`: `app/src/services/suggestionResolution.ts:328-351`, stored by `app/src/repos/suggestionResolutionRepo.ts:454-466` (sort key `<claimedAt>#resolve-<hash>` - still ISO-prefixed, so `before` paging holds).
- `org_name_rewrite` `{ field, from, to, action, actor? }` / `org_name_cleanup` `{ field, from, to }`: `app/src/services/orgRecords.ts:618-628`; the cleanup script appends its own at `app/scripts/clean-org-names.ts:732-742`.
- `housing_fair_signup` today `{ marker, isNew, welcomeSent, viaFlyer }` (`app/src/routes/public.ts:322-327`); S2 adds `signupVersion: 2` and `housingAuthority`.

Writers of a contact's `housingAuthority` outside that list (no spec change needed): the importer SETs it fill-only and appends no audit event (`app/src/lib/import/apply.ts:1145-1153`) - harmless here, since a lead holding a value is not a candidate and every REMOVE path above audits; the dev-only route `app/src/routes/dev.ts:1198-1237` (hermetic lanes only). No seed writes `capture_source: 'housing_fair'` (the only seed capture_source is `inbound_sms`, `app/src/lib/seed/cast.ts:159`).

`contactsRepo.update` with a `housingAuthority`-only patch (`app/src/repos/contactsRepo.ts:1458-1580`): one UpdateItem, no `updated_at`, no classification bump (only for `type`/`role`, `:1501-1508`), no phone rows; guards on the same condition (`:1550-1564`; `value: null` = `attribute_not_exists`); a lost guard or a missing contact throws `ConditionalCheckFailedException`; logs only `{ contactId, setFields, removedFields }`.

Accepted edges (no code change): (1) `isDeleted` treats `deleted_at: ''` as not deleted while the `notDeleted` guard requires the attribute ABSENT, so such a lead (none exist: restore REMOVEs the stamp) would be a dry-run target and an apply `skipped` every time. (2) A post-change re-sign-up landing between a lead's history read and its write is not covered by the three binding guards (D6 writes nothing to the contact); the per-lead read-then-write keeps that window to milliseconds. (3) PowerShell treats an unquoted `a,b` argument as an array, so the RUNBOOK and the usage text quote the `--skip` value.

## 8. S5 - E2E and stale statements (Tasks 5.1-5.3)

CONTRACT ISSUES: none.

The binding sections 0-3 are workable for S5 as written. Checked against the
code: the copy strings in section 1 are the ones the e2e test queries; the
contact attribute `housing_fair_signup_v2` (section 2.2) is readable from the
e2e lane because `GET /api/contacts?phone=` returns the stored item unprojected
(`app/src/routes/contacts.ts:1038-1048`); the 60-per-minute list limit (D2,
section 2.1) is safe for the whole e2e suite (counted below).

### Cross-slice notes for the orchestrator (not contract issues)

1. S3 element type. Task 5.1 drives the select as a NATIVE `<select>`: it finds
   it with `getByRole('combobox', { name: 'Housing authority' })`, picks with
   `selectOption({ label })`, and reads the shown choice from the selected
   `<option>`'s TEXT (never its `value`). Section 2.4 leaves the element type
   open; S3 should render a native select whose option text is the exact name
   (and "Not sure" last, "Choose one" first only in the D8 recovery state).
2. S3 and the perf mutation inventory. `e2e/performance/mutationCatalog.test.ts`
   (part of `npm test` through the e2e workspace) statically parses EVERY
   dashboard `request(...)` call. An options argument that is not an inline
   object literal throws `unprovable_method` (`mutationCatalog.test.ts:111-155`,
   `:178-182`); a non-literal, non-identifier path throws `unprovable_path`.
   So `getHousingAuthorities` should call
   `request<...>('/public/housing-authorities', { signal: ... })` with an inline
   object, and `submitHousingFair` must keep its literal
   `'/public/housing-fair'` and inline `{ method: 'POST', body }` (its catalog
   entry is `e2e/performance/mutationCatalog.ts:174`; the pinned count of 120 at
   `mutationCatalog.test.ts:380` must not move - a GET is filtered out at
   `:323-327`). Task 5.3 runs that test as a check.
3. S3 and D9. Task 5.1 asserts the page makes NO further
   `GET /public/housing-authorities` after "Sign up another person" (after a
   good first read). A list fetch placed inside a component that remounts with
   the keyed IntakeForm would re-read and fail that assertion - the list state
   and its fetch must live in `HousingFairIntake` (as section 2.4 says).
4. Spec pointer precision (no findings file): spec section 7 names
   "`e2e/scenarios/steps.ts` (the housing-fair step's description)", but that
   step (`tenantSelfServes`, `e2e/scenarios/steps.ts:564-584`) states no status;
   the `needs_review` statement is in the next verb's docblock,
   `openSelfServedContact` (`e2e/scenarios/steps.ts:969-974`). Task 5.2 edits
   the right place.
5. S6 timing. The e2e preflight refuses a reused session booted at a different
   commit (`e2e/support/preflight.ts:87-128`), so every targeted run in 5.1 and
   5.2 needs a session booted at the current HEAD; the tasks below stop the
   session before each commit and boot a new one for the next task. S6's live
   self-QA must likewise boot its session after its last commit.

### Decisions recorded without a task

- Perf harness: NO declaration of `GET /public/housing-authorities` is needed.
  `/join` and `/p/:unitId` are excluded from the measured registry
  (`e2e/performance/routes.ts:117-118`, reason `public`), and the flyer renders
  no select (D8), so no measured page makes the request. Even if one did, an
  undeclared first-party path outside `/api/` is classified as an asset with
  `unmatchedApi: false` (`e2e/performance/templates.ts:297-303`); only an
  undeclared `/api/*` path becomes `unmatched_api`
  (`templates.ts:285-295`, `e2e/performance/report.ts:315`). The mutation
  catalog skips GETs (`mutationCatalog.test.ts:323-327`). Task 5.3 runs the
  inventory test to prove S3 kept it green.
- Rate limit (D2, 60 reads per 60 s per IP, hard-coded, not raised by
  `PUBLIC_RATE_LIMIT_MAX` at `scripts/e2e-session.mjs:142`): SAFE. Playwright
  runs one worker, not fully parallel (`e2e/playwright.config.ts`,
  `workers: 1`, `fullyParallel: false`), and all lane traffic shares one key
  (127.0.0.1; `app/src/middleware/rateLimit.ts:67-74`). Page loads of `/join`
  in the whole suite after this change: `a2p-compliance.spec.ts:107` (1),
  `environment-identity.spec.ts:40` via `:101` (1), `public-pages.spec.ts:345`
  (1) and the new 5.1 test (1, plus one raw API read). Each load reads the
  list once, twice at most under React StrictMode (`dashboard/src/main.tsx:15`)
  and "Sign up another person" adds no read (D9). Worst case 9 reads per suite
  run, spread over its ~20-40 minutes. Even with every spec forced into one
  minute it is under 60. Task 5.3 records this beside the env var so a future
  loop over `/join` does not trip it silently.
- Other e2e specs that touch `/join` or `POST /public/housing-fair` - none
  breaks; only the tenant-onboarding note is stale (Task 5.2):
  - `a2p-compliance.spec.ts:103-130` (the `/join` client consent gate): fills
    by label, the click on "Sign me up" auto-waits for the button to be
    enabled (D8 disables it while the list loads), `getByRole('alert')` stays
    unique (the D8 failed-list note only shows on a failed read). `:135-185`
    direct POSTs send no authority and assert no status.
  - `environment-identity.spec.ts:25-53`: counts only
    `/app-identity/config.json` and `/auth/me`; the new GET is neither and
    `networkidle` waits for it.
  - `settings.spec.ts:107-127`, `flows/proof-of-send.spec.ts:19-37`: direct
    POSTs without an authority; assert only the welcome text.
  - `public-pages.spec.ts:228-288` (flyer submit): the flyer shows no select
    and keeps `capture_source: 'flyer'` + `unit_of_interest` (D5);
    `:343-358` (`/join`): the Atlanta default is sent and the thank-you
    assertions still hold (the new button text contains neither
    "Application fee" nor "Address"). Kept unchanged.
  - `scenarios/tenant-onboarding.spec.ts:179-197` + `e2e/scenarios/steps.ts`:
    the self-served contact now starts `onboarding`; the shared tail moves it
    to Searching through the edit form's Status select (no enforced transition
    graph); `findTenantContactIdByPhone` pages by type only
    (`steps.ts:4122-4147`). Stale note and docblock -> Task 5.2.
  - Exact-count audiences: the `/join` UI sign-ups now hold Atlanta Housing
    Authority, but every exact-count audience assertion in the suite uses a
    run-unique authority (`a2p-compliance.spec.ts:455-480`,
    `org-lists.spec.ts:322-358` and `:445-474`,
    `contacts-list-facets.spec.ts:47-52`) or a single seeded recipient
    (`matching-entry-points.spec.ts:149`, `partner-share.spec.ts:151`). The
    5.1 leads also use voucher 4 / none, outside the suite's 2-BR audiences.
- Lean seed: "Atlanta Housing Authority" and "DeKalb County Housing Authority"
  are housing_authority entries of the starting list
  (`app/src/lib/orgStartingList.ts:17` and `:34`) that `seedOrgListRow()` writes in
  both profiles (`app/src/lib/seed/lean.ts:531-536`, `app/src/lib/seed/orgList.ts:43-55`),
  and the preflight reseeds the lean world before every run
  (`e2e/support/preflight.ts:143-150`). No spec renames, merges or re-kinds
  either name (org-lists and the other org specs use run-unique names).

### 8. S5 - End-to-end coverage and the stale statements

Prerequisite: S1-S4 are committed. S5 tasks run in the order 5.1, 5.2, 5.3.

#### Lane rules for Tasks 5.1 and 5.2 (read once)

- All e2e runs go through the e2e workspace with ONE npm hop, so the file
  argument and `--grep` survive (the root `npm run e2e` is a double hop and
  eats them):
  `cd "W:/tmp/join-housing-authority" && npm run e2e -w @housingchoice/e2e -- <spec path(s)> [--grep "<title substring>"]`
  Run it from Git Bash (the Bash tool), bare - never piped.
- Boot a session first; a targeted run then reuses it (`e2e/playwright.config.ts`
  adopts the worktree's live session lane):
  1. If `W:/tmp/join-housing-authority/e2e/.artifacts/session.pid` exists, run
     `cd "W:/tmp/join-housing-authority" && npm run e2e:stop` first.
  2. Start the session in the BACKGROUND (Bash tool `run_in_background: true`):
     `cd "W:/tmp/join-housing-authority" && npm run e2e:session > .superpowers/sdd/e2e-session-s5.log 2>&1`
  3. Wait (up to 3 minutes) until
     `grep -n "web :" W:/tmp/join-housing-authority/.superpowers/sdd/e2e-session-s5.log`
     prints the launcher's readiness line.
- The preflight refuses a session booted at a different commit
  (`e2e/support/preflight.ts:87-128`), and it reseeds the lean world before
  every run. So: stop the session (`npm run e2e:stop`, exit 0) BEFORE each
  commit, and boot a fresh one at the start of the next task.
- Never edit app or dashboard source while a run is in flight. The 5.1 RED
  swap happens between runs.
- On an UNEXPECTED failure, copy `e2e/.artifacts/test-results` to
  `.superpowers/sdd/e2e-results-5.<task>-<n>/` BEFORE any re-run (Playwright
  clears it). There is no named-flake list: a failure is a regression to
  diagnose.

#### Task 5.1 - `/join` e2e: Atlanta default, "Sign up another person", Onboarding leads

Files:
- `e2e/tests/dashboard-next/public-pages.spec.ts` (edit; the file is ASCII)
- `e2e/support/selectors.md` (edit; pre-existing non-ASCII elsewhere - only
  the lines you add or change must be ASCII)

What it proves (spec section 6 E2E; D1, D5, D8, D9): on `/join` the select
shows Atlanta Housing Authority preselected; two people sign up in a row with
"Sign up another person"; the form comes back empty with consent unchecked,
focus on First name and the authority kept (the second person's non-default
choice survives the reset, which is what tells "kept" apart from "reset to the
default"); "Sign up another person" does not read the list again; each new
contact is an `onboarding` tenant holding its authority and the
`housing_fair_signup_v2` marker, read through the authenticated API. The
existing `/join` test (`public-pages.spec.ts:343-358`) is kept unchanged.

Step 1 - boot the lane (see "Lane rules").

Step 2 - edit `e2e/tests/dashboard-next/public-pages.spec.ts` with the Edit
tool, four edits.

Edit A (header list). old_string:

```
//   6. Unavailable - a bogus id and a non-shareable unit stay opaque; BOTH CTA
//      variants land somewhere (public -> /join, text -> a tap-to-text sms: CTA fed
//      by the opaque-404 body's contact_number).
```

new_string:

```
//   6. Unavailable - a bogus id and a non-shareable unit stay opaque; BOTH CTA
//      variants land somewhere (public -> /join, text -> a tap-to-text sms: CTA fed
//      by the opaque-404 body's contact_number).
//   7. `/join` housing authority (join-housing-authority spec D8/D9, 2026-10-12) -
//      the select defaults to Atlanta Housing Authority; two sign-ups in a row via
//      "Sign up another person" (an empty form, consent unchecked, the authority
//      KEPT, no second list read); each lead starts Onboarding holding its
//      authority, read through the authenticated contacts API.
```

Edit B (constants). old_string:

```
const NON_SHAREABLE_UNIT = 'unit-0001'; // seeded `under_application` -> opaque 404
```

new_string:

```
const NON_SHAREABLE_UNIT = 'unit-0001'; // seeded `under_application` -> opaque 404
// Two seeded housing authority NAMES (app/src/lib/seed/orgList.ts SEED_AUTHORITY;
// both reseed profiles write the starting list). No spec renames either, so the
// /join select always lists them.
const ATLANTA = 'Atlanta Housing Authority';
const DEKALB = 'DeKalb County Housing Authority';
```

Edit C (two helpers, between `fillIntake` and the describe). old_string:

```
  await page.getByRole('checkbox', { name: /I agree to receive/i }).check();
}

test.describe('Public pages - the unauthenticated full-info flyer + /join', () => {
```

new_string:

```
  await page.getByRole('checkbox', { name: /I agree to receive/i }).check();
}

/** The /join form as "Sign up another person" must leave it (spec D9): every
 *  person field blank and the consent box unchecked, exactly as on first load. */
async function expectEmptyIntake(page: Page): Promise<void> {
  await expect(page.getByLabel('First name')).toHaveValue('');
  await expect(page.getByLabel('Last name')).toHaveValue('');
  await expect(page.getByLabel('Phone number')).toHaveValue('');
  await expect(page.getByLabel(/Voucher size/)).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: /I agree to receive/i })).not.toBeChecked();
}

/** Read a contact through the AUTHENTICATED contacts API by its phone (the exact
 *  byPhone lookup returns the stored item). `request` MUST carry the staff
 *  session (pass `staff.request` after devLogin). Polls, like the flyer case. */
async function contactByPhone(
  request: APIRequestContext,
  phone: string,
): Promise<Record<string, unknown>> {
  let contact: Record<string, unknown> | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
        if (!res.ok()) return false;
        contact = ((await res.json()) as { contacts: Array<Record<string, unknown>> }).contacts[0];
        return contact !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return contact!;
}

test.describe('Public pages - the unauthenticated full-info flyer + /join', () => {
```

Edit D (the new test, right after the existing `/join` test). old_string:

```
    await expect(page.getByText('Application fee')).toHaveCount(0);
    await expect(page.getByText('Address')).toHaveCount(0);
  });
```

new_string:

```
    await expect(page.getByText('Application fee')).toHaveCount(0);
    await expect(page.getByText('Address')).toHaveCount(0);
  });

  test('/join: housing authority defaults to Atlanta, Sign up another person keeps the choice, each lead starts Onboarding', async ({
    page,
    request,
  }) => {
    // (a) The list read that feeds the select (spec D1), straight through the
    // proxy with no session: housing authority NAMES only, never cached.
    const listRes = await request.get(`${NEXT}/public/housing-authorities`);
    expect(listRes.status()).toBe(200);
    expect(listRes.headers()['cache-control'] ?? '').toContain('no-store');
    const { names } = (await listRes.json()) as { names: string[] };
    expect(names).toEqual(expect.arrayContaining([ATLANTA, DEKALB]));
    expect(names).not.toContain('Step Up'); // a seeded AGENCY - never offered

    // Count the PAGE's own list reads. D9: none on "Sign up another person"
    // after a good read. React StrictMode may double the FIRST read in this dev
    // build, so only "no growth after the first sign-up" is asserted.
    let listReads = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/public/housing-authorities') listReads += 1;
    });

    // (b) No session on `page` - the public /join form, as staff use it at a fair.
    await page.goto(`${NEXT}/join`);
    await expect(page.getByRole('heading', { name: /Find your next home/i })).toBeVisible();
    const authority = page.getByRole('combobox', { name: 'Housing authority' });
    await expect(authority).toBeVisible();
    await expect(authority).toBeEnabled(); // D8: disabled ("Loading...") until the list arrives
    // The shown choice is the selected option's TEXT (whatever its `value`).
    await expect(authority.locator('option:checked')).toHaveText(ATLANTA); // the D8 default
    await expect(page.getByText('The organization that runs your voucher.')).toBeVisible();
    await expect(authority.getByRole('option').last()).toHaveText('Not sure');
    await expect(authority.getByRole('option', { name: 'Choose one' })).toHaveCount(0);
    await expect(authority.getByRole('option', { name: 'Step Up', exact: true })).toHaveCount(0);

    // (c) Person 1 leaves the default alone.
    const firstPhone = uniquePhone();
    await fillIntake(page, { firstName: 'Fairfirst', lastName: 'Lead', phone: firstPhone, voucher: '4' });
    await page.getByRole('button', { name: 'Sign me up' }).click();
    await expect(page.getByRole('heading', { name: /you're signed up/i })).toBeVisible();
    const readsBeforeReset = listReads;
    expect(readsBeforeReset).toBeGreaterThan(0);

    // (d) "Sign up another person": an EMPTY form, focus on First name, and the
    // authority KEPT (D9).
    await page.getByRole('button', { name: 'Sign up another person' }).click();
    await expect(page.getByLabel('First name')).toBeFocused();
    await expectEmptyIntake(page);
    await expect(authority.locator('option:checked')).toHaveText(ATLANTA);

    // (e) Person 2 picks another listed authority.
    const secondPhone = uniquePhone();
    await fillIntake(page, { firstName: 'Fairsecond', lastName: 'Lead', phone: secondPhone });
    await authority.selectOption({ label: DEKALB });
    await page.getByRole('button', { name: 'Sign me up' }).click();
    await expect(page.getByRole('heading', { name: /you're signed up/i })).toBeVisible();

    // (f) The next form keeps DeKalb - the previous person's CHOICE, not the
    // Atlanta default - which is what tells "kept" apart from "reset".
    await page.getByRole('button', { name: 'Sign up another person' }).click();
    await expect(page.getByLabel('First name')).toBeFocused();
    await expectEmptyIntake(page);
    await expect(authority.locator('option:checked')).toHaveText(DEKALB);

    // (g) Each lead, read through the AUTHENTICATED contacts API from a separate
    // staff context: a new tenant in Onboarding holding its authority and the
    // post-change marker (D5), still attributed to the housing fair.
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const first = await contactByPhone(staff.request, firstPhone);
    expect(first).toMatchObject({
      type: 'tenant',
      status: 'onboarding',
      housingAuthority: ATLANTA,
      capture_source: 'housing_fair',
      housing_fair_signup_v2: true,
      firstName: 'Fairfirst',
      voucherSize: 4,
    });
    const second = await contactByPhone(staff.request, secondPhone);
    expect(second).toMatchObject({
      type: 'tenant',
      status: 'onboarding',
      housingAuthority: DEKALB,
      capture_source: 'housing_fair',
      housing_fair_signup_v2: true,
      firstName: 'Fairsecond',
    });
    // The voucher field really was cleared: person 2 sent none.
    expect(second['voucherSize']).toBeUndefined();
    await staff.close();

    // (h) D9: neither "Sign up another person" read the list again.
    expect(listReads).toBe(readsBeforeReset);
  });
```

Step 3 - edit `e2e/support/selectors.md` with the Edit tool. old_string
(three ASCII table rows):

```
| Public form | fields | `getByLabel('First name'|'Last name'|'Phone')` |
| Public form | submit | `getByRole('button', { name: 'Sign me up' })` |
| Public form | success | `getByText("Thanks, we'll text you!")` |
```

new_string (the `success` row was stale - that copy is not on either page):

```
| Public form | fields | `getByLabel('First name'|'Last name'|'Phone')` |
| Public form | submit | `getByRole('button', { name: 'Sign me up' })` |
| Public form | success | `/join`: `getByRole('heading', { name: /you're signed up/i })`; the flyer's in-place thank-you: `getByRole('heading', { name: /you're all set/i })` |
| Public form | housing authority (`/join` only) | `getByRole('combobox', { name: 'Housing authority' })` - a native select: pick with `selectOption({ label: '<name>' })`; read the shown choice with `.locator('option:checked')` + `toHaveText` (the visible name, whatever the option `value`). Disabled, showing `Loading...`, until the list arrives. The flyer form has no select |
| Public form | next sign-up (`/join` thank-you) | `getByRole('button', { name: 'Sign up another person' })` - returns an EMPTY form (consent unchecked) with focus on `First name` and the housing authority kept |
```

Step 4 - RED, for the stated reason. Show the test fails on the pre-change
`/join` page (no select). Swap ONLY the page component back to the branch's
cut point (19607658 = `git -C W:/tmp/join-housing-authority merge-base main HEAD`
until S6's sync); it renders the unchanged IntakeForm, whose new props are all
optional:

```
git -C W:/tmp/join-housing-authority restore --source=19607658 --worktree -- dashboard/src/routes/public/HousingFairIntake.tsx
cd "W:/tmp/join-housing-authority" && npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/public-pages.spec.ts --grep "housing authority defaults to Atlanta"
```

Expected: 1 failed. Step (a) passes (S1's route is live); the failure is at
`expect(authority).toBeVisible()` -
`getByRole('combobox', { name: 'Housing authority' })`, element(s) not found.
Any other failure point is NOT the stated reason: stop and diagnose. Then
restore the page and prove it is restored:

```
git -C W:/tmp/join-housing-authority restore --worktree -- dashboard/src/routes/public/HousingFairIntake.tsx
git -C W:/tmp/join-housing-authority status --short -- dashboard/src/routes/public/HousingFairIntake.tsx
```

The status command must print nothing.

Step 5 - GREEN, the whole file (the six existing cases plus the new one):

```
cd "W:/tmp/join-housing-authority" && npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/public-pages.spec.ts
```

Expected: 7 passed.

Step 6 - static checks, each bare:

```
cd "W:/tmp/join-housing-authority" && npm run typecheck -w @housingchoice/e2e
cd "W:/tmp/join-housing-authority" && npx eslint e2e/tests/dashboard-next/public-pages.spec.ts
git -C W:/tmp/join-housing-authority diff -U0 -- e2e/tests/dashboard-next/public-pages.spec.ts e2e/support/selectors.md | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c
```

Expected: exit 0, exit 0 (no errors - the repo's known lint errors are all
dashboard react-hooks), and `0` (every added line is ASCII).

Step 7 - stop the lane: `cd "W:/tmp/join-housing-authority" && npm run e2e:stop`
(exit 0).

Step 8 - commit.
1. Read `git -C W:/tmp/join-housing-authority status` on its own. Only the two
   files above may be modified; `HousingFairIntake.tsx` must NOT appear.
2. `git -C W:/tmp/join-housing-authority rev-parse -q --verify MERGE_HEAD`
   must print nothing (no merge in progress).
3. `git -C W:/tmp/join-housing-authority add -- e2e/tests/dashboard-next/public-pages.spec.ts e2e/support/selectors.md`
4. `git -C W:/tmp/join-housing-authority diff --cached --name-only` lists
   exactly those two paths (a commit takes the WHOLE index).
5. Commit:

```
git -C W:/tmp/join-housing-authority commit -m "test(e2e): /join housing authority select, Sign up another person, Onboarding leads" -m "Two sign-ups in a row on /join: the select defaults to Atlanta Housing Authority; Sign up another person returns an empty form with consent unchecked, focus on First name, the chosen authority kept and no second list read; each lead is an Onboarding tenant holding its authority and the housing_fair_signup_v2 marker (spec D1, D5, D8, D9). Adds the matching selector rows and fixes the stale public-form success row." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Task 5.2 - Self-serve scenario: the portal sends the housing authority; the lead starts Onboarding

Files:
- `e2e/scenarios/steps.ts` (edit; pre-existing non-ASCII - only added or
  changed lines must be ASCII)
- `e2e/tests/scenarios/tenant-onboarding.spec.ts` (edit; same rule)

What it changes: the tenant-onboarding diagram's "Tenant self-serves" path
used to verify name and voucher size only, because the portal POST had no
housing authority field (`tenant-onboarding.spec.ts:182-183`, stale). It now
sends `housingAuthority: 'Atlanta Housing Authority'` (an exact list name,
D3), asserts the lead starts at Onboarding (D5) through a new `expectOnboarding`
verb, and asserts the authority in the details. The `openSelfServedContact`
docblock's `status:needs_review` (`steps.ts:971`) becomes `status:onboarding`.
(PIN for D3/D5 at the scenario level: S2's app tests are the behavior's real
RED. On main this scenario fails: main's parser ignores the field and creates
`needs_review` - `app/src/routes/public.ts:94-139`, `:259` at 19607658 - so
`expectOnboarding` and the authority check both fail there. Step 4 below shows
the authority assertion bites on the current code with a temporary mutation.)

Step 1 - boot a fresh lane (Task 5.1 stopped it and committed, so HEAD moved).

Step 2 - edit `e2e/scenarios/steps.ts` with the Edit tool, three edits.

Edit A (the portal field). old_string:

```
  tenantSelfServes(t: Tenant, fields: {
    firstName: string;
    lastName: string;
    voucherSize?: number;
  }): Promise<void> {
```

new_string:

```
  tenantSelfServes(t: Tenant, fields: {
    firstName: string;
    lastName: string;
    voucherSize?: number;
    /** An exact organization-list name, as the /join select sends it
     *  (join-housing-authority D3); omit it for none, like "Not sure". */
    housingAuthority?: string;
  }): Promise<void> {
```

(The body already spreads `fields` into the POST data, so nothing else
changes there.)

Edit B (the new verb). old_string:

```
  expectParked(): Promise<void> {
    return step('App: tenant parked (on_hold)', () => this.assertStatus('on_hold'));
  }
```

new_string:

```
  expectParked(): Promise<void> {
    return step('App: tenant parked (on_hold)', () => this.assertStatus('on_hold'));
  }

  /** [App] A self-served /join sign-up starts the tenant at Onboarding, not at
   *  the Needs review front door (join-housing-authority D5, 2026-10-12). */
  expectOnboarding(): Promise<void> {
    return step('App: tenant starts at Onboarding', () => this.assertStatus('onboarding'));
  }
```

Edit C (the stale docblock line). old_string:

```
   * makes a `type:tenant, status:needs_review` contact (NOT an unknown), so resolve
```

new_string:

```
   * makes a `type:tenant, status:onboarding` contact (NOT an unknown; a /join
   * sign-up starts at Onboarding since join-housing-authority D5), so resolve
```

Step 3 - edit `e2e/tests/scenarios/tenant-onboarding.spec.ts` with the Edit
tool, two edits.

Edit A (the stale note and the portal call). old_string = lines 182-184
EXACTLY as the Read tool shows them. This plan is ASCII-only and cannot show
line 183 verbatim: it reads
`  // field on POST /public/housing-fair), so we verify those <U+2014 EM DASH> not housing authority.`
- copy the real character from the file. The three lines are:

```
  // The public self-serve portal captures name + voucher size (no housing-authority
  // field on POST /public/housing-fair), so we verify those <U+2014> not housing authority.
  await flow.tenantSelfServes(tenant, { firstName: 'Jamie', lastName: 'Lopez', voucherSize: 2 });
```

new_string:

```
  // The public self-serve portal is the /join form's endpoint, and it takes the
  // housing authority too (join-housing-authority D3, 2026-10-12): an exact
  // organization-list name. So the diagram's "full name, voucher size, and housing
  // authority" are all verified below, plus the Onboarding start (D5).
  await flow.tenantSelfServes(tenant, {
    firstName: 'Jamie',
    lastName: 'Lopez',
    voucherSize: 2,
    housingAuthority: 'Atlanta Housing Authority',
  });
```

Edit B (assert the start and the authority). old_string:

```
  await flow.openSelfServedContact(tenant);
  await flow.expectTypedTenant();
  await flow.expectTenantDetails({ firstName: 'Jamie', lastName: 'Lopez', voucherSize: 2 });
```

new_string:

```
  await flow.openSelfServedContact(tenant);
  await flow.expectTypedTenant();
  await flow.expectOnboarding();
  await flow.expectTenantDetails({
    firstName: 'Jamie',
    lastName: 'Lopez',
    voucherSize: 2,
    housingAuthority: 'Atlanta Housing Authority',
  });
```

Step 4 - RED (mutation), for the stated reason. Inside the
`flow.tenantSelfServes(tenant, { ... })` call ONLY, temporarily delete the line
`    housingAuthority: 'Atlanta Housing Authority',` (leave the one in
`expectTenantDetails`). That is the portal's only shape on main (no field).
Run:

```
cd "W:/tmp/join-housing-authority" && npm run e2e -w @housingchoice/e2e -- tests/scenarios/tenant-onboarding.spec.ts --grep "Tenant self-serves"
```

Expected: 1 failed, in step "App: tenant onboarding details captured" -
`expect(received).toBe(expected)`, expected "Atlanta Housing Authority",
received `undefined` (`expectOnboarding` passes first: D5 holds without an
authority). Put the deleted line back, and confirm with
`git -C W:/tmp/join-housing-authority diff -- e2e/tests/scenarios/tenant-onboarding.spec.ts`
that the call carries `housingAuthority` again.

Step 5 - GREEN: the whole scenario file (steps.ts changed under all six):

```
cd "W:/tmp/join-housing-authority" && npm run e2e -w @housingchoice/e2e -- tests/scenarios/tenant-onboarding.spec.ts
```

Expected: 6 passed.

Step 6 - the other specs that touch `/join` or `POST /public/housing-fair`
(expected unchanged and green; see "Decisions recorded without a task"), each
bare:

```
cd "W:/tmp/join-housing-authority" && npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/environment-identity.spec.ts tests/flows/proof-of-send.spec.ts
cd "W:/tmp/join-housing-authority" && npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/a2p-compliance.spec.ts --grep "public intake consent checkbox"
cd "W:/tmp/join-housing-authority" && npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/settings.spec.ts --grep "welcome-text edit reflects"
```

Expected: 3 passed (environment-identity 2, proof-of-send 1); 2 passed;
1 passed. A failure here is a regression this change caused until shown
otherwise - diagnose it; do not re-run it away.

Step 7 - static checks, each bare:

```
cd "W:/tmp/join-housing-authority" && npm run typecheck -w @housingchoice/e2e
cd "W:/tmp/join-housing-authority" && npx eslint e2e/scenarios/steps.ts e2e/tests/scenarios/tenant-onboarding.spec.ts
git -C W:/tmp/join-housing-authority diff -U0 -- e2e/scenarios/steps.ts e2e/tests/scenarios/tenant-onboarding.spec.ts | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c
```

Expected: exit 0, exit 0, `0`.

Step 8 - stop the lane: `cd "W:/tmp/join-housing-authority" && npm run e2e:stop`
(exit 0). No e2e session may be left running for S6's full suite.

Step 9 - commit.
1. Read `git -C W:/tmp/join-housing-authority status` on its own; only the two
   files above are modified.
2. `git -C W:/tmp/join-housing-authority rev-parse -q --verify MERGE_HEAD`
   prints nothing.
3. `git -C W:/tmp/join-housing-authority add -- e2e/scenarios/steps.ts e2e/tests/scenarios/tenant-onboarding.spec.ts`
4. `git -C W:/tmp/join-housing-authority diff --cached --name-only` lists
   exactly those two paths.
5. Commit:

```
git -C W:/tmp/join-housing-authority commit -m "test(e2e): self-serve scenario sends the housing authority and checks the Onboarding start" -m "The tenant-onboarding diagram's self-serve path now posts an exact list name as housingAuthority and asserts the lead starts at Onboarding (new expectOnboarding verb) holding it (join-housing-authority D3, D5). Replaces the stale notes that the portal had no housing authority field and created a needs_review contact." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Task 5.3 - Stale statements in the docs, the e2e launcher note, and the perf inventory check

Files:
- `documentation/STATUS-MODEL.md` (edit; pre-existing non-ASCII)
- `documentation/sequence-diagram-to-test.md` (edit; pre-existing non-ASCII)
- `scripts/e2e-session.mjs` (comment-only edit; pre-existing non-ASCII)

No e2e lane is needed (Task 5.2 stopped it).

Step 1 - RED (the stale statements are there). Each must print a hit:

```
grep -n "Every new contact lands here" W:/tmp/join-housing-authority/documentation/STATUS-MODEL.md
grep -n "status:needs_review" W:/tmp/join-housing-authority/documentation/sequence-diagram-to-test.md
```

And this must print nothing (the launcher does not yet say the list read has
its own limit):

```
grep -n "PUBLIC_LIST_RATE_LIMIT" W:/tmp/join-housing-authority/scripts/e2e-session.mjs
```

Also confirm the symbol the new comment cites exists (S1):
`grep -n "PUBLIC_LIST_RATE_LIMIT" W:/tmp/join-housing-authority/app/src/services/publicOrgList.ts`
must print its declaration.

Step 2 - `documentation/STATUS-MODEL.md`, two Edit-tool edits.

Edit A (the living document's date). old_string:

```
[GLOSSARY.md](GLOSSARY.md)). Last substantive update: **2026-06-19**.
```

new_string:

```
[GLOSSARY.md](GLOSSARY.md)). Last substantive update: **2026-10-12**.
```

Edit B (section 5, the Needs review bullet). old_string = lines 161-162
EXACTLY as the Read tool shows them; line 161 has one U+2014 EM DASH between
the bold label and `the single`, which this ASCII plan cannot show:

```
- **`Needs review`** <U+2014> the single front door. Every new contact lands here; there is
  no separate triage state and no `new` status.
```

new_string (all ASCII; the em dash becomes ` - `):

```
- **`Needs review`** - the front door. Auto-captured contacts land here (a text from
  an unknown number, a sign-up on a property's public flyer page `/p/:unitId`); there
  is no separate triage state and no `new` status. Two ways in start a tenant at
  **`Onboarding`** instead, because a person has said who the tenant is: a tenant
  staff create by hand, and (since 2026-10-12) a sign-up on the public `/join` form,
  which staff use at housing fairs and which also records the housing authority.
```

Step 3 - `documentation/sequence-diagram-to-test.md`, one Edit-tool edit
(line 110 only; line 108's em dash is untouched). old_string:

```
  secret) creates a `type:tenant, status:needs_review` contact + fires the welcome text.
```

new_string:

```
  secret) creates a `type:tenant, status:onboarding` contact holding the `housingAuthority`
  it is sent (an exact organization-list name; the `/join` form sends its select's choice,
  Atlanta Housing Authority by default) + fires the welcome text. A flyer sign-up (a body
  with a `unitId`) still creates a `needs_review` contact and may not carry a housing
  authority (400). Until 2026-10-12 every sign-up was `needs_review` with no authority.
```

Step 4 - `scripts/e2e-session.mjs`, one Edit-tool edit (comment only).
old_string:

```
  PUBLIC_RATE_LIMIT_MAX: process.env.PUBLIC_RATE_LIMIT_MAX ?? '100000',
```

new_string:

```
  PUBLIC_RATE_LIMIT_MAX: process.env.PUBLIC_RATE_LIMIT_MAX ?? '100000',
  // NOT raised by that variable: GET /public/housing-authorities (the /join
  // form's housing authority list) has its OWN hard-coded limit of 60 reads per
  // minute per IP (join-housing-authority spec D2; PUBLIC_LIST_RATE_LIMIT in
  // app/src/services/publicOrgList.ts) and no env override. The suite reads it a
  // handful of times (each /join load, doubled by React StrictMode in this dev
  // build, plus one raw read in public-pages.spec.ts), far under 60. A spec that
  // loads /join in a loop must stay under it: past it the read is a 429 and the
  // select offers only "Not sure" (the D8 failed state).
```

Step 5 - GREEN (each bare):

```
grep -n "Every new contact lands here" W:/tmp/join-housing-authority/documentation/STATUS-MODEL.md
grep -n "status:needs_review" W:/tmp/join-housing-authority/documentation/sequence-diagram-to-test.md
git -C W:/tmp/join-housing-authority grep -n "status:needs_review" -- e2e documentation
grep -n "PUBLIC_LIST_RATE_LIMIT" W:/tmp/join-housing-authority/scripts/e2e-session.mjs
cd "W:/tmp/join-housing-authority" && node --check scripts/e2e-session.mjs
git -C W:/tmp/join-housing-authority diff -U0 -- documentation/STATUS-MODEL.md documentation/sequence-diagram-to-test.md scripts/e2e-session.mjs | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c
```

Expected: no output (exit 1); no output (exit 1); no output (exit 1 - Task
5.2 replaced the steps.ts line); one hit; exit 0; `0`.

Step 6 - perf harness check (no edit; it proves the "no declaration needed"
decision and that S3 kept the dashboard mutation inventory parseable):

```
cd "W:/tmp/join-housing-authority" && npm run test -w @housingchoice/e2e -- performance/mutationCatalog.test.ts performance/redact.test.ts performance/routes.test.ts
```

Expected: exit 0. If `mutationCatalog.test.ts` fails with `unprovable_method`
or `unprovable_path` in `dashboard/src/routes/public/publicApi.ts`, the fix is
in S3's code, not the catalog: `getHousingAuthorities` must call `request` with
a literal path and an inline object literal for its options, and
`submitHousingFair` must keep `request<...>('/public/housing-fair', { method: 'POST', body })`.
Report it in the ledger as a QUESTION against Task 3.x before changing
anything.

Step 7 - commit.
1. Read `git -C W:/tmp/join-housing-authority status` on its own; only the
   three files above are modified.
2. `git -C W:/tmp/join-housing-authority rev-parse -q --verify MERGE_HEAD`
   prints nothing.
3. `git -C W:/tmp/join-housing-authority add -- documentation/STATUS-MODEL.md documentation/sequence-diagram-to-test.md scripts/e2e-session.mjs`
4. `git -C W:/tmp/join-housing-authority diff --cached --name-only` lists
   exactly those three paths.
5. Commit:

```
git -C W:/tmp/join-housing-authority commit -m "docs: a /join sign-up starts at Onboarding - STATUS-MODEL, sequence-diagram note, e2e list-read limit" -m "STATUS-MODEL's Needs review bullet no longer says every new contact lands there (staff-created tenants and /join sign-ups start at Onboarding); the self-serve portal note in sequence-diagram-to-test.md states the Onboarding start and the housingAuthority field; the e2e launcher records that the /join list read has its own hard-coded 60 per minute limit that PUBLIC_RATE_LIMIT_MAX does not raise (join-housing-authority D2, D5)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 9. S6 - Completion (Tasks 6.1-6.3)

CONTRACT ISSUES: none (written by the planner).

### 9. S6 - Completion

#### Task 6.1 - Sync main into the branch (ONCE)

Files: none (a merge commit).

1. Read the live state first:
   `git -C W:\tmp\join-housing-authority status` (must be clean) and
   `git -C W:\tmp\join-housing-authority fetch --all --prune` is NOT needed -
   main is a local branch in this repo; read it with
   `git -C W:\tmp\join-housing-authority log --oneline -1 main`.
2. `git -C W:\tmp\join-housing-authority rev-list --count HEAD..main` - the
   number of main commits the branch lacks. If 0, record "main already
   contained" in the ledger and skip to Task 6.2.
3. `git -C W:\tmp\join-housing-authority merge --no-ff main -m "Merge main into feat/join-housing-authority"`
   then append the trailer by amending ONLY if the merge needed no
   conflict resolution and the message lacks it:
   `git -C W:\tmp\join-housing-authority commit --amend --no-edit -m "Merge main into feat/join-housing-authority" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
4. On a conflict: preserve BOTH sides' intent. The likely overlaps are
   `app/src/routes/public.ts`, `app/src/app.ts`, `RUNBOOK.md`,
   `documentation/STATUS-MODEL.md` and `e2e/tests/dashboard-next/public-pages.spec.ts`
   (two other branches are active: fix/caseworker-integrity and the #3/#27
   work). Resolve with the Edit tool, `git add <explicit paths>`, check
   `.git/worktrees/join-housing-authority/MERGE_HEAD` exists, then
   `git commit` with the trailer. If a conflict touches a file this plan
   never edits, STOP and report QUESTION in the ledger.
5. If the merge brought dependency changes (`git diff HEAD~1 HEAD --name-only`
   lists a `package.json` or `package-lock.json`), run `npm install` from
   the worktree root before the gates.
6. This is the ONLY main sync. Later drift is reported in the handback, not
   chased.

#### Task 6.2 - The five completion gates (AGENTS.md), bare, from the worktree

Run each command BARE from `W:\tmp\join-housing-authority` (never piped,
never `;`-chained with another gate), capture its real exit code, and
record command + exit code + duration in the mission records
(`docs/superpowers/reviews/2026-10-12-join-housing-authority/gates.md`).
Do not edit dashboard or app source while gate 4 runs (the e2e lane serves
the source live).

1. `npm run typecheck` - expect exit 0.
2. `npm test` - expect exit 0. First check `env | grep '^AWS_'` (bash) or
   `Get-ChildItem Env:AWS_*` (PowerShell); if an AWS key is exported, run
   `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test` instead.
   DynamoDB Local must be up (`docker ps` shows it); do NOT restart it. On a
   red DynamoDB Local suite follow AGENTS.md "FIRST, if npm test is red":
   re-run the failing FILE alone more than once
   (`cd app; npx vitest run test/<file>`), run the same file at the merge
   base, compare failing FILES. Any `[dynamoAdmin]` line in the output is a
   real container fault: capture `err.$metadata.httpStatusCode` and
   `attempts` first.
3. `npm run smoke` - expect exit 0.
4. `npm run e2e` under a hard outer timeout (bash: `timeout 2700 npm run e2e`)
   - expect exit 0. Before it, confirm no listener survives on this lane's
   ports from an earlier aborted run (`e2e/README.md`). On a failure, COPY
   `e2e/.artifacts/test-results` to
   `.superpowers/sdd/e2e-results-<n>/` BEFORE any re-run (Playwright clears
   it). AGENTS.md has NO named-flake list: a failing spec is a regression
   to diagnose; re-run a single failing spec alone only to classify it, and
   report both runs.
5. Lint, scoped to the branch's own files:
   `git -C W:\tmp\join-housing-authority diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'`
   - If the list is EMPTY, SKIP the gate (never run `npx eslint` with no
     paths - that lints the whole repo).
   - Else run `npx eslint <those paths>` from the worktree root. Exit 0 =
     done. On errors, attribute them by BASELINE: run the same command on
     the same paths at the merge base (`git merge-base main HEAD`, in a
     throwaway detached worktree under `W:\tmp\`) and diff the outputs;
     anything new is BLOCKING and is fixed; pre-existing errors are left
     and NAMED in the handback. A `.mjs`/`.js` path lints NOTHING (the
     config covers `.ts`/`.tsx` only) - do not read its green as a pass.

#### Task 6.3 - Handback

Write `docs/superpowers/reviews/2026-10-12-join-housing-authority/handback.md`
(ASCII; captured tool output verbatim) and commit it with `gates.md`:

- per-spec-decision table (D1-D11): delivered by which task/commit, test
  that proves it;
- the five gate commands with their real exit codes and the final commit
  sha they ran on;
- the live self-QA result (an `npm run e2e:session` lane STARTED AFTER the
  last code commit - `e2e/support/preflight.ts` refuses a session started
  at a different commit - driven with the
  Playwright MCP: `/join` shows the select with Atlanta preselected; two
  sign-ups in a row via "Sign up another person"; each contact is
  Onboarding with the authority on the dashboard; the flyer page `/p/<id>`
  shows no select); screenshots under `.playwright-mcp/`;
- the backfill rehearsal on that lane (`--env local --lane <L>`, dry run
  then `--apply`, with pre-change-shaped leads written directly), its
  output verbatim;
- main drift since the sync (`git rev-list --count HEAD..main`);
- owed operator actions: the RUNBOOK backfill entry (dev then prod, after
  the deploy); nothing else (no Terraform, secrets, schema or env change);
- anything filed in `docs/issues/`.

Then append `STATUS: DONE` to the ledger. Do NOT merge.
