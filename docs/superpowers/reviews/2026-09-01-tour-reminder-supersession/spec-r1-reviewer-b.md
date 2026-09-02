# Spec R1 - adversarial doc review (reviewer B)

Spec under review: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
Repo: `W:/tmp/tour-reminder-supersession` (read only)
Date: 2026-09-01

Every claim below about existing behavior cites a file:line I read. Nothing was
executed - no suites, no e2e.

Verified TRUE and NOT a finding, recorded so nobody re-derives it:

- P1 is accurate. `listByTour` returns every row in the `byTour` partition with
  no filter (`app/src/repos/tourRemindersRepo.ts:221-231`) and `RemindersPanel`
  maps all of them (`dashboard/src/routes/tours/RemindersPanel.tsx:350`), so
  dead ladders really do accumulate.
- The two terminal/re-arm branches are where the spec says they are
  (`app/src/routes/tours.ts:1189-1210`).
- The `byTour` GSI projects ALL (`infra/modules/dynamodb/main.tf:57`,
  `app/src/lib/tables.ts:14`), so a new `armedFor` attribute WILL come back
  from `listByTour`. No projection work needed.
- The 767.98px block is real: `.upcoming` gets `min-height: 2.5rem;
  max-height: 7rem` (`dashboard/src/routes/contact/Timeline.module.css:661-667`).

---

## 1. [BLOCKING] There is a THIRD `cancelTourReminders` caller and the spec orders the function it depends on removed

**What is wrong.** Spec 3.2: "A new repo method replaces `cancelForTour` at its
two `routes/tours.ts` call sites" and "`cancelForTour` itself is REMOVED once
both call sites move, unless review finds a third caller."

Review finds a third caller.

**Evidence.** `app/src/routes/placements.ts:716` -
`await cancelTourReminders(tour.tourId, { tourRemindersRepo: reminders, logger: log });`
inside `POST /api/placements/from-tour`. It is imported at
`app/src/routes/placements.ts:53`. It is not incidental: it sits at step 3 of a
documented five-step ordered conversion claim
(`app/src/routes/placements.ts:692-720`), between `claimConversion` and
`placements.create`, and its comment states the reason the ordering is
load-bearing - "a live reminder firing on a CONVERTED tour would not be [benign]
- so cancel must precede finalize."

**What it implies.** Three separate defects, none of which the builder can
resolve from the spec:

1. Removing `cancelForTour` breaks the conversion route. Typecheck catches it,
   so the builder will patch it under time pressure with no ruling.
2. Whichever way they patch it is a policy decision the spec never made. Point
   it at the new sweep and tour->placement conversion silently starts HARD
   DELETING an unsent ladder on a path D1 never authorised (D1 names "reschedule,
   and the terminal status transitions"; conversion is neither). Leave it on
   `cancelForTour` and two supersession semantics ship side by side.
3. The conversion path is also an unenumerated case for D3: it never re-arms, so
   after it runs the tour keeps its `scheduledAt` and its surviving sent rungs
   stay CURRENT forever. Section 3.3 has no answer for a converted tour.

Related imprecision that helped hide this: 3.2 says `cancelForTour` has "two
`routes/tours.ts` call sites". `cancelForTour` (the repo method,
`tourRemindersRepo.ts:410`) has exactly ONE caller anywhere -
`cancelTourReminders` (`app/src/jobs/tourReminders.ts:584`). It is
`cancelTourReminders` that has three route call sites. The spec conflates the
job wrapper with the repo method, and searching for the wrong name is precisely
how the placements site was missed.

---

## 2. [BLOCKING] Deleting a listed row makes the poll's claim SUCCEED on a phantom item - the superseded reminder SENDS, and the send record is destroyed

**What is wrong.** This is the central mechanism of the feature, and it inverts
the guarantee it is sold on. Spec 3.2: "a rung the poll claimed between the list
and the delete survives: the condition fails, the delete is a benign no-op." It
only reasons about the sweep losing. It never reasons about the POLL losing -
which is the far more common ordering, and which today is the safe one.

**Evidence.**

Today, delete is not in play and the poll is reliably BLOCKED:

- `claimSend` writes under
  `attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt) AND
  attribute_not_exists(#skippedAt)` (`tourRemindersRepo.ts:291-292`).
