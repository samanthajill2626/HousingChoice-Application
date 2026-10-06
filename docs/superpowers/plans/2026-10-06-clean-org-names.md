# Implementation plan - clean housing authority and agency names (branch A)

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  (revision 5, APPROVED by Cameron 2026-10-06). This plan builds BRANCH A
  only. Branch B (caseworkers, spec D16-D21) gets its own plan after this
  branch merges; nothing in this plan implements D16-D21.
- Branch `feat/clean-org-names`, worktree `W:\tmp\clean-org-names`, cut from
  main @d839494a. Mission records:
  `docs/superpowers/reviews/2026-10-06-clean-org-names/`.
- Status: PLAN DRAFT (planner) - pending adversarial plan review.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for the
  stated reason), implement, run it GREEN, commit. One commit per task unless
  the task says otherwise. A case marked (PIN) is a regression pin that is
  already green on unchanged code - write it, confirm it passes, keep it;
  every task still has at least one real RED case.
- Commits: `git status` first (a separate read), explicit paths only (never
  `git add -A`), ASCII message ending with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the authoring
  model's name).
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for new files;
  for edited files check the added lines of `git diff`.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit tool DECODES `\u` escapes - never type a `\u`
  escape through it.
- The Bash tool truncates a single command near 10 KB: write files with the
  Write tool, never with a long heredoc.
- Run commands with absolute paths (`cd "W:/tmp/clean-org-names/app"` etc.);
  the shell's working directory resets between calls.
- Setup once: `cd "W:/tmp/clean-org-names"; npm ci`. DynamoDB Local:
  `npm run db:start` (a START of a stopped container is fine). NEVER restart,
  stop or remove the shared DynamoDB Local container - it holds Cameron's
  local dev data. If it misbehaves, stop and report.
- Unit runs while building: app `cd "W:/tmp/clean-org-names/app"; npx vitest
  run test/<file>`; dashboard `cd "W:/tmp/clean-org-names/dashboard"; npx
  vitest run src/<path>`; typecheck `cd "W:/tmp/clean-org-names"; npm run
  typecheck`. Never pipe a gate command.
- e2e only through `npm run e2e` from the worktree root (or the lane session
  scripts). Never edit dashboard/app source while that worktree's e2e runs
  (the lane serves source live). Never touch Cameron's live ports
  (:5174/:8080).
- No agent runs the cleanup script against dev or prod - lanes only
  (`--env local --lane <L>`).

## 1. Global constraints (verbatim from the spec)

| name | value |
|---|---|
| store | ONE `settings` table item, `settingId: 'org-list'`; NO new table, NO Terraform |
| item fields | `version`, `entries[]` (`orgId`, `kind`, `name`, `spellings`, `notes?`, `createdAt/By`, `updatedAt/By`), `lastRewrite?` (spec 5.1) |
| kinds | `'housing_authority'` and `'agency'` |
| caching | NONE - every reader does one consistent GetItem |
| first read | creates the starting list with a create-only condition; seeds write it with an UNCONDITIONAL put |
| records store | the entry's exact NAME text (never an id) |
| on the list (D3) | value is character-for-character the name of an entry of a kind the field accepts |
| normalization (D4) | lowercase; `&` -> ` and `; `. , ( ) - / ' " _` -> space; collapse whitespace; trim |
| ambiguity | counted within the field's kinds; shared spellings only within ONE kind |
| COMPOUND (D4) | not an exact name/spelling AND >= 2 longest-first non-overlapping spans with no single entry matched by every span |
| limits (D13) | name <= 120 chars; notes <= 500; <= 20 spellings per entry, each <= 120 chars; item <= 300 KB (`org_list_full`) |
| write check (D5) | only values that CHANGE; `housingAuthority: ''` REMOVEs; `agency: ''` stored; list members already held (or equal to legacy `jurisdiction`) pass |
| write error | HTTP 422 `{ error: 'org_not_on_list', field, text, candidates, close, otherKind?, compound? }` |
| admin-only | spellings edit, rename, merge, delete, kind change, all "Not on the list" actions, Run again (`requireRole('admin')`) |
| everyone | view all three Settings sections (incl. "Not on the list" + records), add (name + notes), edit notes |
| rewrite lock | one rewrite at a time; 409 `org_rewrite_running` while `lastRewrite.status === 'running'` and heartbeat < 15 min; cleanup takes the lock as action `cleanup`, never offered "Run again" |
| rewrite job | base-table reads (all contact types + deleted, all units + deleted); conditional per record; REMOVE housingAuthority on clear; dedupe unit lists; NEVER stamp unit `updated_at`; audit `org_name_rewrite` per record; never touches broadcasts |
| merge | moves name + ALL spellings to the target; refused 409 `org_spellings_full` if a cap would break |
| AI | system prompt static; list block in USER content; `orgListFingerprint` per run; block budget 16,000 chars (drop spellings, then agency names, then HA names; WARN); agency in HA field -> drop reason `agency_not_authority` |
| accept value | optional `value`; allowed only = D4 resolution of the suggestion text or one of its candidates; else 422 `value_not_from_suggestion`; re-accept with a different value -> 409 `suggestion_already_resolved` |
| importer | contact HA via `if_not_exists`; agency written when absent; unknown/ambiguous not written, reported |
| drafts | preview and a filter-resolved send re-check `audience_filter.housing_authority`; the curated send is not re-checked |
| intake rule | `agency` counts as an intake fact (missedCallAutoText) + Settings > Templates hint |
| dev seam | `POST /__dev/org-fixture` (local stacks only) writes run-unique off-list values onto spec-created records |
| help text | under Housing authority: `The organization that runs the voucher` |

Things this branch must NOT do: add a table, a GSI, an env var or Terraform;
cache the list; store org ids on records; rewrite broadcasts; let the AI add
names or fill Agency; touch caseworker features (branch B); deploy anything;
run the cleanup against dev or prod.

## 2. Work map

