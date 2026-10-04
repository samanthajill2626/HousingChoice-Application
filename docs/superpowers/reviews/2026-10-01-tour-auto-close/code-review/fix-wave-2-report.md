# Fix wave 2 report - code review round 2 (feat/tour-auto-close)

- Date: 2026-10-04. Implementer: the fix-wave-2 subagent (Claude Opus 5.5),
  worktree `W:\tmp\tour-auto-close`, starting HEAD 608c3947.
- Scope: exactly FW2-1..FW2-5 of `code-review/adjudications-r2.md` section 2.
  Tests and docs only: no runtime file changed, and
  `git diff --quiet -- app/src` was 0 at every commit. Section 6 lists what
  went beyond the literal list, and why.
- Vitest output below is copied from the runs; vitest prints a `$name` value
  in single quotes, and its ellipsis is written here as `...` (ASCII rule).
- Line refs are at the final HEAD of this wave.

## 1. Commits

| item | commit | subject | files |
|---|---|---|---|
| FW2-1 | 3263c3d5 | test(tours): each auto-close race row proves its own term (review r2 R2-1) | `app/test/toursRepo.integration.test.ts`, `app/test/toursRepoFakeConditions.test.ts` |
| FW2-2 | 7d3ec78e | test(worker): pin the tour auto-close poll and its own interval (review r2 F12) | `app/test/jobQueueWiring.test.ts` |
| FW2-3 | 6b4c01e4 | docs(spec): tour auto-close 6.6 and 11 name the never-marked updatedAt term (review r2 R2-2) | `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md` |
| FW2-4 | ec2d94e9 | docs(issues): close-nag wording and line refs re-derived at HEAD (review r2 R2-3) | `docs/issues/tour-reopen-edge-states.md`, `docs/issues/tour-relay-open-vs-auto-close-race.md`, `docs/issues/tours-scheduled-range-query-unpaginated.md` |
| FW2-5 | (this file's commit) | docs(records): tour auto-close fix wave 2 report | this file |

## 2. FW2-1 (R2-1) - every race row proves its own term

The table (`app/test/toursRepo.integration.test.ts:725-826`) now has a `term`
per row (the condition term its change breaks) and a `reads` list; the cases
are rows x reads (`:805`), and the title names both the read and the term, so
a red row names what it proves:

- every change row runs on a NEVER-MARKED read and on a MARKED read (created
  with `lastMarkedAt: '2026-09-10T00:00:00.000Z'`), except "a person marked it
  for the first time" (never-marked by construction) and "a person marked it
  again" (marked by construction): 15 cases where there were 8;
- a raw-write row, "a raw write marked it, updatedAt kept" (`:791-796`): its
  change is `rawFirstMark` (`:707-723`), a direct `UpdateCommand` on the doc
  client that SETs only `lastMarkedAt`, and then asserts the stored row
  equals the pre-write row plus the mark - so on the never-marked read the
  only term that can fail is `attribute_not_exists(#lm)`, and the test itself
  proves that;
- the FW-1 pair is unchanged (`:839`, `:858`);
- the comment (`:725-737`) now says which term each row breaks, why a
  never-marked read cannot prove a term on the store (each repo write also
  moves `updatedAt`, and the change lands in a later millisecond than the
  create), why the marked read can, and why the first mark needs the raw row.

Mirror (`app/test/toursRepoFakeConditions.test.ts:155-252`): the same rows,
reads and titles; the change gets the `FakeWorld` as a third argument and the
raw row writes `world.toursMap.get(id)!.lastMarkedAt` directly (`:213-222`),
with no `updatedAt` stamp. Its comment notes that on the fake a never-marked
row usually isolates its term too (no I/O, so create, read and change mostly
share a millisecond) but not always, so here too the marked read and the raw
row are the proof.

Counts: integration 56 -> 63 tests, fake 30 -> 37.

### 2.1 Mutant table - the real repo (`app/src/repos/toursRepo.ts`), DynamoDB Local

Each term stripped in turn with the Edit tool, then
`npx vitest run test/toursRepo.integration.test.ts` from `app/`, then restored
with the Edit tool and `git diff --quiet -- app/src/repos/toursRepo.ts` = 0
before the next step. Where a strip left an ExpressionAttributeName or Value
unused, the mutant deleted that placeholder too (`#cp`; `#cv` and `:true`;
`#sa`; `#lm`; `:ua`), because DynamoDB rejects an unused placeholder with a
ValidationException, which would turn rows red for the wrong reason. Every
red row below failed with `AssertionError: expected { tourType:
'self_guided', ...(n) } to be undefined` - the close landed - and none with a
ValidationException; every other test stayed green (wins, refusals, reopen,
the FW-1 PIN).

| id | term stripped | red rows (title, read) | summary |
|---|---|---|---|
| S1 | `#st = :from` (`:712`) | 'the status changed' - 'marked' read | 1 failed, 62 passed (63) |
| S2 | `attribute_not_exists(#oc)` (`:713`) | 'an outcome was recorded' - 'marked' read | 1 failed, 62 passed (63) |
| S3 | `attribute_not_exists(#cp)` (`:714`) | 'a conversion was claimed' - 'marked' read | 1 failed, 62 passed (63) |
| S4 | `(attribute_not_exists(#cv) OR #cv <> :true)` (`:715`) | 'it became convertible' - 'marked' read | 1 failed, 62 passed (63) |
| S5a | `#sa = :sa`, the dated half (`:718-719`) | 'it was rescheduled' - 'marked' read | 1 failed, 62 passed (63) |
| S5b | `attribute_not_exists(#sa)`, the undated half (`:721`) | 'an undated tour got a date' - 'marked' read | 1 failed, 62 passed (63) |
| S5 | the whole scheduledAt branch, both halves (`:717-722`) | 'it was rescheduled' and 'an undated tour got a date' - 'marked' read | 2 failed, 61 passed (63) |
| S6 | `#lm = :lm`, the marked half (`:724-725`) | 'a person marked it again' - 'marked' read | 1 failed, 62 passed (63) |
| S7 | `attribute_not_exists(#lm)`, the never-marked half (`:727`) | 'a raw write marked it, updatedAt kept' - 'never marked' read | 1 failed, 62 passed (63) |
| S8 | `#ua = :ua`, the never-marked `updatedAt` term (`:736-737`) | the FW-1 case "when an unrelated write moved a never-marked tour's updatedAt" (`:839`) | 1 failed, 62 passed (63) |

The same runs reproduce R2-1's masking: under S1-S6 the NEVER-MARKED case of
the very row that went red stayed green (it lost on `#ua = :ua` instead), and
under S7 the patch-driven "a person marked it for the first time" row stayed
green for the same reason - only the raw row kills S7. Under S8 every race
row stayed green, because each still breaks its own, intact term.

S5 was run last, after the section 5 gates; the integration file was re-run
green (`Tests  63 passed (63)`) once it was restored.

### 2.2 Mutant table - the harness fake (`app/test/helpers/twilioWebhookHarness.ts`)

Same procedure against `npx vitest run test/toursRepoFakeConditions.test.ts`,
restored with the Edit tool and
`git diff --quiet -- app/test/helpers/twilioWebhookHarness.ts` = 0 after each.
A "half" was stripped by gating `storedAsRead` on the read's type (for
example S5a's twin keeps the check only for a non-string `scheduledAt` read).
Every red row failed with `AssertionError: expected { ...(n) } to be
undefined`.

| id | term stripped | red rows (title, read) | summary |
|---|---|---|---|
| F1 | `t.status !== tour.status` (`:3642`) | 'the status changed' - both reads | 2 failed, 35 passed (37) |
| F2 | `t.outcome !== undefined` (`:3643`) | 'an outcome was recorded' - both reads | 2 failed, 35 passed (37) |
| F3 | `t.convertedPlacementId !== undefined` (`:3644`) | 'a conversion was claimed' - both reads | 2 failed, 35 passed (37) |
| F4 | `t.convertible === true` (`:3645`) | 'it became convertible' - both reads | 2 failed, 35 passed (37) |
| F5a | scheduledAt, string-read half (`:3646`) | 'it was rescheduled' - both reads | 2 failed, 35 passed (37) |
| F5b | scheduledAt, absent-read half (`:3646`) | 'an undated tour got a date' - both reads | 2 failed, 35 passed (37) |
| F6 | lastMarkedAt, string-read half (`:3647`) | 'a person marked it again' - 'marked' read | 1 failed, 36 passed (37) |
| F7 | lastMarkedAt, absent-read half (`:3647`) | 'a person marked it for the first time' and 'a raw write marked it, updatedAt kept' - 'never marked' read | 2 failed, 35 passed (37) |
| F8 | the never-marked `updatedAt` term (`:3648`) | the FW-1 case "when an unrelated write moved a never-marked tour's updatedAt" (`toursRepoFakeConditions.test.ts:264`) | 1 failed, 36 passed (37) |

On the fake the never-marked cases went red as well in these runs (create,
read and change shared a millisecond), which is not guaranteed (the r2
reviewer measured 2 crossings in 2000 runs); the MARKED case and, for F7, the
raw row are the deterministic killers.

### 2.3 Green on the committed tree

Before the FW2-1 commit, each file twice: integration `Tests  63 passed (63)`
twice, fake `Tests  37 passed (37)` twice. Again on the final HEAD (section
5). No `[dynamoAdmin]` line in any run, mutant runs included.

## 3. FW2-2 (F12 dispute) - the worker pin

New case `app/test/jobQueueWiring.test.ts:129-148`, placed before the
existing entrypoint guard so the file header's "the last test in this file is
the guard" stays true. It reads `app/src/worker.ts` with block comments and
whole-line `//` comments removed, asserts the code contains
`startPollLoop('tour auto-close'`, slices the top-level block that holds the
call (`worker.ts:537-569` today), and asserts that block contains
`runTourAutoClose(` and `intervalMs: TOUR_AUTO_CLOSE_INTERVAL_MS` and matches
none of `createMessagingAdapter`, `createSendMessageService`, `tokenBucket`,
`a2pBucket` (the names the other worker blocks use for a send path). Its
comment says why: deleting the block, or binding it to the shared interval,
kept every gate green (review r2).

| step | worker.ts | result |
|---|---|---|
| GREEN | unchanged | `Tests  6 passed (6)` |
| probe R1, first try | the `startPollLoop('tour auto-close', ...)` call commented out (`//` on each line) | GREEN `6 passed (6)` - the raw-source match found the call's text inside the comment; the pin was then changed to strip comments first |
| RED R1 | same probe, comment-stripping pin | `Tests  1 failed, 5 passed (6)`: "worker.ts must start the tour auto-close poll: expected '...' to contain 'startPollLoop(\'tour auto-close\''" |
| RED R2 | `intervalMs: config.workerPollIntervalMs` | `Tests  1 failed, 5 passed (6)`: "expected '...' to contain 'intervalMs: TOUR_AUTO_CLOSE_INTERVAL_...'" |
| RED R3 | `createMessagingAdapter` imported inside the block | `Tests  1 failed, 5 passed (6)`: "expected '...' not to match /createMessagingAdapter|createSendMess.../" |
| GREEN | restored with the Edit tool after each probe, `git diff --quiet -- app/src/worker.ts` = 0 | `Tests  6 passed (6)` |

## 4. Doc changes

- FW2-3, spec: section 6.6's second bullet (`:357-360`) and section 11's Repo
  bullet (`:597-605`) each gain the clause "and, for a never-marked tour, an
  unrelated write that moved `updatedAt` (ruling A-1)". Nothing else in the
  spec changed.
- FW2-4, `docs/issues/tour-reopen-edge-states.md`: the AD-7 paragraph now
  opens "Reopen is the only TOUR event that clears a group's pending relay
  close-nag" and notes that closing the group clears it
  (`app/src/routes/relayGroups.ts:687`, `setCloseNagNextAt(conversationId,
  null)`) and the "Keep open" defer pushes it out 28 days (`:772`) - both
  verified at HEAD; the two refs joined the frontmatter `refs:`.
- FW2-4, `docs/issues/tour-relay-open-vs-auto-close-race.md`: every ref
  re-derived at HEAD. Moved: `toursRepo.ts:496 -> :502` (claimGroupThread's
  condition), `:679 -> :685` (autoCloseIf), `:540 -> :546` (claimConversion's
  condition), `routes/tours.ts:1544 -> :1552` (the relay route),
  `:1550 -> :1558` (its read), `:1559 -> :1567` (the guard),
  `:1644 -> :1652` (the open). Verified unchanged: `rosterProvision.ts:150-164`,
  `:294`, `:303`, `:335`; `routes/tours.ts:883`; `rosterActions.ts:144`,
  `:148`, `:156`, `:171`, `:589`, `:616`; `worker.ts:436`; `dev.ts:545`;
  `placements.ts:644`, `:656`, `:661`, `:716`, `:771-775`.
- FW2-4, `docs/issues/tours-scheduled-range-query-unpaginated.md`: every ref
  re-derived at HEAD, the body's included (it cited main @ae04122d):
  `listByScheduledRange` `toursRepo.ts:347-364 -> :399-416`, `listByStatus`
  `366-385 -> 418-437`, `queryGsi` `274-291 -> 326-342`, the tours route's
  caller `routes/tours.ts:413 -> :387`; `today.ts:550` unchanged; the
  frontmatter follows. The 2026-10-04 update block's "line numbers above are
  as of main @ae04122d; on feat/tour-auto-close ..." sentence (whose
  `:393-410` / `:412-432` fix wave 1 had shifted) became "Every line number
  in this file was re-derived on feat/tour-auto-close (2026-10-04); until then
  they cited main @ae04122d." The range read still has exactly those two
  callers (grep at HEAD).
