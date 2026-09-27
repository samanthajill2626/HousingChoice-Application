# Plan review R2 - reviewer A (adversarial, continued)

Plan: `docs/superpowers/plans/2026-09-26-staff-notes-past-tours.md` v5 @20039fc3
Inputs: `plan-r1-adjudications.md`, `plan-r1-reviewer-b.md`, my
`plan-r1-reviewer-a.md`, and the spec DRAFT 4 with its two precision edits.

## Method

I did not probe snippets this round. I rebuilt every v5-changed file in full, in
a scratchpad, by applying the plan's own code blocks and edit instructions to the
real base files with a script. Files covered:

- Dashboard source: `useTours.ts`, `ToursPage.tsx`, `App.tsx`, `TourDetail.tsx`,
  `StaffNotesCard.tsx` and its CSS, `TenantFile.tsx`, `ContactDetail.tsx`,
  `api/types.ts`.
- Dashboard tests: `useTours.test.ts`, `ToursPage.test.tsx`,
  `TourDetail.test.tsx`, `StaffNotesCard.test.tsx`, `TenantFile.test.tsx`.
- App: `contactsRepo.ts`, `contacts.ts`, `test/contactStaffNotes.test.ts`.
- e2e: both new specs.

What I ran on those files:

- **ESLint**, the repo's own flat config (react-hooks 7.1.1 `recommended-latest`).
  Each file went through `npx eslint --stdin --stdin-filename <real repo path>`
  from the shared checkout, reading only; the scratch files were fed on stdin.
  - I first checked that the compiler rules were actually running on these files.
    I injected a `setState`-in-effect into the assembled ToursPage and
    TourDetail. Both were reported, and TourDetail's pre-existing purity error
    was reported alongside, so one error does not hide another.
- **Dashboard typecheck**: `tsc` with the dashboard compiler options over a
  scratch copy of `dashboard/src`, types resolved from the main checkout's
  node_modules. At base this reported 0 errors.
- **App typecheck**: the app compiler options (bundler resolution) over the
  touched test plus three neighbouring test files. At base: 0 errors.
- **e2e typecheck**: the two new specs. I confirmed the harness catches errors
  by injecting a type error; it did.

Not done: no vitest, Playwright or e2e suite was run. Timing claims below are
marked UNVERIFIED. Nothing in the repo was modified except this file.

## Verdict on the six redesigns (question 2)

- **(a) Task 6, `usePastTours` with no synchronous write.** Correct.
  - Lint: the assembled `useTours.ts` reports only the baseline
    `set-state-in-effect` at 116 (`useClosedTours`).
  - Typecheck: clean.
  - Behavior: first load `idle` -> `ready` / `error`; a reload keeps the rows.
    The page treats `idle` as loading.
  - Remaining issue: one stale header comment (C1).
- **(b) Task 7, keyed remount + `bulkBusyRef` + batched dropped-rows test.**
  Lint-clean (`ToursPage.tsx` and `App.tsx`: 0 problems). Typecheck fails, but
  on a pre-existing plan defect (N1), not the redesign. Three problems:
  - the remount has a real cost for the EXISTING tabs (N2);
  - the batching the dropped-rows test relies on is sound, but that test and the
    remount test read the DOM before they have waited for the render (N5);
  - the ref guard is per mount, so a tab switch in the middle of a batch lets a
    second batch start (see N2).
- **(c) Task 8, dialog opened in the `useState` initializer; the effect only
  strips.** Correct.
  - Lint: only the baseline `react-hooks/purity` error at base
    `TourDetail.tsx:269` remains, now shifted to about line 302.
  - `setSearchParams` is not flagged.
  - Typecheck: clean.
  - Behavior: `TourDetailLoaded` mounts after the tour loads and is keyed by
    `tourId` (TourDetail.tsx:129-131), so the initializer sees both the URL and
    the tour.
  - `Modal` sets no `aria-hidden` / `inert` on the page behind it
    (`contact/Modal.tsx`), so the unit tests can still query the back link while
    the dialog is open.