| slice | what | main files |
|---|---|---|
| S1 rules | pure matching rules + starting list | `app/src/lib/orgNames.ts`, `app/src/lib/orgStartingList.ts` |
| S2 store | the `org-list` settings item: get (lazy create-only seed), read-and-bump mutate, seed put, size guard | `app/src/repos/orgListRepo.ts` |
| S3 services | write checks against the stored list; list operations; record iteration, usage, "Not on the list"; rewrite lock + start/run-again | `app/src/services/orgNames.ts`, `app/src/services/orgRecords.ts`, `app/src/services/orgRewrite.ts`; new repo writers on `contactsRepo` / `unitsRepo` |
| S4 rewrite job | the `org.rewrite` job handler + registration | `app/src/jobs/orgRewrite.ts`, `app/src/worker.ts` (+ in-process wiring) |
| S5 API | `/api/organizations` router + composition-root wiring | `app/src/routes/organizations.ts`, `app/src/routes/api.ts` |
| S6 writers | D5 on contacts PATCH, units POST/PATCH, broadcasts POST/preview/filter-send | `app/src/routes/contacts.ts`, `units.ts`, `broadcasts.ts` |
| S7 AI | list block in user content, fingerprint, apply-layer resolution, agency drop reason, accept `value` | `app/src/services/extraction/*`, `app/src/jobs/extraction.ts`, `app/src/routes/suggestions.ts`, `app/src/services/suggestionResolution.ts`, repo |
| S8 importer | D9 contact + unit sides, report | `app/src/lib/import/apply.ts` |
| S9 intake rule | D15 | `app/src/jobs/missedCallAutoText.ts`, `TemplatesSection.tsx`, issue doc |
| S10 retire old lists (app) | remove the app's two hand-kept lists once S7/S8 no longer import them (the dashboard's `orgVocabulary.ts` goes in S11's tenant-form task, its only consumer) | `app/src/lib/housingAuthority.ts`, `app/src/services/extraction/schema.ts` |
| S11 dashboard | API layer + hook; OrgPicker + "Is this really new?"; tenant/property forms; composer; suggestion accept; Settings tab (lists + Not on the list); activity labels | `dashboard/src/...` |
| S12 seeds | list names everywhere + the `org-list` put | `app/src/lib/seed/*`, `devReset.ts` |
| S13 dev seam | `POST /__dev/org-fixture` | `app/src/routes/dev.ts` |
| S14 e2e | update pinned specs; new specs | `e2e/...` |
| S15 cleanup script | `clean-org-names.ts` + tests + RUNBOOK | `app/scripts/...`, `RUNBOOK.md` |
| S16 docs | glossary, issues | `documentation/GLOSSARY.md`, `docs/issues/` |
| S17 final | main sync + the five gates + handback | - |

Order: S1 -> S2 -> S3 -> S4 -> S5 -> S6 -> S7 -> S8 -> S9 -> S10 -> S12 ->
S13 -> S11 -> S14 -> S15 -> S16 -> S17. S10 (retiring the old lists) runs only
after S6-S9 stopped importing them. S12 (seeds) lands before S11/S14 so the
dashboard work and the e2e world use list names. Between S6 and S12 the unit
suites that seed slugs are updated in the task that breaks them (each task
names its test fallout); nothing deploys mid-branch, so the branch is judged
at S17.

## 3. Interfaces (BINDING for every slice)

Every slice uses these names and shapes exactly. A slice that needs a
different shape stops and reports - it never invents a parallel one.

### 3.1 New files

- `app/src/lib/orgNames.ts`, `app/src/lib/orgStartingList.ts` (S1)
- `app/src/repos/orgListRepo.ts` (S2)
- `app/src/services/orgNames.ts` (S3 - checks and list operations)
- `app/src/services/orgRecords.ts` (S3 - record iteration, usage, Not on the
  list, record rewrites shared by the job and the cleanup script)
- `app/src/services/orgRewrite.ts` (S3 - the lock, start, run-again)
- `app/src/jobs/orgRewrite.ts` (S4)
- `app/src/routes/organizations.ts` (S5)
- `app/src/services/extraction/orgListBlock.ts` (S7)
- `app/scripts/clean-org-names.ts` (S15)
- `dashboard/src/routes/orgs/useOrgList.ts`, `OrgPicker.tsx`,
  `NewOrgDialog.tsx`, `orgCopy.ts` (S11)
- `dashboard/src/routes/settings/OrgListSection.tsx`,
  `OrgEntryDialogs.tsx`, `NotOnListSection.tsx`, `useOrgAdmin.ts` (S11)
- `e2e/fixtures/orgFixture.ts`, `e2e/tests/dashboard-next/org-lists.spec.ts`
  (S14)

### 3.2 Shared app types (in `app/src/lib/orgNames.ts` unless noted)

S1 defines `OrgKind`, `OrgEntry`, `OrgField`, `KINDS_FOR_FIELD`, `OrgRef`,
`OrgNotOnList`, `OrgResolution`, `ScalarCheck`, `ListCheck`, `NameProblem`,
`SpellingProblem` and the limits. Added in S2 (`orgListRepo.ts`):

```ts
export type OrgRewriteAction =
  | 'rename' | 'merge' | 'use' | 'move_to_agency'
  | 'move_to_housing_authority' | 'split' | 'clear' | 'cleanup';

/** The record fields a rewrite may touch (branch A). */
export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities';

export interface OrgRewriteState {
  jobId: string;
  action: OrgRewriteAction;
  /** Stored texts to rewrite, compared NORMALIZED (D4) by the job. */
  fromTexts: string[];
  /** The one field a value action targets; absent for rename/merge (all fields of the kind). */
  field?: OrgRecordField;
  toName?: string;
  /** Split only: the agency half. */
  agencyName?: string;
  status: 'running' | 'done' | 'failed';
  heartbeatAt: string;
  counts?: Record<string, number>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  startedBy: string;
}

export interface OrgListItem {
  settingId: 'org-list';
  version: number;
  entries: OrgEntry[];
  lastRewrite?: OrgRewriteState;
}

export const ORG_LIST_SETTING_ID = 'org-list';
export const ORG_LIST_MAX_BYTES = 300 * 1024;
export const ORG_REWRITE_STALE_MS = 15 * 60 * 1000;
```

### 3.3 Repo API (S2)

```ts
export class OrgListFullError extends Error {}   // item would exceed ORG_LIST_MAX_BYTES
export class OrgListBusyError extends Error {}   // lost the version race 5 times

export interface OrgListRepo {
  /** One consistent GetItem. Absent item: create the starting list with a
   *  create-only put (attribute_not_exists), then return the stored item
   *  (re-read on a lost create). Never caches. */
  get(): Promise<OrgListItem>;
  /** Read-and-bump: read (as get()), run `change`, write the result
   *  conditionally on `version = :expected` with version + 1; retry the whole
   *  cycle on a lost condition, at most 5 attempts (then OrgListBusyError).
   *  Refuses (OrgListFullError) when the serialized item exceeds the cap.
   *  `change` may throw a domain error, which propagates unchanged. */
  mutate<T>(change: (current: OrgListItem) => { next: OrgListItem; result: T }): Promise<T>;
  /** Seeds and tests only: unconditional put of a whole item. */
  putForSeed(item: OrgListItem): Promise<void>;
  /** NON-creating consistent read (the importer CLI and the cleanup script):
   *  the stored item, or null when absent. Callers fall back to
   *  buildStartingEntries() in memory and never write. */
  peek(): Promise<OrgListItem | null>;
}

export function createOrgListRepo(
  deps?: RepoDeps & { now?: () => string; newId?: () => string },
): OrgListRepo;
```