- `npm run issues` (repo root): exit 0, output `[issues] 363 open, 193 closed,
  556 total -> docs/issues/INDEX.md` and `[issues] open by severity: 7 high,
  146 med, 210 low`; no warning line at all. `docs/issues/INDEX.md` is
  gitignored and was not committed.

## 5. Gates (final HEAD ec2d94e9, before this report)

| gate | command | result |
|---|---|---|
| typecheck | `npm run typecheck` (repo root) | exit 0 (the app workspace includes `tsconfig.test.json`) |
| eslint | `npx eslint app/test/toursRepo.integration.test.ts app/test/toursRepoFakeConditions.test.ts app/test/jobQueueWiring.test.ts` | exit 0, no output |
| tests | `npx vitest run test/toursRepo.integration.test.ts` (app) | exit 0, `Tests  63 passed (63)` |
| tests | `npx vitest run test/toursRepoFakeConditions.test.ts` (app) | exit 0, `Tests  37 passed (37)` |
| tests | `npx vitest run test/jobQueueWiring.test.ts` (app) | exit 0, `Tests  6 passed (6)` |
| issues | `npm run issues` (repo root) | exit 0, no warnings |

Every added line was checked for bytes outside 0x09/0x0A/0x0D/0x20-0x7E
(`git diff -U0`): none. Not run, as briefed: `npm test`, `npm run smoke`,
`npm run e2e`; no e2e lane or session was started (lane 8's stale
`session.pid` names a dead process and no lane-8 port listens); the DynamoDB
Local and S3 containers were not touched.

