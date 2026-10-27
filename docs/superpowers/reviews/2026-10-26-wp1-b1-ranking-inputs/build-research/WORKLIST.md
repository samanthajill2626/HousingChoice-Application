# Build worklist - WP1 B1 Ranking inputs, Phase 1 delta research

Status: BINDING for every implementer. Adjudicated by the build orchestrator
2026-10-27 from ten read-only readers run against the branch source, which is
main @d0e2c2d8 (branch head ede08552 carries docs only): D1-S1 ... D5-S5 (one
per plan slice), D6a-S6 (S6 preamble, S6.1, S6.1a, S6.2), D6b-S6 (S6.3-S6.10
and the gate-run commands), D7-S7 (e2e), E1-writers (whole-app writer sweep),
E2-readers (whole-app reader / renderer / consumer sweep). Sources, one per
reader, in this directory. Where an item says "per <id>", the source entry's
"Correction" holds the exact replacement text: apply it verbatim (strip any
list indent; the target file's own indentation is the authority).

Precedence: where an item here and the plan disagree, THIS WORKLIST WINS.
Plan section 4 (rulings PR1-PR58) still binds everything this worklist does
not amend. No item changes product behavior spec rev 10 states; every item is
a correction to make the plan build as the spec says, a test made
non-vacuous, a stale text, or recorded residue.

Totals: 50 raised - 3 BLOCKER reports (2 unique: D2-S2-1 = E2-readers-1, and
D4-S4-1), 0 MAJOR, 24 MINOR, 23 NOTE. Both BLOCKERs were re-checked by the
orchestrator against the tree and the plan text (requirements.test.ts:223-262
holds a second 35-row table; plan line 6165 passes `undefined` to a parameter
defaulted to 0.9). 42 build items (WL-1 .. WL-42); 4 orchestrator-owned items
(section "Orchestrator"); recorded residue in section "Recorded, no code".
The readers' "Verified with no finding" sections list what is already proven
correct - implementers need not re-derive it.

## General rules (every slice)

- G1 (from D6a-S6-2, PR1, WI16): every command that runs vitest or tsx on a
  file that can import `app/scripts/extraction-prompt-probe.ts` - every app
  vitest run in S6, and the S6.10 dry run - is prefixed
  `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL`. Before S6.2 lands, the
  old probe runs `await main()` on import and can read the key and call the
  real model when both variables are exported.
- G2 (from D5-S5-6): every grep / git grep / ls / tr command names ABSOLUTE
  worktree paths (or `git -C W:/tmp/wp1-b1-ranking-inputs`). The shell cwd
  resets to the SHARED main checkout between calls; a relative path silently
  reads another checkout.
- G3: DynamoDB Local is running. Do NOT run `npm run db:start` (it prunes
  per-key databases and can recreate the shared container).
- G4: an Edit whose `old_string` does not match is never forced: re-read the
  current text (an earlier task rewrote it), apply on top, and name the
  divergence in the slice report.

## S1 - tenant matching inputs

- WL-1 (E2-readers-2, MINOR) S1.5: the free-text matching rows keep the
  author's line breaks and wrap a long unbroken value, per E2-readers-2
  correction 1-4: the `.vProse` rule after `.v` in
  `dashboard/src/routes/contact/Card.module.css`; `export const
  proseValueClass = styles.vProse ?? '';` beside `responseClass` in
  `Card.tsx`; each matching row carries `prose: input.kind === 'text'`
  (row type `prose?: boolean`); the KV render line as given; the three
  `toHaveClass` assertions and the CSS source pin. Same commit as S1.5; add
  the two Card files to S1.5's file list, ASCII check and `git add`.
- WL-2 (D1-S1-2, NOTE) S1.5 Step 4b: also replace the stale prop comment
  `EligibilityIntakeCard.tsx:28` per D1-S1-2.
- WL-3 (D1-S1-1, NOTE) S1.3: in the mirror module's header comment, read
  "the APP and E2E typechecks compile types.ts (app/test/contactTimeline.test.ts,
  e2e/tests/tour-roster.spec.ts), so this module stays import-free". Text
  only.

## S2 - Priority on/off

- WL-4 (D2-S2-1 = E2-readers-1, BLOCKER) S2.2 Step 1b is REPLACED by
  D2-S2-1's three edits (a), (b), (c) to
  `dashboard/src/routes/listing/requirements.test.ts`: (a) the two-element
  `[label, flyer]` table at :242-243 gains `['Priority', 'staff_only'],` with
  the comment; (b) `- 35 rows` / `toHaveLength(35)` -> 36; (c) the
  three-element table at :621-622 gains the Priority row. Use the two-line
  anchors exactly as D2-S2-1 gives them (each unique). Step 2's red line and
  S2.4 Step 6's WI12 line name THREE tables at 36 rows
  (app/test/propertyFormFlyerParity.test.ts, requirements.test.ts :224-262
  and :598-641).
