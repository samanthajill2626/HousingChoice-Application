# S5 slice report - dashboard inbox: Inactive tag, triage chip, Unknown-tab sort (tracker #30)

Branch feat/unknown-inactive. Commits: f06257d6 (S5.1), 9cab2e8f (S5.2),
55d115a5 (S5.3, Inbox.tsx included per OR-19), aedbc481 (comment-only mirror
fix, see Divergences), plus this report.
Every task went RED for the plan's stated reason, then GREEN:
- S5.1 InboxRow.test.tsx + InboxRow.styles.test.ts: 6 failed / 37 passed
  (43). The four tag cases failed on `Unable to find an element with the
  text: Inactive`. That is the plan's three plus the OR-7 case. The two CSS
  cases failed on `missing CSS rule for .inactiveTag`. Both PINs passed.
  GREEN: 43 passed.
- S5.2 inboxListMerge.test.ts: 6 failed / 27 passed (33), then 33 passed.
- S5.3 useInbox.test.tsx: 3 failed / 65 passed (68). The first two Unknown
  cases received `c:in-new,c:nr-new,c:in-old,c:nr-old`, and the flip case
  received `c:flip,c:stay`. Both PINs (all, unread) passed. GREEN, with
  inboxListMerge.test.ts and Inbox.test.tsx: 3 files, 160 passed.
- S5.4 `npx vitest run src/routes/inbox`: 11 files (every test file in the
  directory), 244 passed.
`npm run typecheck` exit 0 after S5.1, S5.2 and S5.3.

## What the tree held that the plan got wrong

- Every S5 anchor was byte-exact after S1-S4, including types.ts:3873-3874
  (S4's edits are elsewhere in the file) and useInbox.ts:39-47, :148-153 and
  :722. S2's `useEventStream(...)` line and its comment (useInbox.ts:563-567
  before S5.3, :587-591 now) are not in any S5 diff.
- S5.2 Step 2 says every new case fails with a TypeError. Five do (`(0 ,
  compareX) is not a function`). The mixed-list case
  (inboxListMerge.test.ts:336-339) fails on its assertion instead, because
  `[...].sort(undefined)` is legal: the default string compare keeps the
  input order. It is still red for the stated cause (the missing export).
- C1, confirmed: useInbox.ts had no comment recording the 2026-08-26 ruling.
  The partner was the one-line JSDoc on `sortByActivity` (base :148). The
  `sortForFilter` JSDoc (useInbox.ts:150-174) now records Cameron's
  2026-10-23 supersession.
- C2, confirmed: the old comparator was inline, with no explicit tie-break.
  It moved unchanged to inboxListMerge.ts:59-61 as `compareByActivity`. The
  tie-break is the stable sort over head ++ tail (server order), and
  `compareUnknownTabRows` (:69-74) falls through to it.
- C3 / S5.3 step 6: nothing to do. S3 already cites `sortForFilter`
  (app/src/routes/inbox.ts:2309) and `compareUnknownTabRows` (:2322).
  `grep sortByActivity app/src/routes/inbox.ts` prints nothing, so inbox.ts
  is untouched. These historical records still name `sortByActivity` and are
  left as they are, per the plan:
  - docs/superpowers/plans/2026-06-17-inbox-frontend-plan.md:492, :656
  - docs/superpowers/plans/2026-09-25-inbox-rows-timestamps.md:1673, :2037
  - docs/superpowers/reviews/2026-08-25-inbox-unread-cluster/ (four files)
  - docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/ (two files)
  - docs/issues/thread-hooks-refetch-whole-page-per-event.md:158
  The only code-side mentions are the two intentional "moved from" comments
  (inboxListMerge.ts:58, inboxListMerge.test.ts:283).

## Divergences

- OR-7 adds one InboxRow.test.tsx case beyond the plan's five
  (InboxRow.test.tsx:383-388; see WORKLIST items).
- aedbc481 is a comment-only fix outside the plan's edits. The plan's file
  list does allow it (the InboxRow interface). S3 added "(never for an
  Inactive contact)" to the server's `needsTriage` comment
  (app/src/routes/inbox.ts:127). The dashboard interface says it mirrors the
  server verbatim (types.ts:3845-3850), but its comment did not have that
  phrase. types.ts:3868 now matches the server's comment exactly.
- OR-19 rewraps the Inbox.tsx header (:1-11, comment only), not just one
  line, so the paragraph still reads in order.

