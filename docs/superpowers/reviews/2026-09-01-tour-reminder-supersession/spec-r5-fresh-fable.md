# Round 5 fresh-eyes adversarial review - tour reminder supersession spec

Reviewer: Fable (fresh pair of eyes; no prior-round reports read before these
findings were written - see the closing section for the after-the-fact overlap
check). Spec reviewed at branch `feat/tour-reminder-supersession` @3f670620.

Every claim below cites a file:line I read in this worktree. Items I could not
verify are marked UNVERIFIED.

---

## Finding 1 [BLOCKING] - "cleared" and "never migrated" are the same stored
## state, and 3.3 / 3.4 / 3.5 / A6 / R5 cannot all survive that

The spec's own clear mechanism erases the distinction its rules depend on.

**The mechanism.** 3.2 step 1: `currentLadderId: null` "rides the patch ALREADY
being written at routes/tours.ts:1164". `toursRepo.patch` maps an explicit
`null` to a `REMOVE` clause - "the only way to truly clear an attribute"
(`app/src/repos/toursRepo.ts:319-347`). So after a clear, the tour row is
byte-identical, with respect to the pointer, to a tour that was never migrated:
the attribute is ABSENT in both cases.

**The rules that now collide.**

- D3 (section 2): "A cleared pointer means the tour has no current ladder and
  nothing of its may send."
- 3.3: a rung is refused when its ladderId does not match the pointer,
  "including every rung of a tour whose pointer is cleared".
- 3.4: a row is CURRENT "when the tour has NO pointer and the row has NO
  ladderId (a wholly pre-migration tour)".
- 3.5: a tour with no pointer and unstamped rows "renders, and polls, exactly
  as today".

With cleared == absent, "no pointer" is one state, and the builder must pick a
branch; each branch breaks stated spec text:

(a) **Treat unstamped-row-on-pointerless-tour as CURRENT (3.4's letter, 3.5's
requirement).** Then a terminal transition on a pre-migration tour (pointer
absent before and after; the sweep replaces `cancelForTour`) leaves any
sweep-MISSED unstamped pending rung CURRENT: the pointer check passes, nothing
refuses it, and it SENDS when due on a canceled/closed tour. The poll reads the
tour but never checks its status (`app/src/jobs/tourReminders.ts:1049-1065` -
tour_missing and retiredByTourStart only). That makes R5's sentence - "The
pointer check lowers a missed row's consequence from 'sends' to 'appears in
earlier'" - FALSE for every pre-migration row: for that class the consequence
of a missed delete is still "sends", exactly as a missed `cancelForTour` row
today. R5 is the fourth slogan: a guarantee stated in general that the
mechanism delivers only for stamped rows.

Also under (a): acceptance 6 ("a terminal transition ... every survivor reads
as earlier") is unsatisfiable for any tour carrying pre-migration rows. Sent
unstamped survivors match "no pointer + no ladderId" the moment the pointer is
cleared and flip (back) to CURRENT - including the perverse mixed case where
rows that were correctly EARLIER while a stamped pointer existed become
CURRENT again when a terminal transition removes it.

(b) **Treat a pointerless tour's rungs as refused (3.3's parenthetical, D3's
letter).** Then 3.5 is broken outright: every pre-migration pending rung in
production is claim-skipped `superseded` on its due tick instead of sending -
a silent mass-disarm of every live legacy ladder, with no backfill (section 5)
to save them.

**What it implies.** The spec must either (i) make "cleared" a distinguishable
stored value (an explicit tombstone value rather than REMOVE - which
contradicts 3.2 step 1's ride-the-patch-with-null as the repo implements null
today), and then restate 3.4's second disjunct against it, or (ii) scope A6,
R5 and 3.3's "every rung" claim to stamped generations and accept, in writing,
that pre-migration rows keep today's exposure. As written, a careful builder
cannot implement 3.3 + 3.4 + 3.5 + A6 simultaneously, and an uncareful one
ships branch (a) with tests written only against stamped fixtures.

---

## Finding 2 [HIGH] - acceptance 5 and acceptance 15 contradict each other

3.3: "All three render such a rung as suppressed `superseded`, never as
upcoming" - the three surfaces being the panel, the contact Upcoming bucket
(`routes/contactTimeline.ts:981`) and the group Upcoming bucket
(`routes/relayGroups.ts:226`). Acceptance 5 repeats it: all three "render a
pointer-mismatched pending rung as suppressed `superseded`".