### 3.4 Service APIs (S3)

`app/src/services/orgNames.ts`:

```ts
export class OrgHttpError extends Error {
  constructor(readonly status: number, readonly body: { error: string } & Record<string, unknown>) {
    super(body.error);
  }
}

export interface OrgNamesService {
  read(): Promise<OrgListItem>;
  /** D5 helpers bound to the stored list (one read per call). */
  checkScalar(field: OrgField, next: string, current: string | undefined): Promise<ScalarCheck>;
  checkList(
    field: OrgField,
    next: readonly string[],
    current: readonly string[] | undefined,
    legacyJurisdiction: string | undefined,
  ): Promise<ListCheck>;
  /** POST /check. */
  check(input: { kind: OrgKind; text: string; spellingFor?: string }): Promise<OrgCheckResult>;
  add(input: { kind: OrgKind; name: string; notes?: string; actor: string }): Promise<OrgEntry>;
  updateNotes(orgId: string, notes: string, actor: string): Promise<OrgEntry>;
  updateSpellings(orgId: string, spellings: string[], opts: { confirmShared: boolean; actor: string }): Promise<OrgEntry>;
  changeKind(orgId: string, kind: OrgKind, actor: string): Promise<OrgEntry>;
  remove(orgId: string, actor: string): Promise<void>;
}

export interface OrgCheckResult {
  match?: OrgRef;
  candidates: OrgRef[];
  close: OrgRef[];
  otherKind?: OrgRef[];
  compound?: OrgRef[][];
  /** Set when the text is not acceptable as a NEW name (D13). */
  nameProblem?: NameProblem['code'];
  /** Set when `spellingFor` was given: null = can be remembered. */
  spellingProblem?: SpellingProblem['problem'] | null;
}
```

`app/src/services/orgRecords.ts` (record access shared by the routes, the job
and the cleanup script):

```ts
export type HolderRecord =
  | { kind: 'contact'; contactId: string; name: string | null; type: string; deleted: boolean }
  | { kind: 'unit'; unitId: string; address: string | null; deleted: boolean };

export interface NotOnListResolution {
  status: OrgResolution['status'];
  match?: OrgRef;          // status 'match': the value resolves to one entry but is not its exact name
  candidates?: OrgRef[];   // status 'ambiguous'
  otherKind?: OrgRef[];    // status 'other_kind'
  compound?: OrgRef[][];   // status 'compound'
  close?: OrgRef[];        // status 'unknown'
}

export interface NotOnListRow {
  field: OrgRecordField;
  value: string;
  count: number;          // active records
  deletedCount: number;   // deleted records
  resolution: NotOnListResolution;
}

export interface OrgUsage {
  /** orgId -> counts of records whose field of the entry's kind holds the exact name. */
  [orgId: string]: { tenants: number; otherContacts: number; properties: number; deleted: number };
}

export interface OrgRecordsService {
  usage(entries: readonly OrgEntry[]): Promise<OrgUsage>;
  notOnList(entries: readonly OrgEntry[]): Promise<NotOnListRow[]>;
  holders(field: OrgRecordField, value: string): Promise<HolderRecord[]>;
  /** Rewrite every record (all contact types and units, active and deleted)
   *  per the definition; conditional per record; audits each write with
   *  `auditType` ('org_name_rewrite' for the job, 'org_name_cleanup' for the
   *  script); calls `heartbeat` at most every 20 s; returns counts. */
  rewrite(
    def: OrgRewriteState,
    opts: { auditType: 'org_name_rewrite' | 'org_name_cleanup'; actor?: string; heartbeat?: () => Promise<void> },
  ): Promise<Record<string, number>>;
}
```

`app/src/services/orgRewrite.ts` (the D11 lock and the actions that start a
rewrite; every method throws `OrgHttpError` for its refusals):

```ts
export interface OrgRewriteService {
  rename(orgId: string, newName: string, actor: string): Promise<{ entry: OrgEntry; lastRewrite: OrgRewriteState; skippedSpellings: SkippedSpelling[] }>;
  merge(orgId: string, intoOrgId: string, actor: string): Promise<{ lastRewrite: OrgRewriteState }>;
  resolveNotOnList(input: {
    field: OrgRecordField;
    value: string;
    action: 'use' | 'move_to_agency' | 'move_to_housing_authority' | 'split' | 'add' | 'clear';
    name?: string;
    agencyName?: string;
    rememberSpelling?: boolean;
    actor: string;
  }): Promise<{ lastRewrite: OrgRewriteState; skippedSpellings: SkippedSpelling[] }>;
  runAgain(actor: string): Promise<{ lastRewrite: OrgRewriteState }>;
  /** For the job and the cleanup script. */
  heartbeat(jobId: string): Promise<void>;
  finish(jobId: string, outcome: { status: 'done' | 'failed'; counts?: Record<string, number>; error?: string }): Promise<void>;
  /** Cleanup script: take the lock as action 'cleanup' (409 when held). */
  acquireForCleanup(actor: string): Promise<OrgRewriteState>;
}

export interface SkippedSpelling { spelling: string; problem: SpellingProblem['problem'] }
```

### 3.5 HTTP error table (bodies are `{ error: code, ...extras }`)

| code | status | extras | raised by |
|---|---|---|---|
| `org_not_on_list` | 422 | `field, text, candidates, close, otherKind?, compound?` | D5 on every writer |
| `org_name_empty` / `org_name_too_long` / `org_name_invalid` | 400 | - | add, rename, Add as new (`invalid` = a newline or control character) |
| `org_notes_too_long` | 400 | - | add, notes edit |
| `org_name_taken` | 409 | `entry: OrgRef` | add, rename, Add as new |
| `org_name_compound` | 409 | `spans: OrgRef[][]` | add, rename, Add as new |
| `org_spelling_refused` | 409 | `spelling, problem, entries?` | admin spelling edit (any problem except `shared_same_kind`) |
| `org_spelling_shared` | 409 | `spelling, entries` | admin spelling edit without `confirmShared` |
| `org_spellings_full` | 409 | - | merge transfer or a spelling edit past 20 |
| `org_in_use` | 409 | `uses: { active: number, deleted: number }` | delete, kind change |
| `org_not_found` | 404 | - | any `:orgId` route |
| `org_rewrite_running` | 409 | `lastRewrite` | rename, merge, resolve, run-again, cleanup apply |
| `org_list_full` | 409 | - | any list write past 300 KB |
| `org_list_busy` | 503 | - | `OrgListBusyError` |
| `value_not_from_suggestion` | 422 | - | suggestion accept with a bad `value` |
| `suggestion_already_resolved` | 409 | - | (existing) re-accept with a different `value` |