- `cancelForTour` STAMPS `canceledAt` on the row (`tourRemindersRepo.ts:425`).
- So a poll that listed the row before the reschedule finds `canceledAt` present
  and loses. The repo's own docblock states this as the contract:
  "so a concurrent poll tick or a race with cancelForTour both lose"
  (`tourRemindersRepo.ts:138-141`).

Under D1 the row is GONE instead of stamped. DynamoDB `UpdateItem` against a key
that does not exist CREATES the item, and `attribute_not_exists(...)` evaluates
TRUE against a non-existent item, so all three conjuncts pass. `claimSend`
returns `true` and the caller sends.

The project already knows this footgun and guards it in exactly one place -
`app/scripts/retire-paused-tour-reminders.ts:206`:

```
'attribute_exists(reminderId) AND attribute_not_exists(#sentAt) AND ' +
'attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
```

The repo's three claim conditions (`claimSend` :291, `claimSkip` :328,
`cancel` :360) carry NO `attribute_exists(reminderId)` conjunct. (`uncancel`
:390 is accidentally safe - it requires `attribute_exists(#canceledAt)`.)

The window is not a nanosecond. `runDueTourReminders` lists at
`app/src/jobs/tourReminders.ts:715` and does not reach `claimSend` until
`:1281`, after a tour read, group resolution, a roster read, name resolution and
quiet-hours evaluation - many network round trips, plus batching across rows.

**What it implies.**

- **A regression, not a feature.** Rescheduling a tour can now text the tenant
  "your tour is tomorrow" for the OLD time. That is the exact class of send
  `cancelForTour` exists to prevent, and it is prevented today.
- **D2 is broken on the same path.** The phantom row is
  `{ reminderId, sentAt, sentBody }` - no `tourId`, so it is absent from the
  `byTour` GSI and invisible to `listByTour`; no `_reminderPartition`, so it is
  absent from `byDueAt`. D2 says "A rung that texted somebody keeps its row (it
  is the send-idempotency record...)". Here it does not. Risk R1 - "the only
  thing standing between a race and a lost send record" - names the wrong
  failure: the conditional as specified permits both a lost record AND a send
  that should have been suppressed.
- **Unit tests will not catch it.** The in-memory fake repo
  (`app/test/helpers/twilioWebhookHarness.ts:2955+`) is hand-written and will
  not reproduce DynamoDB's create-on-missing-key semantics.

The spec must add `attribute_exists(reminderId)` to `claimSend`, `claimSkip` and
`cancel`, and must state what a poll that finds its row deleted does (silently
drop it - the row is gone precisely because the ladder was superseded).

---

## 3. [BLOCKING] `armedFor = tour.scheduledAt` does not identify a generation - two supported flows re-arm at the SAME time, so an old ladder's sent rungs rejoin the current one

**What is wrong.** D3 makes generation identity a function of the TIME, not of
the arming event: "Current ladder = `armedFor === tour.scheduledAt`". Two
generations armed against the same `scheduledAt` are indistinguishable by
construction.

**Evidence.** Both re-arming flows can produce an identical `scheduledAt`:

- **Status-only revival.** `rearmTrigger = scheduledAtIso !== undefined ||
  patch['status'] === 'scheduled'` (`app/src/routes/tours.ts:1185`), and
  `canceled`/`no_show` -> `scheduled` is legal
  (`app/src/lib/toursModel.ts:118-123`). `PATCH {status:'scheduled'}` on a
  canceled tour re-arms off the STORED time - there is a shipped test for
  exactly this: `app/test/toursApi.test.ts:1294-1304`,
  "status-only revival {status:'scheduled'} on a canceled tour re-arms off the
  stored time".
- **Reschedule back to a previous time.** `PATCH {scheduledAt: T}` where `T`
  equals a time the tour was armed for earlier. `armable && rearmTrigger` fires
  on any `scheduledAt` patch; the route only suppresses the *event emit* for a
  no-op re-patch (`app/src/routes/tours.ts:1232-1236`), never the arm.

Concrete failing sequence, all legal:

1. Tour at T. Ladder armed, every row `armedFor = T`.
2. `day_before` sends. Row keeps `sentAt` and `armedFor = T`.
3. Operator cancels the tour. Terminal sweep deletes the unsent rows; the sent
   `day_before` survives with `armedFor = T`.
4. Operator revives: `PATCH {status:'scheduled'}`. Sweep finds nothing, arms
   generation 2 with `armedFor = T` (the stored time is unchanged).
5. `tour.scheduledAt === T`, so the generation-1 sent `day_before` is CURRENT.
   The panel shows a sent `day_before` and a new upcoming `day_before` with an
   identical `dueAt`, in one ladder.

**What it implies.** Acceptance 1 ("Rescheduling a tour twice leaves the panel
showing exactly one ladder") is false on a flow the repo has a test for. The
duplication D1+D3 exist to remove is reintroduced by D3's own key. Section 3.4's
migration rule inherits the defect too - see finding 4.

The mechanism needs a generation token that is unique per ARM (a monotonically
stamped `generation` / arm-instant recorded on the tour and copied onto each
row), not a value derived from a field that legitimately repeats. Note that a
bare arm-instant on the row alone does not fix it either: the read side needs
something on the TOUR to compare against.

---

## 4. [HIGH] 3.4's "the pile-up self-heals on first use" is false for the rows that actually persist

**What is wrong.** 3.4 accepts pre-migration pile-up on the grounds that "the
pile-up self-heals on first use": the next reschedule sweeps every unsent row
and the new ladder establishes a generation.

It does not self-heal, because the sweep is defined to delete only UNSENT rows
(D1: "Only rows carrying `sentAt` survive") and nothing ever backfills `armedFor`
(explicit non-goal, section 5). A pre-migration SENT row therefore keeps
`armedFor` absent forever, and 3.3 rules an absent `armedFor` CURRENT forever.

**Evidence.** Rows with `sentAt` and no `armedFor` exist in volume today - every
seeded world writes them: `app/src/lib/seed/cast.ts:780-808` (three sent rungs on
`TOUR_TOURED`), `app/src/lib/seed/matrix.ts:990-998` (a sent `confirmation` on
EVERY matrix tour) and `:1037-1045` (a sent `day_before` on every
toured/no_show/closed matrix tour). Production has the same shape for every tour
that ever fired a rung.

**What it implies.** Every tour that sent a rung before the deploy carries that
rung as CURRENT into every future ladder, permanently. Reschedule such a tour and
the panel shows the new ladder PLUS an orphan sent rung from an unrelated time -
which is a *worse* reading than today's struck-through group, because the orphan
now sits inside the live ladder with no visual separation instead of behind the
`earlier` disclosure the feature built for it. Acceptance 1 fails for that
population, and Acceptance 5 ("Rows with no `armedFor` render exactly as they do
today") is satisfied only in the trivial single-generation case.

The spec must rule on this explicitly: either accept-and-document that
pre-migration SENT rows stick to the current ladder forever (and drop the
self-heals claim), or stamp `armedFor` at sweep time on the survivors.

---

## 5. [HIGH] The `earlier` disclosure has no reachable render slot - and there is an already-tested route shape that empties `reminders[]` while `earlier[]` is non-empty

**What is wrong.** 3.3: "`RemindersPanel` renders `reminders[]` as today and,
when `earlier` is non-empty, one muted disclosure line". The render site does not
have a place for that.

**Evidence.** `dashboard/src/routes/tours/RemindersPanel.tsx:336-349` is a
three-way ternary whose third arm short-circuits the whole body:

```
) : reminders.length === 0 ? (
  <p className={styles.muted}>No reminders armed.</p>
) : (
  <ul className={styles.rows}>
```

`reminders[]` empty and `earlier[]` non-empty is reachable through a shape the
suite already exercises. `PATCH {scheduledAt: <new>, status: 'canceled'}` takes
the TERMINAL branch, not the arm branch: `armable = effectiveStatus ===
'scheduled'` is false (`app/src/routes/tours.ts:1181`), so the sweep runs and
nothing is armed - but `patch['scheduledAt']` was still written
(`:1142`). The tour's `scheduledAt` is now the NEW time; every surviving sent
row still carries `armedFor = <old time>`, so under 3.3 all of them are EARLIER
and `reminders[]` is empty. That exact request is a shipped test:
`app/test/toursApi.test.ts:1254-1266`.

**What it implies.** On a canceled tour that had already texted the tenant, the
panel renders "No reminders armed." and the send history is unreachable -
strictly worse than today, where those rows are visible. Acceptance 4 does not
cover it (it assumes a current ladder exists alongside).

The spec must say the disclosure renders OUTSIDE the empty-state branch, and must
say what the empty-current-ladder + non-empty-earlier panel looks like.

---

## 6. [HIGH] D4 breaks the stream's bottom-anchoring; 3.5's "they keep working by construction" is false against the code it names

**What is wrong.** 3.5 lists `atBottom`, `scrollToBottom`, `hasNewBelow` and
"the three scroll-restoring effects", notes they all measure the container, and
concludes "they keep working by construction". Two of the mechanisms it names
break, for reasons visible in the file.

**Evidence.**

(a) **The layout effect does not depend on `upcoming`.** Its dep array is
`[clusters, resetScrollKey, paging?.olderPagesLoaded]`
(`dashboard/src/routes/contact/Timeline.tsx:1920`), and `clusters` is memoized
over `visible`, the MESSAGE list (`:1821`) - `upcoming` is a separate prop
(`:238`) that is never in that chain. Today that is fine: `.upcoming` lives
outside the scroller (`Timeline.tsx:2102`, a sibling of `.streamWrap` at
`:2035`), so its height changes cannot move `scrollTop`. Move it inside `.stream`
and every Upcoming change - a rung arming, a rung firing, an SSE
`scheduled.updated` refetch - resizes the scroll content with NO re-pin, and
`overflow-anchor: none` (`Timeline.module.css:142`) deliberately blocks the
browser from compensating. The reader silently drifts off the newest message
every time a reminder appears or fires.

(b) **"Bottom" stops meaning the newest message.** `el.scrollTop =
el.scrollHeight` runs on mount and on conversation switch (`Timeline.tsx:1890`),
on every at-bottom update (`:1912`) and from the pill (`:1843`). With `.upcoming`
as the last child of `.stream`, all four land on the Upcoming block. The comment
at `:1830` - "default true -> open on the newest item" - becomes false, and the
"Jump to the newest messages" pill (`:2095`) jumps somewhere that is not the
newest message. On the 390px viewport P2 is about, the block is ~7rem of a ~400px
column, so opening a conversation now shows the Upcoming card and pushes the
newest exchange off - which is P2 restated, not fixed.

(c) `isAtBottom`'s 48px slack (`:1838`) now sits below a block the spec itself
concedes is taller than 48px, so the pill will not clear on `handleStreamScroll`
(`:1848-1853`) until the operator scrolls past the Upcoming block. 3.5 notices
this and defers it to "the specs in section 6"; Acceptance 7 only asserts the
pill "dismisses on scroll to bottom", which is the degraded behavior.

**What it implies.** Acceptance 6 - "scrolling to the bottom reveals the Upcoming
block" - encodes (b) as the goal rather than catching it. The spec needs an
explicit ruling: either `upcoming` joins the layout effect's deps AND "bottom"
is redefined as the bottom of the message list (anchor above `.upcoming`), or
D4 is re-scoped. R3 ("live QA on a phone viewport is required") is not a
substitute for a decision - it hands an unspecified problem to a human at the
end of the build.

---

## 7. [MEDIUM] Acceptance 8 asserts behavior that already ships, and contradicts the spec's own section 4

**What is wrong.** Acceptance 8: "Both Upcoming buckets (contact and group
thread) stop showing rungs from a superseded ladder." They already do.

**Evidence.** `cancelForTour` stamps `canceledAt` on every pending row
(`app/src/repos/tourRemindersRepo.ts:410-437`), and both buckets filter it out:
`app/src/routes/contactTimeline.ts:982-984` and
`app/src/routes/relayGroups.ts:270-272` (both
`sentAt === undefined && canceledAt === undefined && skippedAt === undefined`).

Section 4 states this correctly - "The two Upcoming buckets already filter to
rows with no `sentAt` / `canceledAt`, so D1 clears them with no read-side change".

**What it implies.** Section 4 and Acceptance 8 cannot both be meaningful. A test
written for #8 passes unchanged on `main`, so it certifies nothing and will be
read by the next person as proof the sweep works. Either delete it or replace it
with an assertion that can fail - e.g. that the buckets are unaffected by the
`earlier` partition.

---

## 8. [MEDIUM] "An interrupted sweep cannot delete them" is a slogan its own mechanism does not deliver

**What is wrong.** 3.2: "The new ladder's rows carry the new `armedFor`, so an
interrupted sweep cannot delete them."

The sweep as specified two paragraphs earlier is generation-blind: "The sweep
lists the tour's rows and deletes every row with no `sentAt`. Each delete is
CONDITIONAL on `attribute_not_exists(sentAt)`." It never reads `armedFor`. A
sweep running after an arm would delete the new ladder in full; what actually
prevents that is the sweep-then-arm ORDERING and nothing else.

**What it implies.** The sentence tells a builder that `armedFor` is a safety
interlock. It is not, and a builder who believes it may reorder the two calls, or
skip the ordering comment, on the strength of a protection that does not exist.
Either state the ordering as the sole protection, or make the sweep genuinely
generation-aware (`attribute_not_exists(sentAt) AND armedFor <> :newArmedFor`),
which would also make the sweep idempotent under retry.

---

## 9. [MEDIUM] The panel's visible guarantee rides on an eventually-consistent GSI read

**What is wrong.** Acceptance 1 is a statement about what the panel shows
immediately after a reschedule. The panel gets there via
`GET /api/tours/:tourId/reminders` -> `listByTour`, which is a Query against the
`byTour` **GSI** (`app/src/repos/tourRemindersRepo.ts:222-228`). GSI reads are
eventually consistent and cannot be made strongly consistent.

The refetch is prompt: the PATCH emits `scheduled.updated`
(`app/src/routes/tours.ts:1215`) and `RemindersPanel` refetches on it
(`dashboard/src/routes/tours/RemindersPanel.tsx:265-272`).

**What it implies.** The panel can render just-deleted rows for a beat. Today
this is invisible - a canceled row renders either way, only its chip changes -
so D1 is what makes GSI lag user-visible for the first time. An e2e for
Acceptance 1 that asserts an exact ladder count right after a reschedule is a
flake candidate. The spec should either name the retry/settle posture or write
Acceptance 1 as an eventually-consistent assertion.

---

## 10. [MEDIUM] The behavior change on every terminal tour's Reminders panel is never described

**What is wrong.** Section 3 describes generations and reschedules. It never
describes what a `toured` / `no_show` / `canceled` / `closed` tour's panel looks
like after D1.

**Evidence.** The terminal branch (`app/src/routes/tours.ts:1197-1210`) fires on
all four statuses. Today it stamps `canceledAt` and the panel keeps rendering
those rows with a "Canceled" chip (`RemindersPanel.tsx:117`). After D1 they are
deleted, so a tour that armed a full ladder and then went `toured` shows only its
sent rungs - and a tour that armed a ladder and was canceled before anything
fired shows "No reminders armed." (`RemindersPanel.tsx:346-347`), which reads as
"we never scheduled anything" about a tour we did.

**What it implies.** This is the single most common panel state in the product
(every completed tour), it is a user-visible loss of evidence, and R2 frames it
only as a test-fixing problem ("Any test or e2e spec asserting a canceled row
remains visible after a reschedule..."). It is a product decision that needs the
founder's name on it, not a test-maintenance note.

---

## 11. [MEDIUM] R2 understates the e2e blast radius: the shared step helper's disambiguation strategy goes dead

**What is wrong.** R2 says tests asserting a canceled row survives a reschedule
"must be re-pointed, not deleted". The affected surface is not a handful of
assertions - it is a shared scenario verb whose entire design rests on the old
contract.

**Evidence.** `e2e/scenarios/steps.ts:3615-3661`. Its docblock:

> Rows are scoped by the rung's staff label (REMINDER_KIND_LABELS); after a
> reschedule a label can appear twice (an old canceled row + a fresh armed one),
> so the state filter is what disambiguates.

and the implementation at `:3656` (`state === 'canceled'` ->
`rows.filter({ hasText: 'Canceled' })`) and `:3661`
(`.filter({ hasNotText: 'Canceled' })`).

**What it implies.** After D1 a label can no longer appear twice from a
reschedule, so the helper's stated reason for existing is gone and its
`'canceled'` branch is unreachable for post-reschedule scenarios. Whoever builds
this has to decide whether the verb keeps a `'canceled'` state at all (it is
still reachable via the per-rung operator Cancel, which 3.2 leaves untouched).
The spec should name this file so the decision is made deliberately.

---

## 12. [LOW] Section 4's enumeration is wrong in both directions

**What is wrong.** Section 4 is the spec's completeness claim ("Every writer...
Every reader..."). Two of its entries are inaccurate.

**Evidence.**

- "three sites in `routes/tourReminders.ts`" - there are FIVE `listByTour` calls:
  `:383` (PATCH existence check), `:395` (PATCH honest re-read), `:447`
  (send-now existence check), `:462` (send-now honest re-read), `:499` (GET).
  Only `:499` is the ladder read; the other four are single-row lookups that
  return `undefined` for a swept row and reach a non-null assertion
  (`.find(...)!` at `:395` and `:462`) - worth the builder's attention on its
  own.
- `app/src/lib/performanceSeed.ts` is listed as a writer of reminder rows. It
  constructs the repo (`:167`) but appears to write none:
  `app/test/performanceSeed.integration.test.ts:324` asserts
  `listByTour('perf-tour-00000')` equals `[]`.

**What it implies.** A named-but-wrong entry costs the builder a detour; a
missing entry costs correctness. Both undermine the section's value as the
authority a builder checks their work against.

---

## 13. [LOW] The hand-written fake repo is an unenumerated implementation surface

**What is wrong.** Section 4 lists writers but not the in-memory
`TourRemindersRepo` the app suite runs against.

**Evidence.** `app/test/helpers/twilioWebhookHarness.ts:2955` (`listByTour`),
`:3011` (`cancelForTour`), and `:2939` (its born-skipped comment) - a hand-rolled
implementation of the same interface.

**What it implies.** It must gain the new sweep method and `armedFor` on
`create`, and - per finding 2 - it should be made to reproduce DynamoDB's
create-on-missing-key semantics, or the suite will certify a claim path that is
broken in production. Typecheck will force the first; nothing forces the second.

---

## 14. [LOW] Acceptance 4's `next` clause is vacuous

**What is wrong.** "...and the current ladder's `next` ignores it."

**Evidence.** After D1 an earlier generation can only contain rows with `sentAt`
(D1: "Only rows carrying `sentAt` survive"). `next` is
`reminderViews.find((v) => v.state === 'upcoming' && ...)`
(`app/src/routes/tourReminders.ts:686-688`) and `stateOf` returns `'sent'` for
any row with `sentAt` (`:166-171`). A sent row can never be `next` by any
partitioning.

**What it implies.** The clause cannot fail, so it certifies nothing. If the
intent was "a rung of an earlier generation never becomes `next`", the
non-vacuous version is a test that an earlier-generation row is excluded from
`reminders[]` at all.

---

## 15. [LOW] Two small factual slips in 3.5 and 6.3 that will cost the builder time

**What is wrong / evidence.**

- 3.5: "moves from a sibling of `.stream` to the last child INSIDE it", and P2:
  "a flex sibling BETWEEN the scrolling stream and the composer". `.upcoming`
  (`Timeline.tsx:2102`) is a sibling of `.streamWrap` (`:2035`), not of `.stream`
  (`:2053`). That matters: `.streamWrap` is the positioning context for the
  absolutely-positioned `.newPill` (`Timeline.module.css:71-77` and `:81-85`),
  so a builder who deletes the wrong wrapper detaches the pill.
- Acceptance 3 ("a hand-canceled rung ... cannot be restored into the new
  ladder") ships with a new failure code the spec does not name. Today a lost
  Restore returns 409 with the honest row (`routes/tourReminders.ts:407-411`);
  against a DELETED row the handler never reaches the conditional write - the
  existence check at `:384-387` returns `404 reminder_not_found`. The panel
  swallows both (`RemindersPanel.tsx:291-298` catches and refetches), so this is
  cosmetic, but the spec should say 404 is now the expected shape.
