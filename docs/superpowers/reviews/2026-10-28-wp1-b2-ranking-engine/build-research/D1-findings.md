# D1 findings - B2a build Phase 1 delta reader

- Id: D1. Scope: plan section 5, S1 "The Notes box" (tasks S1.1-S1.11);
  spec D14, D15; watch items WI3, WI4 (S1 half), WI5, WI10 (S1 half).
- Read: plan lines 1-590 (binding sections 0-4) and 591-3696 (S1); later
  slices' uses of S1 exports (plan ~9738, 10659-10660, 10739-10758,
  11172-11272, 13910-13961, 29837, 35205-35360, 39236-39420); spec sections
  1-2, D14, D15, 5-7; AGENTS.md; every S1 target file in the tree.
- Method (read-only; nothing written in the worktree except this file and
  the reference): every quoted anchor checked by script; every S1 edit
  applied in plan order to scratch copies; the post-S1 tree typechecked and
  linted VIRTUALLY (the worktree's own TypeScript and ESLint, served the
  post-S1 text via a compiler host / `lintText`); the plan's tests EXECUTED
  against the plan's code with vitest from the worktree root and a scratch
  config whose plugin serves the post-S1 text (cache dir in scratch;
  `git status --ignored` unchanged afterwards). Per-task RED states were
  reproduced the same way.
- Verdict: S1 is buildable as written except one harness trap: the Bash
  tool collapses a doubled backslash, so S1.1's own test fails at its GREEN
  step (D1-1). Everything else - anchors, types, lint, hand-worked values,
  RED/GREEN claims, WI3 coverage - checks out.

Counts: BLOCKER 0, MAJOR 1, MINOR 6.

Byte-exact replacement text and commands:
`.superpowers/sdd/research/D1-reference.md` (R0-R5). Below, "BS-u2028"
means the six characters backslash, u, 2, 0, 2, 8.

## Findings

### D1-1 - MAJOR - S1.1's heredoc test text breaks under the Bash tool; S1.1 GREEN fails

- Plan: lines 878-879 (Task S1.1 Step 1, the `singleLine.test.ts` heredoc).
- Code/harness fact: this harness's Bash tool collapses every doubled
  backslash `\\` to one, inside a quoted heredoc too, while the Write/Edit
  tools keep `\\` but decode BS-u2028 (measured in scratch; reference R0).
  Plan S1 lines 591-3696 hold exactly three doubled backslashes: 644, 878,
  879.