Names and spellings with a newline or other control character are refused
(`org_name_invalid`; for spellings, `org_spelling_refused` with problem
`invalid`) - S1 Task 1.4's checks gain this rule in S3 Task 3.1's first step
(the S1 functions stay as written; the service checks control characters
before calling them).

### 3.6 Endpoints (S5; signed-in staff unless marked ADMIN)

- `GET /api/organizations` -> `{ version, entries, lastRewrite? }`
- `GET /api/organizations/usage` -> `{ usage: OrgUsage }`
- `GET /api/organizations/not-on-list` -> `{ rows: NotOnListRow[] }`
- `GET /api/organizations/not-on-list/records?field=&value=` -> `{ records: HolderRecord[] }`
- `POST /api/organizations/check` `{ kind, text, spellingFor? }` -> `OrgCheckResult`
- `POST /api/organizations` `{ kind, name, notes? }` -> 201 `{ entry }`
- `PATCH /api/organizations/:orgId` `{ notes }` -> `{ entry }`; ADMIN `{ spellings, confirmShared? }` -> `{ entry }`; ADMIN `{ name }` -> 202 `{ entry, lastRewrite, skippedSpellings }`; ADMIN `{ kind }` -> `{ entry }`. Exactly one of the four keys per request (400 `one_change_per_request` otherwise).
- ADMIN `POST /api/organizations/:orgId/merge` `{ intoOrgId }` -> 202 `{ lastRewrite }`
- ADMIN `DELETE /api/organizations/:orgId` -> 204
- ADMIN `POST /api/organizations/not-on-list/resolve` `{ field, value, action, name?, agencyName?, rememberSpelling? }` -> 202 `{ lastRewrite, skippedSpellings }`
- ADMIN `POST /api/organizations/rewrite/run-again` -> 202 `{ lastRewrite }` (409 `org_rewrite_not_rerunnable` for action `cleanup` or when nothing failed or stalled)

### 3.7 New repo writers (S3; they break typed fakes - update every fake in the same task)

```ts
// contactsRepo
rewriteOrgFields(
  contactId: string,
  expect: { housingAuthority?: string | null; agency?: string | null },   // null = attribute absent
  next: { housingAuthority?: string | null; agency?: string },           // housingAuthority null = REMOVE
): Promise<'written' | 'skipped'>;   // 'skipped' = condition lost (the record changed)

// unitsRepo - NEVER stamps updated_at (the importer's ownership signal)
rewriteAcceptedAuthorities(
  unitId: string,
  expected: string[] | null,   // null = attribute absent; else whole-list equality
  next: string[],
): Promise<'written' | 'skipped'>;
```

### 3.8 Audit

`audit.append('contacts#<id>' | 'units#<id>', 'org_name_rewrite', { field, from, to, action, actor })`
for the job; `'org_name_cleanup'` with `{ field, from, to }` (no actor) for
the script. Dashboard labels (property Activity tab,
`dashboard/src/routes/listing/listingFormat.ts`): `org_name_rewrite` ->
"Housing authority updated", `org_name_cleanup` -> "Housing authority cleaned
up", each with a `from -> to` detail line.

### 3.9 Jobs

`export const ORG_REWRITE_JOB = 'org.rewrite'`, payload `{ jobId: string }`.
- The rewrite id is minted by `orgRewrite.ts` with `randomUUID()` BEFORE the
  list write, stored as `lastRewrite.jobId` and carried in the payload - never
  the jobs envelope id (the envelope id exists only after enqueue).
- The handler reads `lastRewrite`; it does nothing unless `lastRewrite.jobId
  === payload.jobId` and `status === 'running'`.
- The handler catches its own errors, records `failed` with the counts so far,
  and NEVER rethrows (a rethrow would make SQS redeliver up to 5 times).
- `heartbeat` and `finish` are read-and-bump writes that first check
  `lastRewrite.jobId` is still the caller's and otherwise do nothing, so a
  duplicate or stale run can never overwrite a newer rewrite's state.
- Register the handler in `registerAllJobHandlers` and add `org.rewrite` to the
  pinned name list in `app/test/registerHandlers.test.ts`.

### 3.10 AI (S7)

- `renderOrgListBlock(entries, opts?: { budget?: number }): { text: string; fingerprint: string; dropped: { spellings: number; agencies: number; authorities: number } }`
  (`budget` default 16_000). The text starts with the line
  `ORGANIZATION LIST` and never contains the word `TRANSCRIPT`; every name and
  spelling is rendered on one line. `fingerprint` = sha256 hex of `text`.
- `ExtractionInput` gains `orgListBlock: string`; the run draft gains
  `orgListFingerprint: string`; the apply context gains
  `orgEntries: readonly OrgEntry[]`.
- `DROP_REASONS` gains `'agency_not_authority'`; dashboard label map entry
  `agency_not_authority: 'Agency, not a housing authority'`, rendered as the
  label plus the model's reason when both exist.
- Suggestion accept body gains `value?: string`. The completed journal row
  gains `valueKey?: string` = sha256 hex of the accepted value, absent when no
  value was sent. A re-accept compares `valueKey` (absent equals absent).
- The run detail header shows `orgListFingerprint` beside "Prompt
  fingerprint". System Status is unchanged.

### 3.11 Dashboard API (S11)

`dashboard/src/api/types.ts` mirrors 3.2-3.6; `dashboard/src/api/endpoints.ts`
gains `getOrgList`, `getOrgUsage`, `getNotOnList`, `getNotOnListRecords`,
`checkOrgText`, `addOrg`, `patchOrg`, `mergeOrg`, `deleteOrg`,
`resolveNotOnList`, `runOrgRewriteAgain`, and `acceptSuggestion(..., value?)`.
Every new code in 3.5 gets copy in the error-copy map and its parity test.
`useOrgList()` returns `{ entries, version, lastRewrite, loading, error, reload }`.
Labels "Housing authority", "Housing authorities" and "Agency" stay exactly as
today (unit tests and e2e select by them).

### 3.12 Dev seam (S13)

`POST /__dev/org-fixture` `{ contactId?, unitId?, field, value }` -> `{ ok: true }`:
writes the raw value bypassing D5 (contact: SET the field; unit: append the
value to `accepted_authorities`). Mounted only where the other `/__dev`
fixtures mount.

---