- **(d) Task 3, sibling label via `htmlFor` / `useId`.** Correct. Playwright now
  finds the textarea through `element.labels`, whose text is exactly
  "Staff notes". Lint-clean and typecheck-clean.
- **(e) Task 5, "View" group then "Profile".** Correct.
  - The name "View" is unique on the contact page. The other role=group labels
    in `routes/contact` are "Contact kind", "AI suggestion for ...", "Timeline
    filter", "Message channel", call-card direction/time names, and a
    recipient-name group; none contains "view".
  - The spec typechecks and lints clean.
- **(f) Task 10, `timeout 2700` + orphan recipe.** The cap is right, but the
  recipe's port check is unsound (N3).

---

## N1 [MEDIUM] ToursPage.test uses `waitFor` nine times but never imports it

**What is wrong.** The base test file imports only
`{ render, screen, within }` from `@testing-library/react`
(`dashboard/src/routes/tours/ToursPage.test.tsx:12`). Task 7 Step 1 adds tests
that call `waitFor` at plan lines 1885, 1895, 1896, 1928, 1947, 1965, 1980, 1992
and 2004. No instruction in Step 1 items 1-6 adds `waitFor` to that import.

Vitest's `globals: true` (`dashboard/vite.config.ts:118`) exposes vitest's own
API, not Testing Library's `waitFor`. So at runtime every one of those tests
throws `ReferenceError: waitFor is not defined`.

**Evidence.** The scratch dashboard typecheck (0 errors at base) reports
`ToursPage.test.tsx: error TS2304: Cannot find name 'waitFor'` at nine sites,
and nothing else across all the v5 dashboard changes.

**Implications.**
- Task 7 Step 5 ("all green") and Step 6 / gate 1 (`npm run typecheck`) both
  fail.
- The defect was already in v4. Both round-1 reviewers missed it. Neither of us
  typechecked the assembled test file; we only probed snippets.
- Fix: item 3 should import
  `{ render, screen, waitFor, within }` alongside `useLocation`.

## N2 [MEDIUM] The keyed remount makes every Tours tab click refetch the whole contact directory and every unit, behind the page spinner

**What is wrong.** v5 keys the three tours route elements
(`<ToursPage key="active" />`, and so on). The page therefore remounts on every
tab click, which runs all its data hooks again:

- `useTours()`: 2 queries.
- `useContacts('all')` and `useContacts('deleted')`: each walks EVERY page of 4
  contact types (`routes/contacts/useContacts.ts:7-10,30-36,54-66`). There is no
  cache.
- `useListings()` and `useListings(true)`: every unit page, twice.

`crossRefLoading` feeds `loading` in every view (`ToursPage.tsx:196-209`), so
each click shows the full-page spinner until all six hooks resolve.

Before v5 the instance survived a tab switch:
- Closed -> Active was instant, because `toursStatus` and the lookup maps were
  already loaded.
- Active -> Closed refetched only the two closed/canceled queries.

v5 turns every switch into at least about 12 requests (more as contact pages
grow) plus a spinner. That is a staff-facing regression on the two EXISTING tabs,
and the spec did not ask for it.

It also makes spec 4.5's stated premise ("the three tabs share one component
instance") false without a spec note. The spec 2.2 description of the instance
being preserved was accurate: `_renderMatches` creates `RenderedRoute` with no key
(`react-router/dist/development/chunk-4ZMWKKQ3.mjs:6329-6339`). The remount comes
only from the new keys.

A secondary effect: `bulkBusyRef` belongs to one mount.
1. Past -> Active -> Past mid-batch leaves the first runner PATCHing on the
   unmounted instance.
