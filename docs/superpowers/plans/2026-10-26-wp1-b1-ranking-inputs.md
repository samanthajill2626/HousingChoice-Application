# Implementation plan - WP1 B1 Ranking inputs

- Spec (the contract - read it in full before Task S1.1):
  `docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md`
  (rev 8, APPROVED by Cameron 2026-10-26). "Spec Dn" means its decisions
  D1-D7; "spec N" its numbered sections.
- Charter: `docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md`
  (amended on this branch, section 20 items 1-8). Charter decisions bind.
- Branch `feat/wp1-b1-ranking-inputs`, worktree `W:\tmp\wp1-b1-ranking-inputs`,
  cut from main @d0e2c2d8. Mission records:
  `docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/`.
- Spec review: 5 rounds, 57 findings, 0 rejected -
  `docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/design-review/adjudications.md`.
- Status: PLAN v1 DRAFT (2026-10-26). Sections 0-4 and 11 are BINDING and
  written by the planner; slice sections 5-10 are opus section drafts
  assembled verbatim. Section 4 (planner rulings PR1-PRnn) wins over any
  slice text it contradicts. "Plan section N" always means this file's
  top-level sections.

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for
  the stated reason), implement, run it GREEN, commit. One commit per task
  unless the task says otherwise. A case marked (PIN) is a regression pin
  already green on unchanged code; every task still has at least one real
  RED case, except a task the plan marks comment-only or docs-only.
- Setup, once, before S1: the worktree has NO `node_modules`. Run `npm ci`
  at the worktree root (bare; expect exit 0). Never symlink another
  worktree's node_modules. No new dependency is added by this plan.
- Commits: a separate bare `git status` read first, check
  `W:\AI Projects\Housing Choice\HC Application\.git\worktrees\wp1-b1-ranking-inputs\MERGE_HEAD`
  is absent, explicit paths only (never `git add -A`), ASCII message ending
  with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (or the authoring model's name). Use repeated `-m` arguments, or a message
  file OUTSIDE the worktree.
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for a new file;
  for a pre-existing file that already carries non-ASCII, only ADDED lines
  must be ASCII:
  `git diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c`
  prints 0. Never "fix" a pre-existing non-ASCII string a test pins.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit/Write tools DECODE `\u` escapes - after any
  edit near one, grep that the six-character escape survived.
- Run app tests from `app/` with `npx vitest run test/<file>`, dashboard
  tests from `dashboard/` with `npx vitest run src/<path>`, e2e only through
  the e2e workspace (`npm run e2e`, or `npm run e2e:session` + the
  Playwright MCP). Never pipe a test or gate command. App vitest runs need
  DynamoDB Local (`npm run db:start` STARTS it; never RESTART the shared
  container - it wipes local data; ask the human).
  `ALLOW_SKIP_DYNAMO_TESTS=1` is allowed ONLY for a pure-file red/green step,
  never for a gate. If the environment exports `AWS_ACCESS_KEY_ID`, run app
  tests as `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY ...`.
- Never touch the live stack (`:5174` / `:8080`). Never run anything against
  AWS dev or prod. NEVER call the Anthropic API: no agent reads, exports or
  uses `ANTHROPIC_API_KEY`, and no agent runs the probe script against a
  real model (PR1). Every test uses the fake driver or a stub.
- Never edit dashboard/app source while this worktree's e2e suite runs (it
  serves the source live). Never commit during it.
- Line numbers are hints against main @d0e2c2d8; the QUOTED text is the
  anchor. Where an earlier task changed a region, re-read the current text
  and apply the change ON TOP of it - never revert an earlier task.
- Slice reports: `docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/slices/S<n>-report.md`,
  ASCII, findings only (what the tree held that the plan got wrong, risks,
  watch-item results), citing code by `file:line`. A slice with nothing to
  report writes one line saying so. Commit it with explicit paths when the
  slice ends.
- Code blocks under list bullets carry the bullet's indent in this file.
  Strip that indent before using a block as an Edit anchor or as
  replacement text; the target file's own indentation is the authority.

## 1. Global constraints (from the spec; the spec wins on any doubt)

