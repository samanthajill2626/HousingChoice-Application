# Planner review round 2 - plan-blind adversarial pass - feat/tour-list @ 7267b3be

Scope: the fix wave `git diff e666fae3..7267b3be -- . ":(exclude)docs/superpowers"`
(code-final cab09c9c; e666fae3 itself touches only docs/superpowers), read
cold, plus a second sweep of the whole branch for anything round 1 missed.
Plan-blind, read-only, nothing run; every claim checked at the cited lines.

Verdict: one MEDIUM (new, missed by every pass so far), four LOW. F1 and F5
conceded, with one factual correction to the F1 adjudication on the record.
Top two: R2-1 (every action button in the All tab drops keyboard focus to the
page body) and R2-2 (the new first-page merge keeps the LATER-read copy,
which under eventually consistent GSI reads can be the STALER one).

## The fix wave, read cold

- a653d944 `mergeRows`: correct for the case it names. A first page carrying
  one tour twice now yields one row (it used to render two `<li>` siblings
  with the same React key). Order and identity: the duplicate collapses to the
  first copy's position; the count line, `restore.depth` / `openedIndex`, the
  React keys and the views memo all read the de-duplicated array, so they stay
  mutually consistent; `lastPageEmpty` and `followCount` still read the
  server's `page.tours.length`, as before. The "later copy wins" rule is the
  one open point - R2-2.
- 775f719f views memo: the dependency list is complete - `rowView` reads only
  the row, `contacts`, `units` and module constants
  (`AllToursView.tsx:203-226`), and every hook path returns stable
  references between landed pages (`EMPTY` constants while loading, state
  fields otherwise). Side effect, harmless: `visible` is now stable when not
  searching, so the anchor layout effect stops re-running on every render; its
  deps still include `record` and `restoreOutcome`, so it fires when it must.
  Residual cost (note, not a finding): every visible row still re-renders per
  keystroke, because each row's Link state embeds `back`, which embeds `q`
  (`AllToursView.tsx:381-382`, `:626`).
- e84dfbfa + cab09c9c `queryLimit`: correct; the docblock is accurate; the
  only caller is the integration test (renamed); a literal `{ pageLimit }` would
  now fail typecheck (excess property). `queryGsi` (`toursRepo.ts:356`) and
  the other repos still use the module logger - the house default, no finding.
  One doc left behind - R2-4.
- 8d6a1377, a2ac6144, 0f6fc82b: tests, glossary and issue appends; accurate.
  Added lines are ASCII-only.

## Contesting the adjudications

- F1 - conceded: the only exposure is a pre-fa24547b local stack, a reseed
  is the remedy, and a complement filter would misplace the row and still miss
  it under a dated When. Two premises of the rejection are wrong, though, and
  should not stand in the record. (1) The reminder sweeps do NOT read
  byScheduledAt: the poll reads due rungs from the reminders table's byDueAt
  (`app/src/jobs/tourReminders.ts:786`, `app/src/repos/tourRemindersRepo.ts:317`)
  and tours by id (`tourReminders.ts:1051`, `:1128`); auto-close reads by
  status (`app/src/jobs/tourAutoClose.ts:77`); `listByScheduledRange`'s only
  callers are `app/src/routes/tours.ts:432` and `app/src/routes/today.ts:550`.
  The blast radius of a missing stamp is Today, Active, Past and All - not
  reminders. (2) The type did not enforce the stamp where it actually broke:
  matrix tour rows are `Record<string, unknown>` (`app/src/lib/seed/matrix.ts:900-901`)
  and the cast rows are untyped literals; only typed writers (repo create,
  `performance.ts` via `satisfies TourItem`) are checked. Premise (1) comes from
  stale docblocks - R2-5.
- F5 - conceded (the parallel-branch conflict is real; e2e `tours-all.spec`
  pins the back-arrow path). A zero-conflict breadcrumb remains available: a
  `TODO(area):` at `unitsRepo.ts:581` naming `contactsRepo.ts:849` as its twin.

## Findings

### R2-1 - MEDIUM - Every All-tab action button removes itself when pressed, dropping keyboard focus to the page body

What: the action area renders a button only while no loader runs
(`dashboard/src/routes/tours/AllToursView.tsx:663-692`: Load more and Keep
checking require `data.loader === 'none'`; Retry and Start over vanish when
their call flips `moreFailed` / `dead` / `status`). Pressing one starts a
load, so the focused button unmounts and focus falls to `document.body`; when
the page lands a NEW button renders, unfocused. The same holds for the first
page's Retry (`:608-615`, status error -> loading). The view already guards
exactly this failure for its other self-unmounting controls - the Status
Clear (`:176-179`) and Clear filters (`:353-356`), both with comments saying
focus must not fall back to the page body - and the house primitive for a
busy action exists: `Button`'s `loading` prop keeps the element, with a
spinner and `aria-busy` (`dashboard/src/ui/Button.tsx:45-79`); every other
paged list keeps its Load more mounted while loading (`Inbox.tsx:430-438`,
`BroadcastsList.tsx:172-180`, `EmailTriage.tsx:368-376`, `AiRunList.tsx:79`).
No test asserts focus after any action (`AllToursView.test.tsx` checks focus
only for the restore anchor).