## S1 - the matching rules (pure; `app/src/lib/orgNames.ts`, `app/src/lib/orgStartingList.ts`, tests `app/test/orgNames.test.ts`, `app/test/orgStartingList.test.ts`)

Everything in this slice is pure TypeScript with no I/O. Every later slice
imports from it. Read spec D3, D4, D5, D12, D13 and Appendix A first.

### Task 1.1 - types, normalization, exact on-list check

RED: create `app/test/orgNames.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  normalizeOrgText,
  isOnListFor,
  KINDS_FOR_FIELD,
  type OrgEntry,
} from '../src/lib/orgNames.js';

export function entry(partial: Partial<OrgEntry> & Pick<OrgEntry, 'name' | 'kind'>): OrgEntry {
  return {
    orgId: `id-${partial.name}`,
    spellings: [],
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'test',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'test',
    ...partial,
  };
}

const ATLANTA = entry({
  kind: 'housing_authority',
  name: 'Atlanta Housing Authority',
  spellings: ['AHA', 'Atlanta Housing', 'Atlanta (AHA)'],
});
const AUGUSTA = entry({ kind: 'housing_authority', name: 'Augusta Housing Authority', spellings: ['AHA'] });
const DCA = entry({
  kind: 'housing_authority',
  name: 'Georgia Department of Community Affairs',
  spellings: ['DCA', 'Georgia DCA'],
});
const VASH = entry({
  kind: 'agency',
  name: 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)',
  spellings: ['HUD-VASH', 'VASH'],
});
const STEP_UP = entry({ kind: 'agency', name: 'Step Up' });
const LIST = [ATLANTA, AUGUSTA, DCA, VASH, STEP_UP];

describe('normalizeOrgText', () => {
  it('lowercases, folds punctuation and underscores to spaces, collapses whitespace', () => {
    expect(normalizeOrgText('  Atlanta (AHA) ')).toBe('atlanta aha');
    expect(normalizeOrgText('atlanta_housing')).toBe('atlanta housing');
    expect(normalizeOrgText('HUD-VASH')).toBe('hud vash');
    expect(normalizeOrgText('Hope & Help, Inc.')).toBe('hope and help inc');
    expect(normalizeOrgText('St. Mary\'s / "Home"')).toBe('st mary s home');
  });
  it('returns an empty string for blank input', () => {
    expect(normalizeOrgText('   ')).toBe('');
  });
});

describe('isOnListFor (spec D3: exact text, right kind)', () => {
  it('is true only for a character-for-character name of an accepted kind', () => {
    expect(isOnListFor(LIST, 'Atlanta Housing Authority', ['housing_authority'])).toBe(true);
    expect(isOnListFor(LIST, 'atlanta housing authority', ['housing_authority'])).toBe(false);
    expect(isOnListFor(LIST, 'AHA', ['housing_authority'])).toBe(false);
    expect(isOnListFor(LIST, 'Step Up', ['housing_authority'])).toBe(false);
    expect(isOnListFor(LIST, 'Step Up', ['agency'])).toBe(true);
  });
  it('maps every field to its kinds', () => {
    expect(KINDS_FOR_FIELD.housingAuthority).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.accepted_authorities).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.audience_filter).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.agency).toEqual(['agency']);
  });
});
```

(The `entry` helper and the fixtures stay at the top of the file; later tasks
append `describe` blocks that reuse them.)

Run: `cd "W:/tmp/clean-org-names/app"; npx vitest run test/orgNames.test.ts`
- RED (module missing).

GREEN: create `app/src/lib/orgNames.ts`:

```ts
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
```

GREEN; commit `feat(org-names): matching rules - types, normalization, on-list check`.

### Task 1.2 - resolution: match, ambiguous, other kind, compound, unknown + close names

RED: append to `app/test/orgNames.test.ts` (extend the import with
`resolveOrgText`, `compoundSpans`, `closeNames`):

```ts
describe('resolveOrgText (spec D4)', () => {
  const HA = ['housing_authority'] as const;
  const AG = ['agency'] as const;
  it('matches a name ignoring case and punctuation', () => {
    expect(resolveOrgText(LIST, 'atlanta housing authority', HA)).toEqual({
      status: 'match',
      entry: ATLANTA,
      via: 'name',
    });
  });
  it('matches a unique spelling, including slug-shaped text', () => {
    expect(resolveOrgText(LIST, 'atlanta (aha)', HA)).toEqual({ status: 'match', entry: ATLANTA, via: 'spelling' });
    expect(resolveOrgText(LIST, 'atlanta_housing', HA)).toEqual({ status: 'match', entry: ATLANTA, via: 'spelling' });
  });
  it('a spelling two entries of the kind share is ambiguous, never a match', () => {
    expect(resolveOrgText(LIST, 'AHA', HA)).toEqual({ status: 'ambiguous', candidates: [ATLANTA, AUGUSTA] });
  });
  it('an exact name or spelling of the other kind is other_kind', () => {
    expect(resolveOrgText(LIST, 'HUD VASH', HA)).toEqual({ status: 'other_kind', entries: [VASH] });
    expect(resolveOrgText(LIST, 'Step Up', HA)).toEqual({ status: 'other_kind', entries: [STEP_UP] });
    expect(resolveOrgText(LIST, 'HUD VASH', AG)).toEqual({ status: 'match', entry: VASH, via: 'spelling' });
  });
  it('a value naming entries that no single entry explains is compound', () => {
    expect(resolveOrgText(LIST, 'DCA HUD-VASH', HA)).toEqual({ status: 'compound', spans: [[DCA], [VASH]] });
  });
  it('a value whose spans all fit one entry is not compound', () => {
    expect(resolveOrgText(LIST, 'Atlanta Housing Authority (AHA)', HA).status).toBe('unknown');
  });
  it('blank text is unknown with no close names', () => {
    expect(resolveOrgText(LIST, '   ', HA)).toEqual({ status: 'unknown', close: [] });
  });
});

describe('compoundSpans', () => {
  it('returns null for an exact name or spelling', () => {
    expect(compoundSpans(LIST, 'aha')).toBeNull();
    expect(compoundSpans(LIST, 'atlanta aha')).toBeNull();
  });
  it('takes the longest phrase at each position', () => {
    expect(compoundSpans(LIST, 'atlanta housing authority aha')).toBeNull();
    expect(compoundSpans(LIST, 'georgia dca vash')).toEqual([[DCA], [VASH]]);
  });
  it('needs two or more spans', () => {
    expect(compoundSpans(LIST, 'dca office')).toBeNull();
  });
});

describe('closeNames (prompts only)', () => {
  const HA_ONLY = LIST.filter((e) => e.kind === 'housing_authority');
  it('finds a name from abbreviated words', () => {
    expect(closeNames(HA_ONLY, 'atlanta hsg auth')[0]).toBe(ATLANTA);
  });
  it('finds a name from its initials', () => {
    const decatur = entry({ kind: 'housing_authority', name: 'Decatur Housing Authority' });
    expect(closeNames([...HA_ONLY, decatur], 'dha')).toContain(decatur);
  });
  it('finds a near-miss spelling', () => {
    expect(closeNames(HA_ONLY, 'atlnta housing authority')[0]).toBe(ATLANTA);
  });
  it('ignores matches on generic words alone', () => {
    expect(closeNames(HA_ONLY, 'fulton county')).toEqual([]);
  });
  it('returns at most three', () => {
    expect(closeNames(HA_ONLY, 'atlanta augusta georgia housing').length).toBeLessThanOrEqual(3);
  });
});
```

