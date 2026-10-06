# Design review r1 (reviewer A) - tour auto-close and reopen

- Spec: `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md` (DRAFT 1)
- Repo state reviewed: `feat/tour-auto-close` @edc045c3 (main @ae04122d + the spec)
- Method: every claim about current behavior checked in code; read-only; nothing run.
- Severity = consequence if it ships unfixed.

Most of section 3's description of today's code is accurate. I checked each cited
file:line (PATCH guards, exit gate, terminal rotation, recordTourEvent, close-nag arm,
conversion claim/finalize, listByStatus/listByScheduledRange, pollLoop, worker wrapper,
config default, dev tick, Past/Today selectors, CTA ladder, activity label maps,
listing-send chip, Today board, roster-actions owner check) and found them correct,
except where a finding below says otherwise.

---

## F1 [HIGH] A staff PATCH can land on top of an auto-close and leave a LIVE tour carrying `no_outcome`. The 6.6 guarantee and the section 12 invariant are false, and section 8 rules out the only fix

**What is wrong.** Section 6.6 says: "whichever write lands first wins; a staff write
after the close meets the existing closed-terminal 409". The mechanism cannot deliver
that. The PATCH handler checks every transition rule against a READ, then writes with
no status condition:

- read: `app/src/routes/tours.ts:1057` (`tours.get(tourId)`, eventually consistent by
  default - `app/src/repos/toursRepo.ts:325-336`);
- guards evaluated on that read: `tours.ts:1073-1149` (the closed-terminal 409 at
  `:1076-1080` included);
- write: `tours.ts:1239` -> `toursRepo.patch`, whose only condition is
  `attribute_exists(tourId)` (`toursRepo.ts:422`).

So this interleaving goes through: PATCH reads `scheduled`, the sweep's conditional close
wins, then the PATCH write runs. The 6.3 condition protects the sweep against a staff
write that lands between the SWEEP's read and the SWEEP's write. Nothing protects a
staff write whose READ came before the close. The staff write wins, and it MERGES into
the closed row instead of replacing it: `status` becomes the staff's target, while
`outcome: 'no_outcome'`, `autoClosedAt` and `autoClosedFrom` stay on the row.