- WL-5 (D2-S2-2, MINOR) S2.3 Step 3c: `.priorityBadge` uses
  `background: var(--c-pill-unknown-bg);` (white text on `--c-warning` is
  4.28:1, rejected once already as code review RD-8), and the rule's comment
  per D2-S2-2.

## S3 - extraction reconciles the four fields

- WL-6 (D3-S3-1, MINOR) S3 start gate: the ContactItem assumption reads per
  D3-S3-1 (ContactItem declares the four VALUE keys; `<key>_source` rides the
  index signature, PR24). The gate holds; do NOT stop on it.
- WL-7 (D3-S3-2, MINOR) S3.3 Step 1b: the PROVENANCE case body becomes
  `expect(PROVENANCE_FIELDS).toEqual([...ORIGINAL, ...MATCHING, 'address']);`
  and Step 2's "$1,200" sentence reads "fails AGAIN after 3a-3c alone ... and
  only passes after 3e", per D3-S3-2.
- WL-8 (D3-S3-3, MINOR) S3.8 gains items 15-20 (journalSweep.ts:229, :251;
  journalSweep.test.ts:512; suggestionResolutionRecovery.test.ts:17;
  extractionSchema.test.ts:536; AiRunsSection.test.tsx:111 and :113-114) per
  D3-S3-3, and their files join S3.8's `git add`.
- WL-9 (D3-S3-4 + E2-readers-3, MINOR) S3.8 item 21:
  `e2e/support/selectors.md:81`'s order list becomes the sixteen targets
  (the four after `porting`, in list order) per D3-S3-4, and beside the
  `agency_not_authority` label exception add "`text_field_filled` reads
  `Field already filled`" (E2-readers-3); add the file to S3.8's `git add`
  (only ADDED lines must be ASCII - the file carries pre-existing em
  dashes). S6.7 gains the two RUNBOOK edits (RUNBOOK.md:1596 "eight scalar
  profile fields", RUNBOOK.md:614 the tenant-only accept list) per D3-S3-4.
- WL-10 (D3-S3-5, MINOR) S3.3 Step 1e: append the accept-path case
  "refuses a fractional or out-of-range dollars suggestion, KEEPING it (one
  coercion rule)" per D3-S3-5; add it to Step 2's RED list (today 400
  `unknown_target`: the status passes, the body assertion fails).
- WL-11 (E1-1, NOTE) The S3 report records, under risks, that the
  `text_field_filled` drop reads the run's contact snapshot
  (jobs/extraction.ts:438) and the batched write is unconditional
  (apply.ts:498-500): a staff fill landing during the model call is
  overwritten - the accepted last-write-wins class pets / tenure already
  have. No code. Filed: docs/issues/extraction-text-field-write-races-staff-fill.md.

## S4 - Notes lines

- WL-12 (D4-S4-1, BLOCKER) S4.2 Step 1, the case 'clamps confidence to 0..1
  and reads a non-number as 0' (plan line 6165): the third item is
  `{ text: 'missing' }` (NO confidence key), not `note('missing', undefined)`
  - the helper's default parameter turns `undefined` into 0.9. Expected
  values unchanged (`['over one']`, belowFloor 3).
- WL-13 (D4-S4-2, MINOR) The WI4 grep at S4.3 Step 4, the S4.7 Check and
  S4.8 step 5 becomes
  `git -C W:/tmp/wp1-b1-ranking-inputs grep -n -E "noteLines: \[('|noteLine\])" -- app/test e2e`
  with D4-S4-2's expected output (exactly 4 lines, all in
  app/test/extractionApply.test.ts - the three `.map((text) => note(text))`
  fixtures and the legacy-string case; before S4.7 it also prints the three
  e2e lines S4.7 migrates).
- WL-14 (D4-S4-3, MINOR) S4.6 Step 3's `new:` block is D4-S4-3's block: the
  "Profile notes lines ... earlier runs." sentence moves up into the noteLines
  bullet, and the NEVER bullet ends `animal are allowed. This is the
  never-written list.`; add the test line
  `expect(sys).toContain('animal are allowed. This is the never-written list.');`
  to the case 'states the never-written list ...'. This gives S5.5's
  "the never-written list" its referent (closes D5-S5-3).
