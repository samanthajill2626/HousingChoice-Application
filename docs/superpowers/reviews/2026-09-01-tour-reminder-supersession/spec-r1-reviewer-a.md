# Adversarial doc review R1 - reviewer A

Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
Repo: `W:/tmp/tour-reminder-supersession` @ f27aabbf (read-only)
Date: 2026-09-01

All line references were read in this worktree. Anything I could not verify is
marked UNVERIFIED.

---

## 1. [BLOCKING] Deleting a pending rung does NOT stop its send - `claimSend` is an upsert that resurrects the row

**What is wrong.** D1 replaces a `canceledAt` STAMP with a hard DELETE. The
stamp is what currently makes the poll lose the race. The delete does not.

`claimSend` is an `UpdateCommand`, not a conditional Put:

`app/src/repos/tourRemindersRepo.ts:271-303`

```
new UpdateCommand({
  TableName: table,
  Key: { reminderId },
  UpdateExpression: 'SET #sentAt = :sentAt, #sentBody = :sentBody',
  ConditionExpression:
    'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
  ...
})
```

DynamoDB `UpdateItem` is an upsert. On a row that has just been DELETED, all
three `attribute_not_exists` predicates evaluate TRUE against the absent item,
the condition PASSES, the item is CREATED, and `claimSend` returns `true`. The
poll then sends.

Sequence, entirely reachable today:

1. worker `listDue` returns rung R (`app/src/repos/tourRemindersRepo.ts:233`)
2. operator reschedules -> sweep DELETES R
3. worker finishes `resolveReminderTarget` and calls `claimSend(R)`
4. condition passes on the absent item -> row recreated -> **tenant is texted
   the superseded ladder's message**

