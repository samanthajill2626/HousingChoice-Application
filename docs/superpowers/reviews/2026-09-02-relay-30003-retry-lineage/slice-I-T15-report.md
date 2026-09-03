# Slice I report - plan Task 15 (the issue closures)

Implementer record for the docs-only slice: stamping the two issues this branch
closes, annotating one it must NOT close, correcting one sentence in each of the
two that stay open, and regenerating the gitignored issue index.

Branch `feat/relay-30003-retry-lineage`, worktree
`W:\tmp\relay-30003-retry-lineage`, base `90d78f89` (slice H's report commit).

No code was touched. No test suite, e2e run or Playwright session was started.

## Commits

| hash | subject |
| --- | --- |
| `3787d818` | docs(issues): close the relay 30003 retry lineage pair |
| (this file) | docs(records): slice I report - issue closures |

Bare `git status` was read before the commit and `MERGE_HEAD` confirmed absent
at the worktree's real gitdir
(`.git/worktrees/relay-30003-retry-lineage/MERGE_HEAD` - a worktree's `.git` is a
FILE, so a bare `test -f .git/MERGE_HEAD` proves nothing and was not relied on).
Explicit paths only; nothing amended. 5 files, +227 / -15.

## Files - exactly the five in scope

- `docs/issues/relay-30003-retry-lineage.md` - `status: resolved`,
  `updated: 2026-09-02`, `resolved: 2026-09-02`, plus a
  `**Resolution (2026-09-02, feat/relay-30003-retry-lineage).**` block.
- `docs/issues/relay-30003-classified-transient-retrying.md` -
  `status: resolved`, `resolved: 2026-09-02`, plus its Resolution paragraph.
- `docs/issues/quiet-hours-ungated-automated-paths.md` - **status UNCHANGED
  (`open`)**; a dated annotation inside item 3 only.
- `docs/issues/relay-member-key-collapses-two-phones-one-contact.md` - **stays
  `open`**; the E5 sentence corrected.
- `docs/issues/relay-inbound-source-has-no-delivery-rollup.md` - **stays
  `open`**; the E4 sentence corrected.

`docs/issues/INDEX.md` was regenerated but NOT staged - `git check-ignore -v`
returns `.gitignore:62:docs/issues/INDEX.md`, and it never appeared in
`git status`.

## `npm run issues`, quoted from the runner

```
> housingchoice@0.1.0 issues
> node scripts/issues.mjs

[issues] 286 open, 176 closed, 462 total -> docs/issues/INDEX.md
[issues] open by severity: 6 high - 128 med - 152 low
EXIT=0
```

(The runner's `->` is a U+2192 and its severity separator a U+00B7; rendered
ASCII here.) Both issues appear as `resolved` in the regenerated index:

```
| med | bug | resolved | [relay-30003-retry-lineage](./relay-30003-retry-lineage.md) | ...
| low | bug | resolved | [relay-30003-classified-transient-retrying](./relay-30003-classified-transient-retrying.md) | ...
```

## Gates

| gate | result |
| --- | --- |
| ASCII on added lines (`git diff -U0 -- FILE \| grep '^+' \| tr -d '\11\12\15\40-\176' \| wc -c`) | **0** for all five |
| `npm run issues` | **exit 0** |
| bare `git status` + `MERGE_HEAD` absent before the commit | confirmed |

Gate 5 (`npx eslint`) does not apply: the branch's file list for this slice is
Markdown only, so the extension filter yields an EMPTY list and a bare
`npx eslint` would go repo-wide. Not run, per `AGENTS.md`.

## The nine-criteria walk, and its one honest "not literally"

Every citation in the Resolution was verified rather than copied from the brief.
All sixteen task commits resolve and their subjects match the task each is
attributed to (`git log -1 --format=%s` on each of `814f2997`, `6940a63d`,
`b2b35e81`, `1478ca0b`, `c8b0724d`, `6332843b`, `5d2feb14`, `e4e8b533`,
`51b12e13`, `bbe58487`, `65bed580`, `845cfa54`, `64773ab3`, `71181d79`,
`c05a25d7`, `a97884f5`). Every test title quoted was read out of the suite file
it is attributed to.

**AC 6 is recorded as met in substance and SUPERSEDED in wording**, stated
plainly rather than glossed: the issue asks for "one message bubble", and the
founder-approved display contract (spec Sec 5) renders a SECOND bubble for a
DELIVERED retry of an OUTBOUND original. The Resolution says so and says why -
that permission is what made D1's new-row architecture available at all - and
records that every other retry row renders none.

**AC 2 carries its own limit**: the duplicate-JOB-delivery half is unit-proven
only (adjudication E6 - the lane's in-process queue cannot redeliver), so the
Resolution states that a green e2e is not evidence for it.

## Divergences and judgement calls

1. **The Resolution block sits BEFORE the `## Design knowledge from M5
   (2026-09-01)` appendix, not at the literal end of the file.** Appending after
   that H2 would have made the closure read as part of a historical section
   about a different mission. Body order is now Problem -> Desired -> Suggested
   fix -> Acceptance -> Related -> Twilio references -> Resolution -> the M5
   appendix.
2. **Frontmatter shape copied from `relay-stale-participant-phone.md`** (the
   live convention worklist section 7 names): a bold-lead
   `**Resolution (DATE, BRANCH).**` paragraph, and `resolved:` placed after
   `created:` / `updated:`. Cross-checked against
   `npm-test-dynamodb-local-contention.md`, which carries both fields in that
   order.
3. **Two frontmatter edits on `quiet-hours-ungated-automated-paths.md` beyond
   the literal brief**: `updated: 2026-09-02`, and `app/src/jobs/relayRetryLeg.ts`
   appended to `refs:`. Worklist 7.1 asks for the refs addition explicitly (the
   item named only the 1:1 producer, so nothing in the frontmatter pointed at
   the relay ladder). `status` was NOT touched.
4. **No `updated:` was added to the two issues that stay open.** Both were
   created 2026-09-02, so the field would carry no information.
5. **The quiet-hours annotation also names the transient sub-ladder** (5s then
   10s, verified at `app/src/jobs/relayRetryLeg.ts:118`, `:219`, `:463`) and
   states that it does NOT extend the ~7-minute bound. Without that a reader
   reconciling the code against the item's arithmetic would find a second
   backoff the item does not account for.
6. **The member-key correction was expanded into two bullets rather than one
   rewritten clause.** E5 corrects only the "records the destination on the leg"
   half, but the surviving half needed sharpening too: the retry keys its LADDER
   on the destination digest while the DISPLAY join still keys on the member key
   the row records, so the collapse is unchanged on screen. Stating only the
   first would have implied the display defect was worked around as well.

## What I could not verify

- **The `refs:` line numbers on the two closed issues were left untouched, as
  briefed, and several are now stale.** `relay-30003-retry-lineage.md` cites
  `twilio.ts:2348/2433/2553`, `retrySend.ts:27`, `messagesRepo.ts:118`,
  `deliveryStatus.ts:543` and `Timeline.tsx:1670`;
  `relay-30003-classified-transient-retrying.md` cites `twilio.ts:286/295/2377`.
  Both files were substantially rewritten by Tasks 1, 8, 9, 12 and 13, so those
  anchors have moved. Not chased - out of scope for this slice, and both issues
  are now closed, so the refs are historical.
- **The `:948-951` citation inside the corrected inbound sentence is the issue's
  own existing reference**, quoted forward rather than re-derived against the
  post-Task-9 `Timeline.tsx`. Same reasoning; that issue stays OPEN, so it is
  the one anchor a future reader might want re-checked.
- **No gate beyond `npm run issues` was run here.** typecheck, `npm test`,
  smoke and e2e are the orchestrator's battery; nothing in this slice can move
  them (Markdown only, and `INDEX.md` is gitignored).
