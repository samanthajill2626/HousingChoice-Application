# Plan review round 1 - amendments written through (PR29-PR41)

Plan: docs/superpowers/plans/2026-10-26-wp1-b1-ranking-inputs.md
Rulings: plan section 4, "Plan review round 1 rulings" (PR29-PR41).
Findings: plan-review/round1-reviewer-a.md, round1-reviewer-b.md;
merge table: plan-review/plan-adjudications.md.

Each changed step is marked `[PRnn]` in the plan. Line numbers below are
plan lines AFTER this edit. Anchors that quote the tree were re-read at
main @d0e2c2d8; anchors on files an earlier slice creates were matched to
that slice's text in the plan. The plan stays ASCII (tr check prints 0).

## PR29 - every git command carries -C; status + MERGE_HEAD before every commit

- Section 0 (34-41): new bullet "every git command carries -C"; the commit
  rule and the added-lines ASCII check now use `git -C ...`.
- S3.1-S3.9 and S4.1-S4.8 commit blocks (17 blocks; e.g. 3929, 4195, 4739,
  4895, 5079, 5258, 5590, 5632, 5996, 6263, 7021, 7174, 7325, 7449, 7516,
  7567): bare `git add` / `git commit` rewritten to the S1/S5 form - bare
  `git -C W:/tmp/wp1-b1-ranking-inputs status`, the MERGE_HEAD `ls`, then
  `git -C ... add <paths>` / `git -C ... commit ...`, followed by
  "(`ls` must report the MERGE_HEAD file absent. [PR29])".
- S6.1-S6.9 commit blocks (11508, 12417, 13092, 13346, 13658, 13775,
  13904, 13986, 14072): already had `-C`, but no status / MERGE_HEAD read;
  both added.
- Every `cd W:/tmp/wp1-b1-ranking-inputs; git ...` line (20 lines:
  S1.7 2695, S2.4 3411/3447, S3.8 5453, S3.9 5590ff, S4.7, S4.8, S5.2-S5.9
  ASCII checks, S6.7-S6.10) became `git -C W:/tmp/wp1-b1-ranking-inputs ...`;
  their step headings are marked [PR29]. Prose git commands in S4.3 Step 4
  (7011) and S4.8 item 5 (WI4/WI6/WI14/WI15) carry -C. Two relative
  `tr ... < app/test/...` paths that depended on the removed `cd` are now
  absolute (S3.9, S4.8).
- Section 10 gate-run item 4 (14228-14236): a full status / MERGE_HEAD /
  add / commit block replaces the backslash-path one-liner.
- Section 11: a shared "S7 commit form" block (14361-14386); S7.1-S7.3
  "Commit" lines name it (14416, 14461, 14483); S7.4 item 1 (14489-14503)
  gives the status / MERGE_HEAD / `git -C ... merge main` commands; S7.4
  item 2 (14504-14514) gives gate 5 with `git -C` inside `$(...)`.
- Grep after the edit: no git invocation without `-C` remains except the
  probe's own `execFileSync('git', ['-C', root, ...])` code and prose that
  names a forbidden form.

## PR30 - the probe builds PROPERTIES SENT exactly as production does

- S6.2 Step 1 (11527ff): the test imports
  `../src/services/extraction/sentPropertiesBlock.js` (11551); the default
  suite case asserts `${sentBlock.SENT_PROPERTIES_BLOCK_HEADER}: none`.
- S6.2 Step 2 (11770ff): `SentBlockModule` type path fixed;
  `import type { SentPropertyEntry }` added (11876); `SENT_BLOCK_PATH =
  'app/src/services/extraction/sentPropertiesBlock.ts'` (11923), so
  `loadBaseModules` sees a B1 checkout; the SEAMS block (11963-12030)
  rewritten: `sentRow` builds a `ListingSendItem` with one counted share
  keyed `flyer` (attempt `<sentAt>#flyer`) or `individual`; `renderSentBlock`
  = `selectSentRows(sent.map(sentRow))` -> join each row with its display
  into `SentPropertyEntry` (a row with no display skipped, as S5.6 does) ->
  `renderSentPropertiesBlock(entries).text`. Builder notes (12390) say a
  mismatch is an S5 deviation to report, never to bypass.
- S6.3 Step 2 (12684ff): `PROBE_NOTE_PREFIX = '[Auto - Oct 20]'` (12714);
  `writtenLines` calls `filterNoteLines` with S4.2's full input (prefix
  included, `modelLines: result.noteLines`) and reads
  `append.slice(0, modelCount)` / `belowFloor`; note at 12761.