- WL-15 (D4-S4-4, MINOR) The run-detail demotion row reads
  `{run.notesDemoted} withheld by the unknown-speaker rule`, in lockstep at
  S4.5 Step 3b, S4.5 Step 1 test 1 (`'0 withheld by the unknown-speaker
  rule'`), the S4 cross-slice note, and BOTH S5.8 anchor copies (old and
  new) of that `<li>`.
- WL-16 (D4-S4-5, NOTE) S4.4 Step 4 adds the escape check
  `git -C W:/tmp/wp1-b1-ranking-inputs grep -n -F "'\uffff'" -- app/src/repos/aiRunsRepo.ts`
  (prints the SORT_KEY_CEILING line). The same check runs after S5.7's edit
  to that file.
- WL-17 (E1-2, NOTE) The S4 report records, next to WI14, that the staff
  edit form replaces the whole Notes box from the copy it opened with
  (ContactEditForm.tsx:183, :228, :379), erasing `[Auto - ...]` lines
  appended while it was open. No code. Filed:
  docs/issues/contact-edit-form-notes-save-drops-auto-lines.md.

## S5 - feedback lines

- WL-18 (D5-S5-1, MINOR) S5.7 Step 3b's second edit and Step 3c use
  D5-S5-1's post-S4 anchors (`notedLines = filtered.append.length;` plus
  S4's two comment lines; S4's five-line return object) and new text
  (`appendedLines = filtered.append;`; the return gains `appendedLines`).
  S4's "(S5)" comment is replaced as given.
- WL-19 (D5-S5-2, MINOR) S5.7 Step 3g (recordRun), Step 3h (AiRunRecord) and
  S5.8 Step 3b (AiRunRecordView) anchor on S4's LAST line (the
  `notesDemoted` spread / field) per D5-S5-2; delete S5.8's sentence about
  `notedLines: number;` occurring at ~264 / ~2207.
- WL-20 (D5-S5-3, MINOR) CLOSED BY WL-14: S5.5's last bullet and its test
  phrase stay as planned. If the built S4.6 NEVER bullet does not end with
  "This is the never-written list.", STOP and report.
- WL-21 (D5-S5-4, MINOR) S5.5 Step 1a also renames the case at
  extractionSchema.test.ts:569 and rewrites the comment at :559-560 per
  D5-S5-4.
- WL-22 (D5-S5-5, NOTE) S5.7 Step 2: the aiRunsRepo PIN is typecheck-red
  "until Step 3h" (not 3g).
- WL-23 (D5-S5-6, NOTE) S5.4 Step 1d / 1g and S5.7 Step 4 use the absolute
  forms per D5-S5-6 (G2).
- WL-24 (E1-3, NOTE) S5.9 Step 3's WI10 grep becomes E1-3's pattern
  (adds `applyShareLedgerEntry|applyFlyerShareEntry|applyLaterAttempt|originalRowLedgerWrite|createListingSendsRepo`
  and `app/src/lib/propertyLabel.ts`); expect NO output (exit 1).

## S6 - the probe, the fake driver, the docs

- WL-25 (D6a-S6-1, MINOR) S6.2 Step 2: the dry-run placeholder comment is
  replaced by D6a-S6-1's explicit loop (`m.prompt.renderUtteranceLine(u)`),
  and "`prompt.` -> `m.prompt.`" joins the stated substitutions.
- WL-26 (D6a-S6-2, MINOR) S6.2's RED command is
  `cd W:/tmp/wp1-b1-ranking-inputs/app; env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL npx vitest run test/extractionPromptProbe.test.ts`
  with D6a-S6-2's added reason sentence (and G1 for every S6 run).
- WL-27 (D6a-S6-3, NOTE) The section 10 setup note reads per D6a-S6-3:
  constructing the driver or the structured-output client against the
  `vi.mock('@anthropic-ai/sdk')` stub in structuredOutputClient.test.ts is
  allowed; only the REAL (unmocked) SDK is forbidden.
- WL-28 (D6a-S6-4, NOTE, adopted) `parseProbeArgs` refuses `--out` unless
  `--suite never-written` or `--baseline` is given
  (`--out applies only with --suite never-written or --baseline`), plus the
  refuses-table row, per D6a-S6-4. Reason: a gate command typed without
  `--baseline` must not run and silently write no record.
- WL-29 (D6b-S6-1, MINOR) S6.4 test "a feedback control with no line naming
  its property fails the gate" also asserts the record's reason line per
  D6b-S6-1.
- WL-30 (D6b-S6-2, MINOR) S6.7 Edit 5 names the 4,000-character budget and
  the two block WARN lines per D6b-S6-2.
