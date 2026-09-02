# Spec R4 - adversarial doc review (reviewer B), terminal round

Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md` (revision 4)
Adjudications: `.../adjudications.md` (rounds 1-3)
Repo: `W:/tmp/tour-reminder-supersession` (read only)
Date: 2026-09-01

D1 is settled and is not argued here. Findings are against D3a, the 3.2 ordering
and conversion split, 3.3's enforcement surface, and 3.6's sentinel predicate.
All ten are new.

**Checked and found FINE - recorded so the build does not chase them:**

- **The ResizeObserver does not break jsdom.** `dashboard/src/test/setup.ts`
  already installs a global no-op stub ("jsdom has no ResizeObserver, but
  components that observe element size construct one on mount
  (useAutoGrowTextarea). A no-op stub lets them render in tests"). I expected
  this to break the ~10 suites that render `Timeline`; it does not. Being a
  no-op, it never fires the callback, which is exactly why section 4 is right to
  put the anchor proof in e2e.
- **All three preview surfaces already hold the tour, so 3.3's pointer check
  costs no IO on any of them.** `routes/contactTimeline.ts:978` walks
  `toursRepo.listByTenant` and has the `TourItem` in hand at `:981`;
  `routes/relayGroups.ts:221` does `tours.get(owner.id)` before `:226`;
  `routes/tourReminders.ts:493` does `tours.get(tourId)` before `:499`. The poll
  likewise already reads it (`jobs/tourReminders.ts:1049`).
- **`REMINDER_SKIP_REASON_LABELS` and `REMINDER_SUPPRESSION_LABELS` really are
  typecheck-forcing.** Both are exhaustive mapped types -
  `dashboard/src/api/types.ts:1301-1303` and `:1286-1288`. 3.3's claim holds for
  those two. It does not hold for the third map - see finding 3.
- **`toursRepo.patch` merges and supports clearing.** `SET`/`REMOVE` per supplied
  field, `null` maps to `REMOVE`, `ConditionExpression: attribute_exists(tourId)`,
  `ReturnValues: 'ALL_NEW'` (`app/src/repos/toursRepo.ts:319-362`). The pointer
  write, the clear, and section 4's "the returned object must carry it" all work
  as written.

---

## 1. [BLOCKING] 3.6's sentinel gives one predicate for two gates, and cannot satisfy both failure modes it names

**What is wrong.** 3.6 defines a single rule - "at-bottom means that sentinel's
bottom is within 48px of the viewport bottom" - and then requires two properties
of it:

> an operator reading the Upcoming block must NOT be yanked back to the last
> message by an arriving item, and a "New messages" pill must NOT be permanently
> lit merely because content exists below the sentinel.

One boolean feeds both gates, and the two properties pull it in opposite
directions.

**Evidence.** `atBottomRef` is written from the predicate in one place and read
in two:

`dashboard/src/routes/contact/Timeline.tsx:1851` - `atBottomRef.current = isAtBottom(el);`
`:1911-1913` - `if (atBottomRef.current) { el.scrollTop = ...; setHasNewBelow(false); }`  (the PIN)
`:1914-1915` - `} else if (grew) { setHasNewBelow(true); }`  (the PILL)

Call `S` the scroll offset where the sentinel's bottom meets the viewport bottom.
An operator who has scrolled DOWN to read the Upcoming block is BELOW `S` - the
sentinel has left the viewport upward by the block's height, which 3.6 elsewhere
establishes exceeds 48px.

- **Read "within 48px" symmetrically** (`|sentinelBottom - viewportBottom| <= 48`).
  That operator is NOT at bottom, so every arriving item takes the `else if
  (grew)` branch and lights the pill. That is failure mode 2, and the pill stays
  lit for as long as they read the block.
- **Read it one-sided** (`sentinelBottom <= viewportBottom + 48`, i.e. at OR
  past). Now that operator IS at bottom, so the arriving item runs the pin at
  `:1912` and scrolls them back to `S`. That is failure mode 1.

There is no third reading. The properties are only jointly satisfiable by
splitting the boolean: a PIN gate that is false once the operator is below `S`
(do not move someone who chose to be there) and a SEEN gate that is true at or
below `S` (they have seen everything, so no pill). 3.6 specifies one.

**What it implies.** This is my round-3 finding 4 unresolved. R3-4's adjudication
records it as answered - "A sentinel element after the last cluster now defines
at-bottom". The sentinel is real progress: it fixes WHERE the anchor is, which
was genuinely undefined before. But the dilemma was never about the anchor's
position; it was about what is true BELOW it, and a sentinel does not answer
that. A builder implementing 3.6 literally writes one predicate and fails
acceptance 13 - which half depends on which way they read "within".

This is the one part of the spec I do not believe a builder can execute
correctly without going back to the author.

---

## 2. [HIGH] The conversion split moves the sweep past `create` but not past the finalize, and the finalize-failure path has the identical defect

**What is wrong.** 3.2: "The sweep runs only once `create` has succeeded and the
conversion is real." `create` succeeding is not the point at which the conversion
is real, by the spec's own criterion.

**Evidence.** The step after `create` is the finalize patch, and it has its own
failure path that deliberately returns the tour to a retryable state:

`app/src/routes/placements.ts:757-773`
```
try {
  await tours.patch(tour.tourId, { status: 'closed', convertedPlacementId: created.placementId });
} catch (err) {
  try { await tours.releaseConversionClaim(tour.tourId, sentinel); } catch (relErr) { ...LOUD... }
  log.error({...}, 'convert: FINALIZE FAILED after placement created - ORPHAN placement (findable via fromTourId)');
  throw err;
}
```

The patch that would have set `status: 'closed'` is the one that failed, so the
tour is still `scheduled`. The claim is released - the comment at `:751-756` says
why: "attempt to release it (so a retry can re-convert)". So after a finalize
failure the tour is live, scheduled, and retryable.

If the sweep has already run between `create` and this patch, that live tour's
ladder is gone. That is precisely the state R3-3 was raised about, one step
later, with the same consequence: a scheduled tour that will silently send
nothing, and no trace that it ever had a ladder.

**What it implies.** The split's own logic puts the sweep AFTER the finalize -
that is where `convertedPlacementId` becomes a real id and the status becomes
`closed`, i.e. where "the conversion is real". Moving it there costs nothing: the
pointer is already cleared, so no rung can fire during the extra window
(3.2's whole argument). Acceptance 7 currently pins only the `create` failure;
it should pin the finalize failure too, which is the harder of the two because
the placement already exists.

---

## 3. [HIGH] The `superseded` token needs three more surfaces than 3.3 names, and the one carrying the new 409 is NOT typecheck-forced

**What is wrong.** 3.3 names one map and asserts it is safe by typecheck: "a new
`ReminderSkipReason` token `superseded`, labelled 'superseded by a reschedule' in
the exhaustive `REMINDER_SKIP_REASON_LABELS` map (both unions and the map are
exhaustive; a new token that misses either fails typecheck)."

That is true of the skip-label map. It is false of the map that renders the
send-now 409 the same section introduces, and it does not mention the suppression
union at all - which 3.3's own preview-surface paragraph requires.

**Evidence.**

- **The send-now copy map is string-keyed with a fallback.**
  `dashboard/src/api/types.ts:1327` -
  `const SEND_NOW_ERROR_COPY: Readonly<Record<string, string>> = {`
  and `:1379` - `return SEND_NOW_ERROR_COPY[code] ?? "Couldn't send that just now - please try again.";`
  Nothing forces an entry. A `superseded` 409 from `forceSendReminder` renders the
  generic fallback, whose copy invites a retry that can never succeed - the
  opposite of what every neighbouring entry does (compare `tour_missing`: "That
  tour is gone, so nothing was sent.").
- **The suppression reason is a DIFFERENT union.** `ScheduledSuppressionReason` is
  `'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage' |
  'quiet_hours' | 'paused' | 'discontinued'`
  (`app/src/services/scheduledSendSuppression.ts:9-11`, mirrored at
  `dashboard/src/api/types.ts:1147-1157`). 3.3 requires all three preview surfaces
  to "render such a rung as suppressed with the `superseded` reason", which means
  this union gains the token too - a second union, in a second file, with a
  dashboard mirror.
- **`suppressionLead` is a non-exhaustive if-chain.** `types.ts:1181-1186` ends in
  a bare `return 'Will be skipped';`, so a new reason compiles silently into that
  lead. `discontinued` needed its own lead ("No longer sent") precisely because it
  is TERMINAL, and `superseded` is terminal in exactly the same way now that
  `forceSendReminder` refuses it. Same reasoning, same treatment - but nothing
  makes the builder notice.
- The one good news: `REMINDER_SUPPRESSION_LABELS` (`types.ts:1286-1288`) IS an
  exhaustive `Record` over the suppression union, so the label half is forced.

**What it implies.** Four copy/type surfaces, of which 3.3 names one and asserts
the safety property of the two it did not check. The spec should name all four
and give the send-now sentence, since that is the one that will otherwise ship
wrong and silent.

---

## 4. [HIGH] "No current ladder" is safe against sending and unsafe against NOT sending - a step-3 failure silently disarms a live tour

**What is wrong.** R4: "The 3.2 ordering bounds every interruption to 'no current
ladder', which is safe by construction: nothing sends."

Nothing sending is the failure mode of this feature, not its safety property. The
ordering makes "no current ladder" the deliberate intermediate state on every
path, and step 2 has already hard-deleted the previous generation, so an
interruption anywhere after step 2 leaves the tour with no rungs at all and no
pointer.

**Evidence and reachability.** The sequence is clear (1), sweep (2), arm + set
pointer (3). A failure at step 3 - the arm throwing, or the caller's pointer
`tours.patch` throwing - leaves:

- tour `status: 'scheduled'` with a real `scheduledAt` (the status/time patch
  landed earlier, `routes/tours.ts:1164`),
- zero unsent reminder rows (the sweep deleted them),
- no `currentLadderId`,
- `RemindersPanel` rendering "No reminders armed." (`RemindersPanel.tsx:346`),
- and nothing that re-arms: the only arm sites are the create route
  (`routes/tours.ts:350`) and the re-arm path (`:1191`), neither of which runs
  again on its own.

The patch throw is not exotic: `toursRepo.patch` carries
`ConditionExpression: 'attribute_exists(tourId)'` (`toursRepo.ts:354`) and can
also fail on throttling; Express 5 forwards the async throw to a 500. A client
retry heals it; an operator who sees a 500 and moves on does not.

**What it implies.** Acceptance 7 pins the analogous conversion case and nothing
pins this one. Two cheap asks, neither of them scope creep: state in R4 that a
partial arm leaves a live tour silently non-sending (so it is not discovered as a
bug), and require the arm-plus-pointer pair to log at `error` on failure so the
state is greppable. If the founder wants an invariant asserted anywhere -
`status === 'scheduled'` implies a pointer - that is a separate decision and I am
not asking for it here.

---

## 5. [MEDIUM] Step 1's separate clear leaves a window that merging it into the patch already happening would close

**What is wrong.** 3.2 makes "clear the pointer" its own step. On the re-arm and
terminal paths a tour patch has already happened moments earlier in the same
handler, and merging the clear into it is both safer and cheaper.

**Evidence.** `routes/tours.ts:1164` - `tour = await tours.patch(tourId, patch);`
writes the new `scheduledAt` / `status`. The reminder side effects do not start
until `:1189-1195`. Between those two points the tour carries the NEW
`scheduledAt` with the OLD `currentLadderId`, so every rung of the old generation
is still CURRENT and passes 3.3's check. A rung that comes due in that window
sends a body composed from `tour.scheduledAt` - the read path takes the tour's
current time (`routes/tourReminders.ts:314-318`, and the poll's composer
likewise) - i.e. an en-route text fired on the OLD schedule's dueAt announcing
the NEW time.

The window is one DynamoDB round trip wide. Merging `currentLadderId: null` into
the `:1164` patch removes it entirely and makes "the time changed" and "the
ladder is disarmed" a single atomic write. It also saves a write: `toursRepo.patch`
bumps `updatedAt` on every call (`toursRepo.ts:323`, "updatedAt is always
bumped"), and the current sequence produces three tour writes per reschedule.

**What it implies.** 3.2's own argument - "the pointer moves first... it closes
the interval the sweep is working in, rather than leaving it open" - applies one
step earlier than the spec applies it. One sentence: on the re-arm and terminal
paths the clear rides the patch at `:1164` rather than being a separate write.

---

## 6. [MEDIUM] D3a's cost rationale is wrong by ~17 call sites, and the return SHAPE it turns on is unspecified

**What is wrong.** D3a justifies caller-owned pointer writes as "the cheap side of
a real fork: threading a repo into the armer would touch its ~25 call sites". But
the chosen option changes the armer's RETURN, which touches most of those same
sites.

**Evidence.** `armTourReminders` returns `Promise<TourReminderItem[]>`
(`jobs/tourReminders.ts:381`). Call sites that consume the array:

- `app/src/lib/seed/live.ts:514`, `:528`, `:538` - `const armedToday = await armTourReminders(...)`
  then `armedToday.length` at `:519`, `:533`, `:543`.
- 14 sites in `app/test/tourReminders.test.ts` bind `const rows = await armTourReminders(...)`
  (`:318`, `:382`, `:437`, `:483`, `:549`, `:587`, `:643`, `:686`, `:723`,
  `:1437`, `:1518`, `:4593`, `:4691`, `:4727`).

So a `{ ladderId, rows }` return touches ~17 of the ~25. The fork is 25-vs-17,
not 25-vs-0.

The alternative that really is zero - keep returning the array and have the
caller read `rows[0]?.ladderId` - is not what "RETURNS it" says, and the two
differ observably: on an arm that creates no rows (the `typeof scheduledAt !==
'string'` early return at `:389-392`), `{ladderId, rows}` still hands back an id
so the caller writes a pointer naming an empty ladder, while `rows[0]?.ladderId`
is `undefined` so the caller writes nothing and the tour stays pointer-less.

**What it implies.** The decision is fine; the reasoning behind it is wrong and
the shape is the part the builder actually needs. Name the return type. If the
count was the deciding factor, note that it was not decisive - the argument that
survives is `lib/seed/live.ts` having no repo to thread, which is true and
sufficient on its own.

---

## 7. [MEDIUM] "The release path restores the pointer" needs the old id captured and a failure posture; neither is specified

**What is wrong.** 3.2 leans on reversibility: "Clearing the pointer alone
disarms the ladder REVERSIBLY - the poll refuses every rung immediately, and the
release path restores the pointer." Restoring requires having kept the value, and
the restore is itself a write that can fail.

**Evidence.** The conversion route reads the tour once at the top and the
compensation catch is currently a single statement plus a rethrow:

`app/src/routes/placements.ts:745-748`
```
} catch (err) {
  await tours.releaseConversionClaim(tour.tourId, sentinel);
  throw err;
}
```

So the build must (a) capture `tour.currentLadderId` before the clear, and (b)
write it back here. The repo has a precedent for what a compensating write that
can itself fail should do - the sibling finalize catch wraps its release in its
own try/catch and logs loudly (`:759-767`). Nothing says whether the pointer
restore follows that pattern, whether it precedes or follows the claim release,
or what happens when it fails.

Acceptance 7 asserts the restored state and does not cover the restore failing,
which leaves the tour disarmed - finding 4's state, reached by a different door.

**What it implies.** Two sentences in 3.2: capture before clear, and restore
best-effort inside its own try/catch with a loud log, mirroring `:759-767`.

---

## 8. [MEDIUM] "`earlier[]`'s actions are allowlisted to Cancel" does not say which STATES, and two states make it wrong

**What is wrong.** 3.4 says an unsent earlier rung "renders with its real state
and keeps **Cancel**", and that the action list is "allowlisted rather than
inherited". It never says which states get the Cancel.

**Evidence.** The current renderer keys on state, and one button serves two
actions:

`dashboard/src/routes/tours/RemindersPanel.tsx:408-417`
```
{rung.state === 'upcoming' || rung.state === 'canceled' ? (
  ... aria-label={`${rung.state === 'upcoming' ? 'Cancel' : 'Restore'} the ${kindLabel} reminder`}
```

An allowlist that says only "Cancel" hits two wrong cases:

- **`canceled`.** The same branch renders **Restore**, which calls `uncancel` and
  puts a superseded rung back to pending. It cannot then send (3.3 refuses it on
  both paths), so the operator's click produces a rung the poll will claim-skip -
  an action whose only outcome is a skipped row.
- **`skipped`.** Once the poll has claim-skipped a mismatched rung `superseded`,
  `cancel` cannot win: it requires `attribute_not_exists(#skippedAt)`
  (`app/src/repos/tourRemindersRepo.ts:361`). A Cancel button there 409s every
  time.

**What it implies.** State the allowlist per state: `upcoming` -> Cancel; every
other state in `earlier[]` -> no actions. That is one line and it is the
difference between an allowlist and a slogan.

---

## 9. [LOW] Section 4 still calls conversion one of "the three sweep call sites" after 3.2 split it into two operations

**Evidence.** Section 4, Writers: "the three sweep call sites (3.2)". 3.2 item 3
now splits conversion into a pointer clear before `placements.create` and a sweep
after it - two operations at two points in an ordered compensation, not one call
site. Section 4's tour-row-writer paragraph ("written by the CALLER (D3a) at the
three sweep sites and on arm") inherits the same flattening.

**What it implies.** Cosmetic, but the Writers list is the enumeration a builder
audits their diff against, and conversion is the one path whose two halves are
deliberately far apart. Listing it as one site invites putting them back
together.

---

## 10. [LOW] The ResizeObserver fixes the block's height and leaves the clusters' height on the ids/count key 3.6 rejects

**What is wrong.** 3.6's argument is correct and general: "An ids/length key is
insensitive to the block's rendered height, which is the quantity the pin depends
on - a body wrapping to a second line moves the anchor with no key change." It
then applies the remedy to one side only.

**Evidence.** The effect's deps are `[clusters, resetScrollKey,
paging?.olderPagesLoaded]` (`Timeline.tsx:1920`), and `clusters` is memoised over
`visible` (`:1821`) - an items-derived value, insensitive to rendered height in
exactly the way 3.6 describes. An MMS image finishing load, or a delivery-ticker
line appearing, changes the message column's height with no dep change, and
`overflow-anchor: none` (`Timeline.module.css:142`) means nothing compensates.

**What it implies.** Pre-existing on `main`, so NOT a regression this change
introduces, and fixing it is outside section 5's scope. Worth one sentence only
so the builder does not read "a ResizeObserver on the Upcoming block" as covering
the anchor generally - if the observer is placed on the sentinel's container
rather than the block, it covers both for the same cost. UNVERIFIED whether that
placement has any downside; I did not model it.

---

## Contested adjudications

**R3-4 (the pin predicate) - recorded as ACCEPT and resolved by the sentinel. I
do not agree it is resolved.** See finding 1. The sentinel answers "where is the
anchor", which was one of the two things my round-3 finding said were missing.
The other - what `atBottom` means below the anchor, given that one boolean gates
both the pin and the pill - is restated in 3.6 as two required properties rather
than decided. This is the only adjudication I am contesting.

**A15 / R5 (pagination) - conceded for the third time, and the risk text is now
right.** R5's "the pointer check lowers the consequence of a missed row from
'sends' to 'shows up in earlier'" is the correct framing and matches what I
argued at round 2 and conceded at round 3.

**R3-3 (conversion compensation) - accepted and the direction is right.** The
pointer-clear-then-sweep split is the correct shape. Finding 2 is about where the
split's second half lands, not about the split.

Everything else across the three rounds I agree is closed.

---

## Buildability

**Not buildable as written, because of one part: 3.6's `atBottom` predicate.**

Everything else in this spec is executable by a builder with no context. The
ordering in 3.2 is a numbered sequence; D3a names an owner; 3.3 names the
enforcement points; 3.4 names the render slot; section 4 enumerates surfaces and
the tests that encode the old contracts. Findings 2-10 are corrections a builder
could apply from the text above - they change what gets built, not whether it can
be built.

3.6 is different in kind. It states a predicate and, in the next sentence, two
properties that predicate cannot both have, with acceptance 13 asserting both.
A builder executing it literally produces code that fails its own acceptance
criterion, and which of the two halves fails depends on how they read "within
48px". The fix is small - split the one boolean into a pin gate and a
seen-the-newest gate, and say which of the two `atBottomRef`'s two read sites
(`Timeline.tsx:1911` and `:1914`) takes which - but it is a decision, and it is
not in the document.