Acceptance 15: "Both Upcoming buckets stop returning rungs from a superseded
ladder."

A sweep-missed pointer-mismatched rung IS a rung from a superseded ladder. If
the buckets render it (A5), they have not stopped returning it (A15); if they
stop returning it (A15), they cannot render it as suppressed (A5). The two
acceptance tests cannot both be written against the same fixture. Presumably
A15 means the deleted-row common case and A5 the sweep-miss residue, but the
document must say so - acceptance criteria are what the builder's e2e
assertions get written from, and these two, as written, instruct opposite
filters on the same code path.

Secondary, verified: the group bucket today emits NO suppression annotations
at all, by documented design - "Suppression annotations are deliberately
absent: member-level opt-out suppresses individual LEGS at send time, never
the group send itself" (`routes/relayGroups.ts:196-197`). Rendering
`superseded` there is a contract change to a surface whose header argues
against carrying suppression; the spec should acknowledge it is overriding
that note (the rationale does not cover supersession, so the override is
defensible - but a builder reading the header will hesitate or skip it).

---

## Finding 3 [HIGH] - 3.6 replaces `atBottomRef` but enumerates only one of
## its five writers; the reset path as coded fails acceptance 12 on every
## thread open

3.6 specifies the anchor's derivation "on scroll", its three growth behaviors,
the pill/pin gating, and the Jump-to-newest target. But `atBottomRef` has five
writers in `dashboard/src/routes/contact/Timeline.tsx`, and the spec accounts
for only the scroll handler:

- `:1830` - initial value `true` ("default true -> open on the newest item");
- `:1844` - `scrollToBottom` (the pill's click target) sets it true;
- `:1851` - the scroll handler (the one 3.6 covers);
- `:1884-1892` - the conversation-switch reset: sets it true AND jumps with
  `el.scrollTop = el.scrollHeight`;
- `:1976` - `handleSend` pins after the operator sends.

Two of these are load-bearing against the spec's own acceptance list:

- **The reset/open path (`:1890`).** With the Upcoming block moved INSIDE
  `.stream` as its last child, `scrollTop = scrollHeight` opens every thread
  with the BLOCK at the bottom of the viewport - the operator lands past the
  sentinel, on the block. Acceptance 12 requires the at-rest view to show "no
  Upcoming block". The reset target must become "sentinel at the bottom edge"
  (the same computation as the `sentinel` growth re-pin), and the initial
  anchor value must be defined as `sentinel`. The spec says neither; a builder
  implementing exactly the listed 3.6 changes ships open-on-the-block.
- **The send path (`:1976`).** After the operator sends while scrolled up,
  today they are pinned to the bottom. The anchor model needs an equivalent
  write (`anchor = 'sentinel'`) or sends stop pinning. Unstated.

Also unstated: what CLEARS the pill under the anchor model. Today reaching
bottom clears it (`:1853`); presumably crossing into `sentinel` (or `below`?)
clears it now. One sentence would settle it.

---

## Finding 4 [MEDIUM] - concurrent reschedules can end pointer-at-a-swept-
## ladder: silently disarmed with no failed request and no log

3.2's ordering (clear -> sweep -> arm -> write pointer) and R4's "two writes,
one invariant" bound every single-request INTERRUPTION to "disarmed + loud
log". They do not bound interleaving. Two concurrent PATCHes on one tour
(double-click retry, two staff):

A clears + sweeps + arms L_A; B clears + sweeps (deleting L_A's fresh unsent
rows - the sweep deletes every row with no sentAt, generation-blind) + arms
L_B; then the two step-4 pointer writes land in either order. If A's lands
last, the tour points at the swept L_A: a live scheduled tour, zero current
rows, L_B's rows refused as mismatched - disarmed, with both requests
returning 200 and the "interruption posture" error log never firing (nothing
failed).

Today's code has the same race but its failure mode is a DUPLICATE armed
ladder (`routes/tours.ts:1190-1195` cancel + arm, unserialized) - noisy, and
the messages still send. The new failure mode is a silent non-send, which is
the severity class this whole feature exists to avoid. A conditional step-4
write (succeed only if the pointer is still absent/unchanged since this
request's own clear) or an explicit statement accepting the race with the same
loud-log posture belongs in 3.2/R4.

---

## Finding 5 [MEDIUM] - conversion: "REVERSIBLY" and acceptance 7's "still
## armed" overstate what the restore can restore

3.2: clearing the pointer disarms the ladder "immediately and REVERSIBLY - the
poll refuses every rung the moment the pointer is gone - so both existing
compensation paths can restore it." The pointer write is reversible; the
poll's refusal is not. The refusal is a claim-skip (`3.3`), and a claim-skip
is terminal: `claimSkip` stamps `skippedAt` (`tourRemindersRepo.ts:318-348`),
`cancel` and `uncancel` both require `attribute_not_exists(skippedAt)` /
absence of it (`:361`, `:391`), and nothing un-skips.

So a rung that comes due inside the cleared window (poll tick between the
clear and a failed `placements.create` / finalize) is permanently retired
`superseded`; the compensation restores the pointer around its corpse.
Acceptance 7's "leaves the tour with its ladder intact ... still armed" does
not hold for that rung, and the surviving state is odd on its face: a rung
whose `ladderId` MATCHES the current pointer, chipped with a reason token that
asserts a mismatch. Narrow window, real reachable state (a conversion attempted
at the moment a rung is due is not exotic - operators convert right after
tours). The spec should either accept and name the residue (the honest option;
the old code canceled the same rungs un-restored on a create failure, so this
is still an improvement) or drop the word REVERSIBLY.

---

## Finding 6 [MEDIUM] - `lib/seed/live.ts` will stamp rows through the real
## armer but nothing in the spec writes its tour pointers - the demo world's
## ladders all become refused

`seedLive` writes tour rows as raw `PutCommand`s FIRST (`live.ts:459-468`,
`:499-503`) and then arms through the real `armTourReminders` (`:514`, `:528`,
`:538`). Post-change the armer stamps every row with a fresh `ladderId`
(3.1, unconditional). Unless the seed then writes each tour's
`currentLadderId` - a wholly new step the spec never states - every seeded
ladder is stamped-rows-with-absent-pointer: not current under 3.4, refused by
the poll under 3.3, claim-skipped `superseded` as rungs come due, and rendered
under the disclosure. The full-profile demo world's reminder ladders all break.

The risk is aggravated by D3a's own rationale - "`lib/seed/live.ts` has no
repo to thread" - which a builder can read as "live.ts is exempt from pointer
writes". It is the opposite: live.ts is the one caller that must grow a NEW
write (a direct UpdateCommand with its `doc`), because its tours are already
persisted before the arm. Section 4's seed sentence names only `matrix.ts`.

Same section-4 gap, lower stakes: `cast.ts` also builds raw reminder rows
(`app/src/lib/seed/cast.ts:67`, `:780-805`, `:1513`) and `history.ts` writes
sentAt-bearing rows (`history.ts:847`); the generic "seed builders" mention
covers them, but the spec's explicit enumeration stops at matrix. (Unstamped
cast/history rows on pointerless tours are 3.5-legal legacy shape, so those
two may deliberately stay unstamped - saying which is intended would prevent a
builder from half-stamping them, the exact split-ladder hazard the spec warns
about for matrix.) Compile-caught, no action needed: the three
`armed*.length` reads in live.ts break on the `{ ladderId, rows }` shape.

---

## Finding 7 [MEDIUM] - the "FOUR copy/type surfaces, only two typecheck-
## forced" enumeration is wrong in both directions

Verified against the code:

- Adding `superseded` to the shared `ScheduledSuppressionReason` union
  (mirrored at `dashboard/src/api/types.ts:1147` from
  `app/src/services/scheduledSendSuppression.ts:9`) breaks the build in THREE
  exhaustive maps the spec never names: `REMINDER_SUPPRESSION_LABELS`
  (`types.ts:1286` - Record over the union), `NUDGE_SUPPRESSION_LABELS`
  (`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64` - a
  placement-NUDGE surface that will need a compile-completeness entry with the
  same "no writer emits it" comment its `discontinued` entry carries), and
  `SUPPRESSION_COPY` (`dashboard/src/routes/contact/ScheduledCard.tsx:19-21` -
  the very component that renders the two Upcoming buckets' suppression, i.e.
  a surface on the REQUIRED path of 3.3). So "only two are typecheck-forced"
  undercounts the forced set; benign, but the builder should not be surprised
  by five compile errors when the spec promised two.
- The claimed forced pair is only CONDITIONALLY forced. `ReminderSkipReason`
  lives twice - the app union (`tourRemindersRepo.ts:38-92`) and a
  hand-mirrored inline union on the dashboard view type (`types.ts` around
  :1200-1247) - and `REMINDER_SKIP_REASON_LABELS` (`types.ts:1301`) is
  exhaustive over the DASHBOARD union only. Nothing forces the mirror itself:
  adding the token app-side alone compiles green in both workspaces, and the
  panel then renders the raw snake_case token through the `??` fallbacks
  (`RemindersPanel.tsx:360`; ScheduledCard `:93`). The spec's sentence "will
  fail the build if the token is missing" is true only after a manual step it
  does not name (update the mirror), which is precisely the silent-and-green
  failure mode this paragraph exists to warn about.

---

## Finding 8 [MEDIUM] - the tour CREATE path is absent from 3.2, and its 201
## response has the same stale-pointer defect the spec fixes only for PATCH

Section 4 mandates that the PATCH response carry the `currentLadderId` the
same request wrote (correct: `routes/tours.ts:1164` captures the tour
pre-side-effects, `:1284` returns it). But POST /api/tours has the identical
shape: it creates the tour (`:338`), arms (`:350` - a D3a caller that must now
mint a pointer write of its own), and returns the PRE-arm object (`:369`). The
201 omits the pointer the request just wrote. 3.2's ordering section
enumerates reschedule/terminal/conversion and never create - so the create
path's ordering (arm -> pointer write; what happens when the pointer write
fails; that its response must carry the pointer) is entirely builder
inference. Also note the arm at `:350` is commented "best-effort" but is NOT
contained - an armer throw already fails the 201 today - so the interruption
posture sentence of 3.2 should name the create site too.