Scenario: a keyboard or screen-reader user tabs past 50 rows to Load more and
presses Enter -> focus jumps to the body; 50 more rows land; the next Tab
starts at the top of the page, so reaching the next Load more means tabbing
through the nav, every filter and all 100 rows. Keep checking after a capped
follow is worse: its follow chain can run up to 10 requests with no button.

Smallest fix: keep the activated button in the action area while its load
runs (the shared `Button` with `loading`, as the other lists do), and when a
user-started load settles move focus deliberately - to the first row it added
(the anchor's own idiom, `focus({ preventScroll: true })` then
`scrollIntoView({ block: 'nearest' })`, `:439-440`), else to the action now
shown. Add one view test per action asserting `document.activeElement` after
the page lands. (A `disabled` busy button alone may not hold focus in current
Chrome, which applies the focus fixup rule to a disabled element - hence the
deliberate move.)

### R2-2 - LOW - The merge keeps the LATER-read copy, which is not always the newer one

What: `mergeRows` (`dashboard/src/routes/tours/useAllTours.ts:97-113`)
replaces a listed tour with whichever copy was read later, on the stated
premise that the later copy is the fresher one. GSI reads are always
eventually consistent and each GSI replicates independently, and the two
copies of a duplicate come from DIFFERENT indexes (byScheduledAt for phase D,
byStatus for the U phases - `toursRepo.ts:840-905`), so read order is not
freshness order. Since a653d944 this also applies inside one page.

Scenario: staff book requested tour X (PATCH writes status `scheduled` and a
date); within the replication window a list request reads phase D, where
byScheduledAt already holds X dated, then phase U-requested, where byStatus
still holds X as `requested`. The page carries both copies; the merge keeps
the stale one at the dated position, so the row reads "Needs booking" /
"Requested" among dated rows until the next reload. Before a653d944 the page
showed both rows; now it shows only the wrong one. The cross-page path
(`withPage`) has the same rule.

Smallest fix: in `mergeRows`, replace only when the incoming copy is not
older - `if (at !== undefined && r.updatedAt >= out[at].updatedAt) out[at] = r`.
Every writer bumps `updatedAt`, rows always carry it (`tours.ts:217-225`),
and the values are canonical ISO, so string order is time order. The new test
(`useAllTours.test.ts:197`) passes unchanged (its later copy is newer); add the
reverse case (an older later copy is ignored).

### R2-3 - LOW (PLAUSIBLE) - Typing a year into From or To commits every intermediate year

What: both date inputs commit on every change
(`AllToursView.tsx:486`, `:500`: `onChange -> change(...)`), and `change`
applies the selection, writes the URL and, through the new list key, starts a
new list (`:327-333`). Chrome and Firefox report a date input's value as the
year is typed, so a To date passes through `0002-..`, `0020-..` and `0202-..`
before `2026-..`.

Scenario: From is 2026-10-01; the user types the To year. For the first three
keystrokes `tourListRangeError` holds (`tourListSelection.ts:162-165`), so the
list vanishes, the role="alert" range message is inserted and announced while
the user is still typing a valid date, and the list then reloads from page 1.
Typing a From year instead (To set) starts up to three throwaway lists
(`0202` is a valid bound; `0002` / `0020` fail `ymdParts` and silently drop
the bound), each up to 6 Queries server-side - the client aborts only its own
wait.

Smallest fix: keep the two inputs' raw values in local draft state and commit
to the selection only when the value has a year of at least 1000, or on blur;
judge `rangeError` on committed values only. (A controlled input cannot simply
ignore the intermediate change - it would refuse the keystroke.)

### R2-4 - LOW - The rename left the knob's old name in the issue that documents it

`docs/issues/tours-scheduled-range-query-unpaginated.md:66` still says the
read "gained an optional third argument `{ pageLimit?: number }`" and `:73`
that the test reads with `pageLimit: 1`; the same Resolution block cites
`toursRepo.ts:416-426` / `:203-210` (now `:420-434` / `:204-213`). That block
is this branch's record of the shipped API, not pre-fix history, so a grep for
the knob lands on a name that no longer exists. Fix: rename both mentions (or
append one line naming e84dfbfa) and refresh the two cites.

### R2-5 - LOW - Stale docblocks name consumers byScheduledAt does not have

`app/src/repos/toursRepo.ts:13` ("reminder/no-show clock") and
`app/src/lib/tables.ts:521-522` ("reminder/no-show clocks") and `:534`
("no-show sweep, reminder job") say the reminder job and a no-show sweep read
this index. None does (see the F1 correction above; there is no no-show
sweep). Pre-existing, but on this branch it misdirected an adjudication about
the index's blast radius, and the next person weighing a change to the
partition invariant will read the same lines. Fix: list the real readers -
Today's tours, `GET /api/tours?from&to` (the Active and Past tabs), the All
tab's phase D. Comment-only; `gen:tables` output is unchanged.
