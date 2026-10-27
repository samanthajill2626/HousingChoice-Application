# D5-S5 findings - plan section 9 (S5 Feedback lines)

Reader D5-S5 checked plan lines 1-515 (binding sections 0-4) and 7734-10920
(S5: tasks S5.1-S5.9 and the S5 coverage table), plus S4's planned text in
plan lines 5792-7733 wherever an S5 anchor sits on it, against the worktree at
branch HEAD ede08552, whose app/, dashboard/, e2e/ and scripts/ are
byte-identical to main @d0e2c2d8 (`git diff --stat d0e2c2d8 HEAD` over those
paths is empty). Checked: every quoted anchor (verbatim, unique, and as S3/S4
leave it), every name/helper/fixture the S5 tests and code call, every
UnitsRepo implementation, every ExtractionInput literal and ExtractionJobDeps
construction site, the run-failing read path, the WI2 hash literals
(recomputed), the WI10 test and grep, the prompt bullets and pins, and the
run-detail guard. Nothing was run except a local sha256 of two literal strings.
Four MINOR findings and two NOTEs; no BLOCKER or MAJOR. Every finding is a
cross-slice or wording defect; the S5 logic itself traces correctly.

## D5-S5-1 - MINOR - S5.7's two apply.ts edits quote main's text; after S4 neither anchor exists and the literal "new" text does not compile

- Plan location: Task S5.7 Step 3b second edit (plan 10328-10338) and Step 3c
  (10340-10349). The text they must land on is S4.3 Step 3i/3j (plan
  7020-7072); S4's cross-slice note (5899-5906).
- What the plan says: 3b old `        notedLines = toAppend.length;`, new adds
  `appendedLines = toAppend;` ("use S4's name for that list"); 3c old
  `  return { wrote, suggested, notedLines, displaced, decisions };`, new
  `  return { wrote, suggested, notedLines, appendedLines, displaced, decisions };`
  ("keep S4's added fields").
- What the tree holds: main has both lines (app/src/services/extraction/apply.ts:746,
  :758), but S4.3 3i replaces section 8 wholesale: the success branch becomes
  `      notedLines = filtered.append.length;` followed by S4's comment "The model
  lines really appended are filtered.append.slice(0, filtered.modelCount) -
  counted here, after the write landed (S5)." (plan 7050-7052); no `toAppend`
  survives. S4.3 3j replaces the return with a five-line object carrying
  `notesBelowFloor` / `notesDemoted` (plan 7066-7071), both REQUIRED on
  ApplyOutcome after S4.3 3h. So both old strings match nothing; pasted
  literally, 3b references an undeclared `toAppend` and 3c drops two required
  fields (typecheck red at S5.7 Step 4). S4's comment also describes a design S5
  did not take (S5 C4: apply exposes EVERY appended line, model then system,
  and the job counts), so leaving it beside the new line misleads.
- Correction: replace S5.7 Step 3b's second edit and Step 3c with these exact
  post-S4 anchors.

  3b (second edit) old:
  ```ts
        notedLines = filtered.append.length;
        // The model lines really appended are filtered.append.slice(0,
        // filtered.modelCount) - counted here, after the write landed (S5).
  ```
  new:
  ```ts
        notedLines = filtered.append.length;
        // WP1 B1 spec D5.3 (S5 C4): every line appended, model then system,
        // exactly as joined into nextNotes - the job counts feedback lines over it.
        appendedLines = filtered.append;
  ```
  3c old:
  ```ts
    return {
      wrote, suggested, notedLines,
      notesBelowFloor: filtered.belowFloor, notesDemoted: filtered.demoted,
      displaced, decisions,
    };
  ```
  new:
  ```ts
    return {
      wrote, suggested, notedLines, appendedLines,
      notesBelowFloor: filtered.belowFloor, notesDemoted: filtered.demoted,
      displaced, decisions,
    };
  ```
  (Strip the two-space list indent; the target indentation is 6 spaces inside
  the try and 2 at the return.)

## D5-S5-2 - MINOR - S5.7 Step 3g/3h and S5.8 Step 3b quote adjacencies S4.4/S4.5 split; none matches after S4

- Plan location: S5.7 Step 3g (plan 10404-10417), Step 3h (10419-10439);
  S5.8 Step 3b (10626-10646). The text they must land on: S4.4 Step 3c
  (7241-7256), Step 3d (7258-7281); S4.5 Step 3a (7366-7387).