## 6. Changed beyond the list, and why

- FW2-2: the pin strips comments before matching. The brief's own RED probe
  (comment the block out) stayed GREEN on a raw source match, because the
  call's text survives inside the comment - a pin that a commented-out
  trigger passes would not hold the F12 dispute's point.
- FW2-1: each row carries a `term`, printed in its title, so a mutant run
  names the term it caught; `rawFirstMark` asserts its own isolation (stored
  row == pre-write row + the mark) instead of trusting the helper. The
  patch-driven first-mark row is kept beside the raw row (it still proves the
  change wins on the fake and on the store).
- FW2-3: `updatedAt` is in backticks, the spec's convention for field names.
- FW2-4: the same AD-7 paragraph's "the feature added the first clear" now
  reads "the first tour-event clear" (the R2-3 inaccuracy, restated), and
  `relayGroups.ts:687` / `:772` were added to the frontmatter `refs:`.
- Transient, none committed: ten store mutants (S1-S8 with S5, S5a, S5b), nine
  fake mutants (F1-F8 with F5a/F5b) and three worker probes (R1-R3), each
  restored with the Edit tool and proven with `git diff --quiet` before the
  next step; `grep MUTANT` over `app/src` and `app/test` is empty, and
  `git diff --quiet -- app/src` was 0 at every commit.

## 7. Not done, and notes for the orchestrator

- Nothing in FW2-1..FW2-5 is left undone.
- For the orchestrator's one-mutant re-check: deleting `toursRepo.ts:712`
  (`'#st = :from',`) must redden exactly one integration case - 'the status
  changed', 'marked' read - and leave its 'never marked' twin green.
- The issue refs re-derived here will move again if the S11 main sync shifts
  `toursRepo.ts` or `routes/tours.ts`.