- Four tenant fields, keys `area_preference`, `max_tenant_portion`,
  `accessibility_need`, `preferences_constraints`, declared ONCE in the
  leaf module `app/src/lib/tenantMatchingInputs.ts` (imports nothing). Every
  reader iterates the list; no reader names the four (spec D1).
- Text fields: trimmed, at most 500 characters, `''` or `null` CLEARS
  (REMOVE). Dollars: integer 0..20000, `null` / `''` clears. Exact error
  copy as in spec D2.
- Extraction: 8 -> 12 extractable fields, 12 -> 16 decision targets; a
  `write` on a NON-EMPTY text field is DROPPED with reason
  `text_field_filled` (not a suggestion, not in `demotedFields`);
  `max_tenant_portion` keeps the pets rule (spec D3).
- noteLines become `{ text, confidence }`; floor
  `EXTRACTION_FACT_MIN_CONFIDENCE` default 0.7, fail-fast `0 < x <= 1`;
  order clamp -> floor -> retry guard -> system lines -> five-line cap;
  a demoted run appends NO line of either kind; all value rules live in the
  PURE exported `filterNoteLines` (spec D4).
- Feedback lines are ordinary Notes lines. No new filter, no shape check,
  no listing_sends write, no `shares_op` change, no status change. Only
  counts: `feedbackLines`, `unlabeledAddressLines` (spec D5).
- PROPERTIES SENT block: tenant AND unknown contacts, listed rows, newest
  20, budget 4,000 chars, `none` when empty, a read failure or an
  incomplete units read FAILS THE RUN; transcript render and per-message
  hash unchanged (spec D5.1).
- Priority: boolean, `unit.priority === true` is the only on test, never on
  the flyer, never in a model input (spec D6).
- The probe gains `--suite never-written`, `--model` REQUIRED there, and the
  default suite compared branch vs main; the gate RUN is Cameron's (PR1)
  (spec D7).
- No Terraform, no GSI, no new table, no deploy, no dev/prod data write,
  no new env var REQUIRED to deploy. Lean seed byte-stable.

## 2. Work map (build order; each slice ends with its report and commit)

| Slice | Scope | Depends on |
|---|---|---|
| S1 | Tenant matching inputs: the leaf list module; contact storage types; PATCH and create parsers; dashboard API types, the mirror + drift test, the edit form controls, the intake card rows and chip labels; the full-seed tenant (spec D1, D2) | - |
| S2 | Priority on/off: unitFields boolean, unit types, PROPERTY_FORM_FIELDS app + mirror (35 -> 36), New and Edit checkboxes, ListingDetail row and header pill (spec D6) | - |
| S3 | Extraction reconciles the four fields: EXTRACTABLE_FIELDS / PROVENANCE_FIELDS through the list, schema entries, coercion by kind in `coerceField` and `coerceAccept`, the `text_field_filled` drop, targets 12 -> 16 and every hard-coded count, CURRENT PROFILE, prompt guidance, the run-detail target order (spec D3) | S1 |
| S4 | Notes lines: `{ text, confidence }` shape, the config floor, `filterNoteLines`, retry guard before the cap, demotion appends nothing, `notesBelowFloor` / `notesDemoted`, widened prompt + never-written list, every string-noteLines fixture (app, fake driver, e2e specs) migrated (spec D4) | S3 |
| S5 | Feedback lines: `propertyLabel` / `labelMatches`, `getDisplaysByIds` `requireComplete`, the PROPERTIES SENT block + fingerprint, required job deps, run-failing reads, prompt guidance, `feedbackLines` / `unlabeledAddressLines`, run-detail display (spec D5) | S4 |
| S6 | The probe: exported `main` + guard, `--suite never-written`, `--model` required, branch-vs-main default suite comparison, record writer, stub-driver unit tests; the fake driver taught the new outputs; RUNBOOK, GLOSSARY, env example files (spec D7, spec 4 docs) | S5 |
| S7 | e2e coverage (fields, extraction tick, feedback line, Priority), the five gates, the gate-run command sheet for Cameron (planner section 11) | S6 |

Slices are strictly serial. S1 and S2 touch disjoint files; S3-S6 all
touch extraction (apply.ts, prompt.ts, schema.ts, jobs/extraction.ts,
AiRunDetail.tsx) and must run in order.