## Risk (not measured by S5)

- A resurfaced soft-deleted Inactive contact's row carries two rigid
  markers, Deleted and Inactive, beside the rigid channel chip
  (InboxRow.module.css:102-115, the chip rule). At 360px the name yields to
  them. S6's live self-QA should look at one such row if it can build one.
- Each row's text is part of its link's accessible name, so an Inactive
  row's link name now contains "Inactive". No existing e2e spec is affected:
  - Only contacts-list-facets.spec.ts:164 makes a contact Inactive, and it
    reads the Contacts list, not the inbox.
  - Inbox row selectors such as inbox-rows-timestamps.spec.ts:116 pass a
    string `name`, which Playwright matches as a substring.
- In the full/demo world, the matrix seed's Inactive tenants
  (app/src/lib/seed/matrix.ts:815) now show the tag on their inbox rows.
  Spec D9 intends this (any type).

Untrimmed input paths: none. S5 adds no input (D10).

## WORKLIST items

- OR-7: applied, keeping AR5 literal. InboxRow.test.tsx:383-388 renders a row
  with `deleted: true, inactive: true, needsTriage: false` and finds both
  "Deleted" and "Inactive" inside the row link. It was RED before the tag
  existed. The server side is app/src/routes/inbox.ts:1128-1129.
- OR-19: applied. Inbox.tsx:3-6 says every tab lists newest-activity-first
  except Unknown, which lists the Needs review rows first, then the Inactive
  ones, each newest first. Inbox.tsx is in the S5.3 commit, the S5.4 lint
  list and the ASCII list.
- OR-20: every S5 file's added lines are ASCII against 916258ae. All ten
  print 0: types.ts, InboxRow.tsx, InboxRow.module.css, InboxRow.test.tsx,
  InboxRow.styles.test.ts, inboxListMerge.ts, inboxListMerge.test.ts,
  useInbox.ts, useInbox.test.tsx and Inbox.tsx. This report prints 0 too. No
  S5 file holds a `u2192` escape.
- OR-15: a case-insensitive grep of the S5 added lines for the British
  spellings of color, behavior and labeled counts 0. The plan's S5 text had
  no British spellings.
- OR-22: I read a bare `git status` before every `git add`. Nothing was ever
  staged that I had not staged.
- Gate 5 / lint: `npx eslint` on the nine S5-touched .ts/.tsx files exits 0
  with no output. They are types.ts, InboxRow.tsx, InboxRow.test.tsx,
  InboxRow.styles.test.ts, inboxListMerge.ts, inboxListMerge.test.ts,
  useInbox.ts, useInbox.test.tsx and Inbox.tsx. It ran again on types.ts
  after aedbc481, exit 0. The config does not lint InboxRow.module.css
  (.ts/.tsx only).

## As built (S6 depends on these)

- Wire field: `inactive?: boolean` on the dashboard `InboxRow`
  (dashboard/src/api/types.ts:3874-3880), mirroring app/src/routes/inbox.ts:133-138.
- The tag (dashboard/src/routes/inbox/InboxRow.tsx:137):
  - It is a plain `<span class="inactiveTag">` with the exact text
    `Inactive`, and no role or aria-label.
  - It sits inside the row's `<a>` (role link), in the head, after the Needs
    triage slot and before the Deleted chip.
  - The CSS is InboxRow.module.css:181-189: muted, the `.tag` look.
  - To select it, take the row with
    `getByRole('link', { name: /<contact name>/ })`, then call
    `getByText('Inactive', { exact: true })` within it. Scope to the inbox
    list, `getByRole('list', { name: 'Conversations' })` (Inbox.tsx:382). An
    unscoped `getByText('Inactive')` can also match other page text.
- The chip: `Needs triage` still renders from `row.needsTriage` only
  (InboxRow.tsx:132). The server sends false for an Inactive contact.
- The sort:
  - `compareByActivity` (inboxListMerge.ts:59) and `compareUnknownTabRows`
    (inboxListMerge.ts:69) are exported.
  - `sortForFilter(rows, filter)` (useInbox.ts:175) is module-private. The
    render line `const rows = sortForFilter(visible, filter);` is at
    useInbox.ts:746.
  - On the Unknown tab, Inactive rows render after every Needs review row
    that is LOADED, each group newest first. A row that flips to Inactive
    moves down on the next head read (the contact.updated refetch, S2).
    Every other tab is newest-first, Inactive rows included.
