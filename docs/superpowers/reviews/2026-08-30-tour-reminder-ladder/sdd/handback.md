# HANDBACK - Tour reminder ladder, Phase A

**MERGE-READY @85e78de8 on `feat/tour-reminder-ladder`
(`W:\tmp\tour-reminder-ladder`), 21 behind `main`, UNMERGED (human gate).**

**NO infra. NO deps. NO post-merge ops owed.** Nothing to deploy, no terraform,
no SSM, no secrets. Merge and it is done.

---

## 1. THE FIVE THINGS TO KNOW BEFORE YOU MERGE

1. **THE LADDER IS STILL PAUSED.** `MANUAL_ONLY_REMINDER_KINDS` and
   `REMINDER_KINDS` are byte-identical to the merge base (verified, not
   asserted). Nothing auto-sends. `confirmation` still arms and its **Send now
   button is LIVE** - accepted knowingly per spec 2, because a force-sent
   confirmation is a correct message to a tenant who does have a booked tour.
2. **FORCE-SEND IS LIVE AND IT IS THE PATH THAT REACHES PEOPLE.** Every word of
   the new copy and every fallback - the "Hey there," greeting, the
   landlord-led-degrades-to-self-guided rule, the `names_unavailable` refusal -
   goes to a real tenant or landlord the moment Sam presses Send now. That is
   why the copy got send-grade scrutiny even though the poll is off.
3. **THE HARNESS TRAP:** the dev tick route injects an EMPTY manual-only set, so
   the e2e suite exercises an automatic send path production does not have. A
   green e2e proves the MACHINERY, not that anything sends in production.
4. **In-flight rows are NOT re-armed.** For one booking horizon the panel shows
   OLD dueAts with NEW copy - a rung labelled "Day before" sitting at 3pm. A
   backfill would be more destructive; accepted per spec 9.3.
5. **`docs/issues/tourcopy-messageid-cast-unguarded.md` is CLOSED** by the
   exhaustive compose matrix (spec 9.1 asked for this to be said out loud).

---

## 2. GATES - all five GREEN on the FINAL commit 85e78de8

Run bare from the worktree, never piped, real exit codes read from marker files.

| # | Gate | Result |
| --- | --- | --- |
| 1 | `npm run typecheck` | **exit 0** |
| 2 | `npm test` | **REAL_EXIT=0** - 346 passed + 1 skipped / 182 / 19 / 34 / 13 test files |
| 3 | `npm run smoke` | **exit 0** - "1356 import specifier(s) across 239 emitted file(s) resolve under plain Node." |
| 4 | `npm run e2e` | **REAL_EXIT=0** - `259 passed (19.6m)`, 0 failed, 0 flaky |
| 5 | `npx eslint <41 branch files>` | **PASS - ZERO NEW ERRORS** |

The one gate-2 skip is the known MinIO media-bucket one. **No DynamoDB suite
self-skipped.**

**Gate 5 detail, because the raw exit code is 1 and that is expected.** `main`
carries 117 pre-existing lint errors; the rule is no-new-errors-in-touched-files.
I attributed by BASELINE COMPARISON, not by line number: checked out the
merge-base version of all 38 pre-existing touched files in place, ran the
identical eslint invocation, restored. **Baseline 11 errors, HEAD 11 errors,
identical set** once line numbers are normalised. The four that looked new were
pure line shifts from my edits. Note especially
`relayGroups.ts:60 'resolveMessage' is defined but never used` - which looks
exactly like the delete-the-last-use trap AGENTS.md names by name - is
**pre-existing at the same line at the merge base**.