- What the plan says: 3g old `      notedLines: draft.notedLines ?? 0,` +
  `    };`; 3h old `  notedLines: number;` + `  expires_at: number;` + `}`;
  S5.8 3b old `  notedLines: number;` + `  expires_at?: number;` + `}`, with the
  note that the `expires_at?` line "makes this anchor unique". Each step says
  "after S4's count fields" yet quotes main's text.
- What the tree holds: those adjacencies exist on main
  (app/src/jobs/extraction.ts:672-673, app/src/repos/aiRunsRepo.ts:65-67,
  dashboard/src/api/types.ts:373-375), but S4.4 3c puts two spread lines
  between `notedLines: draft.notedLines ?? 0,` and `    };`, S4.4 3d puts
  `notesBelowFloor?` / `notesDemoted?` (with doc comments) between
  `notedLines: number;` and `expires_at: number;`, and S4.5 3a does the same in
  AiRunRecordView. After S4 all three old strings match nothing (the Edit
  fails; S5.8's uniqueness note is moot). Only S5.8 3c carries a STOP rule;
  these three do not say what to do.
- Correction: anchor on S4's last line instead (each is unique after S4).
  - S5.7 3g old:
    ```ts
          ...(draft.notesDemoted !== undefined && { notesDemoted: draft.notesDemoted }),
        };
    ```
    new:
    ```ts
          ...(draft.notesDemoted !== undefined && { notesDemoted: draft.notesDemoted }),
          ...(draft.feedbackLines !== undefined && { feedbackLines: draft.feedbackLines }),
          ...(draft.unlabeledAddressLines !== undefined && { unlabeledAddressLines: draft.unlabeledAddressLines }),
        };
    ```
  - S5.7 3h old (app/src/repos/aiRunsRepo.ts, AiRunRecord):
    ```ts
      notesDemoted?: number;
      expires_at: number;
    }
    ```
    new: the same three lines with the plan's existing 3h doc comment and
    `feedbackLines?: number;` / `unlabeledAddressLines?: number;` inserted
    between `notesDemoted?: number;` and `expires_at: number;`.
  - S5.8 3b old (dashboard/src/api/types.ts, AiRunRecordView):
    ```ts
      notesDemoted?: number;
      expires_at?: number;
    }
    ```
    new: the same with the plan's existing 3b doc comment and the two fields
    inserted between `notesDemoted?: number;` and `expires_at?: number;`.
    Delete the sentence about `notedLines: number;` occurring at ~264/~2207.

## D5-S5-3 - MINOR - The last feedback bullet points at "the never-written list", a name the post-S4 prompt never uses

- Plan location: S5.5 Step 3b, the last two prompt lines (plan 9402-9403), its
  test phrase in Step 1b (9322), the contingency note (9405-9406); S5
  cross-slice note (7884-7886).
- What the plan says: `'- Every other noteLine rule applies to feedback, the
  never-written list',` / `'  included.',`, and "(If S4 named its list
  differently, use S4's exact name in the last bullet AND in the test phrase.)"
- What the tree holds: S4.6 Step 3 (plan 7543-7551) states the list as the
  bullet `'- NEVER write a noteLine stating any of these, even when the client
  says it:'` and never calls it "the never-written list"; main's prompt
  (app/src/services/extraction/prompt.ts:12-134) has no such name either. The
  contingency cannot fire (S4 gives the list no name at all), so the model
  reads a reference to an unnamed list in the one bullet that ties spec D5.2's
  last rule ("The never-written list governs feedback like any line") to the
  prompt - the rule Cameron's never-written gate run measures.
- Correction: S5.5 Step 3b, replace the last two new prompt lines with
  ```ts
      '- Every other noteLine rule applies to feedback, including the "NEVER write',
      '  a noteLine stating any of these" rule above.',
  ```
  and in Step 1b replace
  `expect(sys).toContain('- Every other noteLine rule applies to feedback, the never-written list');`
  with
  `expect(sys).toContain('- Every other noteLine rule applies to feedback, including the "NEVER write');`
  (one prompt line, ASCII; still RED before Step 3).

## D5-S5-4 - MINOR - After S5.5 an existing case's name, and a sibling comment, say the opposite of what the prompt now does

- Plan location: S5.5 Step 1a (plan 9278-9294); the note on the sibling case
  (9338-9340).
- What the plan says: Step 1a flips the assertion to
  `expect(sys).not.toContain('Addresses NEVER go in noteLines')` and adds a
  comment, keeping the case and its name.
- What the tree holds: app/test/extractionSchema.test.ts:569 is
  `it('carries the address hard rules (current-residence only; never in noteLines)', ...)`;
  after S5.5 it asserts the no-address bullet is GONE. The sibling case's
  comment at :557-560 says a baked-in street address would "model the one
  thing the address rules forbid - putting an address in a noteLine", which is
  false once PR50 lands and the prompt itself carries the
  "123 Main St, Decatur: on the fence ..." feedback example.
- Correction: add to S5.5 Step 1a two edits in the same file.
  - old `  it('carries the address hard rules (current-residence only; never in noteLines)', () => {`
    new `  it('carries the address hard rule (current-residence only); the no-address bullet is gone (PR50)', () => {`
  - old (:559-560)
    ```ts
        // prompt forever and model the one thing the address rules forbid - putting an
        // address in a noteLine.
    ```
    new
    ```ts
        // prompt forever and teach the model a real client's address. (WP1 B1
        // PR50: a feedback noteLine may now name a sent property; not this one.)
    ```

## D5-S5-5 - NOTE - S5.7 Step 2 names the wrong step for the aiRunsRepo PIN's typecheck

- Plan location: S5.7 Step 2 (plan 10288-10289).
- What the plan says: the new aiRunsRepo (PIN) "is red only at typecheck until
  Step 3g".
- What the tree holds: Step 3g edits recordRun in app/src/jobs/extraction.ts;
  the fields the PIN's `draftRecord({... feedbackLines, unlabeledAddressLines })`
  needs on AiRunRecordInput (app/src/repos/aiRunsRepo.ts:69) land in Step 3h
  (`sentPropertiesFingerprint` already landed in S5.6 Step 3g).
- Correction: read "until Step 3h".

## D5-S5-6 - NOTE - Three verification greps use relative paths or no path; the shell cwd is the SHARED main checkout

- Plan location: S5.4 Step 1d (plan 9015-9016), S5.4 Step 1g (9091-9092),
  S5.7 Step 4 (10451-10452).
- What the plan says: `grep -c "      orgListBlock: '',$" app/test/extractionSchema.test.ts`;
  `grep -c "orgListBlock: '', profile:"` (no file argument at all);
  `grep -rn "ApplyOutcome" app/src app/test app/scripts`.
- What the tree holds: plan section 0 / PR29 and the Claude overlay say the
  shell cwd resets to `W:/AI Projects/Housing Choice/HC Application` between
  calls, so the relative forms read the shared main checkout (equal today,
  wrong once main moves) and the bare form reads stdin.
- Correction: use absolute paths:
  `grep -c "      orgListBlock: '',$" W:/tmp/wp1-b1-ranking-inputs/app/test/extractionSchema.test.ts` (prints 4),
  `grep -c "orgListBlock: '', profile:" W:/tmp/wp1-b1-ranking-inputs/app/test/extractionAdapter.test.ts` (prints 8),
  `git -C W:/tmp/wp1-b1-ranking-inputs grep -n "ApplyOutcome" -- app/src app/test app/scripts`.

## Verified with no finding

- S5.1: `Address` (app/src/lib/address.ts:12-21) is all-optional, so every typed
  fixture compiles; propertyLabel / labelMatches / hasStreetAddress hand-traced
  against every case (the `ter`/`terrace` and `st`/`street` alternation
  backtracking, the five-word and "Streetcar" negatives, every boundary case) -
  each passes as stated; target ES2023 (tsconfig.base.json:6) covers for-of
  over strings and `\p{..}` with `u`; the leaf test's two regexes hit no line of
  the planned source; no `\u` escape; files do not exist yet.
- S5.2: anchors verbatim and unique (unitsRepo.ts:49, :661-668, :1276-1277,
  :1304-1306, :1309-1311; contactsRepo.ts:677-688); stubDoc / makeRepo /
  unitIds / keysOf / capture.atLevel exist with the shapes used (call is
  1-based, 4 attempts = request + 3 retries, chunks sequential), so
  `toHaveLength(4)` and `[100, 100]` hold; the default path WARNs once; no test
  pins the contacts message; the ONLY UnitsRepo implementations are
  unitsRepo.ts:1276 and the harness fake twilioWebhookHarness.ts:2991 (one
  parameter - still assignable); the only caller tours.ts:551 is unchanged;
  every two-argument `new IncompleteBatchReadError` site keeps "contacts".
- S5.3: ListingSendItem required fields and ShareLedgerEntry
  (listingSendsRepo.ts:65-126); listByContact already applies isListed
  (:486-497); FLYER_SHARE_KEY = 'flyer' and latestCountedShareKey accepts the
  shares map (shareLedgerKeys.ts:17, :37-47); every block and counter case
  traced (order, dedupe newest, TRANSCRIPT drop, budget, oldest-first stop,
  fingerprint, unlabeled).
- S5.4: anchors verbatim (adapters/extraction.ts:120-123; prompt.ts:4-7,
  :194-195; jobs/extraction.ts:586; probe :205); EVERY ExtractionInput /
  buildExtractionUserContent literal is covered (schema test 4 + 1, adapter
  test 8, run-window test 1, job, probe; none elsewhere, none added by S1-S4;
  LF endings, so the 4/8 counts hold); WI2 literals recomputed - sha256
  prefixes `8804bb247bad2f59` and `f0196a44d5ac9368` are correct;
  `ExtractionProfileSnapshot.contactType` is `string`, so the unannotated
  `profile` const compiles; the anthropic driver passes the whole input to the
  builder (adapters/extraction.ts:265).
- S5.5: prompt.ts:20-23, :124-125, :132-133 verbatim and untouched by S3.6 and
  S4.6; extractionSchema.test.ts:573-575 verbatim; every asserted phrase sits
  inside one prompt line and is RED before Step 3; the :556-568 slice stays
  address-free; nothing else pins the deleted bullet.
- S5.6: anchors verbatim (jobs/extraction.ts:50-51 - S3.5 inserts after :51,
  still adjacent - :108-110, :315-316, :580-581, :665; aiRunsRepo.ts:58-59;
  worker.ts:458-460 and :468-469 inside the `if (config.aiExtractionEnabled)`
  block, so the new `await import` consts shadow nothing; dev.ts:745-746 with
  both factories imported at :59-60); the four ExtractionJobDeps sites are the
  only ones (dev.ts `extractionTickDeps` is never injected by a test); harness
  anchors extractionJob.test.ts:33, :47, :234-236, :246-248, :296-299, :312
  and extractionJobDraftGuard.test.ts:173 verbatim and composing with S4.3
  1i/1j; every helper the tests call exists; `failed('repo', err)` records
  `err.message` (:404-407), the org-list read fails the same way (:563-568),
  and repo.fail backs off and parks at MAX_EXTRACTION_ATTEMPTS (:755-778);
  `contact` is narrowed at the new read; no test pins whole runs or seen
  inputs; the WI10 proxy can fail (a write through either dep throws and is
  recorded) and the WI10 grep names the repo's three writers
  (listingSendsRepo.ts:195, :213, :222) and prints nothing today; the instance
  role covers every stack table and index (infra/modules/ec2/main.tf:42-62).
- S5.7: both pins compose with S4.3 Step 1c (6-space indent at :268-273);
  3a, 3b-first, 3e and 3f anchors match post-S4; makeDeps findByPhone /
  updateImpl and run() exist; '555-010-9999' becomes +15550109999
  (extractionApply.test.ts:607-620); the job prefix is [Auto - Jul 17]
  (apply.ts:175, NOW); apply runs on every successful call, so a no_op run
  records 0/0; draftPiece (jobs/extraction.ts:379); makeFakeDoc / repoWith /
  draftRecord / 'run#run-1' exist and putRun spreads its input
  (aiRunsRepo.ts:225); ApplyOutcome has no other literal.
- S5.8: S4.5's NotesLines anchors compose verbatim; the heading's parent is the
  `<header>` (AiRunDetail.tsx:70), so the header assertion is sound; the
  default fixture has notedLines 0 and no counts (AiRunsSection.test.tsx:26),
  so the PIN and the RED claims hold; types.ts:355-356 verbatim; the detail
  route returns the stored run whole (aiRuns.ts:272); dashboard tsconfig
  includes test files.
- Lint and ASCII: no unused import or binding in any S5 block; the plan is
  ASCII; the only `\u` near an S5 edit is aiRunsRepo.ts:124, which the plan
  checks.