2. The fresh instance accepts a second batch (spec 4.5: "the runner also ignores
   a call while one is in flight").
3. Tours both runners touch then come back "Changed since the list loaded",
   although the user's own batch marked them.

**Is it safe for the existing tests and for `useClosedTours`?** Yes, for both:
- The unit tests mock every hook as already `ready`, so a remount renders
  synchronously.
- `tours-page.spec.ts:438-453` waits on visible regions.
- `useClosedTours` refetches on mount exactly as it did on the enable flip.

It is correct, then, but it pays for a lint fix with a regression.

**Implications and a lint-clean alternative.** Keep the page instance and move the
Past view's batch state into a Past-only child, for example a `PastToursSection`
rendered under `view === 'past'` that receives `contactsMap` / `unitsMap`. It
holds `selectedIds`, `results`, `snapshot`, `bulkBusy` / `bulkBusyRef` and calls
`usePastTours(true)`.

A tab switch then unmounts only that child, which resets the batch state without
an effect. Active and Closed keep today's behavior, and neither App.tsx nor the
test's `renderPage` needs keys.

If the planner prefers to keep the remount, say so in the plan and add a
one-line note to spec 4.5, so the regression is a recorded decision, not a
side effect.

## N3 [MEDIUM] The orphan recipe's port check reserves a lane and can print the wrong lane's ports

**What is wrong.** Task 10 (plan lines 3060-3065) says, after exit 124:
"confirm no listener survives on this lane's ports (`e2e/support/lane.mjs`
prints them)".

Running `node e2e/support/lane.mjs` is not a read-only lookup. Its CLI path calls
`resolveLane()` (`lane.mjs:426-436`), which RESERVES a lease:
`lease.reserve(lane, ...)`, writing a `state: 'reserved'` record
(`laneLease.mjs:197-218`). A reservation is honoured for `RESERVE_GRACE_MS =
240_000` even after the resolver exits (`laneLease.mjs:41-52` and
`isReclaimable` at 138-150).

Two consequences:

1. **The wrong ports in exactly the case the check exists for.** Suppose
   `e2e:stop` did not kill the orphan. Its launcher still holds a `held` lease
   with a live pid. `resolveLane` then skips that lane and walks to the next free
   one (`lane.mjs:363-372`). It prints THAT lane's ports, which are free, and the
   builder "confirms" nothing survives while the orphan is still up.

   AGENTS.md's warning applies directly: `reuseExistingServer` adopts an orphaned
   stack on a commit match alone.

2. **The next run lands on a different lane.** Even when the stop succeeded, the
   hand-run reservation blocks this worktree's own preferred lane for 4 minutes.
   The recipe's next step is the isolate run
   (`npm run e2e -w @housingchoice/e2e -- --grep ...`). Its config resolve then
   finds the lease un-reclaimable and moves to another lane, possibly a stale
   lane with an old schema (AGENTS.md) or another worktree's usual lane.

**Implications.** Read the ports from `e2e/.artifacts/lane.json` BEFORE running
`npm run e2e:stop`. The session writes `lane` and `ports` there
(`scripts/e2e-session.mjs:72-86`), and `e2e-stop.mjs` deletes it when it finishes
(`e2e-stop.mjs:5-8,142`). Then check those ports after the stop, and never run
`lane.mjs` by hand.

Also, "read the partial report for the failing FILE" assumes a failure. A healthy
suite killed by the cap has no failing file, so the recipe should branch:
- no failure yet: re-run with a higher cap;
- a failure: isolate that file.

## N4 [LOW] The gate-5 baseline note names one of the three pre-existing errors in touched files

Linting the base files gives exactly three errors in files this branch touches:

| file:line | rule |
|---|---|
| `useTours.ts:116` | `react-hooks/set-state-in-effect` |
| `TourDetail.tsx:269` | `react-hooks/purity` (`Date.now`) |
| `TenantFile.tsx:14` | `@typescript-eslint/no-unused-vars` (`FieldSource`) |

`app/src/routes/contacts.ts`, `contactsRepo.ts`, `contact-detail.spec.ts`,
`types.ts`, `ToursPage.tsx` and the touched test files are clean at base.

