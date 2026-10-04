# Adversarial review - feat/tour-auto-close (planner review, fresh eyes)

Reviewer: adversarial code reviewer (no spec, no plan, no review history read;
nothing under docs/superpowers/ opened except to write this file).
Inputs: `.superpowers/planner-review/code-package.txt` (the -U8 diff) and the
worktree at `W:\tmp\tour-auto-close` (branch tip 16e1f6f0, merge base 71e532fb).
Read-only: no test, build, server or install was run. Line numbers are the
branch tip.

## Verdict in one paragraph

The conditional-write core holds. I walked every read-then-write on the tour
row I could find (sweep vs PATCH, sweep vs conversion claim/finalize, sweep vs
reopen, sweep vs sweep, sweep vs relay open, reopen vs reopen, reopen vs PATCH,
stale byStatus GSI reads, ABA through reopen) and each resolves to one winner
whose loser runs no side effect - except the relay-open race, which is already
filed. The job cannot reach a messaging path, nothing writes `no_show` on its
own, and no route lets a person record `no_outcome`. No BLOCKING defect. What
is wrong is at the edges: the clock means two different things depending on an
attribute no screen shows, a reopen can park a tour where no list can see it,
pending roster actions survive the close, staff-facing copy misdescribes the
rule, and the job is unobservable when it does nothing.

---

## 1. [MEDIUM] The two-week clock has two permanent meanings, chosen by an attribute no screen shows

**What is wrong.** The clock's "mark" is `lastMarkedAt` when present, else
`updatedAt` (`app/src/lib/toursModel.ts:218`). The write mirrors that split:
`updatedAt` is conditioned only for a never-marked read
(`app/src/repos/toursRepo.ts:729-747`). The code, the RUNBOOK and the test
name treat the `updatedAt` branch as a migration stand-in ("no row carries
`lastMarkedAt` before this deploy, so `updatedAt` stands in", `RUNBOOK.md:411`;
"11. LEGACY FLOOR", `app/test/toursModel.test.ts:276`). It is not transitional:
`POST /api/tours` never stamps `lastMarkedAt` (`app/src/routes/tours.ts:309-316`;
pinned "create is not a mark", `app/test/toursApi.test.ts:610`), and the
dashboard's Schedule-a-tour dialog creates every dated tour through that POST
(`dashboard/src/routes/tours/ScheduleTourForm.tsx:313-323`). So every tour
booked with a time and not yet marked - the whole "Not marked" population, in
perpetuity - runs on "any write restarts the clock", while a tour a person has
marked once runs on "only a status/time change or a reopen restarts it"
(`app/src/routes/tours.ts:1161-1166`). The same staff action therefore extends
one tour and not the other:

- opening the relay group writes only `groupThreadId` (claim + pointer,
  `app/src/services/rosterProvision.ts:335`, `:398`) - it bumps `updatedAt`, so
  it restarts a never-marked tour and is ignored on a marked one (pinned as
  intended for the race: `app/src/jobs/tourAutoClose.ts:16`,
  `toursRepo.ts:295-296`, integration "(PIN) autoCloseIf still closes a MARKED
  tour after the same unrelated write");
- the no-show check-in is a GET of a draft plus a normal composer send
  (`app/src/routes/tourReminders.ts:952`), so it never touches the tour row and
  never extends anything.

**Concrete failure.** A tour is marked no-show on day D. On D+14 minus an hour
a navigator, working Today's newly-added no-show rows
(`dashboard/src/routes/today/useTodayPastTours.ts:161`), opens the tour's relay
group to reach both parties: the intro is texted to tenant and landlord. Within
15 minutes the sweep reads the tour (marked: `updatedAt` ignored), it is due,
`autoCloseIf` carries no `updatedAt` term and lands, the tour reads "Closed -
No outcome recorded", and `armRelayCloseNagIfOpen`
(`tourAutoClose.ts:133-137`) arms a 28-day "close this group?" nag on the group
the navigator opened an hour earlier. The identical action on a never-marked
tour dated D keeps it open until D+29.

**Implication.** Closes are unpredictable from anything staff can see: no
surface shows `lastMarkedAt` or a due instant, and the staff copy says the
opposite of the marked-tour rule (finding 3). The "legacy floor" label and
RUNBOOK framing will mislead the next maintainer into treating the
`updatedAt` branch and its same-millisecond residual
(`toursRepo.ts:296-299`) as temporary.

## 2. [LOW] Reopen can return a tour to a live state that no Tours list shows, where it re-closes 14 days later

**What is wrong.** Reopen restores the closed-from status and keeps
`scheduledAt` (`app/src/repos/toursRepo.ts:767-803`). The Past tab reads only
`[start of the day 90 days ago, end of today]` plus toured rows that are
UNDATED or dated after the window (`dashboard/src/routes/tours/useTours.ts:181-185`,
`:200-212`, `:239-252`); Active reads the future window and `requested`.

**Concrete failure.** The first production run closes, as documented, tours
"from before early July" that were "on no list" (`RUNBOOK.md:410`). The RUNBOOK's
review step says to reopen any that should not have closed (`RUNBOOK.md:418`).
Reopening a scheduled, no-show or dated toured tour older than 90 days puts it
back to a live status that neither Past, Today nor Active lists; nobody sees it
until the sweep closes it again 14 days later, writing a second "Tour closed
automatically" pin on both parties' timelines.

**Implication.** The documented undo for a wrong close quietly expires for the
very population the RUNBOOK flags as the blind spot.

## 3. [LOW] The Past tab tells staff the wrong rule

**What is wrong.** `dashboard/src/routes/tours/ToursPage.tsx:603`: "Tours with no
outcome close on their own two weeks after their date or their last update."
For any tour a person has marked, an update (roster edit, relay group open,
message, check-in) does not move the clock - only a status/time change or a
reopen does (`tours.ts:1161-1166`, `toursModel.ts:218`). The GLOSSARY and the
model comment say "mark"; the only staff-facing statement says "update".

**Concrete failure.** Finding 1's navigator reads that line, reasonably believes
working the tour keeps it open, and watches it close.

**Implication.** Copy and rule disagree on exactly the case that surprises staff.

## 4. [LOW] The auto-close leaves the tour's pending roster actions live

**What is wrong.** A quiet-hours deferral (pending `open_group` / `add_member`,
`app/src/routes/tours.ts:762-778`, `:1612-1641`) lives in its own table; the
sweep's deps hold no pending-roster-actions repo
(`app/src/jobs/tourAutoClose.ts:45-56`, `app/src/worker.ts:547-562`) and
nothing retires the rows. (The conversion does migrate them,
`app/src/routes/placements.ts:842-858`; the PATCH terminal paths also do not.)

**Concrete failure.** (a) The tour is closed overnight by the sweep; at
quiet-end the roster-action poll skips the row as `owner_canceled`
(`app/src/jobs/rosterActions.ts:171-173`) and the People card tells staff
"... was not added - this tour was canceled."
(`dashboard/src/routes/shared/rosterWrites.ts:154-155`) about a tour nobody
canceled. (b) If staff reopen the tour before the row's dueAt, the deferred open
or add applies at quiet-end and texts the group, minutes after a Reopen dialog
that said "Nothing is sent" (`dashboard/src/routes/tours/tourReopen.ts:23-28`).

**Implication.** A system close now produces a human-sounding "canceled" notice,
and a person's stale deferral can outlive the close and fire after a reopen.

## 5. [LOW] The new 409s leak raw machine codes from the header one-click writes, and the bulk runner mislabels them

**What is wrong.** The feature's contract is that every writing tour dialog maps
a 409 to the reload copy (`dashboard/src/routes/tours/TourModals.tsx`, header
comment and `failureCopy`). The two header one-click writes are not dialogs:
Mark toured and Mark no-show go through `runDirect`
(`dashboard/src/routes/tours/TourDetail.tsx:359-372`, `:380`, `:386`), which
renders `err.message`, and the client builds that message as `code (detail)`
(`dashboard/src/api/client.ts:75-80`). The Past tab's bulk runner maps any PATCH
failure to "The update failed" (`dashboard/src/routes/tours/ToursPage.tsx:457-462`).

**Concrete failure.** A tour page is open when the sweep closes the tour (the
bridged `tour.updated` refresh is best-effort, `app/src/lib/eventBridge.ts`).
The navigator clicks Mark toured; PATCH's consistent read sees `closed` and the
header shows "illegal_status_transition (a closed tour cannot be changed
(current: closed, requested: toured))". In the bulk runner the same race (its
re-read is eventually consistent) reports "The update failed" instead of
"Changed since the list loaded".

**Implication.** The sweep is a new background writer that makes stale-page
clicks routine; the two most common writes on a past tour were left out of the
409 handling the feature added for the rest.