## 3. Watch items (each is checked and the result recorded in a slice report)

- WI1 The fake extraction driver BYPASSES `parseExtractionText`
  (adapters/extractionFake.ts:103). Every value rule lives in apply's pure
  functions, never only in the parser. (S4, S5, S6)
- WI2 The transcript render (`renderUtteranceLine`) and the run log's
  per-message hash are byte-unchanged; a test pins it. (S5)
- WI3 Hard-coded counts: "every one of the eight field entries"
  (prompt.ts:43-44), "The eight client-profile fields" (schema.ts:23),
  the "twelve" / "eleven" comments, `SWEEP_MAX_ATTEMPTS_PER_CALL`
  (journalSweep.ts:84-86), `DECISION_TARGET_ORDER` (AiRunDetail.tsx:40-44).
  A repo grep for `eight`, `twelve`, `eleven` in extraction code and tests
  is recorded in the S3 report. (S3)
- WI4 The noteLines shape change reaches every fixture: app tests, the
  fake driver, the probe, and the e2e payloads
  (conversation-fact-extraction.spec.ts:332/:377, caseworkers.spec.ts:517,
  ai-run-log.spec.ts:177). `npm run typecheck` is green at the end of S4.
  (S4)
- WI5 Retry guard moves BEFORE the five-line cap (today after it,
  apply.ts:723 vs :738-740); a test proves a guarded duplicate no longer
  consumes a cap slot. (S4)
- WI6 `hasAiCaseworkerNote` (lib/caseworkers.ts:42-82) is silenced by a
  dropped or demoted line - expected (spec Q1); its existing tests stay
  green or are updated with a stated reason. (S4)
- WI7 Lean seed byte-stable; only the full-profile seed tenant gains the
  four fields. The existing seed stability tests stay green. (S1)
- WI8 `getDisplaysByIds` existing callers do not pass `requireComplete`
  and are byte-unchanged in behavior; a test pins the default path. (S5)
- WI9 The job's new deps `listingSends` and `units` are REQUIRED; every
  construction site (worker.ts, routes/dev.ts, every job test harness)
  compiles. (S5)
- WI10 No listing_sends write anywhere in the extraction path; a test
  asserts the fake repo saw reads only. (S5)
- WI11 e2e `getByLabel('Pets')` (steps.ts:930) is not exact: no new label
  contains an existing intake label as a substring. (S1, S7)
- WI12 Priority never on the flyer (unitFields.ts:359); a legacy string
  reads as off; `propertyFormFlyerParity.test.ts` and the dashboard
  requirements tests at 36 rows in DOM order. (S2)
- WI13 `services/extraction/runTypes.ts` stays cycle-free: it may import
  ONLY `lib/tenantMatchingInputs.ts`, and its header says so. (S3)