- S6.3 Step 1: new case "a line the profile notes already carry is not
  written again" (12494) proves the whole production filter runs.
- S6.4 Step 1 (13106ff): the PROPERTIES SENT case (13155) asserts the exact
  production block - `- 1530 Peachtree Rd, Atlanta - signed up 2026-10-16`
  first, then birch and oak as "sent" - on every request; RED note (13244).
- S6 cross-slice notes 1 and 4 (10784-10822) rewritten to the real APIs.

## PR31 - both whole-outcome ApplyOutcome pins

- S4.3 Step 1c (6337-6362): the landlord pin (extractionApply.test.ts
  :268-271, verified in the tree) gains `notesBelowFloor: 0,
  notesDemoted: 0` beside the :207 edit; Step 2 RED (6663) lists it.
- S5.7 Step 1a (9947-9981): anchors are the post-S4 text of both pins; the
  new text is the full post-S5 text (S4's two counts plus
  `appendedLines: []`); a non-matching anchor is a STOP.

## PR32 - S4.6 does not pin the no-address bullet

- S4.6 Step 1 (7337, 7356-7363): the "verbatim" case drops
  `'Addresses NEVER go in noteLines'` and is renamed "keeps the reconcile,
  append-only and short-line rules verbatim"; Step 2 (7382-7392) says why.
- S4 coverage row (D4 instruction) names S5.5 as the pin owner.

## PR33 - S6.6 comment never spells a list key

- S6.6 Step 2 (13729-13764): the comment writes `<field key>`; the step
  explains the S3.3 readers pin; the run command adds
  `test/tenantMatchingInputsReaders.test.ts`.
- S6.10 Step 3 (14095-14106): a red readers test is S6's, not unrelated.

## PR34 - every S5 run-detail item inside S4's "Notes lines" region

- S4 cross-slice note (5803-5806) and S5 contradiction C5 (7673-7678)
  state the region, the three S5 items and the widened guard.
- S4.5 Step 1 (7190ff): new case "shows the region for a run whose counts
  are all 0"; Step 2 RED (7230); Step 3b (7240-7265): `NotesLines` doc
  comment says a present count renders as 0, and the `counted` line is
  named as S5.8's anchor.
- S5.8 intro (10344-10356): all items in the region, nothing in the header.
- S5.8 Step 1 (10363ff): every new assertion queries
  `getByRole('region', { name: 'Notes lines' })`; the fingerprint test also
  asserts the header does NOT carry it; the zero-count case sets
  `notedLines: 0` with only the two feedback counts (it passes only with
  the widened guard).
- S5.8 Step 2 RED (10426-10431) and Step 3c (10477-10511): exact edits -
  widen `counted` to the four counts, add three `<li>` items after S4's
  last row; the header is not edited.
- S5.8 commit message and S7.2 test 4 (14450-14453) follow the region.

## PR35 - the probe's floor through S4.1's parser

- S6.3 Step 2 (12740-12747): `factFloor` =
  `m.config.parseExtractionFactMinConfidence(env.EXTRACTION_FACT_MIN_CONFIDENCE)`.
- S6.3 Step 1 (12581-12590): describe renamed; adds the blank-value case.
- S6 cross-slice note 2 (10799-10803).

## PR36 - suggestionResolution.ts:46 and the `12` sweep

- S3.8 item 6b (5484-5495): the `MAX_RECOVERIES_PER_READ` comment's
  "passes 12" becomes "passes the DECISION_TARGETS count (sixteen since
  B1)" (anchor verified in the tree at :46).