RED. GREEN: append to `app/src/lib/orgNames.ts`:

```ts
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
 * more. Kept at a best score of 0.5 or more, highest first.
 */
export function closeNames(
  candidates: readonly OrgEntry[],
  normalized: string,
  limit = 3,
): OrgEntry[] {
  if (normalized === '') return [];
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
```

GREEN; commit `feat(org-names): D4 resolution, compound test, close names`.

### Task 1.3 - write checks (spec D5)

RED: append to `app/test/orgNames.test.ts` (import `checkScalarWrite`,
`checkListWrite`):

```ts
describe('checkScalarWrite (D5)', () => {
  it('passes an unchanged value even when it is not on the list', () => {
    expect(checkScalarWrite(LIST, 'housingAuthority', 'atlanta_housing', 'atlanta_housing')).toEqual({
      ok: true,
      value: 'atlanta_housing',
    });
  });
  it('clears on blank', () => {
    expect(checkScalarWrite(LIST, 'housingAuthority', '  ', 'Atlanta Housing Authority')).toEqual({ ok: true, value: null });
  });
  it('stores an exact name as is and a unique spelling as its name', () => {
    expect(checkScalarWrite(LIST, 'housingAuthority', 'Atlanta Housing Authority', undefined)).toEqual({
      ok: true,
      value: 'Atlanta Housing Authority',
    });
    expect(checkScalarWrite(LIST, 'housingAuthority', 'Georgia DCA', undefined)).toEqual({
      ok: true,
      value: 'Georgia Department of Community Affairs',
    });
  });
  it('refuses ambiguous, other-kind, compound and unknown text with details', () => {
    const amb = checkScalarWrite(LIST, 'housingAuthority', 'AHA', undefined);
    expect(amb.ok).toBe(false);
    if (!amb.ok) {
      expect(amb.error.error).toBe('org_not_on_list');
      expect(amb.error.field).toBe('housingAuthority');
      expect(amb.error.candidates.map((c) => c.name)).toEqual([ATLANTA.name, AUGUSTA.name]);
    }
    const other = checkScalarWrite(LIST, 'housingAuthority', 'Step Up', undefined);
    expect(!other.ok && other.error.otherKind?.map((c) => c.name)).toEqual(['Step Up']);
    const comp = checkScalarWrite(LIST, 'housingAuthority', 'DCA VASH', undefined);
    expect(!comp.ok && comp.error.compound?.length).toBe(2);
    const unk = checkScalarWrite(LIST, 'agency', 'Nowhere Org', undefined);
    expect(!unk.ok && unk.error.close).toEqual([]);
  });
});

describe('checkListWrite (D5 per member)', () => {
  it('keeps members the record already holds and the legacy jurisdiction', () => {
    expect(checkListWrite(LIST, 'accepted_authorities', ['atlanta_housing', 'Old Place'], ['atlanta_housing'], 'Old Place')).toEqual({
      ok: true,
      value: ['atlanta_housing', 'Old Place'],
    });
  });
  it('resolves new members, trims and de-duplicates', () => {
    expect(checkListWrite(LIST, 'accepted_authorities', [' Georgia DCA ', 'Georgia Department of Community Affairs', ''], [], undefined)).toEqual({
      ok: true,
      value: ['Georgia Department of Community Affairs'],
    });
  });
  it('refuses the first new member that does not resolve', () => {
    const r = checkListWrite(LIST, 'accepted_authorities', ['Atlanta Housing Authority', 'Step Up'], [], undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.text).toBe('Step Up');
  });
});
```

RED. GREEN: append to `app/src/lib/orgNames.ts`:

```ts
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
 * dropped (first wins). A member the record already holds (exact text) or
 * equal to the unit's legacy `jurisdiction` passes unchanged; every other
 * member must resolve to an entry name. The first failing member is reported.
 */
export function checkListWrite(
  entries: readonly OrgEntry[],
  field: OrgField,
  next: readonly string[],
  current: readonly string[] | undefined,
  legacyJurisdiction: string | undefined,
): ListCheck {
  const out: string[] = [];
  for (const raw of next) {
    const member = raw.trim();
    if (member === '') continue;
    let value: string;
    if ((current ?? []).includes(member) || member === legacyJurisdiction) {
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
```

GREEN; commit `feat(org-names): D5 write checks for scalar and list fields`.

### Task 1.4 - name and spelling rules (spec D12, D13)

RED: append to `app/test/orgNames.test.ts` (import `checkNewName`,
`checkSpelling`):