Under the current code step 4 fails deterministically: `cancelForTour` has
already written `canceledAt` (`app/src/repos/tourRemindersRepo.ts:410-435`) and
`attribute_not_exists(#canceledAt)` is false. **D1 removes a live safety
property.** The whole point of the terminal-status branch at
`app/src/routes/tours.ts:1205-1209` ("a tenant who showed up, or a tour flagged
no-show, must never get a later 'your tour is tomorrow' reminder") stops being
guaranteed.

The resurrected row is also garbage: it carries only `{reminderId, sentAt,
sentBody}` - no `tourId` (so it is invisible to the `byTour` GSI), no
`_reminderPartition` (invisible to `byDueAt`), no `kind`/`dueAt`, both of which
`TourReminderItem` declares required (`app/src/repos/tourRemindersRepo.ts:95-121`).
It is unreadable by every surface and un-collectable.

`claimSkip` (`:317`) and `cancel` (`:348`) have the identical shape and the
identical hole. Only `uncancel` (`:380`) is safe, because it asserts
`attribute_exists(canceledAt)`.

**Implies.** Spec section 3.2 reasons about exactly one interleaving (claim
wins, delete no-ops) and R1 asserts "the conditional on `sentAt` is the only
thing standing between a race and a lost send record". The other interleaving -
delete wins, claim follows - is the dangerous one and the spec does not mention
it. Any delete-based supersession must either (a) add a tombstone the claim
conditions test, or (b) convert `claimSend`/`claimSkip`/`cancel` to require
`attribute_exists(reminderId)`, and the spec must say which. As written the
build is not safe to ship.

## 2. [BLOCKING] The unit-test fake will PROVE acceptance #2 while production does the opposite

**What is wrong.** Every app suite runs against the in-memory repo in
`app/test/helpers/twilioWebhookHarness.ts`. Its `claimSend`:

`app/test/helpers/twilioWebhookHarness.ts:2971-2982`

```
const r = tourRemindersMap.get(reminderId);
if (!r || r.sentAt !== undefined || ...) return false;
```

A missing row returns `false`. DynamoDB returns `true` and creates the row
(finding 1). The fake models "delete then claim" as SAFE; production models it
as SEND.

**Implies.** Acceptance criterion 6.2 ("A rung the poll claims mid-sweep
survives the sweep and reads as sent") can be written, run, and pass green
against a fake whose semantics are the inverse of the store the feature ships
on. The spec names no integration-level proof. Any test of the sweep/claim race
must run against DynamoDB Local (the repo already has integration suites - e.g.
`app/test/placementsRepo.integration.test.ts`), and the fake must be corrected
in the same change or it will actively conceal finding 1.

## 3. [BLOCKING] `armedFor = tour.scheduledAt` is not a generation identifier - two generations can share one value

**What is wrong.** D3 defines "current ladder" as `armedFor === tour.scheduledAt`.
But a re-arm is triggered by things that do not change `scheduledAt`:

`app/src/routes/tours.ts:1185`

```
const rearmTrigger = scheduledAtIso !== undefined || patch['status'] === 'scheduled';
```

Two reachable shapes produce a re-arm at an UNCHANGED time:

- **Status-only revival.** `PATCH {status:'scheduled'}` from `canceled` /
  `no_show`. The code comments this deliberately at
  `app/src/routes/tours.ts:1183-1184`: "a status-only revival from
  canceled/no_show uses the stored time". `scheduledAtIso` is `undefined`,
  `armable && rearmTrigger` is true, sweep + arm run.
- **No-op re-PATCH of the same time.** `scheduledAtIso` is set whenever
  `newScheduledAt` is present, changed or not
  (`app/src/routes/tours.ts:1139-1141`); the idempotency guard further down is
  only on the *reschedule event emit*, not on the arm.

In both, the new ladder's `armedFor` equals the value already carried by the
PREVIOUS generation's surviving SENT rows. Those sent rows classify as CURRENT,
render inline in the new ladder, and duplicate the kind labels of the fresh
rungs at the same dueAt. That is P1's pile-up, un-fixed, on a supported path.

**Implies.** Acceptance 6.1 ("Rescheduling a tour twice leaves the panel showing
exactly one ladder") and 6.4 ("shows that rung only behind the disclosure") are
both false for these shapes, and the spec proposes no mechanism that makes them
true. A generation stamp must be a value that CHANGES on every arm (a monotonic
counter, or the arm instant), not the tour's time. This is a design defect, not
an implementation detail.

## 4. [BLOCKING] The spec misidentifies the call sites, and there IS a third caller

**What is wrong.** Section 3.2: "A new repo method replaces `cancelForTour` at
its two `routes/tours.ts` call sites" and "`cancelForTour` itself is REMOVED
once both call sites move, unless review finds a third caller."

In the code:

- `cancelForTour` (the repo method) has exactly ONE production caller: the
  wrapper `cancelTourReminders` at `app/src/jobs/tourReminders.ts:584`. It has
  ZERO call sites in `routes/tours.ts`.
- `cancelTourReminders` (the wrapper) has THREE production call sites:
  - `app/src/routes/tours.ts:1190` (re-arm path)
  - `app/src/routes/tours.ts:1208` (terminal path)
  - **`app/src/routes/placements.ts:716`** (tour -> placement conversion)

The third one is not incidental. It sits inside the conversion's ordered
claim/release sequence, documented at `app/src/routes/placements.ts:693-699`,
and its failure mode is explicitly handled ("3. cancelTourReminders - fail ->
release + rethrow"). Immediately after, `app/src/routes/placements.ts:758`
patches the tour to `status:'closed'` - which does NOT re-enter the PATCH route,
so this cancel is the only retirement the converted tour's ladder ever gets.

**Implies.** The spec is silent on whether conversion should DELETE or CANCEL.
A builder following section 3.2 literally will move two call sites, remove
`cancelForTour`, and break `placements.ts` (or leave conversion on a
now-inconsistent stamping path while reschedule deletes). Either way the
invariant "only sent rows survive" does not hold uniformly. The spec must name
this site and decide.

## 5. [HIGH] Two readers dereference a row that the sweep can now delete - `!` becomes a 500

**What is wrong.** Both write-echo handlers pre-check that the row exists, write,
then re-read with a non-null assertion:

`app/src/routes/tourReminders.ts:395`

```
const after = (await reminders.listByTour(tourId)).find((r) => r.reminderId === reminderId)!;
```

`app/src/routes/tourReminders.ts:462` - identical shape on send-now.

`after` is then fed to `stateOf(after)` / `viewOf(after, ...)`
(`:404`, `:409`, `:422`, `:466`). The `!` is safe TODAY by construction: no code
path deletes a reminder row, so a row present at `:383` is present at `:395`.

D1 makes rows disappear. A reschedule concurrent with an operator's Cancel or
Send now leaves `after === undefined` and the handler throws a TypeError -> 500,
on the exact surface the file header says must "return the honest current state
instead of lying". Finding 1 makes it worse: the resurrected row has no `tourId`,
so it is invisible to `listByTour` and `after` is undefined even though the write
"won".

Note also that the spec's Surfaces section says "three sites in
`routes/tourReminders.ts`". There are five `listByTour` calls: `:383`, `:395`,
`:447`, `:462`, `:499`. The two the spec appears to have skipped are precisely
the two that break.

**Implies.** The build must make both re-reads absence-tolerant, and the spec
should say what they return when the row is gone. Not optional - it is a 500 on
a staff action.

## 6. [HIGH] "Sent rungs keep their `sentBody` snapshot" is false for legacy rows - `earlier[]` will render the WRONG time

**What is wrong.** D2 justifies keeping sent rows by "it holds the `sentBody`
snapshot". `sentBody` is OPTIONAL and documented as absent on older rows:

`app/src/repos/tourRemindersRepo.ts:110`
"Absent on rows claimed before this field existed - those compose live."

The read path honours that:

`app/src/routes/tourReminders.ts:294`

```
if (row.sentAt !== undefined && typeof row.sentBody === 'string') return row.sentBody;
```

and otherwise falls through to `composeTourReminderBody({ scheduledAt: tour.scheduledAt ?? '' , ...})`
at `:311-318` - the tour's CURRENT time.

So an EARLIER-generation sent rung with no `sentBody` renders under the
"Earlier schedules" disclosure quoting the NEW tour time, presented as the text
that was already sent. The disclosure's entire purpose is historical fidelity,
and its default content for pre-`sentBody` rows is a fabrication.

**Implies.** `earlier[]` needs an explicit rule for snapshot-less rows (render
no body, or a "text not retained" line). The spec's mechanism does not deliver
D2's stated guarantee.

## 7. [HIGH] 3.4's "the pile-up self-heals on first use" does not hold for pre-migration SENT rows

**What is wrong.** 3.3 classifies a row with absent `armedFor` as CURRENT. The
sweep in 3.2 deletes rows with no `sentAt` and has no `armedFor` condition. So on
the first reschedule after deploy:

- pre-migration UNSENT rows: deleted. Fine.
- pre-migration SENT rows: survive, still have no `armedFor`, still classify as
  CURRENT - **permanently**. No later reschedule can ever move them, because
  nothing ever stamps `armedFor` onto an existing row (3.4 and the non-goals
  forbid a backfill).

Every tour that has ever fired a rung before deploy keeps those rungs pinned
inline in its current ladder forever, mixed with the fresh generation, and
(per finding 6) most of them have no `sentBody` because they predate it, so they
also render the wrong time.

**Implies.** "self-heals on first use" is a slogan; the mechanism heals only the
unsent half. Either 3.3 must treat absent-`armedFor` SENT rows as EARLIER (which
breaks acceptance 6.5, "Rows with no `armedFor` render exactly as they do
today"), or the spec must state that legacy sent rungs stay inline forever.
6.5 and 3.4 cannot both be satisfied as written.

## 8. [HIGH] D4 breaks the stick-to-bottom contract: nothing re-pins the stream when `upcoming` changes

**What is wrong.** 3.5 claims the scroll machinery "keeps working by
construction" because everything measures the container. That is true of the
MEASUREMENTS and false of the TRIGGERS.

`dashboard/src/routes/contact/Timeline.tsx:1920`

```
}, [clusters, resetScrollKey, paging?.olderPagesLoaded]);
```

`upcoming` is NOT in the layout effect's dependency list, and `prevCountRef`
counts cluster items only (`:1892`). Today that is correct: `.upcoming` is a
sibling of `.streamWrap` (`Timeline.tsx:2102`, outside `.stream` at `:2053`), so
its height never touches `scrollHeight`.

Move it inside `.stream` and every `upcoming` change - the `scheduled.updated`
SSE refetch, a rung firing and leaving the bucket, a reschedule re-arming a
ladder - silently changes `scrollHeight` with NO effect scheduled to re-pin.
An operator sitting at the bottom drifts off the bottom, `atBottomRef` goes
stale, and the next inbound message shows the "New messages" pill instead of
auto-scrolling.

Second, independent break: `isAtBottom` is a 48px slack
(`Timeline.tsx:1835-1838`). The spec acknowledges the block "is taller than 48px
whenever it has a card" and then asserts section 6 pins it. It does not. With the
block inside the scroller, an operator reading the newest MESSAGE is by
definition NOT at bottom, so `atBottomRef.current` is false and every inbound
message sets `hasNewBelow` (`:1913-1915`) - a permanent pill on any conversation
that has an Upcoming card. That is a regression the spec's own acceptance 6.7
does not detect, because 6.7 only checks that the pill appears while scrolled up.

Third: the pill is absolutely positioned at `bottom: var(--sp-3)` of
`.streamWrap` (`Timeline.module.css:80-99`). Moving `.upcoming` inside `.stream`
leaves the pill floating over the Upcoming block. The spec never mentions
`.streamWrap` and describes the section as "a flex sibling BETWEEN the scrolling
stream and the composer" - it is a sibling of the WRAPPER, not of `.stream`.

**Implies.** D4 is not a pure markup move. `upcoming` must join the layout
effect's deps, and "at bottom" needs a definition that is not "48px from
scrollHeight" once a variable-height block sits below the last message. Neither
is in the spec.

## 9. [HIGH] Acceptance 6.6 contradicts D4's own mechanism

**What is wrong.** 6.6: "On a 390px viewport the conversation stream shows more
messages than it does on `main`."

On `main` the block is capped: `max-height: 7rem` under 767.98px
(`Timeline.module.css:661-668`). 3.5 explicitly deletes "its own `max-height` /
`overflow-y` / `flex` rules". Combined with `atBottomRef = useRef(true)`
(`Timeline.tsx:1830`) and the open-on-newest jump `el.scrollTop = el.scrollHeight`
(`:1883`, `:1911`), opening a conversation now scrolls to the bottom of the
UNCAPPED Upcoming block. A tour with a four-rung ladder produces a block well
over 7rem, so the phone viewport on open shows FEWER messages than `main`, not
more.

**Implies.** The mechanism and the acceptance criterion point in opposite
directions on the exact case P2 was reported for. Either the open-scroll must
target the last message rather than `scrollHeight`, or the block must stay
capped - and the spec picks neither.

## 10. [MEDIUM] The e2e spec that proves reschedule-retirement asserts the old contract, and the spec does not name it or its replacement

**What is wrong.** R2 warns generically that "Any test or e2e spec asserting a
canceled row remains visible after a reschedule ... must be re-pointed, not
deleted", then names none. The one that matters:

`e2e/tests/scenarios/scheduled-visibility.spec.ts:268`

```
await flow.expectReminderRung('morning_of', 'canceled'); // the retired old rung
```

This is the ONLY end-to-end proof that a reschedule retires the previous
ladder, and its surrounding comment (`:249-262`) records that the assertion was
already re-derived twice, on 2026-08-26 and 2026-08-31, for exactly this reason.
Under D1 the row no longer exists, so the assertion has to become an ABSENCE -
a strictly weaker proof that can false-pass on a mid-load empty panel (a hazard
`steps.ts:3665-3670` already documents for the Upcoming bucket).

**Implies.** The spec must specify what replaces this positive proof. "Zero rows
of kind X" is not equivalent to "the old rung was retired"; it also passes when
nothing was ever armed.

## 11. [MEDIUM] A terminal transition now erases the ladder from the panel with no trace, and the spec never says so

**What is wrong.** 3.2 applies the delete sweep to the terminal path
(`canceled` / `closed` / `toured` / `no_show`) in one clause, with no discussion.
Today, cancelling a tour leaves the operator a struck-through ladder showing what
WAS going to be sent (`RemindersPanel.tsx:114-117` renders the `canceled` chip).
After D1, a canceled tour that never fired a rung shows an EMPTY Reminders panel -
identical to a tour that was never armed.

**Implies.** This is a real product decision bundled into a fix framed as being
about reschedule pile-up. P1 describes only reschedule. If the founder locked
"terminal also deletes", the spec should say why the audit trail is expendable;
if not, the terminal path may want to keep stamping.

## 12. [MEDIUM] `armedFor` is written canonicalized but compared raw - the comparison is asymmetric

**What is wrong.** 3.1: "`armTourReminders` stamps `armedFor` ... canonicalized
the same way the tour stores it (`new Date(x).toISOString()`)". 3.3 then compares
`armedFor === tour.scheduledAt`, where `tour.scheduledAt` is whatever is STORED.

The two are equal only if every writer of `scheduledAt` canonicalizes. The API
routes do (`app/src/routes/tours.ts:342`, `:1138-1141`), but the seed builders
write tour rows directly (`app/src/lib/seed/cast.ts:761`,
`app/src/lib/seed/matrix.ts:962-982`) and `app/src/lib/seed/live.ts:499` hand-builds
`TourItem` shapes for `armTourReminders`. I spot-checked cast/matrix and they
appear canonical (`.000Z` / `iso(ms)`), so the drift is latent rather than live -
but it is a silent, total failure: one non-canonical seeded tour makes its whole
freshly-armed ladder read as EARLIER, `reminders[]` empty and `next` undefined.

**Implies.** Specify the comparison as raw equality against the stored string on
BOTH sides (i.e. stamp `tour.scheduledAt` verbatim, do not re-canonicalize), or
canonicalize both sides at read time. As written the spec instructs a build that
can diverge and fail silently.

## 13. [LOW] Acceptance 6.8 already passes on `main`

**What is wrong.** 6.8: "Both Upcoming buckets (contact and group thread) stop
showing rungs from a superseded ladder." They already do. Both filter on all
three terminal stamps:

- `app/src/routes/contactTimeline.ts:982-984`
- `app/src/routes/relayGroups.ts:270-272`

and `cancelForTour` stamps `canceledAt` on exactly the rows those filters would
otherwise pass (`app/src/repos/tourRemindersRepo.ts:410-416`). The spec's own
Surfaces section concedes it ("D1 clears them with no read-side change").

**Implies.** Harmless as a regression guard, but it is not evidence the feature
works, and listing it among the acceptance criteria invites a builder to
"implement" behaviour that already ships.

## 14. [LOW] `scripts/retire-paused-tour-reminders.ts` is an unlisted writer

**What is wrong.** The Surfaces enumeration omits
`app/scripts/retire-paused-tour-reminders.ts`, which stamps `skippedAt` +
`skipReason` on reminder rows (it is the sole writer of `kind_retired`, per
`app/src/repos/tourRemindersRepo.ts:81-86`). It does not CREATE rows, so it needs
no `armedFor`, but under D1 its output becomes deletable-on-next-reschedule
rather than durable - and it races the sweep on the same
`attribute_not_exists`-only condition described in finding 1.

**Implies.** Add it to the surface list, and cover it by whatever fix finding 1
lands on.

## 15. [LOW] `listByTour` is unpaginated - not caused by this spec, but it is the read the whole design leans on

**What is wrong.** `app/src/repos/tourRemindersRepo.ts:221-231` issues a single
`QueryCommand` with no `LastEvaluatedKey` loop, unlike `listDue` immediately
below it (`:233-270`), which paginates and documents why. Both the sweep (3.2)
and the read partition (3.3) are built on this call.

**Implies.** D1 shrinks the partition, so the design reduces the exposure rather
than increasing it. Worth one sentence in the spec so a builder does not assume
the sweep is exhaustive on a pathological tour. Not blocking.