- Problem: lines 878-879 (`toContain('\\u2028')`, `toContain('\\u2029')`)
  land on disk as `toContain('` BS-u2028 `')`, i.e. the RAW separator in
  JavaScript. `singleLine.ts` holds the escape, so the case "writes the two
  separators as escapes, never as raw characters" fails: Step 4 gives
  4 passed / 1 failed, not "5 passed" (reproduced: plan text with the
  collapse applied, run against the plan's `singleLine.ts`). The plan's perl
  raw-character check prints nothing on that file (it holds an escape, not a
  raw character), so the builder gets no pointer to the cause; the natural
  "fix" (raw characters in `singleLine.ts`) is a syntax error and breaks the
  ASCII case.
- Correction: replace the two lines with the backslash-free form in R1
  (`String.fromCharCode(92)`), and/or create the four escape-holding files
  by extracting the heredoc bodies from the plan by header line instead of
  typing them (R3; verified byte-identical with `cmp`). Add a section 0
  note: never type a doubled backslash through the Bash tool.

### D1-2 - MINOR - the raw-separator restore one-liner corrupts the file it repairs

- Plan: line 644 (S1 "The `\u` trap"; the same one-liner is the slice's
  only recovery path).
- Fact: same collapse as D1-1. Typed through the Bash tool,
  `s/\x{2028}/\\u2028/g` reaches perl as a single-backslash u in the
  replacement, which perl reads as "uppercase the next character": the raw
  separator becomes `2028` (verified on a scratch file). In
  `singleLine.ts` that turns the character class into one that also folds
  the digits 2, 0 and 8.
- Correction: use `\x5c` for the backslash (R2; verified to write
  BS-u2028).

### D1-3 - MINOR - the S1.3(a) heredoc and its suggested split exceed the Bash command cap

- Plan: lines 1099-1448 (Task S1.3 Step 1a) and its split note at
  1446-1448.
- Fact: the body (plan 1104-1441) is 338 lines / 17,842 bytes (the plan
  says "about 15 KB"); the suggested split ("up to the end of the any date
  describe") leaves an 11.7 KB first command. This harness caps a Bash
  command near 10 KB (Cameron's memory note share-skip-mission: "append big
  files by Write-to-part then cat"), and Write-to-part is unusable here
  because Write decodes BS-u2028.
- Correction: extract from the plan (R3), or split three ways after plan
  lines 1205 and 1328 (~5.5 / 6.2 / 6.2 KB; R4), then check `wc -l` prints
  338, the last line is `});`, and the perl check prints nothing.

### D1-4 - MINOR - S1.1 Step 2 quotes a RED message vitest does not print

- Plan: line 895 (Task S1.1 Step 2).
- Fact: vitest 3.2.6 (this tree) reports "Cannot find module
  '../src/lib/singleLine.js' imported from ..." caused by "Failed to load
  url ../src/lib/singleLine.js ... Does the file exist?" (captured; R5).
- Correction: quote that text; the reason (module missing) is right.

### D1-5 - MINOR - "npm ci once before S1" is stale

- Plan: line 625 (S1 Scope) and section 0 lines 34-37.
- Fact: node_modules is installed in the worktree now (brief; the
  virtual runs above used it). On Windows `npm ci` deletes node_modules
  first, which can fail EBUSY or break any process still using the
  worktree's node_modules.
- Correction: skip `npm ci` when node_modules is present and the lockfile
  is unchanged since install; if it must run, run it only when no other
  agent is using this worktree.

### D1-6 - MINOR - WI3 table names two webhook files by a path that does not exist

- Plan: line 3559 (Task S1.11 Step 2 table, "consent stamps
  (webhooks/twilio.ts, webhooks/voice.ts)").
- Fact: the files are `app/src/routes/webhooks/twilio.ts` and
  `app/src/routes/webhooks/voice.ts` (there is no `app/src/webhooks/`); the
  other rows are app/src-relative (`routes/contacts.ts`), and the S1 report
  cites each row by `file:line`.
- Correction: `routes/webhooks/twilio.ts`, `routes/webhooks/voice.ts`.

### D1-7 - MINOR - GLOSSARY still says staff_notes is never machine-read; nobody fixes it

- Plan: S1.9 (D15, comment-only) and S8.9 (GLOSSARY, ranking terms).
- Fact: `documentation/GLOSSARY.md:165-173` ("Staff notes ... never
  machine-written or machine-read (not the import, the seeds, the public
  sign-up, the transition service, or extraction)") becomes false with the
  ranking card (spec D15), and the entry names `staff_notes_updated_at` but
  not the new `notes_updated_at` stamp on contact `notes`. S1.9 corrects
  only code comments; S8.9 adds ranking terms and does not touch this
  entry. AGENTS.md: GLOSSARY drift is fixed in the same change.
- Correction: S8.9 (GLOSSARY owner, PR2) rewrites that paragraph per D15
  and names `notes_updated_at`; or the planner moves it to S1.9.

## Checked and fine

- Anchors: all 52 quoted "Anchor (old)" blocks in S1 occur byte-exact
  exactly once in their target files; applying every S1 edit in plan order
  composes cleanly on all 17 edited files (prompt.ts 3, apply.ts 8,
  contacts.ts 9, contactsRepo.ts 3, ContactEditForm.tsx 7, ...).
- Typecheck (virtual, post-S1): app `tsconfig.test.json` (src + tests,
  21 overridden files in the program), `tsconfig.scripts.json` and
  dashboard `tsconfig.json`: 0 diagnostics each (base also 0).
- Lint (virtual, gate 5 rules; proven to fire react-hooks and
  no-unused-vars on these paths): 0 errors on all 25 S1 files, base 0.
- ASCII: 0 non-ASCII bytes in every added line (25 files + the CSS block).
- S1.1/S1.3 pure tests run against the plan's code: singleLine 6/6,
  extractionNoteLines 35/35; against today's `filterNoteLines` the new file
  gives 22 fail / 13 pass, exactly the S1.3 Step 2 list (whole-result
  `toEqual`s, `duplicate` asserts, D14.1 cases; the PIN and break-free
  `.append` cases pass). Hand-worked values all hold (the 198 x + " /"
  clamp case, the duplicate counts, demoted counts).
- S1.2: the three transcript cases pass on the edited renderer and two fail
  on today's (as stated); `ExtractionInput`, `renderUtteranceLine`,
  `buildExtractionUserContent` are already imported. prompt.ts diff = the
  import, the removed helper (now a `//` comment), the one call - nothing in
  `buildExtractionSystemPrompt` or the schema (WI5). The Step 0 tsx command
  works and prints `915df487ad47` on main.
- App suites post-S1 (vitest, in-memory): extractionApply, extractionJob,
  extractionNoteLines, extractionSchema, contactsCrud, propertyLabel = 411
  pass (base 388); contactNotesGuard 24/24 and seedNotesStamp 2/2; the
  GREEN-step regression suites (extractionPromptProbe, aiRunsRepo,
  aiRunsApi, contactTriage, trimStrings, landlordRequirementsPatch,
  importOrgNames, extractionRunWindow, extractionAdapter, contactStaffNotes)
  434 pass.
- Per-task RED reproduced as stated: S1.4 (4 fail; the PIN passes once S1.3
  is in), S1.5 (2), S1.6 (3 + the 2 contactsCrud OWNED cases), S1.7 (stamp
  case, the extractionJob call pin; seed pins pass), S1.8 (9 fail / 15
  pass, the exact list), S1.10 (10 fail, "sends no stamp" passes, all 131
  older cases pass).
- Dashboard post-S1: ContactEditForm 142/142 (131 + 11 new),
  AiRunsSection 45/45, StaffNotesCard + ContactDetail 176/176.
- S1.7 importer case (needs DynamoDB Local, not run): one UpdateCommand per
  contact (`lib/import/apply.ts:1238-1248`), `importedAt` in scope, set per
  run by `scripts/import-apply.ts:375`; the clean workbook carries no notes,
  so the landlord stays notes-free; the noTraffic notes it writes are read
  by no later case.
- `filterNoteLines` callers: `applyExtraction` (apply.ts:944-975) and
  `scripts/extraction-prompt-probe.ts:297-304` (append, modelCount,
  belowFloor only); no snapshots. `ApplyOutcome` is built only in apply.ts;
  `NoteLineFilterResult` only in `filterNoteLines`.
- Run record: one apply path sets the counts (jobs/extraction.ts:715-717);
  `GET /api/ai-runs/:runId` returns the stored record whole
  (routes/aiRuns.ts:272), so `notesDuplicate` reaches AiRunDetail; the list
  projection is untouched.
- Contacts route: `refuseServerOwnedFields` runs first in both parsers
  (contacts.ts:582, :885); the PATCH has a single guarded write
  (:2021); the conflict rule extends the existing re-read (:2027-2050);
  the audit uses `changedFields`, so the stamp is never an audited field;
  the fake repo honors `expect` clauses with null = absent
  (test/helpers/twilioWebhookHarness.ts:2473-2486).
- WI3 (own sweep of app/src, app/scripts, root scripts/, e2e helpers): only
  the contacts PATCH and POST, extraction apply and the importer upsert
  write a contact's `notes`. public.ts, unmatchedEmail.ts,
  caseworkerConversion, contactCapture, groupConvert, groupMembers, the
  webhooks, dev.ts, performanceSeed and every seed layer write none (seeds
  carry only `preferences_notes`); no contact merge exists (C11);
  contactsRepo PutCommands are create, createIfAbsent and pointer items;
  no dashboard or e2e caller echoes a whole contact into a PATCH or POST,
  so the new server-owned refusal breaks no client. The plan's table is
  complete (path precision aside, D1-6).
- WI4 (S1 half): `notes_updated_at` joins `SERVER_OWNED_CONTACT_FIELDS`;
  S3 classifies it `exclude` (plan ~11172, ~11272) and lists
  `notes_expected_updated_at` in its writer-key scan (~10659).
- WI10: no seed layer (lean, cast, matrix, live, history, heardFrom) writes
  a contact's notes; `seedNotesStamp.test.ts` mirrors
  `seedContactTypeInvariants.test.ts`'s world composition and its imports
  (`SEED`, `castItems`, `matrixItems`, `buildLiveStaticItems`) exist.
- U+2028/U+2029: every single-backslash u-escape in S1 sits inside a Bash
  heredoc (S1.1, S1.2, S1.3); no Edit/Write step carries one. (The doubled
  backslash is the trap - D1-1, D1-2.)
- Dashboard facts the tests rely on: `ApiError(status, code, message,
  body)` and `code = body.error` (api/client.ts:22, :75-81);
  `getByLabelText('Notes', { exact: true })` works in jsdom (Testing
  Library 10.4.1 leaves textarea text out of label content); the form
  clears its generic error at submit start (ContactEditForm.tsx:602), so
  `findByRole('alert')` finds only the panel; `TENANT.contactId` is `k1`;
  `searching` and `placing` are tenant statuses; the CSS tokens all exist
  (ui/tokens.css); a Cancel button exists (ContactEditForm.tsx:690-691).
- Cross-slice: S7.12 drives the panel by `role="alert"`, the D14.3 copy
  and a `/^Notes/` label, exactly as S1 publishes; no later slice imports
  `toOneLine`. Existing e2e Notes saves (contact-detail.spec.ts,
  scenarios/steps.ts:1179) now send the opened stamp; the fake extractor
  acts only on `EXTRACT:` markers, so no new 409 race.
- Paths and mechanics: every test file named in S1 commands exists except
  the three new ones; the S1.11 Step 1 diff paths exist; the MERGE_HEAD
  path matches the worktree gitdir; the only new import is
  `'../../lib/singleLine.js'` with `.js` and no directory import (smoke).