## 6. [LOW] Nothing can stop, preview or undo the first run except a code change

**What is wrong.** The poll starts unconditionally in every worker
(`app/src/worker.ts:526-569`), on a code-constant cadence
(`app/src/jobs/tourAutoClose.ts:40`); compare the extraction poll gated on a flag
(`app/src/worker.ts:450`). The only preview is a manual Past-tab heuristic the
RUNBOOK itself calls approximate with a blind spot (`RUNBOOK.md:410`). The only
undo is one reopen per tour (`RUNBOOK.md:418`), which cannot remove the "Tour
closed automatically" pins already written to both parties' timelines and the
property/tour activity (it adds "Tour reopened" pins beside them), and which
expires for old tours (finding 2).

**Concrete failure.** If the first prod tick closes a wrong population (bad
data, a clock-input surprise), every close is already persisted and pinned
before anyone sees the run line; containment is a revert-and-deploy while the
next 15-minute ticks keep closing.

**Implication.** The blast radius of the first run is bounded only by the
correctness of the predicate on production data nobody has dry-run.

## 7. [NOTE] A sweep that does nothing - or loses every write - is invisible

**What is wrong.** The run summary is logged only when `closed > 0 ||
failed > 0` (`app/src/jobs/tourAutoClose.ts:113`); a lost write is logged only at
debug in the repo (`app/src/repos/toursRepo.ts:760`). The RUNBOOK's triage is
"look for `tour auto-close poll error` lines" (`RUNBOOK.md:1237-1240`, under the
worker-polls section).

**Concrete failure.** A sweep that reads zero candidates, or whose every close
loses its condition, emits nothing at info; it is indistinguishable from a
healthy idle sweep, and no alarm or line says the job is alive.

**Implication.** The RUNBOOK's "if overdue tours stop closing" path only finds
thrown errors.

## 8. [NOTE] The sweep's side effects are not ordered against a reopen and are not durable

**What is wrong.** The close is one write; pins, the reminder sweep and the
nag arm run afterwards, best-effort, in the same process
(`app/src/jobs/tourAutoClose.ts:96-110`, `:118-140`). The reopen's clear runs
after its own write (`app/src/routes/tours.ts:1504-1521`).

**Concrete failure.** A reopen that lands between the sweep's write and its
`afterClose` runs `clearRelayCloseNagOnReopen` first; the sweep's
`armRelayCloseNagIfOpen` then arms a 28-day nag on the now-live tour's group,
and the timelines read "Tour reopened" followed by "Tour closed automatically".
Separately, a worker shutdown (every deploy) between a close and its side
effects leaves a closed tour with no pins and no nag, and nothing re-drives them.

**Implication.** Narrow windows, but the nag one produces a wrong Today prompt
four weeks later with no trace of why.

## 9. [NOTE] "Silent by construction" is pinned on field names, not capability

**What is wrong.** `TourAutoCloseDeps` carries the full `ConversationsRepo`
(`app/src/jobs/tourAutoClose.ts:45-56`). The guards check the deps' key set
(compile pin in `app/test/tourAutoClose.test.ts`) and a regex over the worker
block (`app/test/jobQueueWiring.test.ts`, the `createMessagingAdapter|...`
pattern). I traced every call the job can make (listByStatus/get/autoCloseIf;
deleteSupersededForTour; activity record x2, units.getById, audit append x2;
conversations getById/setCloseNagNextAt; two bus emits whose only app-side
listeners are the SSE route, `app/src/routes/api.ts:2659-2660`) and none
reaches a send today.

**Implication.** Silence holds now; a future repo method that enqueues a send
would pass both guards.

## 10. [NOTE] Rules and copy duplicated across app and dashboard with nothing that fails on drift

`reopenTargetOf` (`dashboard/src/routes/tours/tourReopen.ts:12-21`) re-implements
`reopenTargetFor` (`app/src/lib/toursModel.ts:253-259`); its test restates the
server table by hand. The outcome union is hand-mirrored
(`dashboard/src/api/types.ts:903`). The close label exists three times
(`app/src/jobs/tourAutoClose.ts:43`, `dashboard/src/routes/listing/listingFormat.ts:142`,
`dashboard/src/routes/tours/tourActivityFormat.ts:26`). A server rule change
ships with the dashboard offering Reopen where the server answers 409, and no
gate notices.

## 11. [NOTE] `isTourOutcome` is now dead and wider