```ts
describe('checkNewName (D13, D12 rename rule)', () => {
  it('accepts a fresh name', () => {
    expect(checkNewName(LIST, 'Marietta Housing Authority')).toBeNull();
  });
  it('refuses blank, too long, taken by any name or spelling of either kind, and compound', () => {
    expect(checkNewName(LIST, '  ')).toEqual({ code: 'org_name_empty' });
    expect(checkNewName(LIST, 'x'.repeat(121))).toEqual({ code: 'org_name_too_long' });
    expect(checkNewName(LIST, 'atlanta housing')).toEqual({ code: 'org_name_taken', entry: ATLANTA });
    expect(checkNewName(LIST, 'Step up')).toEqual({ code: 'org_name_taken', entry: STEP_UP });
    expect(checkNewName(LIST, 'DCA VASH')).toEqual({ code: 'org_name_compound', spans: [[DCA], [VASH]] });
  });
  it('a rename may take one of the entry\'s own spellings', () => {
    expect(checkNewName(LIST, 'Atlanta Housing', { excludeOrgId: ATLANTA.orgId })).toBeNull();
  });
});

describe('checkSpelling (D12)', () => {
  it('accepts a fresh spelling', () => {
    expect(checkSpelling(LIST, DCA, 'GA Dept of Community Affairs')).toBeNull();
  });
  it('names every problem', () => {
    expect(checkSpelling(LIST, DCA, ' ')).toEqual({ problem: 'empty' });
    expect(checkSpelling(LIST, DCA, 'y'.repeat(121))).toEqual({ problem: 'too_long' });
    expect(checkSpelling(LIST, DCA, 'georgia dca')).toEqual({ problem: 'duplicate' });
    expect(checkSpelling(LIST, DCA, 'Step Up')).toEqual({ problem: 'equals_name', entries: [STEP_UP] });
    expect(checkSpelling(LIST, DCA, 'VASH')).toEqual({ problem: 'cross_kind', entries: [VASH] });
    expect(checkSpelling(LIST, DCA, 'Atlanta Housing VASH')).toEqual({ problem: 'compound' });
    expect(checkSpelling(LIST, DCA, 'AHA')).toEqual({ problem: 'shared_same_kind', entries: [ATLANTA, AUGUSTA] });
  });
  it('reports a full entry', () => {
    const full = entry({ kind: 'agency', name: 'Full', spellings: Array.from({ length: 20 }, (_, i) => `s${i}`) });
    expect(checkSpelling([...LIST, full], full, 'one more')).toEqual({ problem: 'too_many' });
  });
});
```

RED. GREEN: append to `app/src/lib/orgNames.ts`:

```ts
export type NameProblem =
  | { code: 'org_name_empty' }
  | { code: 'org_name_too_long' }
  | { code: 'org_name_taken'; entry: OrgEntry }
  | { code: 'org_name_compound'; spans: OrgEntry[][] };

/**
 * D13 + D12: a new name (add, Add as new, rename). Refused when blank, over
 * 120 chars, equal (normalized) to any OTHER entry's name or spelling of
 * either kind, or compound. `excludeOrgId` is the entry being renamed - its
 * own name and spellings do not count against it.
 */
export function checkNewName(
  entries: readonly OrgEntry[],
  name: string,
  opts: { excludeOrgId?: string } = {},
): NameProblem | null {
  const trimmed = name.trim();
  if (trimmed === '') return { code: 'org_name_empty' };
  if (trimmed.length > ORG_NAME_MAX) return { code: 'org_name_too_long' };
  const others = entries.filter((e) => e.orgId !== opts.excludeOrgId);
  const n = normalizeOrgText(trimmed);
  const taken = others.find((e) => matchesText(e, n));
  if (taken) return { code: 'org_name_taken', entry: taken };
  const spans = compoundSpans(others, n);
  if (spans !== null) return { code: 'org_name_compound', spans };
  return null;
}

export type SpellingProblem =
  | { problem: 'empty' }
  | { problem: 'too_long' }
  | { problem: 'too_many' }
  | { problem: 'duplicate' }
  | { problem: 'equals_name'; entries: OrgEntry[] }
  | { problem: 'cross_kind'; entries: OrgEntry[] }
  | { problem: 'compound' }
  | { problem: 'shared_same_kind'; entries: OrgEntry[] };

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
```

Note for the builder: in `checkSpelling` the `duplicate` check runs BEFORE
`too_many`, so re-adding an existing spelling to a full entry reports
`duplicate`. The `compound` check uses the WHOLE list (target included): a
spelling built from the target's own name plus another entry's spelling is
compound.

GREEN; commit `feat(org-names): name and spelling rules (D12, D13)`.

### Task 1.5 - the starting list (spec Appendix A) and its conformance tests

RED: create `app/test/orgStartingList.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STARTING_ORG_LIST, buildStartingEntries } from '../src/lib/orgStartingList.js';
import {
  checkNewName,
  checkSpelling,
  resolveOrgText,
  type OrgEntry,
} from '../src/lib/orgNames.js';

const NOW = '2026-10-06T00:00:00.000Z';
let n = 0;
const entries: OrgEntry[] = buildStartingEntries(NOW, () => `org-${(n += 1)}`);
const byName = (name: string): OrgEntry => {
  const e = entries.find((x) => x.name === name);
  if (!e) throw new Error(`missing ${name}`);
  return e;
};
const HA = ['housing_authority'] as const;
const AG = ['agency'] as const;

describe('STARTING_ORG_LIST conforms to the rules', () => {
  it('every name is valid against the others', () => {
    for (const e of entries) expect(checkNewName(entries, e.name, { excludeOrgId: e.orgId })).toBeNull();
  });
  it('the only shared spellings are AHA and MHA, each within one kind', () => {
    const shared = new Map<string, string[]>();
    for (const e of entries) {
      for (const s of e.spellings) {
        const without = { ...e, spellings: e.spellings.filter((x) => x !== s) };
        const problem = checkSpelling(entries.map((x) => (x.orgId === e.orgId ? without : x)), without, s);
        if (problem === null) continue;
        expect(problem.problem).toBe('shared_same_kind');
        shared.set(s, [...(shared.get(s) ?? []), e.name]);
      }
    }
    expect([...shared.keys()].sort()).toEqual(['AHA', 'MHA']);
  });
  it('builds entries with ids, timestamps and system authorship', () => {
    expect(entries.every((e) => e.orgId.startsWith('org-') && e.createdAt === NOW && e.createdBy === 'system')).toBe(true);
    expect(entries.length).toBe(STARTING_ORG_LIST.length);
  });
});

describe('old values resolve as spec Appendix A says', () => {
  const cases: Array<[string, readonly ('housing_authority' | 'agency')[], string]> = [
    ['Atlanta (AHA)', HA, 'Atlanta Housing Authority'],
    ['Atlanta, aha, Atlanta housing', HA, 'Atlanta Housing Authority'],
    ['atlanta_housing', HA, 'Atlanta Housing Authority'],
    ['Jonesboro (JHA)', HA, 'Jonesboro Housing Authority'],
    ['Dekalb County Housing', HA, 'DeKalb County Housing Authority'],
    ['dekalb_housing', HA, 'DeKalb County Housing Authority'],
    ['Georgia Housing Voucher (GHV)', HA, 'Georgia Housing Voucher Program (DBHDD)'],
    ['DCA', HA, 'Georgia Department of Community Affairs'],
    ['ga_dca', HA, 'Georgia Department of Community Affairs'],
    ['East Point', HA, 'East Point Housing Authority'],
    ['College Park', HA, 'College Park Housing Authority'],
    ['HUD VASH', AG, 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)'],
    ['Claratel', AG, 'Claratel Behavioral Health'],
    ['Hope Atlanta', AG, 'HOPE Atlanta'],
    ['Step Up', AG, 'Step Up'],
  ];
  it.each(cases)('%s -> %s', (text, kinds, name) => {
    const r = resolveOrgText(entries, text, kinds);
    expect(r.status).toBe('match');
    if (r.status === 'match') expect(r.entry.name).toBe(name);
  });
  it('agency names in a housing authority field are the other kind', () => {
    for (const t of ['HUD VASH', 'Claratel', 'Hope Atlanta', 'Step Up']) {
      expect(resolveOrgText(entries, t, HA).status).toBe('other_kind');
    }
  });
  it('bare AHA and MHA are ambiguous by design', () => {
    expect(resolveOrgText(entries, 'AHA', HA).status).toBe('ambiguous');
    expect(resolveOrgText(entries, 'MHA', HA).status).toBe('ambiguous');
  });
  it('DCA HUD-VASH is compound', () => {
    const r = resolveOrgText(entries, 'DCA HUD-VASH', HA);
    expect(r.status).toBe('compound');
    if (r.status === 'compound') {
      expect(r.spans.map((s) => s.map((e) => e.name))).toEqual([
        ['Georgia Department of Community Affairs'],
        ['HUD-Veterans Affairs Supportive Housing (HUD-VASH)'],
      ]);
    }
  });
  it('fulton_housing is not on the list (pending spec section 13)', () => {
    expect(resolveOrgText(entries, 'fulton_housing', HA).status).toBe('unknown');
  });
});

it('every entry carries notes only within the cap', () => {
  expect(byName('Georgia Department of Community Affairs').notes?.length ?? 0).toBeLessThanOrEqual(500);
});
```