- WL-31 (D6b-S6-3, NOTE) S6.6 Step 2 anchors after S4.7's last line
  (`// EXTRACTION_FACT_MIN_CONFIDENCE (default 0.7).`) and opens with the
  shorter lead sentence per D6b-S6-3.
- WL-32 (D6b-S6-4, NOTE) S6.5 Step 2 also deletes the line
  `// Placeholders - S6.4 and S6.5 replace these two bodies.`.
- WL-33 (D6b-S6-6, NOTE) `renderNeverWrittenRecord` prints the PARTIAL
  verdict wording per D6b-S6-6 for a passing `--case` run.
- WL-34 (D3-S3-4, part of WL-9) S6.7 also edits RUNBOOK.md:1596 and :614
  per D3-S3-4.

## S7 - e2e (child), then the orchestrator's gates, self-QA and sheet

- WL-35 (D7-S7-1, MINOR) S7.2 test 2 is D7-S7-1's text: a `voucherSize`
  suggest sentinel in run 1, the server-truth GET of
  `/api/contacts/:id/suggestions`, and the sentinel chip awaited BEFORE the
  area-preference chip's count-0 assertion.
- WL-36 (D7-S7-2, MINOR) S7.3: a street line without the word Priority;
  publish through the listing-status PATCH while Priority is ON; the flyer
  JSON has no `priority` key; the flyer page's h1 positive BEFORE the
  absence check; exact match for the header pill - per D7-S7-2.
- WL-37 (D7-S7-3, MINOR) S7.1 declares
  `const BLANK = String.fromCharCode(0x2014);` and reads rows through the
  label span's parent per D7-S7-3; before the first S7 commit run the three
  `tr` ASCII checks (each prints 0).
- WL-38 (D7-S7-4, MINOR) Helpers are file-local: S7.2 uses
  conversation-fact-extraction.spec.ts's own helpers and adds exactly
  `import { createUnitViaApi, daysAgo, plantListedSend } from '../../support/followUpFixtures.js';`
  (NEVER `createTenant` from there - TS2440); each NEW file declares its own
  `NEXT` and `devLogin`; S7.1 may import `createTenant` from
  followUpFixtures; S7.3 copies `createLandlord`, `getUnit`, `publish` and
  `addPropertyFromLandlordPage` from property-requirements.spec.ts - per
  D7-S7-4.
- WL-39 (D7-S7-5, MINOR) `npm run e2e:session` starts in the shell tool's
  BACKGROUND mode; the first spec run waits for the launcher's
  `ready - app :...` line; a run that boots its own stack instead of
  "reusing the live e2e:session" means restart the sequence - per D7-S7-5.
- WL-40 (D7-S7-8, NOTE) `test.slow();` at the top of S7.3's test and S7.2
  test 4.
- WL-41 (D7-S7-10 + E2-readers-3, NOTE) S7 adds to e2e/support/selectors.md
  (ASCII added lines) the four new chip labels, the `Notes lines` region and
  its items, and the Priority checkbox / row / pill.
- WL-42 (D7-S7-6, MINOR; orchestrator) self-qa.md (S7.5) and
  gate-run-commands.md (S7.6) are committed as produced; the sheet names the
  commit the gates ran at and cites `MAX_OUTPUT_TOKENS` by name, not by line
  (D6b-S6-5).

## Orchestrator

- Filed with this worklist: docs/issues/extraction-text-field-write-races-staff-fill.md
  (E1-1), docs/issues/contact-edit-form-notes-save-drops-auto-lines.md
  (E1-2); appended the demotion consequence to
  docs/issues/voice-extraction-window-demotion-persistence.md (E2-readers-4).
- S7.4 / Phase 6 sync: if the merge changes package-lock.json, `npm ci`
  before the gates (D7-S7-7).
- S7.5 self-QA route for an MCP browser: D7-S7-9 (dev message fixture,
  "Run AI extraction", tick).
- WL-42 above.

## Recorded, no code

- D1-S1-3: TenantFile also serves team_member contacts, so the four rows show
  BLANK there exactly as the existing intake rows do; the edit form gates the
  controls on tenant. Spec D2 "as the other intake rows have".
- D3-S3-6: the dismiss PIN is green because dismiss returns its plan for any
  target before a target check (suggestionResolution.ts:282), not because of
  `isDecisionTarget`; conclusion unchanged.
- D3-S3-7: the bare-integer portion suggestion is guaranteed by apply's
  `String(coerced)`; `suggestionMatchesAppliedValue` runs only for `type`.
  S3.9's slice lint covers 10 of ~27 touched files; gate 5 covers all.
- E1-1, E1-2: filed (above); accepted residuals of the last-write-wins class.