- WI14 The importer (lib/import/*) is untouched; it still REPLACES the
  Notes box on re-import (filed: docs/issues/import-overwrites-notes-box.md).
  (S4)
- WI15 The prompt fingerprint changes (expected). The run-log hash of each
  message does not. (S4, S5)
- WI16 No test or script reaches the network or reads `ANTHROPIC_API_KEY`
  outside the probe's own real-model path, which no agent runs. (S6, S7)

## 4. Planner rulings (binding; win over slice text)

- PR1 THE GATE RUN IS CAMERON'S. No agent runs the probe against a real
  model, reads the testing key, or writes `never-written-test.md`. S6
  builds and unit-tests the script with a stub driver; S7 writes the
  command sheet (section 11). The orchestrator hands back
  "merge-ready PENDING the never-written gate run"; the planner hands
  Cameron the commands at the verdict, and B1 merges only after the
  record passes with his sign-off (spec D7) or he decides otherwise.
- PR2 File ownership by slice, so a later slice never re-decides an
  earlier one: the list module and every dashboard field surface are S1;
  `PROVENANCE_FIELDS` and its staff-PATCH `_source` clear pin are S3 (they
  derive from `EXTRACTABLE_FIELDS`); `DECISION_TARGET_ORDER` in
  AiRunDetail.tsx is S3; the run-detail count rows are S4 (floor and
  demotion) and S5 (feedback); the e2e payload migrations to the object
  noteLines shape are S4 (so typecheck is green when the shape changes);
  new e2e specs are S7; docs are S6.
- PR3 The full-profile seed tenant (seed/cast.ts) gains values for the four
  fields in S1; no seed carries a Priority value (the boolean defaults to
  off; a seeded `true` would change the full world for no test).
- PR4 `filterNoteLines` is the ONE place for note value rules. It takes
  the floor as an argument; `applyExtraction` receives the floor through
  `ApplyDeps` from config; the probe passes the same config value. No
  second copy of any rule in the job, the parser or the probe.
- PR5 `propertyLabel` and `labelMatches` live in
  `app/src/lib/propertyLabel.ts`, a leaf (imports nothing). The street
  suffix pattern for `unlabeledAddressLines` lives beside them as an
  exported pure function, so B2 can reuse or delete it in one place.
- PR6 The never-written suite's cases, banned terms, controls and the
  dated price table live in a data module beside the script
  (`app/scripts/extractionProbeNeverWritten.ts` or a name the S6 draft
  fixes), so the unit tests import them without the CLI.
- PR7 Nothing in B1 removes or renames a public type or route field; the
  only changed wire shapes are additive, plus noteLines (model-facing) and
  `priority` (string -> boolean; production holds 0 values, charter 9.2).
- PR8 The list module's API, fixed here so S3-S6 can rely on it:

  ```ts
  export type TenantMatchingInputKind = 'text' | 'dollars';
  export type TenantMatchingInputControl = 'input' | 'textarea' | 'dollars';
  export type TenantMatchingInputSource = 'field' | 'notes';
  export interface TenantMatchingInput {
    readonly key: string;
    readonly label: string;       // record row + form label
    readonly chipLabel: string;   // suggestion chip noun
    readonly kind: TenantMatchingInputKind;
    readonly control: TenantMatchingInputControl;
    readonly source: TenantMatchingInputSource;
    readonly promptGuidance: string;
  }
  export const TENANT_MATCHING_INPUTS = [ /* the four, spec D1 order */ ] as const satisfies readonly TenantMatchingInput[];
  export type TenantMatchingInputKey = (typeof TENANT_MATCHING_INPUTS)[number]['key'];
  export const TENANT_MATCHING_TEXT_MAX = 500;
  export const TENANT_MATCHING_DOLLARS_MAX = 20000;
  ```

  The dashboard mirror carries the same entries minus `promptGuidance`
  and `source`; the drift test compares key, label, chipLabel, kind and
  control, in order.

### Hours (Cameron's hands-on hours; charter estimate 8-10)

The unit is Cameron's own time - thinking, deciding, reviewing, talking to
Claude, running the gate, QA - not agent wall time or suite runtime.

| Phase | Hours | Basis |
|---|---|---|
| Design to spec gate (done) | ~3.0-3.5 | replay timestamps: 16:00-17:02, 17:39-19:04, 00:24-01:17 UTC, plus reading the spec; Cameron's own log wins |
| Plan gate + launch gate | 0.25-0.5 | read the plan summary and reject list, pick a mode |
| During the build | 0-0.5 | escalations only; AUTO supervision is the planner's |
| Never-written gate run | 0.75-1.5 | run two commands, read the record, judge each feedback case's meaning, sign off; the top of the range is one prompt fix and a re-run |
| Handback verdict + merge | 1.0-1.5 | read the verdict and the reviewers' findings, look at the four fields and the Priority control in the UI, merge |
| Deploy dev + prod, first live runs | 0.5-1.0 | if Cameron counts the release in B1; a look at the first runs' counts in the AI run detail |
| **Total** | **5.5-8.5** | |

Honest read: B1 lands at or below the charter's 8-10. The design phase
already cost about a third of it because the reaction design was redone
twice at the gate; that is spent. The two real risks to the top of the
range are the gate run (a leaked excluded fact means a prompt change, a
new run and a second judgment) and handback findings that need his call.
If both hit twice, B1 reaches about 10.

## 5-10. Slice sections

(Assembled from the S1-S6 drafts.)

## 11. S7 - e2e, gates, and the gate-run command sheet

(Planner-written after the drafts land.)