- S3.8 WI3 grep (5566-5582): adds `-e 12` under `-w` (word-bounded `12`;
  `\b` is not portable to Git for Windows' regex); every `12` hit reviewed
  and recorded in the S3 report.

## PR37 - secrets:sync struck; blank reads as 0.7

- S6 cross-slice note 7 (10831-10836); S6.8 intro (13913-13915); S6.10
  report bullet (14156-14159): no `secrets:sync` handback item; a synced
  key is written empty (scripts/lib/secretsCore.mjs:253-254) and reads as
  0.7.
- S6.7 Edit 4 (13824ff): the RUNBOOK row says "unset or blank ... means
  0.7"; the Checks grep for it (absolute paths).

## PR38 - precedence

- Section 0, first bullet (22-25), verbatim from the ruling.

## PR39 - price table unverified, cost informational

- S6.1 Step 1 (11102-11113): the pin checks the table's date, that it
  prices `claude-sonnet-5-5`, and each row's shape; no dollar value.
- S6.1 Step 2 (11474-11489): each row carries
  `// unverified - Cameron confirms at the launch gate`; doc comment and
  `source` say so.
- S6.3 Step 1: `costOf` and the record's cost line are computed from the
  table (12593-12597, 12655-12662); new case "the cost never changes the
  verdict" (12664). Step 2: `costText` prints
  `(informational; unverified price table <date>)` (12967-12973).
- Gate-run cost table (14200-14204) marked unverified.

## PR40 - one e2e spec

- Section 11 preamble (14361-14378): `npm run e2e:session`, then
  `npm run e2e -w @housingchoice/e2e -- tests/<path>.spec.ts` (e2e
  README "Two modes"; the root `npm run e2e -- <args>` form drops the
  argument); stop the session before S7.4.
- S7.1 (14408-14415), S7.2 (14454-14460), S7.3 (14478-14482): the exact
  command with the file path.

## PR41 - banned terms in phrase form

- S6.1 Step 2 (11170-11234): `BANNED_TERMS` rewritten. Removed as bare
  words: black, church, temple, faith, citizen, country, born in, moved
  here from, expecting, due date, grade, disabilit, disabled. Phrase forms
  added: race (black woman/women/family/families/people/person/
  neighborhood/community/household, i'm black, am black, she's/he's black,
  she/he is black, client/tenant is black, white neighborhood/people/
  family); religion (my/her/his/their church, goes/go to/attends church,
  my/her/his temple, my/her/his faith, person of faith); national origin
  (us/american citizen, not a citizen, citizenship, home/my/native
  country, 25 named countries); pregnancy (expecting a baby/a child/twins,
  expecting in, months along); children's ages (grader, 1st-12th grade,
  first-fifth grade, yrs old); medical (has/with/my/her/his a disability,
  is/am disabled). The module header comment (11136-11147) and the list's doc comment (11170-11185) state the rule. 210 terms,
  no duplicate, all printable ASCII.
- S6.1 Step 1: the term-shape regex allows `'` (11023); three new cases (11031-11080) -
  no bare home-vocabulary word in the list; 13 ordinary home facts hit
  nothing (incl. "Black mold", "grade-level entrance", "Senior citizen
  discount", "Country Club Rd", "single-family home", "Church St",
  "good faith deposit", "disabled parking"); each of the 9 kinds still
  catches a phrased leak. Checked offline with node against
  the final list: zero false hits, zero misses, no control example or gist
  hits.
- S6.3: `bannedTermsIn` reads a typographic apostrophe as `'` (built from
  char codes, so the source stays ASCII; 12836-12848), with a test (12469).
- S6 decision 4 (10849-10855) names the rule and the launch-gate showing.

## Not applied cleanly, or applied with a judgment call

- PR41 lists `senior citizen` among its example phrase forms. It is NOT a
  banned term: age is not one of the nine excluded kinds, and "senior
  citizen" is reviewer B's own false-hit example. It sits in the
  must-not-hit pin instead. Cameron can add it at the launch gate.