---

## Finding 9 [LOW] - "the next PATCH that touches the tour re-arms it" is
## false as stated

3.2's interruption posture. Re-arming requires `armable && rearmTrigger`:
effective status `scheduled` AND (a scheduledAt in the body OR an explicit
move into scheduled) - `routes/tours.ts:1181-1189`. An outcome-only PATCH, or
any PATCH not carrying those fields, touches the tour and re-arms nothing.
The recovery story is "the next RESCHEDULE (or revival) re-arms"; as written
the sentence promises more than the mechanism delivers.

---

## Finding 10 [LOW] - `earlier[]` "newest first" has no defined sort key

Generations are identified by UUID `ladderId`s, chosen over timestamps
precisely because two arms can share one injected instant (3.1,
`toursApi.test.ts:1228`). UUIDs do not order. Rows carry `createdAt`, stamped
with real repo time (`tourRemindersRepo.ts:197`) - usable in production, but
the spec should say "by createdAt descending" (and how ties group) or the
three-generation panel ordering becomes builder folklore; note the spec's own
same-instant test argument applies to createdAt collisions within a test too.

---

## Finding 11 [LOW] - the 48px sentinel band vs a short Upcoming block:
## acceptance 13 is violated when the block is shorter than the slack

3.6: anchor is `sentinel` while the sentinel's bottom is within 48px of the
viewport bottom; `below` requires scrolling PAST it. If the rendered block
(head + one compact card; `.upcomingHead` is xs-type,
`Timeline.module.css:669-675`) is shorter than ~48px, the scroller's maximum
scroll never moves the sentinel more than 48px above the viewport bottom -
`below` is unreachable, an operator standing on the fully-revealed block is in
`sentinel`, and the next growth re-pins the sentinel to the bottom edge,
scrolling them off the block. Acceptance 13 says that operator "is NOT
scrolled back". The displacement is sub-48px, so this may be acceptable - but
then say so, or define the `sentinel` band to exclude positions where any of
the block is on screen.

---

## Verified-correct claims worth recording (no finding)