RED. GREEN: create `app/src/lib/orgStartingList.ts` with EXACTLY these
entries (spec Appendix A; the three notes come from the 2026-10-06 research):

```ts
// The STARTING organization list (spec Appendix A). It seeds an EMPTY store
// once (repos/orgListRepo.ts) and the seeds' explicit put. After an
// environment has its `org-list` item, editing this file changes NOTHING
// there - change names through Settings > Housing authorities & agencies.
import type { OrgEntry, OrgKind } from './orgNames.js';

export interface StartingOrg {
  kind: OrgKind;
  name: string;
  spellings: string[];
  notes?: string;
}

export const STARTING_ORG_LIST: readonly StartingOrg[] = [
  {
    kind: 'housing_authority',
    name: 'Atlanta Housing Authority',
    spellings: ['AHA', 'Atlanta Housing', 'Housing Authority of the City of Atlanta', 'Atlanta (AHA)', 'Atlanta, aha, Atlanta housing'],
  },
  {
    kind: 'housing_authority',
    name: 'Georgia Department of Community Affairs',
    spellings: ['DCA', 'Georgia DCA', 'GA DCA', 'Department of Community Affairs', 'DCA, Department of Community Affairs'],
    notes: 'Runs vouchers in 149 of Georgia\'s 159 counties (not Fulton, DeKalb, Clayton, Cobb, Bibb, Chatham, Glynn, Muscogee, Richmond or Sumter). North Regional Office in Atlanta.',
  },
  {
    kind: 'housing_authority',
    name: 'Georgia Housing Voucher Program (DBHDD)',
    spellings: ['GHV', 'GHVP', 'DBHDD', 'Georgia Housing Voucher', 'Georgia Housing Voucher (GHV)'],
    notes: 'Statewide supportive housing voucher run by the Department of Behavioral Health and Developmental Disabilities. DBHDD\'s contractor pays landlords; the tenant\'s provider agency requests the unit inspection.',
  },
  {
    kind: 'housing_authority',
    name: 'DeKalb County Housing Authority',
    spellings: ['HADC', 'Housing Authority of DeKalb County', 'Dekalb County Housing', 'Dekalb Housing'],
  },
  { kind: 'housing_authority', name: 'Decatur Housing Authority', spellings: ['Housing Authority of the City of Decatur'] },
  { kind: 'housing_authority', name: 'Marietta Housing Authority', spellings: ['MHA'] },
  {
    kind: 'housing_authority',
    name: 'Jonesboro Housing Authority',
    spellings: ['JHA', 'Jonesboro (JHA)', 'Jonesboro housing', 'Jonesboro, JHA, Jonesboro housing'],
  },
  { kind: 'housing_authority', name: 'East Point Housing Authority', spellings: ['EPHA', 'East Point', 'Eastpoint Housing Authority'] },
  {
    kind: 'housing_authority',
    name: 'College Park Housing Authority',
    spellings: ['Housing Authority of the City of College Park', 'College Park'],
  },
  { kind: 'housing_authority', name: 'Macon-Bibb County Housing Authority', spellings: ['Macon Housing Authority', 'MHA'] },
  { kind: 'housing_authority', name: 'Augusta Housing Authority', spellings: ['AHA'] },
  {
    kind: 'agency',
    name: 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)',
    spellings: ['HUD-VASH', 'VASH'],
    notes: 'National program. The voucher comes from a housing authority; the case manager comes from the local VA medical center.',
  },
  { kind: 'agency', name: 'Step Up', spellings: [] },
  { kind: 'agency', name: 'Claratel Behavioral Health', spellings: ['Claratel', 'DeKalb Community Service Board'] },
  { kind: 'agency', name: 'View Point Health', spellings: ['Viewpoint Health'] },
  { kind: 'agency', name: 'HOPE Atlanta', spellings: ['Travelers Aid'] },
  { kind: 'agency', name: 'Mercy Care', spellings: [] },
  { kind: 'agency', name: 'CaringWorks', spellings: ['Caring Works'] },
];

/** The starting list as stored entries. */
export function buildStartingEntries(now: string, newId: () => string): OrgEntry[] {
  return STARTING_ORG_LIST.map((s) => ({
    orgId: newId(),
    kind: s.kind,
    name: s.name,
    spellings: [...s.spellings],
    ...(s.notes !== undefined && { notes: s.notes }),
    createdAt: now,
    createdBy: 'system',
    updatedAt: now,
    updatedBy: 'system',
  }));
}
```

PENDING-SAM AMENDMENT (the planner applies this before the launch gate; the
builder never guesses it): spec section 13 decides whether "Fulton County
Housing Authority" joins this list (with spellings `Housing Authority of
Fulton County`, `Fulton County`, `Fulton, Fulton County`), whether
`Clayton County` becomes a spelling of Jonesboro and `Cobb County` of
Marietta, and any added agency. When that lands, the planner edits this task,
Appendix A and Task 12.x's `fulton_housing` mapping in the same commit; the
conformance test's expected shared-spelling set stays `['AHA', 'MHA']`.

GREEN; commit `feat(org-names): the starting list and its conformance tests`.