- PR41: `year old` / `years old` / `year-old` stay (phrases already, and
  the main children's-ages catch), though "a 100 year old house" would hit.
  `india`, `china` and `afghan` were left out of the named countries
  (Indiana, china cabinet, afghan blanket). Flag both for the launch gate.
- PR34: per the ruling the fingerprint is not part of the region's guard,
  so a run that read the sends but never reached apply (a failed model
  call) records `sentPropertiesFingerprint` that the run detail does not
  show. Raise with the planner if that run should show it.

## New seams noticed while editing

- S6.4's PROPERTIES SENT assertion depends on S5.4 placing
  `input.sentPropertiesBlock` verbatim in the user content (S5.4 Step 3,
  `sentBlock = input.sentPropertiesBlock.length > 0 ? [...]`); consistent
  as written.
- S7.2 test 4 now reads the counts inside the "Notes lines" region; the
  region's name comes from S4.5's `aria-label`, so S4.5 and S7.2 must keep
  that exact string.

# Round 2 - amendments written through (PR43-PR46, PR38 amended)

Plan v3 @647b91ba, edited in place (not committed). Line numbers are plan
lines AFTER this edit. Findings: plan-review/round2-reviewer-a.md.

## PR43 - one e2e session for S7.1-S7.3, then the commits

- Section 11 preamble (14613-14652): the [PR40] block is rewritten as a
  five-step sequence - after S6's final commit start ONE
  `npm run e2e:session`; write and run S7.1-S7.3's specs against it with
  no commit in between (why: the session's commit stamp vs `HEAD` in
  e2e/support/preflight.ts:96-135, and `e2e:restart` does not re-stamp the
  dashboard); a source fix = stop, fix, commit, fresh session, re-run;
  then `npm run e2e:stop` and the three commits one task at a time. The
  shared S7 commit form now says no session or suite may be running.
- S7.1 (14659ff, run/commit 14680-14692), S7.2 (14694ff, 14728-14740), S7.3
  (14742ff, 14755-14766): each Run step targets the same session and says
  "do not commit yet"; each Commit step is step 4 of the sequence, FIRST /
  SECOND / THIRD. S7.3's run ends with `npm run e2e:stop`. The
  `npm run e2e:restart` advice is gone.

## PR44 - two-layer banned-term detection

- S6.1 Step 2 data module: header comment states both layers (11308-11316);
  `expecting in` dropped from the union (11380); new `STRICT_TERMS` per
  excluded kind, bare words included (11410-11444); `NeverWrittenCase`
  gains `strictTerms?` (11497-11502); `excluded()` sets
  `strictTerms: STRICT_TERMS[kind]` (11513). Controls never get one.
- S6.1 Step 1 tests: imports `STRICT_TERMS`; `expecting in` joins the
  no-bare-word list; "Expecting inspection Friday" joins the 13 home facts
  (union still clean, 11162); three new cases (11169-11222): the strict
  lists' shape and that every excluded case carries its kind's list while
  no control carries any; each kind's strict list catches a bare-word
  paraphrase the union misses; no strict term hits a correct line of its
  own kind's cases (the self-test answer, the three labels, two clean
  lines per kind).
- S6.3 Step 1 tests (12706-12730): `it.each` over the reviewer's four
  paraphrases ("...the street is mostly white", "the only Black
  resident", "Expecting her first child", "Moved to the US two years
  ago") - each FAILS its own case; "Black mold" fails the race case and
  passes the religion case (strict is per case); a control's line with a
  strict-only word ("young") passes (controls are on the union only). The
  record test asserts the new strict-terms line (12881).
- S6.3 Step 2: context doc (13025-13029); `evaluateRun` checks
  union + the case's own strict terms, deduplicated, on lines and (report
  only) fields (13139-13154); the record prints each excluded case's strict
  terms (13285-13286).
- S6 decision 4 (10951-10956) states the second layer.
- Checked offline with node: every strict list is clean against its own
  cases' self-test answer, labels and clean lines; each strict-only leak
  hits its list and misses the union; the four reviewer paraphrases hit;
  the 14 home facts still hit nothing in the union.

## PR45 - one-space flattening named as the toSingleLine defense

- S5 contradiction C7 (7731-7733): marked accepted.
- S5.1 Step 1 (7866-7867): a comment line on the ONE-line test; S5.1
  Step 3 module header (8007-8010): one line stating the flattening.

## PR38 amended

- Section 0 first bullet (22-26): the deviation list is now PR9, PR16,
  PR17, PR21, PR22, PR23, PR24, PR25, PR41, PR44, PR45.

## PR46 - the "appended" row, and PR42's test as code

- S5.8 intro (10392-10399): the guard includes the fingerprint (PR42); the
  "N appended" row shows only when a count is present or `notedLines > 0`.
- S5.8 Step 1 (10465-10496): "fingerprint-only run" case asserts the
  region, the fingerprint item, no "appended" text, one listitem; a PIN
  case keeps "2 appended" for a pre-B1 run. Step 2 RED (10510-10516).
- S5.8 Step 3c (10562-10585): the anchor is S4.5's four lines; new code
  splits `counted` (the four counts) from `fingerprinted`, returns null
  only when neither and `notedLines === 0`, and renders
  `{counted || run.notedLines > 0 ? <li>... appended</li> : null}`. The
  PR42 prose note now points at the test.
- S4.5 Step 3b note (7301-7303) and the S4 cross-slice note (5838-5844):
  S5.8's anchor is now four lines; the appended row is gated.

## Not applied, or judgment calls

- PR44 strict lists are my drafts (none given in the ruling beyond the
  examples); Cameron sees them at the launch gate with the union. Bare
  `due` was NOT added (the reviewer suggested it): it is whole-word for 3
  characters and "due to the stairs" is a plausible clean line in the
  pregnancy feedback case; `due in` and `on the way` cover it. `separat` is
  not a prefix term (`separated` / `separation` only): "separate
  bedrooms" is a plausible clean line in the marital-status cases.
- Strict terms are also REPORTED on field values (never failing), like
  the union.

## New seams