- The DynamoDB UpdateItem-creates-missing-items claim and the three unguarded
  claims are exactly as described: `claimSend`/`claimSkip`/`cancel` condition
  only on `attribute_not_exists(...)` (`tourRemindersRepo.ts:291-292`, `:328-
  329`, `:360-361`), which HOLDS against a deleted row; `uncancel` already
  requires `attribute_exists(canceledAt)` (`:391`); the in-repo precedent is
  real (`app/scripts/retire-paused-tour-reminders.ts:205-207`). Note
  `cancelForTour`'s inner updates (`:422-435`) share the defect, but all three
  of its call sites are replaced by the sweep, leaving it caller-less.
- The reader/writer enumeration in section 4 is accurate for the app: all
  `listByTour` callers are the five router sites (`routes/tourReminders.ts
  :383/:395/:447/:462/:499`), the two buckets (`contactTimeline.ts:981`,
  `relayGroups.ts:226`), the force-send (`jobs/tourReminders.ts:1618`), and
  the repo-internal `cancelForTour`. The two `.find(...)!` post-write re-reads
  are exactly where claimed, and `:416` is the emit the 404 path must keep.
- The poll already fetches the tour per row (`jobs/tourReminders.ts:1049`), so
  the pointer check costs no new read; the dev tick routes go through
  `runDueTourReminders` and inherit it (`routes/dev.ts:354-413`).
- 3.6's diagnosis of the one-boolean problem is correct in the code: the same
  `atBottomRef` gates the pin (`Timeline.tsx:1911`) and the pill (`:1914`);
  deps are `[clusters, resetScrollKey, paging?.olderPagesLoaded]` (`:1920`);
  the 48px measurement is at `:1838`; `overflow-anchor: none` at module CSS
  `:142`; the pill is positioned in `.streamWrap` (`:2090`, CSS `:71-77`);
  `GroupTextView.tsx:451` passes a fresh `upcoming={[]}` literal; P2's CSS
  numbers are real (`Timeline.module.css:661-667`).
- The cited breaking tests exist and encode the old contract:
  `scheduled-visibility.spec.ts:268` (expects the retired rung as `canceled`),
  `steps.ts:3615-3661` (expectReminderRung's "old canceled row + fresh armed
  one" doc), `Timeline.test.tsx:1375+` (the stick-to-bottom suite, which
  mocks geometry and will need the sentinel model); the four
  region-by-name e2e sites are `steps.ts:3595`, `steps.ts:3677`,
  `placements-page.spec.ts:205`, `tour-comms-pane.spec.ts:226`.
- Timeline is genuinely the single render site: the five consumers are
  ContactCommsPane:319, ConversationDetail:480, GroupTextView:448,
  TourConversation:467, PlacementConversation:320.
- Acceptance 2's fake-vs-DynamoDB rationale: UNVERIFIED in detail (I did not
  read the in-memory fake), but consistent with the repo contract.

---

## Post-writing check against prior rounds

Written before reading any prior report, per the mission brief. Afterward I
grepped the round 1-4 reports and adjudications in this directory to mark
overlap honestly:

- Finding 1: PARTIAL overlap. Round 1 (both reviewers) raised "pre-migration
  SENT rows classify CURRENT forever" against the earlier `armedFor` design,
  and rounds 3-4 recorded the `null -> REMOVE` fact of `toursRepo.patch` as
  background. What I found no prior statement of: that REMOVE makes "cleared"
  and "never migrated" the SAME state and therefore 3.3's cleared-pointer
  refusal, 3.4's letter, 3.5, acceptance 6's universal wording and R5's
  lowered-consequence claim cannot all hold - specifically the sweep-missed
  legacy pending rung that still SENDS on a terminal tour (R5 false for that
  class; round 4 even blessed R5's sentence as "now right"), and the mixed
  tour whose EARLIER legacy rows flip back to CURRENT when a terminal
  transition removes the pointer. Those consequences are new.
- Finding 2 (acceptance 5 vs acceptance 15): new. The prior rounds' "A15"
  label is a different item (unpaginated listByTour); the contradiction
  between the two ACCEPTANCE bullets appears in no prior report.
- Finding 3: new. Round 4's BLOCKING #1 attacked the OLD one-predicate
  sentinel; the three-valued replacement's unenumerated writers (reset path,
  send path, pill clear) were never raised.
- Finding 11: adjacent to round 4's geometry argument (which assumed the
  block exceeds 48px); the short-block residual under the NEW model is new.
- Findings 4-10: I found no prior-report equivalents by grep.
