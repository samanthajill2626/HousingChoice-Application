# Fix wave 1 report - inbox rows + timestamps

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`, from 701570ed.
Implementer: Claude Opus 5.5 (1M context). Charter:
`code-review-r1-adjudications.md`. Logs: ignored `.superpowers/sdd/fw1/`.

## Commits

| Hash | One-liner |
|---|---|
| 96dce256 | perf(inbox): module-level date formatters and a memoized row (AD-1) |
| 6959578c | fix(inbox): an incomplete head read installs its cursor when the list had none (AD-4); carries the whole spec DRAFT 8.5 edit (5.6, section 8, 5.8, Status) |
| d9923997 | fix(inbox): drain queued observer entries on re-observe (AD-5) |
| 9edab26a | docs(inbox): stale comments and issue text (AD-7, AD-9, AD-10, AD-15) |
| 9dd2f2dd | test(inbox): pin the review-found gaps (SC-1..SC-13, AD-8, AD-16) |
| ef37bf69 | docs(issues): file the review follow-ups |

Six commits, one `Co-Authored-By` trailer each, explicit paths only.

## Status of every FIX and FILE row

| Row | Status | Where |
|---|---|---|
| AD-1 | FIXED | `inboxTime.ts:15-32` (four module formatters), `:55-59`, `:66`; `InboxRow.tsx:51-53` (memo + reason) |
| AD-3 | FILED | `docs/issues/inbox-time-title-unreachable-under-actions-overlay.md` |
| AD-4 | FIXED | `inboxListMerge.ts:123-127, :135`; spec 5.6 (`spec:600-605`), section 8 (`spec:1130-1135`) |
| AD-5 | FIXED | `useAutoLoad.ts:43-73` (default factory), header `:18-21` |
| AD-7 | FIXED | `thread-hooks-refetch-whole-page-per-event.md:113-118, :127, :214`; `inbox-parselimit-empty-one-row.md:42-44` |
| AD-8 | FIXED | `dashboard/src/routes/inbox/inboxLimits.test.ts` |
| AD-9 | FIXED | `app/src/routes/inbox.ts:2023-2027, :2032` (comments only); `unknown-queue-status-flip-duplicates-across-pages.md` (symptom, 100). Perf ledger untouched (NOTE) |
| AD-10 | FIXED | `AuthGate.tsx:6-12`, `AuthGate.test.tsx:1-7`; spec 5.8 (`spec:673-678`, in 6959578c) |
| AD-13 | FILED | `docs/issues/inbox-restore-shows-row-read-after-mark-unread-jump.md` |
| AD-15 | FIXED | `inbox-loaded-pages-survive-refresh.md:22-28` |
| AD-16 | FIXED | `useInbox.test.tsx:935` (inboxListKey); `inboxFeed.test.ts:2565` (HYDRATE_CONCURRENCY + 1) |
| SC-1..SC-12 | FIXED | tests below |
| SC-13 | FIXED, NOT RUN | `inbox-rows-timestamps.spec.ts:188, :221, :243, :250, :299` (assertion-only; typechecked) |
| SC-19 | FILED | `docs/issues/group-text-inbox-spec-depends-on-leftover-conversations.md` |
| Slice G note | FILED | `docs/issues/e2e-waitforurl-does-not-prove-route-rendered.md` |
| Slice D gaps 6-9 | FIXED | `Inbox.test.tsx:614, :674, :700, :712` |

REJECT/NOTE rows (AD-2, AD-6, AD-11, AD-12, AD-14, SC-14..SC-18) untouched.

## Mutant/kill table

Every mutant was one edit to committed source (M9c: two), run against the
single test file, then restored from a byte copy; `git diff --exit-code` on
the source was clean after each. "Failed" counts are for that file only; in
every row the failures are exactly the pins named.

| Pin | Finding | Mutant | Failed / passed |
|---|---|---|---|
| `useAutoLoad.test.tsx:115` | SC-1 | `useAutoLoad.ts:121` handled-epoch write deleted | 1 / 11 |
| `useAutoLoad.test.tsx:132` | SC-2 | `useAutoLoad.ts:120` `!enabled` term dropped | 1 / 11 |
| `useInbox.test.tsx:1233` | SC-3 | `useInbox.ts:483` ready gate deleted | 1 / 59 |
| `useInbox.test.tsx:1248` | SC-6 | `useInbox.ts:463` restoredKeyRef update deleted | 1 / 59 |
| `useInbox.test.tsx:1265` | SC-7 | `useInbox.ts:459` reset's refreshFailed clear deleted | 1 / 59 |
| `useInbox.test.tsx:1282` | SC-7 | `useInbox.ts:457` reset's pendingRef clear deleted | 1 / 59 |
| same | SC-7 | `useInbox.ts:460` reset's scroll-seed zeroing deleted | 1 / 59 |
| `useInbox.test.tsx:158` (strengthened) | SC-8 | `useInbox.ts:462` setLoadingMore(false) deleted | 1 / 59 |
| `useInbox.test.tsx:1302` | SC-9 | `useInbox.ts:702` markUnread commit deleted | 1 / 59 |
| `useInbox.test.tsx:1325` | SC-9 | `useInbox.ts:707` finally no longer clears the patch | 1 / 59 |
| `useInbox.test.tsx:1342` | SC-9 | alive gates at `useInbox.ts:303` AND `:702` both removed | 1 / 59 |
| same (control) | SC-9 | either gate alone removed | 0 / 60 each (they back each other up) |
| `useInbox.test.tsx:337` (strengthened) | SC-10 | `useInbox.ts:342` success-path generation guard deleted | 1 / 59 |
| `Inbox.test.tsx:726` (4 cases) | SC-4 | `Inbox.tsx:197` enabled forced true | 3 (the enabled=false cases) / 55 |
| same | SC-4 | `Inbox.tsx:197` autoLoadArmed term dropped | 1 / 57 |
| same | SC-4 | `Inbox.tsx:198` epoch forced 0 | 4 / 54 |
| same | SC-4 | `Inbox.tsx:199` no-op onLoad | 4 / 54 |
| `Inbox.test.tsx:674` | gap 6 | `Inbox.tsx:187` restore latch deleted | 1 / 57 |
| `Inbox.test.tsx:700` | gap 7 | `Inbox.tsx:188` store-only guard deleted | 1 / 57 |
| `Inbox.test.tsx:712` | gap 8 | `Inbox.tsx:175` scroll listener not added | 1 / 57 |
| `Inbox.test.tsx:614` (strengthened) | SC-12, gap 9 | `Inbox.tsx:384` aria-hidden removed | 1 / 57 |
| `inboxListMerge.test.ts:109` (2 cases) | SC-5 | `inboxListMerge.ts:55` additive on every filter but groups | 2 / 24 |
| `inboxListMerge.test.ts:172` | AD-4 | `inboxListMerge.ts:135` back to the pre-fix rule | 1 / 23 |
| same | AD-4 | `inboxListMerge.ts:135` always the read's cursor | 4 (this + 3 existing keep pins) / 20 |
| `inboxTime.test.ts:27` | SC-11 | year checked before Yesterday (inserted after `inboxTime.ts:56`) | 1 / 14 |
| NBSP pins (moved) | AD-1 | `inboxTime.ts:55` and `:66` without plainSpaces | 2 / 12 |
| `InboxRow.test.tsx:228` (strengthened) | SC-12 | `InboxRow.tsx:128` no dateTime/title on multi-party rows | 1 / 20 |
| `inboxLimits.test.ts:21` | AD-8 | `useInbox.ts:62` MAX_PAGE_LIMIT 100 -> 50 | 1 / 0 |

No mutant: the `clearInboxLists()` added to `Inbox.test.tsx` beforeEach
(spec 7.1 hygiene; the hook is mocked there); AD-16's two rewrites (same
assertions); SC-13 (Playwright not runnable in this wave). No new test
exposed a production defect.

## Gates (bare, from the worktree; exit codes)

| Before | Dashboard suite | Typecheck | Other |
|---|---|---|---|
| 96dce256 | 0: 197 files, 3251 passed | 0 (a first run was 2: TS2769 on the getter spy's typing; fixed before commit) | eslint 3 files 0; 169,628 instants, old vs new formatter, 0 mismatches |
| 6959578c | 0: 197 / 3252 | 0 | eslint 0 |
| d9923997 | 0: 197 / 3252 | 0 | eslint 0; throwaway stub-IO check of the default factory (deleted) |
| 9edab26a | 0: 197 / 3252 | 0 | `npm run test -w app` 0: 366 files, 6876 passed, 1 skipped, 139.6 s, no `[dynamoAdmin]` line; inboxFeed 68 passed; eslint 0 |
| 9dd2f2dd | 0: 198 / 3272 | 0 (e2e workspace included) | inboxFeed 68 passed; eslint 9 files 0 |
| ef37bf69 | 0: 198 / 3272 | 0 | `npm run issues` 0 |

Wave eslint on all 16 touched TS/TSX files: exit 0, no output. Added lines
in the wave: 0 non-ASCII bytes. Not run, per the brief: `npm run e2e`,
`npm run smoke`, root `npm test`, `perf:pages`.

`npm run issues`: "296 open, 180 closed, 476 total", "open by severity:
6 high, 128 med, 162 low"; no warnings; all four new files indexed.

## Divergences from the charter's stated fix

1. AD-1 spies: `format` is an accessor on `Intl.DateTimeFormat.prototype`,
   and a value spy throws ("incompatible receiver"). The pins spy the GETTER
   and return a stub; lib.es5 types `format` as a method, so a `stubFormat`
   helper (`inboxTime.test.ts:90-99`) casts for the 'get' overload. Both
   the getter and the stub are asserted called once.
2. AD-4 test update: no existing test pinned null over a cursor. The only
   null test (`inboxListMerge.test.ts:158`, null over null) holds under both
   rules; it kept its assertions and gained a comment naming the rule.
3. Spec: the whole DRAFT 8.5 edit is in 6959578c. The Status line was
   replaced with the given text, which drops "APPROVED for build" and the
   Task 7b clause from line 3 (the ruling stays in 5.8).
4. AD-5: the header had no residual sentence; one was added
   (`useAutoLoad.ts:18-21`).
5. SC-4: a pass-through `vi.mock` of `./useAutoLoad.js` in the existing
   `Inbox.test.tsx` (records the options, still runs the real hook) instead
   of a new file.
6. SC-5 covers Unread (group row) and Unknown (relay row); no Groups branch I
   case (the report's fix names Unread only). SC-7 is two tests; pendingRef
   and the scroll seed are unrendered, so the pin reads the next tab's first
   save. SC-9's post-unmount pin simulates the sign-out order and kills only
   the removal of both alive gates.
7. SC-13: test 3's row-set check (a small `rowHrefs` helper) is on the
   limit=10 part only; the limit=2 part rebuilds its list and was left alone.
8. Docs: dated text in the thread-hooks issue keeps "30 on that commit" as
   history; the parselimit issue also names the validated `?limit=`; the
   unknown-queue issue updates every "30" (downgrade note, reachability,
   measured page, reopen trigger).

## Worth an eye (not blocking)

- Spec 7.1 (`spec:940-941`) still says "keeps the old cursor including
  null", contradicting amended 5.6; the brief limited the spec edit to 5.6,
  section 8, 5.8 and Status.
- Spec 5.2's residual paragraph (`spec:350-354`) predates AD-5's drain.
- Module formatters fix their time zone at load: an OS zone change mid-session
  labels in the old zone while the tiers follow the new one, until reload.
- "The gap between two Load more clicks" (`app/src/routes/inbox.ts:2034-2035`
  and the unknown-queue issue's condition 2) ignores auto-load; and the
  thread-hooks issue (`:211`) still says loadMore does not dedupe (true
  on its dated commit). Left: outside the charter's edits.
- SC-13's e2e assertions have never run; the next full e2e gate is their
  first exercise.