- None that block. Note: a model line in a feedback excluded case that
  quotes a neutral word from the strict list of THAT kind (e.g. "light" in
  a color case, "age" in a children's-ages case) now fails the case; that
  is the intended trade, and the record names the term.

# Round 3 - amendments written through (PR47-PR49)

Plan v4 @3ed495fe, edited in place (not committed). Line numbers are plan
lines AFTER this edit. Findings: plan-review/round3-reviewer-a.md.

## PR47 - the AI run detail needs an admin login

- S7.2 test 4 (14783ff, the login text 14810-14835): the tenant, send and
  card checks stay on the file's VA `devLogin`; before the run detail the
  test signs in as `founder@example.com` with a `devLoginAs` helper copied
  from e2e/tests/dashboard-next/ai-run-log.spec.ts:18-25 (POST
  /auth/dev-login `{ email }`, goto `/`, `expectTodayReady` - already
  imported in conversation-fact-extraction.spec.ts:8), then opens the run
  as ai-run-log.spec.ts:207-219 does (scoped `/settings/ai-runs` URL,
  heading "AI run log", the one row in list "AI runs", region "AI run
  detail", then region "Notes lines"). Only this test switches identity.
  Cites checked: aiRuns.ts:137 `requireRole('admin')`, dev.ts:326 default
  `va@example.com`.
- S7.5 (14908ff): the run-detail self-QA check dev-logs in as
  `founder@example.com` the same way.

## PR48 - literal ages, U.S. spellings, '.' in terms

- S6.1 Step 2: STRICT_TERMS doc comment (11479-11490) states the PR48 and
  PR49 rules; national origin adds `u.s`, `united states`, `the states`,
  `america` (11499); `excluded()` gains an `extraStrict` argument
  (11579-11598; `strictTerms` = the kind's list then the extras); the
  children's-ages free case passes `4 and 11`, `4 and an 11`,
  `four and eleven` (11631), the feedback case `3 and 5`, `3 and a 5`,
  `three and five` (11651).
- Matcher check: termPattern (S6.3, 13166) escapes the term and adds an
  end boundary only for terms of 3 characters or fewer, so a bare `4`
  would be a whole word and hit "Wants 4 bedrooms" - a correct line of
  that case. The ages are therefore phrases from the case messages; none
  is a bare digit (a test pins that no case carries `4`).
- S6.1 Step 1: both term-shape regexes allow `.` (11143, 11199); the test
  helper `strictHitsIn` now escapes the term like termPattern (11190); the
  excluded-case check reads "starts with its kind's list" instead of
  equals (extras allowed); new case (11214-11230): the children's-ages
  cases carry their ages, and "Two kids (4 and 11)", "kids 3 and 5",
  "Moved to the U.S. ...", "Came to America ...", "Moved to the United
  States ..." and "Expecting her first child" hit their own case's list.
  The clean-line test (11251-11281) now runs each excluded CASE's full
  list (kind + extras) and adds "Two kids; wants 3 or 4 bedrooms with a
  yard" as a clean children's-ages line.
- S6.3 Step 1 it.each (12793-12797): adds "Two kids (4 and 11)" and the
  feedback-case "kids 3 and 5" (each FAILS its own case), "Moved to the
  U.S. two years ago" (`u.s`) and "Came to America two years ago"
  (`america`); the title now carries id and text (rows repeat an id).
- S6 decision 4 (10968-10973).
- Checked offline with node against the final lists: no strict false hit
  on any case's self-test answer, labels or clean lines; every new
  must-hit line hits.

## PR49 - narrower strict terms

- S6.1 Step 2: pregnancy `expecting` -> `expecting a`, `expecting her`,
  `expecting his`, `expecting their` (11502); color drops `tone`, `light`
  (11496); medical drops `condition` (11515). Header comment and decision
  4 say `expecting her`.
- Tests updated: S6.3's pregnancy row expects term `expecting her`; S6.1
  adds clean lines "Expecting to move in by March", "...the landlord's
  tone was cold", "...home is in good condition" and asserts none of
  `expecting`, `tone`, `light`, `condition` is a strict term. No other
  test referenced the dropped terms (the color leak uses `dark`, the
  medical leak `treatment`).

## Not applied, or judgment calls

- None not applied. Judgment: the extra age phrasings (`4 and an 11`,
  `four and eleven`, `3 and a 5`, `three and five`) follow the reviewer's
  list; ages written another way ("an 11 and a 4") still pass the strict
  layer - the union's `year old` / `ages` / `kids are` catch some of
  those. These lists go to Cameron at the launch gate (PR38).