The plan (lines 3066-3070) names only the first. It also tells the builder to
attribute errors by reading "the reported line at `main` for the same file".
Task 8 inserts about 33 lines above the purity error, so after the build it
reports around line 302, and line 302 at `main` is unrelated code. That is the
line-number shortcut AGENTS.md warns against. List all three, and say "compare
the error lists, not line numbers".

## N5 [LOW] The dropped-rows test and the remount test read the DOM before they wait for the batched render

The batching argument in the dropped-rows test holds. `setResults`,
`setSelectedIds`, the synchronous `pastRows` swap inside `reloadPast()`, and
`setBulkBusy(false)` all run in one continuation. React commits them as one later
render, and that render reads the new rows through the spy.

But the test then does:
1. `await screen.findByRole('region', { name: 'Past tours' })` (plan 1930). The
   region existed before the batch, so this resolves at once.
2. Synchronous `getByText` / `getByRole('alert')` / `getByRole('status')` reads.

The remount test likewise reads `getAllByRole('alert')` synchronously right after
`waitFor(reloadPast called)` (1948). `waitFor` can succeed as soon as
`reloadPast` has been called, which happens before React commits.

Whether user-event's post-click drain always covers the commit is UNVERIFIED (no
suite run). Replace the first read with
`await within(region).findByText('No past tours need attention in the last 90 days.')`,
and in the remount test use `await screen.findAllByRole('alert')`. That removes
the dependence on scheduler ordering without weakening any assertion.

---

## Contested and conceded adjudications (question 3)

- **C1 [LOW] CONTEST A1 / B2: "every 'to now' text corrected".** Not quite.
  - The useTours.ts header comment the builder is told to paste still reads
    "query over [start of the local day 90 days ago, now]" (plan line 1520).
  - Lines 1523-1524 still say it drops "a toured tour whose outcome is recorded",
    leaving out the Needs-placement exception.
  - The code, tests, commit message and ToursPage comment are fixed. This is the
    last stale sentence, and it ships in source.
- **CONCEDE A3 / B1 (lint).** Every rebuilt v5 dashboard file lints clean except
  the three baseline errors in N4.
- **CONCEDE A4 (label).** The sibling `htmlFor` / `useId` label resolves
  `getByLabel('Staff notes', { exact: true })` whatever the box holds.
- **CONCEDE A2 / B3, A7 / B5 (mock spread, `reloadFailed`).** The scratch
  typecheck is clean on both, and N1 is the only dashboard type error left.
- **CONCEDE A5 / B9 (Profile toggle).** The locator is unique and the pane
  behavior matches the code.
- **CONCEDE A6 / B6, A10 / B7, A12 / B8, A13 / B11, A15.** Verified in v5 text:
  the full intro assertion, the back arrow clicked on the stripped page, the
  precedence and Needs-placement cases, the four-red count, the top-level
  describe, the trailer placeholder, and split status / MERGE_HEAD commands. The
  MERGE_HEAD path matches the worktree's real gitdir.
- **CONCEDE A8 / B4 (dropped-rows test).** The redesign is sound; the remaining
  read-before-render risk is N5.
- **CONCEDE A9 / B14 (timeout value).** 2700s is 2.5x the 17.9m idle baseline.
  The recipe problem is filed separately as N3.
- **CONCEDE A11 / B13 (2s settle).**
  - Local jobs run in-process (`app/src/jobs/queueWiring.ts:36,136`), so an
    enqueued send lands within the 2s.
  - The worker's poll cadence is left at the 30s default in e2e
    (`scripts/e2e-session.mjs:249-252`; `app/src/lib/config.ts:609`). But a
    past-dated tour has no due rung for a poll-driven send.
- **CONCEDE A14 / B10 (`bulkBusyRef`).** Lint-clean and correct within one mount.
  The cross-mount gap is part of N2.

## Question 4: correct, or merely plausible?

- **Correct:** (a), (c), (d), (e).
- **Correct but costly:** (b). N2's remount regression, plus N1, which blocks the
  typecheck and test run regardless of the design.
- **Plausible, not sound:** (f)'s recovery procedure (N3).