`isTourOutcome` (`app/src/lib/toursModel.ts:88`) has no caller left in
`app/src` (PATCH moved to `isStaffTourOutcome`) and now accepts `no_outcome`. The
next input validator that reaches for the obvious name accepts the system-only
outcome.

## 12. [NOTE] Staff-facing vocabulary disagrees with itself

The Reopen dialog says the tour "goes back to Not marked"
(`dashboard/src/routes/tours/tourReopen.ts:26-27`) and the header then reads
"Scheduled" (asserted by `e2e/tests/dashboard-next/tour-auto-close.spec.ts:245-249`).
The tenant file, landlord file and property tour lists render only the status
label (`dashboard/src/routes/contact/TenantFile.tsx:339`,
`dashboard/src/routes/contact/LandlordFile.tsx:219`,
`dashboard/src/routes/listing/ListingDetail.tsx:1088`), so an auto-closed tour
and a not-a-fit read the same "Closed" everywhere but the Closed tab.
`RUNBOOK.md:1134` still says one interval drives "five" polls while the edited
`app/src/lib/config.ts:600` says six; this diff touched both sections.

## 13. [NOTE] Filed residuals re-verified, severities agree

Re-derived from code, each reproduces as its issue file says:
relay open vs auto-close (`claimGroupThread` has no status term,
`app/src/repos/toursRepo.ts:494-507`; `autoCloseIf` ignores `groupThreadId`,
`:685-765`); reopen vs conversion (F2: `claimConversion` has no status or
`convertible` term, `:534-556`); AD-5 (reopen trusts a decision as proof of a
visit, `toursModel.ts:257`); AD-7 (a PATCH revival keeps its cancel's nag);
AD-8 (`reopenIf` has no ABA term, `toursRepo.ts:767-803`); AD-3 (same-status
PATCHes still merge). Not repeated above.

---

## Walked and found sound (so the next reviewer need not repeat them)

- Sweep vs PATCH, both orders: PATCH reads consistently (`tours.ts:1034`) and
  writes with `expectedStatus` (`tours.ts:1234`); the close conditions on status,
  outcome, conversion claim, convertible, scheduledAt, lastMarkedAt
  (`toursRepo.ts:710-747`). A mark always stamps `lastMarkedAt`, so a mark
  between the sweep's read and write always breaks a term; a close between
  PATCH's read and write always fails `expectedStatus`. No side effect runs on
  either loser (`tours.ts:1235-1252`; `tourAutoClose.ts:104-107`).
- Stale byStatus GSI reads (projection ALL, `infra/modules/dynamodb/main.tf:57`):
  a stale copy can only make the close lose, never land wrongly; reopen's
  `lastMarkedAt` stamp defeats the close-reopen-stale-read ABA.
- Sweep vs sweep (two workers, worker plus dev tick): `#st = :from` gives one
  winner; only the winner runs side effects.
- Reminders: the poll does not read tour status; it relies on the pointer, and
  the close rotates `currentLadderId` in the same write
  (`toursRepo.ts:748`), so every old rung (pre-migration exempt pairs
  included) is refused; the follow-up sweep rides a ConditionCheck on the
  rotation (`app/src/repos/tourRemindersRepo.ts:502-578`).
- Silence: proven by call-graph trace (finding 9). No automatic `no_show`
  writer exists (the close writes `closed`; `autoClosedFrom` copies the
  conditioned read status). No route accepts `no_outcome` (PATCH
  `tours.ts:1022-1025`; POST allowlist `tours.ts:143`; reopen takes no fields
  `tours.ts:1489-1493`).
- Security: reopen sits behind requireAuth like every tour route (test 403/401
  in `app/test/toursReopenApi.test.ts`); the dev tick mounts only when dev auth
  is on, NODE_ENV is not production and a DynamoDB Local endpoint is set
  (`app/src/lib/devRoutes.ts:19`).
- Test fakes: the harness `autoCloseIf` / `reopenIf` / `patch` precondition
  evaluate the same terms synchronously, including string-vs-absent
  (`app/test/helpers/twilioWebhookHarness.ts`, `storedAsRead`); `get` returns
  copies.
- e2e lane: the lane's real worker sweeps by wall clock, but the lean world
  seeds no tours, spec-created tours are never due by wall clock, and the
  full-profile matrix/cast/live tours are recent, decided or requested
  (`app/src/lib/seed/matrix.ts:907-916`, `cast.ts:548-561`, `:799-817`).