This is not a new discovery. It is the open issue
`docs/issues/tours-patch-status-precondition.md`: "the server cannot refuse the late
write". Both reads in the Past tab's bulk runner are eventually consistent
(`dashboard/src/routes/tours/ToursPage.tsx:436-448`, then the handler's own read), so the
window is a round trip plus replication lag at two layers.

**Resulting states (all reachable from shipped dashboard buttons):**

- Mark toured (`TourDetail.tsx:361`, or the Past tab's bulk runner): `toured` +
  `no_outcome`. The CTA ladder shows nothing, because "Record outcome" needs
  `outcome === undefined` (`TourDetail.tsx:595`). The Past tab drops the row as
  "decided" (`useTours.ts:203`), so Today does too. `autoCloseDueAtMs` returns null
  (outcome present, spec 5.3), so it never closes again. Reopen answers 409
  `tour_not_closed` (7.1). The Outcome card renders "Closed automatically on..." (9.2)
  under a "Toured" badge. Nothing in the UI can get the tour out of this state.
- Reschedule a no-show (`TourDetail.tsx:509-511`): the write takes status `scheduled`
  and a new date. Arming a ladder and `setLadderIdIf` then succeed
  (`tours.ts:1270-1319`), so REMINDER TEXTS GO OUT for a tour that also carries
  `no_outcome` and the auto-close attributes. The sweep has also armed the relay
  close-nag (6.4 step 3) on that now-live tour's group. The tour can never auto-close
  again (outcome present), and once marked toured it disappears from every list, as
  above.
- Cancel: the result is `canceled` + `no_outcome`. A later Reschedule revives it into
  the same stuck state.

The section 12 invariant ("a tour carrying `no_outcome` was closed by the sweep... until
a reopen removes all three") does not hold under this interleaving.

**When it is most likely.** At the first production run (section 13), when a backlog
of old tours closes at once. Those are exactly the rows staff work from the Past tab.

**Same root cause elsewhere.** `POST /:tourId/relay` checks `tourOpenGuard` against a
read (`tours.ts:1500-1513`), and `claimGroupThread` has no status condition
(`toursRepo.ts:440`). A relay open racing the sweep can therefore provision a group and
send intro texts on a tour that was just closed.

**What it implies.** The guarantee needs a write-time precondition on PATCH: an expected
`status` turned into a `ConditionExpression`, answering 409 `tour_changed` (the fix the
issue already proposes). That contradicts section 8 ("Everything else in the PATCH
handler is unchanged"). The spec has to pick one: change section 8 and section 6.6 and
resolve or escalate the issue, or drop the guarantee and the invariant and name the
residual. Either way, the issue's severity (`low`) is stale once an automatic writer
exists.

---

## F2 [MEDIUM] An existing e2e spec asserts the opposite of decision 2.5 and is missing from section 11

**What is wrong.** Section 11 lists the existing e2e specs that must change
(listing-activity, landlord-activity). Decision 2.5 / section 9.4 (Today lists no-shows)
breaks a third one that is not listed:
`e2e/tests/dashboard-next/today-past-tours.spec.ts`.

- Its test title is "lists past tours minus no-shows" (`:95`).
- It creates a no-show (`:105`, `:107`).
- It asserts exactly two Today rows (`:115`, `:128`, `:136`, `:163`), and that the
  no-show has no link on Today (`:121-122`).
- It asserts "See all 3" (`:124`) and a capped list of five that excludes the no-show
  (`:175-178`).

The section 9.4 line "Its comment and tests change with it" refers to the selector's
unit tests. The comments that encode the old rule are not named either:

- `dashboard/src/routes/today/Today.tsx:7-9` and `:220-224`;
- `dashboard/src/routes/today/useTodayPastTours.ts:1-5` and `:47-50` ("It includes what
  Today leaves out (no-shows...)").

**What it implies.** Gate 4 goes red on a spec the plan never mentions. New e2e item 4
("A no-show dated within two weeks is listed on Today") overlaps the rewrite this file
needs anyway. Add it to section 11 and make it the home of item 4.

---

## F3 [MEDIUM] The section 13 preview misses every candidate older than 90 days, and a reopened tour of that age appears on no list

**What is wrong.** Section 13 tells the owner to preview the first production run from
the Past tab. The Past tab cannot show what the sweep will close:

- The Past tab looks back 90 days only: `PAST_TAB_DAYS = 90` (`useTours.ts:158`), the
  range read (`:179-183`), and undated rows only when touched within the window
  (`:243`).
- The sweep reads every scheduled, toured and no_show tour, with no lower bound (6.2).

Every no-outcome tour dated more than 90 days ago closes silently and is missing from
the preview. Such tours can exist: the tours feature predates 2026-07-08
(`app/src/lib/toursModel.ts:17`). UNVERIFIED: whether production actually holds any
(I had no production data).

The same gap breaks a section 7.5 claim. Reopening one of those tours to `scheduled`
does NOT make it "Not marked" on the Past tab: it is outside the range read. Active only
lists future tours (`useTours.ts:79`) and Closed only lists closed and canceled tours, so
the reopened tour is on no list. It can only be reached through its own page or the
contact and property files, and it re-closes 14 days later.

**What it implies.** The owner sets deploy timing from this preview (decision 2.6). The
handback needs a preview that reads the same three status partitions the sweep reads
(the API's `?status=` filter plus `autoCloseDueAtMs`), or the section must state the
90-day blind spot. Section 7.5 / 9.3's "reappears by the existing rules" also needs that
caveat.

---

## F4 [MEDIUM] Tours recorded late close within one sweep interval, while the same tour recorded with no date gets 14 days

**What is wrong.** "Mark already toured" exists to record a visit after the fact. Its
dialog expects a past time and only warns on a future one
(`dashboard/src/routes/tours/TourModals.tsx:182-188`, `:208-218`).

- With a date more than 14 days old, the result is a `toured` tour with no outcome whose
  clock is `scheduledAt` (5.3), so it is already due.
- The chained Record outcome dialog (`TourDetail.tsx:521-530`) is dismissable. If the
  operator dismisses it, for example while waiting on the tenant, the next sweep (15
  minutes at most) closes the tour as "No outcome recorded".
- Leaving the date blank instead gives a full 14 days (D3: clock = `updatedAt`).

So giving the system MORE information cuts the window from 14 days to minutes. That is
inconsistent with the spec's own reasoning that a reopened tour "gets a fresh two weeks"
(2.2). The Book and Reschedule dialogs ("... anyway" with a past time) reach the same
state.

**What it implies.** This surface is not enumerated. Decision 2.1 ("14 days after the
tour time") does not address a tour that enters a candidate status after its own
deadline. The spec should decide this explicitly. One option: the clock starts no
earlier than the moment the tour entered its current candidate status, which needs a
stamp much like `reopenedAt`. The other option is to accept it and say so in the dialog
copy.

---

## F5 [LOW] Section 10.2 says the Past tab refetches on `tour.updated`. It does not

**What is wrong.** `usePastTours` (`useTours.ts:296-343`) and `ToursPage.tsx` subscribe
to no event stream. The `tour.updated` subscribers are useTour, useTourActivity,
RemindersPanel, useRoster, useToday and useTodayPastTours (grep of `onTourUpdated` in
dashboard/src). The Closed tab does not subscribe either.

**What it implies.** A Past tab left open while the sweep runs keeps showing closed
tours as "Not marked" or "Needs outcome". The bulk mark then reports "Changed since the
list loaded", and a Record outcome link lands on a closed tour. That outcome is harmless
but surprising. Either correct the claim, or decide that live refresh is in scope.

---

## F6 [LOW] The e2e "now + 15 days" tick acts on the whole lane and mixes three clocks

**What is wrong.**

- e2e item 2's tick runs the real sweep over the whole lane database. It closes every
  undecided tour whose due time is before the injected time: all past-dated ones, and
  scheduled tours up to about a day ahead. That includes tours left behind by earlier
  specs or earlier tests in the same file (item 4's no-show, if it exists at that
  point). The lane's isolation convention is visible in
  `today-past-tours.spec.ts:17-20` and `:91-93`.
- The tick writes the INJECTED instant into `autoClosedAt` and `updatedAt` (6.3), so the
  tour page shows "Closed automatically on <a date 15 days ahead>".
- The activity rows use the wall clock (10.1 accepts that).
- The close-nag uses `Date.now()` unless the sweep's deps pass a clock
  (`app/src/services/relayCloseNag.ts:52`).

**What it implies.** The spec should require the new e2e spec to reseed (or order its
tests) before the future tick. It should also say which clock the sweep passes to
`armRelayCloseNagIfOpen`.

---

## F7 [LOW] An undated no_show IS reachable through the API, so it never closes and is on no list

**What is wrong.** Section 5.3 says "an undated scheduled/no_show tour cannot exist
through the API". It can:

- requested -> canceled is allowed (`tours.ts:1089-1110`);
- canceled -> no_show is refused by no rule (`tours.ts:1073-1128`);
- the result is a `no_show` with no `scheduledAt`.

`autoCloseDueAtMs` returns null for it (5.3, "defensively"). It is also on no list: the
range read skips undated tours and the off-range selector keeps only `toured`
(`useTours.ts:241`).

**What it implies.** It is an API-only edge. Section 13's #6 note ("#6 must decide
explicitly how a requested (undated) tour counts") should also cover this state, which
nothing closes either.

---

## F8 [LOW] Three statements in the spec are inaccurate

- **6.3, "both absent on every candidate" (moveForward / convertible).** False. A PATCH
  of `{moveForward:false}` on a toured tour sets `moveForward:false` and
  `convertible:false` with no outcome (`tours.ts:1173-1177`). That tour is a candidate.
  The close is unaffected, but reopen (7.3) then REMOVEs both fields.
- **6.4 step 1, "normally none".** `deleteSupersededForTour` deletes EVERY never-sent
  row, skipped and canceled ones included (`app/src/repos/tourRemindersRepo.ts:502-507`).
  Every tour created past-dated through the API carries a `booked_too_late` skipped row,
  and other skip reasons are common. So an auto-close routinely erases visible reminder
  history, exactly as a manual terminal transition does. The behavior is acceptable; the
  statement is wrong, and an e2e must not expect that row to survive.
- **Section 1, "Any closed tour that did not become a placement can be reopened".**
  This contradicts 7.1's `tour_reopen_unsupported` (D6).

---

## F9 [LOW] The spec does not say which primary CTA wins on a closed tour with `convertible: true`

**What is wrong.** Section 9.2 makes "Reopen tour" the primary CTA on every reopenable
tour, and 7.2 treats a closed tour with a `move_forward` outcome as reopenable. The
existing ladder, however, shows "Start placement" for `convertible === true` before any
status branch (`TourDetail.tsx:577-582`). That state exists:

- the performance seed writes closed tours with `outcome: move_forward`,
  `convertible: true` and no conversion (`app/src/lib/seed/performance.ts:660-664`);
- `PATCH {status:'closed', outcome:'move_forward', moveForward:true}` produces it too.

**What it implies.** For this state the spec has to say which CTA wins, and whether
reopen removing `convertible` (7.3) is intended.
