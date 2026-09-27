# Planner's independent review - adjudications

Branch `feat/staff-notes-past-tours`, handback @821d8a36 (gated tree 03768233,
code head 9382e0c7). Planner: Fable (this session), 2026-09-27 morning, still
under the overnight unattended rule (Cameron asleep; Go-AUTO standing).

Inputs: the orchestrator's handback; my own bare gate run on 821d8a36
(`.superpowers/planner/*.log`); two fresh read-only reviewers, opus -
spec-conformance (`planner-review-conformance.md`, CONFORMS, 10 LOW) and
plan-blind adversarial (`planner-review-adversarial.md`, 0 BLOCKING, 1 MEDIUM,
7 LOW); my own read of the riskiest diffs (the module-scoped batch store and
runner, the `useContact` guard, the PATCH block, the deep link).

## My gates on 821d8a36 (bare, quiet tree, 12:14Z done)

| gate | exit | note |
|---|---|---|
| typecheck | 0 | |
| test | 1 | app `375 passed, 1 failed (376)`; the one failure is `tourRemindersApi.test.ts > earlier[] ... tie-break`, the OPEN registered issue `tour-reminders-earlier-tie-break-test-ms-race` (two clock reads straddling a millisecond; file untouched by this branch; on main since 2026-09-26). Re-run alone: exit 0, exit 0. Dashboard 206/206, e2e-vitest 21/21, fake-twilio 34/34, fake-twilio-web 13/13. 0 `[dynamoAdmin]` lines. |
| smoke | 0 | |
| e2e | 0 | `287 passed (28.3m)` (the voicemail mission's e2e was live concurrently) |
| lint | 1 | `3 problems` = exactly the merge-base baseline (TenantFile unused import; TourDetail purity, shifted; useTours set-state-in-effect in useClosedTours, shifted). No new error. |

## Adjudications

Conformance (C) and adversarial (A) findings, folded by topic.

| # | finding | ruling |
|---|---|---|
| A-1 [MEDIUM] | a Staff notes save from a stale page silently overwrites a colleague's newer note; no version check although `staff_notes_updated_at` could be one; the audit row has no old text | RECORD FOR CAMERON, not fixed: spec Q12 chose last-write-wins deliberately (parity with every contact field), and adding optimistic concurrency changes the PATCH contract - a product call, not a code one. Filed `staff-notes-stale-page-overwrite` (decision, med) with the cheap design. TOP of the verdict. |
| A-4 [LOW] | the Past row link's `aria-label` replaces its content, so a screen reader never hears the state chip | FIXED by me: the label is now "Tour for <tenant> at <property> on <date-time>, <state>"; the unit tests assert the new name for all three states; the e2e's anchored regexes still match. Re-verified: ToursPage + useTours tests 66/66, typecheck 0, lint clean on the file, the two new e2e specs isolated (see verdict). |
| C-4 / A-6 [LOW] | the perf ledger's Tours citations drifted again (fix wave 2 shifted ToursPage by 12 lines after the F-11 refresh) | FIXED by me: 618-622 -> 630-634, 618-635 -> 630-647, 695-793 -> 707-805, verified against HEAD; `routes.test.ts` 24/24. |
| C-3 [LOW] | a `tours-past.spec.ts` comment still says 561-800px after the 840px change | FIXED by me (comment only). |
| A-7 [LOW] | every contact PATCH rewrites `participant_display_name` on every thread and emits per thread, whatever field changed - staff notes make it the most frequent trigger | PRE-EXISTING; filed `contact-patch-fans-out-on-every-field` (debt, low). |
| A-2 / C-2 [LOW] | a batch straddling a tab switch or route change reports nothing | KNOWN (handback C-7(ii)); accepted for this release: the PATCHes stand, the refreshed list is the truth, and the reload-on-remount shows it. Noted in the verdict. |
| A-3 [LOW] | the module-scoped busy flag has no timeout, no aria-busy or progress text | KNOWN (handback R2-4); hosted environments bound a request at CloudFront's 30 s. A progress line is a nice-to-have, not built. |
| A-5 [LOW] | focus drops to body after Save/Cancel and after a row's Mark toured unmounts | ACCEPTED as a follow-up nicety; not built (the aside is a plain CardAction with no ref). |
| A-8 / C-9 [LOW] | `resetBulkBatchStoreForTests` exported from production code; the DST unit test proves nothing on a non-DST host | ACCEPTED. The reset export is the honest price of a module store (the alternative is a test-only module seam). The DST test is a US-zone guard; CI here runs on this Windows box. |
| C-1 [LOW] | the module store covers more than the plan's page ref at the cost of global state | ACCEPTED (spec-conformant; the plan-blind review found it sound). |
| C-5 / C-7 [LOW] | result roles per block, not per line; the same text is announced | ACCEPTED. |
| C-6 [LOW] | `/tours/past` is not a profiler surface | ACCEPTED; issue `perf-pages-tours-past-surface` already filed. |
| C-8 [LOW] | the `:5174` fallback in the two new specs (house style, 59 files) | ACCEPTED; repo-wide, its own change. |
| C-10 [LOW] | the Past view also issues the Active window's reads (as Closed always has) | ACCEPTED; spec 4.2's "one request" is about the Past hook, which meets it. |

## What I did not redo

The orchestrator's live self-QA (`self-qa.md`, eleven screenshots, wire
proofs) was driven on the same code head; my own gate run re-executed both
new Playwright specs inside the full suite, and again in isolation after my
fix pass. I did a short live look of my own only where my fix changed
something a human sees (the row's accessible name is not visible; nothing
visual changed).
