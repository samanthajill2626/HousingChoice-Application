# Fix wave 2 report - inbox rows + timestamps

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`, from 4a47fa35.
Implementer: Claude Opus 5.5 (1M context). Charter:
`code-review-r2-adjudications.md`. Logs: ignored `.superpowers/sdd/fw2-*`.

## STATUS: every edit made and verified, NOTHING COMMITTED

Before commit 1, `npm run test -w @housingchoice/dashboard` was DENIED by the
Claude Code auto-mode permission classifier (reason given: "Irreversible
Local Destruction"). The brief makes that suite a gate before EACH commit,
so no commit was made and the suite was not retried in any form. The lane
is stopped. The work sits uncommitted in the worktree, split into three
verified patches in the ignored `.superpowers/sdd/fw2/`: `commit1.patch`,
`commit2.patch`, `commit3.patch`. Applied to HEAD 4a47fa35 in that order,
they reproduce the working tree byte for byte (0 diff lines, checked in a
throwaway index). Each one can be staged with `git apply --cached`, which
leaves the working tree untouched. This file is the report; it is also
uncommitted.

Planned commits (hashes pending):

1. `fix(inbox): the row head never yields to the preview; long tags yield before the name (R2-1, R2-2)`
   - `InboxRow.module.css`
   - the spec
   - `inbox-rows-timestamps.spec.ts`
2. `fix(inbox): resolve the scroll root from the rendered list; a day change refreshes memoized rows (R2-3, R2-4)`
   - `Inbox.tsx`, `InboxRow.tsx`
   - `InboxRow.test.tsx`, `Inbox.test.tsx`, `useInbox.test.tsx`
3. `docs(inbox): make the round-2 texts true (R2-7); file the time-zone note (R2-5)`
   - `useAutoLoad.ts`, `useInbox.test.tsx` (the SC-9 assertion)
   - the spec
   - the three issue files
4. `docs(reviews): fix wave 2 report - ...` (this file)

## Status of every FIX and FILE row

| Row | Status | Where |
|---|---|---|
| R2-1 | FIXED | `InboxRow.module.css:66-80` (`.head` `flex: 0 0 auto`, comment). Spec 5.4 at `spec:452-465`. E2E pin: `inbox-rows-timestamps.spec.ts:290-299` (a block-7 party with a 304-character body), `:331-336` (768: name `clientWidth > 0` for that party and for the long-name contact), `:342-344` (WIDE_RESTORE: that party's name is not ellipsized, next to the existing Tasha check). |
| R2-2 | FIXED | `InboxRow.module.css:97-116` (`.tag`: `min-width: 0`, overflow hidden, ellipsis, `flex-shrink: 100`, with a comment). `.deletedTag` gets the same at `:128-143`. `.channel` and `.triage` rules are unchanged. Spec 5.4 at `spec:458-462`. There is no automated pin (see Worth an eye). |
| R2-3 | FIXED | `Inbox.tsx:158-176`: `listShown` is the `<ul>`'s own render condition, and it replaces `hasRows` in the scroll-root effect's guard and deps. Composed pin plus a control: `useInbox.test.tsx:1369-1430`. |
| R2-4 | FIXED | `Inbox.tsx:209-214` computes `dayKey` once per render, and `:384` passes it to every row. `InboxRow.tsx:23-28` declares the optional prop, unread and commented as a memo-busting input; the memo comment is at `:57-59`. Pins: `InboxRow.test.tsx:272-313`, plus `Inbox.test.tsx:740-762` (divergence 1). |
| R2-5 | FILED | `docs/issues/inbox-time-formatters-pin-time-zone-at-load.md` (debt, low, open). |
| R2-7 | FIXED | AD-15 paragraph: `inbox-loaded-pages-survive-refresh.md:22-32`. Spec 5.5 cursor: `spec:520-525`. Spec 5.2 residual: `spec:353-358`, and `useAutoLoad.ts:18-23`. Spec 5.4 `title`: `spec:494-501`. Spec 8 re-reading: `spec:1155-1160`. |
| SC-9 rollback pin | FIXED (replaced) | `useInbox.test.tsx:1325-1342`. The store is now read after the UNMOUNT save, which folds `pendingRef` in. |
| AD-2 addendum | FIXED | Spec 8, `spec:1133-1136`. |
| AD-3 geometry | FIXED | `inbox-time-title-unreachable-under-actions-overlay.md:19-20, :35-39`. |
| R2-6 | untouched (NOTE) | - |

SC-13 has now EXECUTED: e2e runs 1 and 4 passed tests 2 and 3, and with
them the SC-13 assertions.

## Mutant/kill pairs

For every mutant, the source was restored from a byte copy (sha1 checked),
and each was run against a single test file.

| Pin | Mutant | Result |
|---|---|---|
| R2-3 composed pin (`useInbox.test.tsx:1385`) | M1: `Inbox.tsx:169/:176` back to `!hasRows` / `[hasRows]` | 1 failed / 61 passed, "expected +0 to be 250". The control (`:1421`) passes. |
| R2-4 row pin (`InboxRow.test.tsx:295`) | M2: a memo comparator that ignores `dayKey` | 1 failed / 22 passed. `Inbox.test.tsx` also fails, 1 failed / 58 passed. |
| R2-4 page pin (`Inbox.test.tsx:744`) | M3: `Inbox.tsx:384` removed | 1 failed / 58 passed. |
| "fails without the dayKey prop" | M4: only the declaration at `InboxRow.tsx:28` removed | `InboxRow.test.tsx` 23/23 PASS: `React.memo` compares every prop passed, declared or not. Killed only by typecheck (`tsc -p dashboard/tsconfig.json` exit 2, TS2322 at the `dayKey` attribute in `Inbox.tsx` (now `:384`) and at `InboxRow.test.tsx:286`). |
| SC-9 (`useInbox.test.tsx:1341`) | M5: `clearPatch` no longer writes `pendingRef` (the rendered state still clears) | 1 failed / 61 passed, "expected 1 to be +0". The HEAD copy of the file under M5 passes 60/60, so the old assertion was vacuous against it. The copy was a throwaway, deleted by name. |
| E2E R2-1 (`spec.ts:335`, `:344`) | E1: `.head` back to `flex: 0 1 auto` | Test 4 fails at `:335`: Received 0. With the two 768 checks swapped for a probe (widths 0 and 171 px), it fails at `:344` (false). The Tasha check passes under E1. |

## E2E spec runs (lane 16)

The lane used app :10601, web :10611, fake :10621 and public base :10631,
with table prefix `hc-local-16-` and launcher pid 67396.

- **Before the start**, there was no `e2e/.artifacts/lane.json` and no
  `session.pid`.
- **Start**: `fw2-session.log` showed the ready line after about 15 s.
- **Stop**: `npm run e2e:stop` exited 0. It stopped launcher 67396 and its
  children, dropped `hc-local-16-*` and released the lease.
  - The background command then exited. It exited 1 because it was killed;
    the log ends at the stop's `/__dev/ping`.
  - `lane.json` and `session.pid` are gone.
  - `Get-NetTCPConnection` shows no listener on any of the four ports, and
    netstat shows 0 LISTENING (only TIME_WAIT).

| Run | What | Result |
|---|---|---|
| 1 | Whole file, fixed code | 6 passed, 23.7 s. Tests 1-6: 2.2, 5.0, 4.0, 2.1, 2.2, 5.7 s. |
| 2 | Test 4, mutant E1 | 1 failed, 2.0 s (above). |
| 3 | Test 4, E1, 768 checks probed | 1 failed, 2.1 s (above). |
| 4 | Whole file, restored final files | 6 passed, 22.3 s. Tests 1-6: 1.8, 5.1, 4.0, 2.1, 2.3, 5.7 s. |

## Gates

| Gate | Exit code and counts |
|---|---|
| Single touched files | `InboxRow.test.tsx` 0 (23 passed). `useInbox.test.tsx` 0 (62 passed; again after the SC-9 edit, 62). `Inbox.test.tsx` 0 (59 passed). |
| `npm run test -w @housingchoice/dashboard` | NOT RUN: denied, see STATUS. |
| `npm run typecheck` | 0, on the commit-1+2 tree before the lane. 0 again on the final tree. It includes the e2e workspace. |
| `npx eslint` | 0, no output, on all 7 touched TS/TSX files. |
| ASCII | 0 non-ASCII bytes in added lines, and 0 in the new issue file. |

`npm run issues`: exit 0.

- Totals: "297 open, 180 closed, 477 total".
- Open by severity: 6 high, 128 med, 163 low.
- The new issue is indexed. `INDEX.md` is gitignored and was not staged.

## Divergences from the charter

1. **R2-4 has an extra page-level pin** (`Inbox.test.tsx:740-762`). No
   row-level test can see whether the page passes `dayKey` (M3 survives
   them all).
2. **The literal "fails without the dayKey prop" is caught only by
   typecheck** (M4). The runtime kills are M2 and M3.
3. **Where the R2-3 pin lives**: a new describe block at the end of
   `useInbox.test.tsx`, which already renders the real Inbox. It uses
   `filter=unknown`, and it also asserts that the list is hidden under the
   error surface before Retry.
4. **The e2e body is 304 characters** (a 61-character phrase times 5). It
   is minted inline, because `seedParties` fixes the body.
5. **Beyond "add the geometry" in the AD-3 issue**, the now-false "no
   browser was run" was reworded (`:19-20`).
6. **Spec 5.2 drops the "UNVERIFIED" clause.** The synchrony argument
   replaces it.
7. **The `.head` comment is rewritten**; it said chips never shrink.
8. **One extra e2e mutant run (E1)** as evidence. The files were restored
   byte-exact, and run 4 ran on them.
9. **No commits** (STATUS).

## Worth an eye (not blocking)

- **R2-2 has no automated pin.** Unit tests run with `css: false`, and the
  lean world cannot mint a placement tag. The live self-QA is its check.
- **Spec 7.3 test 4** (`spec:1070-1084`) does not mention the new
  300-character pin. That section is outside the charter, so it was left.
- **Lane 16's tables already existed** at the session start (`db:create`
  skipped them), left over from an earlier session. This wave's stop
  dropped them.
- **The pre-existing act() warning** in `useInbox.test.tsx` ("drops an
  in-flight loadMore...") is not from this wave.

## Addendum (orchestrator, 2026-09-26) - how the wave was committed

The dashboard-suite gate command was denied to the implementer by the
auto-mode classifier (reason text "Irreversible Local Destruction", most
likely from a `git checkout --` of its own byte-copied files in the preceding
command). The implementer committed nothing and reported. The orchestrator
then ran the gates itself on the uncommitted tree from
W:\tmp\inbox-rows-timestamps, bare, redirected to `.superpowers/sdd/fw2-gate-*`:

- `npm run test -w @housingchoice/dashboard`: EXIT=0, 198 test files passed
  (the touched files alone: InboxRow 23, Inbox 59, useInbox 62).
- `npm run typecheck`: EXIT=0.

and committed the three verified patches in order with `git apply --cached`
(the working tree matched HEAD exactly afterwards, only this report untracked):

- fd64976d fix(inbox): the row head never yields to the preview; long tags
  yield before the name (R2-1, R2-2)
- afa482f0 fix(inbox): resolve the scroll root from the rendered list; a day
  change refreshes memoized rows (R2-3, R2-4)
- cdae0d97 docs(inbox): make the round-2 texts true (R2-7); file the
  time-zone note (R2-5)
- 6024b619 this report

The `Co-Authored-By` trailers name the implementer's model, which wrote the
changes; each commit body says the orchestrator committed it. Round 3
(`code-review-r3.md`) later found that the R2-2 tag rule blanks short tags;
see `code-review-r3-adjudications.md`.