The suite was also run green twice earlier (259 passed at `b208285d`, 254 passed
at Task 4's interim checkpoint before the retiming red window opened).

---

## 3. WORK MAP - all ten shipped

| id | item | state |
| --- | --- | --- |
| T1 | `shiftLocalDate()` calendar-day helper | shipped `7a98bb3c` |
| T2 | `resolveTourContactNames()` module | shipped `e500aa0c` |
| T3 | `booked_too_late` on both unions + label | shipped `e8e20c92` |
| T4 | Catalog, composer, every compose path | shipped `6c495d3a` |
| T5 | Failure is not absence | shipped `f720c9a9` |
| T6 | Retime `computeDueAt` | shipped `123aa43a` |
| T7 | Booked-too-late rules + quiet warn | shipped `f2908b1a` |
| T8 | Relabel + pinned accessible names | shipped `7cbbe7d3` |
| T9 | e2e mirror + timing contract | shipped `0f30c9b5` |
| T10 | Seeds, prose, issue registry | shipped `6e34c95d` |
| T11 | Main sync, gates, handback | `268554ef` + this |

Plus two review fix waves: `b208285d`, `85e78de8`.
71 files, +14402 / -588 against the merge base.

Main synced ONCE at `268554ef` - 115 commits, **zero conflicts**. It changed
`dashboard/package.json` + the lockfile, so `npm install` was re-run before
gating. Main has drifted 21 commits since; noted, not chased.

---

## 4. LIVE SELF-QA - what I saw with my own eyes

Hermetic `e2e:session` on lane 10, real dashboard, two tours booked through the
real UI. Not eyeballed - measured against the API.

**A landlord-led tour 3 days out at 14:00 local.** All four rungs, verbatim
from the panel:

```
Hey, your tour is set for Thu, Sep 3 at 2:00 PM at 88 Sycamore St, Decatur, GA 30030.
Hey Tasha, confirming your tour tomorrow at 2:00 PM. Does that still work for you?
Hey Tasha, looking forward to having you tour at 2:00 PM today. Does that still work for you? Address is 88 Sycamore St, Decatur, GA 30030.
Hey Tasha, Marcus will be headed that way shortly. Can you please text here when you're on the way?
```

The confirmation keeps its OLD copy and its address twin. `Marcus` is the unit's
landlord of record, resolved LIVE - the property-contact path works end to end.
All four rungs showed **"Paused - send manually"**.

**Timing, read back from the API** (tour 18:00Z = 14:00 EDT):

| rung | dueAt | check |
| --- | --- | --- |
| confirmation | `2026-08-31T14:31:50Z` | the arm instant |
| day_before | `2026-09-02T23:30:00Z` | 19:30 EDT the evening BEFORE - exact |
| morning_of | `2026-09-03T14:00:00Z` | sched - 4h - exact |
| en_route | `2026-09-03T17:00:00Z` | sched - 1h - unchanged |

**A self-guided tour booked SAME DAY, 3.5h out** - the booked-too-late path,
which has NO e2e coverage at all, so this walk is its only live proof:

```
Day before        Skipped - booked too late for this reminder
4 hours before    Skipped - booked too late for this reminder
Confirmation      NEXT   Paused   Send now / Cancel
En route          Paused   Send now / Cancel
```

Both rows are VISIBLE rather than absent (spec 8.1's whole point), both store the
CLAMPED dueAt (spec 8.2), and the self-guided `en_route` correctly reads
"can you please text me when you're on the way?" - so both sides of the tour-type
fork are confirmed live.

**Accessible names**, swept from the DOM - the relabel and the "the" insertion:

```
Send the Confirmation reminder now      Cancel the Confirmation reminder
Send the Day before reminder now        Cancel the Day before reminder
Send the 4 hours before reminder now    Cancel the 4 hours before reminder
Send the En route reminder now          Cancel the En route reminder
```

Zero occurrences of "Morning of" anywhere.

**SEGMENT COST (spec 5 asked for a measurement, not a gate).** Every rung is ONE
GSM-7 segment, worst case included:

```
146 chars  1 seg  GSM-7  morning_of / long name / long address (worst case)
 98 chars  1 seg  GSM-7  morning_of / no address
109 chars  1 seg  GSM-7  en_route landlord-led
 87 chars  1 seg  GSM-7  day_before
 41 chars  1 seg  GSM-7  no_show_checkin
```

**No extra SMS cost.** The founder's wording happens to fit comfortably, which
is the best possible vindication of the ruling not to constrain it.

NOT walkable live: the read-FAILURE behaviour (refusals, the blank-preview note)
needs injected repo failures the hermetic stack does not expose. It is pinned at
unit and API level instead - deliberately, per the mission brief.

---

## 5. REVIEW - two passes, one re-review, two fix waves

**Conformance reviewer:** no VIOLATED rulings. All seventeen load-bearing spec
rulings CONFORM, including the two I asked it to check hardest - the pause is
genuinely untouched, and all five founder copy strings are byte-exact against
spec section 5 (machine-compared, not read).

**Adversarial reviewer (plan-blind by mandate):** 7 findings, then 4 more on
re-review. **None BLOCKING, none HIGH surviving.**

### The one that mattered - and where the PLAN was wrong

The adversarial reviewer found that a `booked_too_late` rung can still
**supersede the confirmation**, so the panel shows "superseded by a later
reminder" pointing at a rung that will never fire.

The plan, and the ledger entry written from it, called this PRE-EXISTING. **I
checked at the merge base and the plan was wrong.** There, seedLive pins the
superseder ALIVE (`morningOf.skippedAt` explicitly undefined), and it cannot
arise generally either: confirmation's clamped dueAt is always `>= now` while a
past-dueAt-dropped rung is always `< now`, and `supersededBySlot` already
excludes `past_event`. **Rule (e) introduced it.**

I did NOT fix the machinery - spec 8.1 puts cross-rung supersession out of scope
for Phase A in terms, and the fix reorders rule evaluation, which spec 8.1 warns
reopens the vanishing-row problem. The impact is bounded by the pause, and the
lost rung is `confirmation`, which Phase B deletes anyway. **What I did fix is
the record**: the Phase B ledger now carries the true account plus a measured
band from an exhaustive sweep - and the honest numbers are worse than the plan's
guess. Under `quietHoursStart: '19:00'` - a supported setting this branch
deliberately refuses to validate - the band runs **up to seven hours daily** at
tour hours 10:00-20:00. Phase B should treat item 8 as real work.

### The other finding worth your eye

A `{token}` inside a **contact's first name** was being expanded into the
outbound SMS, because the shared `interpolate` substitutes declared tokens in
sequence and re-expands what it just inserted. Newly reachable on the tour path
(tour entries declare seven tokens; the other name-bearing entries declare one).
Closed at the tour source with a brace strip in `tourContacts.ts`, proven end to
end through the real composer with hostile values on every name field.

**But the re-review then found this is LIVE IN RELAY TODAY, with no tour
involved:** `relay.member_added` declares TWO tokens, both fed from contact
display names, so a group member named `{members}` puts a literal token into an
SMS to the whole group. Out of scope here (relay is explicitly out per spec 4)
and **filed as `message-interpolate-token-reexpansion`** - but it is a live bug
in code this branch does not own, and you should know it exists.

### The finding I upheld against my own first ruling

I initially rejected "the resolver names the unit's contact, not the tour's
roster" as spec-conformant. The reviewer came back with a proof I accepted: when
`unit.landlordId === tour.tenantId`, the body composed
**"Hey Alice, Alice will be headed that way shortly."** and sent it to Alice -
and `rosterResolution.ts:279-281`, one line below the very snippet spec 6.1 told
the build to reuse, carries the de-dupe guard the build had dropped. Fixed in the
second wave, and I proved the new test is real by reverting the guard and
watching it fail.

Full record: `.superpowers/review/adjudications.md`, `review-a-conformance.md`,
`review-b-adversarial.md`, `review-b-round2.md`, `fix-wave-report.md`.

---

## 6. DECISIONS I MADE - your call to overrule any of them

- **Nudge accessible names deliberately NOT changed.** The relabel inserted "the"
  into the two REMINDER aria templates; the sibling nudge panel keeps
  `Send <label> nudge now`. The knock-on is scoped to the rung whose label
  changed, and `selectors.md` already pins `Send the relay group now`, so "the"
  is house-acceptable on one side without forcing the other. A reviewer WILL
  read this as a missed sweep if nobody says otherwise - hence this line.
- **Seeds stay `sentBody`-less**, so seeded "already sent" demo rows re-render in
  the CURRENT copy: the demo shows months-old tours quoting today's wording.
  Chosen over fabricating synthetic send snapshots in a store whose whole point
  is recording what actually went out.
- **The `{where}` declarations stay** on the twin-less entries (spec 6 mandates
  declaring the full set so a future wording change is a pure string edit), even
  though re-adding `{where}` to one of those defaults would throw for an
  addressless unit. Filed rather than "fixed" by removing the declaration.
- **The shared `interpolate` was not touched.** A single-pass fix changes every
  message in the app and deserves its own change and its own review.

## 7. KNOWN TAILS - accepted, filed, not defects

- An org with `quietHoursStart <= 19:30` retires every `day_before` as
  "superseded", with a WARN naming the cause (spec 7.1). One warn per arm - per
  booking, per reschedule, per revival. No dedupe; accepted as specified.
- Reschedule and revival re-evaluate both skip rules against the RE-ARM instant,
  so a tour nobody booked late can get the "booked too late" chip. Spec 11
  accepts this and rules only that the wording must not accuse. Re-arming a
  short-horizon tour repeatedly accumulates skipped rows.
- The whole e2e harness assumes host zone == `ORG_TIMEZONE` and **nothing asserts
  it**. Pre-existing, stated in comments, not fixed. If CI ever moves zones, the
  comment Task 9 wrote is the only warning.
- `booked_too_late` has no e2e verb - `expectReminderRung`'s state union has no
  `'skipped'` member. Deliberately not widened; filed.
- Read-failure semantics have ZERO e2e coverage by design. Pinned at unit/API
  level only.

**Pre-existing problems found and deliberately left alone** (each would be its
own change): `rosterProvision.ts:525` copies the primary-contact rule WITHOUT the
empty-string guard; `RemindersPanel.tsx:189` and four sites in `TourDetail.tsx`
render `err.message` raw; the skip chip has no `?? rawReason` fallback unlike its
siblings; `TimelineScheduled.reminderKind` is a third hand-duplicated kind union.

**One pre-existing TEST defect I did fix**, because a new test could not exist
without it: the in-memory `tourRemindersRepo.create` fake in
`app/test/helpers/twilioWebhookHarness.ts` **silently dropped `input.skipped`**,
so every arm-time skipped row looked like a live rung to every route-level suite.
The fake now mirrors the real repo, and `toursApi`'s `pendingRows` helper was
tightened to the same definition `listDue` already uses.

## 8. ISSUE REGISTRY

- CLOSED: `tourcopy-messageid-cast-unguarded`
- UPDATED: `founder-message-template-updates-owed` (tour half landed; D2 reversal
  recorded), `tour-reminders-panel-e2e-flake`, `scheduled-message-visibility`
- FILED: `tour-reminder-ladder-phase-b` (the nine-item unpause ledger),
  `tour-reminder-zero-primary-e2e-gap`, `message-interpolate-token-reexpansion`,
  `tour-copy-where-token-declared-not-passed`

**Phase B's first task is a one-time RETIREMENT SWEEP of stale pending rows
BEFORE the pause lifts** - criterion is THE TOUR BEING PAST, not the dueAt, and
never stamp them `past_event`. Without it, unpausing texts a backlog of tenants
about tours that already happened.

## 9. RECOVERIES - 1, environmental

The Task 10 child was killed mid-sentence by a weekly usage limit while writing
its report. Its work SURVIVED - it had already committed - so I verified the
commit against the tree myself rather than re-dispatching. No agent malfunction,
no re-run, budget intact.
