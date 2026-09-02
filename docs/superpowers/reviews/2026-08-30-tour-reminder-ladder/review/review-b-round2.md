# Adversarial review B - round 2 (post fix-wave `b208285d`)

Charge order honoured: new findings first, the fix diff reviewed cold second,
adjudication challenges third, closure of round-1 findings last.

Everything below was run against `b208285d`. Empirical work used throwaway
`tsx` probes and vitest runs from the free lane; nothing was written into the
repo except this report.

**Four new findings: two MEDIUM, two LOW. Nothing BLOCKING, nothing HIGH.**
No defect found in `inertName` itself.

---

# Part 1 - what round 1 missed

## N1. MEDIUM - CONFIRMED - Phase B ledger item 8's "REACHABLE BAND" is wrong on three checkable points, and under a supported quiet-hours setting the band is up to SEVEN HOURS wide at almost every tour hour

`docs/issues/tour-reminder-ladder-phase-b.md`, item 8, the REACHABLE BAND
paragraph. This paragraph is the entire Phase A remediation for B1, so its
accuracy is the deliverable.

I swept `armTourReminders` exhaustively - every tour local hour 00..23, arm
instants walked backwards minute by minute over 12 hours, EDT and EST, quiet
window ON / OFF / `start:'19:00'` - and classified every rung retired
`quiet_hours_superseded` by whether its same-slot superseder was itself retired.

### Error 1: "arming inside the org quiet window" is not required

Corpse cases occur with `quietHoursEnabled: false`. Clamping is one route to a
slot collision, not the only one - `confirmation.dueAt` is literally `now`, so
it collides with any rung whose raw dueAt equals the arm instant.

### Error 2: "a tour starting roughly 08:00-12:00 local" is wrong at the low end

Measured (default window, 1-minute granularity), the WIDE contiguous band is:

```
tour 10:00 local   corpse for arm instants 04:01 .. 08:00 local   240 min
tour 11:00 local                            05:01 .. 08:00        180 min
tour 12:00 local                            06:01 .. 08:00        120 min
```

08:00 and 09:00 tours produce NO corpse - both rungs clamp at/after the start
and go `past_event`, which `supersededBySlot` already excludes. Every other tour
hour produces only a 1-minute (in reality millisecond-exact) collision.

### Error 3: "The evening side of the window is safe" is false - there is a SECOND corpse family the paragraph never considers

The paragraph reasons only about `morning_of`. But rule (e) also retires
`day_before`, and `day_before` has a fixed 19:30 org-local anchor:

```
tour 07/23 00:00 .. 07:00 local, arm at exactly 07/22 19:30 local
  -> confirmation SKIPPED quiet_hours_superseded, superseder day_before:booked_too_late
```

This fires on the EVENING side, at every tour hour, and with the window
**disabled**. It is millisecond-exact from a wall clock - but `armTourReminders`
takes `now` as a parameter and `routes/tours.ts` threads `deps.now`, so seeds,
fixtures and any injected clock land on round instants routinely.

### The part that actually matters: a legal non-default window makes this wide

`quietHoursStart: '19:00'` is a supported setting. `armTourReminders:309-329`
refuses to validate it in terms ("quiet hours are a general setting and must not
be constrained by one rung") and only logs a warn; the branch's own
`tourReminders.test.ts` case 8 calls that config the ONLY remaining coverage for
`staleDayBefore`. Under it, 19:30 is inside the window, so every `day_before`
clamps to 08:00 on the tour morning - the same slot a pre-08:00 arm instant
clamps the confirmation to. Measured:

```
quiet start 19:00
  tour 13:00 local   corpse for arm 01:00 .. 08:00   ~7 hours   live=[en_route]
  tour 14:00                          02:00 .. 08:00  ~6 hours   live=[morning_of,en_route]
  tour 15:00                          03:00 .. 08:00  ~5 hours
  tour 16:00                          04:00 .. 08:00  ~4 hours
  tour 17:00                          05:00 .. 08:00  ~3 hours
  tour 18:00                          06:00 .. 08:00  ~2 hours
  tour 19:00                          07:00 .. 08:00  ~1 hour
  tour 10:00 / 11:00 / 12:00          240 / 180 / 120 min, BOTH day_before AND
                                      morning_of are corpses in the same row
  tour 20:00                          08:00 .. 08:00, live=[morning_of]
```

So on an org that starts quiet hours at or before 19:30, a morning booking for
an afternoon tour loses BOTH `day_before` and the `confirmation`, and the
confirmation's chip blames `day_before`. The existing arm-time warn tells the
operator that every `day_before` will be retired; it does not say the
confirmation goes with it.

**What I would change.** Not the machinery - see the B1 challenge below, I
accept that ruling. Rewrite the REACHABLE BAND paragraph so Phase B plans from
the real shape: two families (`<- morning_of` and `<- day_before`), reachable
with the window off, band width measured, and the `quietHoursStart <= 19:30`
case named as the one where it stops being a corner. The one-line invariant that
covers all of it: **`supersededBySlot` treats "not `past_event`" as "will fire",
and rule (e) broke that equivalence.**

Reproduction: `armTourReminders` with the default window, tour
`2026-07-23T14:00:00.000Z`, arm `2026-07-23T10:00:00.000Z` (10:00 EDT for a
10:00 EDT tour is the exact-4h case) or any arm instant in
`2026-07-23T08:01Z .. 12:00Z` for the wide band.

---

## N2. MEDIUM - CONFIRMED - the filed interpolator issue's scope justification is false, and the re-expansion is LIVE outside the tour path today

`docs/issues/message-interpolate-token-reexpansion.md`, the "Why it is NARROW
today" section, says:

> The two other catalog entries that carry a contact-supplied name declare
> exactly ONE token each, so there is no second token for a value to leak into.

A whole-catalog pass falsifies that. Eight entries declare more than one token;
seven are the `tour.*` family, and the eighth is **`relay.member_added`**
(`app/src/messages/catalog.ts:299-306`, `vars: ['joined', 'members']`). Both of
its values are built from contact DISPLAY NAMES by `composeMemberAddedBody`
(`app/src/jobs/relayFanOut.ts:238-250`), and `joined` is substituted first, so a
value in it is re-scanned by the `members` pass.

Proved through the real composer:

```
member named "{members}":
  Hey! You're now connected with Alice, Bob, and {members} on this number.
  Reply here and everyone in the group sees it. joined this group chat.
  You're now connected with Alice, Bob, and {members} on this number.
  Reply here and everyone in the group sees it.

member named "{joined}":
  Hey! Carol joined this group chat. You're now connected with Alice and
  {joined} on this number. Reply here and everyone in the group sees it.
```

Both go to EVERY member of the relay group. The second emits a literal
`{joined}` in an outbound SMS.

Severity is not disclosure - the connection sentence is already in that body, so
this garbles rather than leaks. It matters because the paragraph is the reason
the general fix is parked, and it is wrong on a fact one grep settles. A reader
deciding priority from it will conclude the hazard is dormant when it is
currently mangling a real message.

The same misstatement is in `adjudications.md` B2. (The fix wave already caught
and corrected the related `notification.attachment` -> `relay.media_only`
misnaming from my round-1 report - that correction is right, and this is a
different error in the same paragraph.)

**What I would change.** Replace that paragraph with the measured list: eight
multi-token entries, seven `tour.*` (now sanitized at source) plus
`relay.member_added` (NOT sanitized, contact-name-fed, live). Either sanitize
`composeMemberAddedBody`'s two inputs the same way, or state explicitly that the
garbling is accepted until the single-pass fix lands. Do not leave the issue
asserting there is nothing else.

---

## N3. LOW - CONFIRMED - the release-time twin of the same predicate has the identical blind spot, and item 8 does not mention it

`app/src/jobs/tourReminders.ts:883-897`, `supersededInBatch` inside
`processReminderRow`.

Item 8 names `supersededBySlot` and describes the fix as "requiring a superseder
to be genuinely armable". There is a second copy of the same predicate at
RELEASE time, and it is weaker still: it retires an earlier rung on the mere
PRESENCE of a later due rung in the batch, with no check of any kind on whether
that later rung will send. It runs FIRST in `processReminderRow` - above the
quiet-hours backstop, above target resolution, above the roster gates and above
the compose gate - so every one of those "does not send" outcomes happens after
the earlier rung is already terminal.

Reproduced with a minimal fake (only `listDue` / `claimSkip` are reachable
before the quiet return):

```
tick at 2026-07-23T02:01:00.000Z (22:01 EDT - inside the org quiet window)
  day_before   dueAt=2026-07-22T23:30:00.000Z  SKIPPED:quiet_hours_superseded
  morning_of   dueAt=2026-07-23T02:00:00.000Z  still PENDING
```

In that particular interleaving the outcome is defensible (the superseder sends
at quiet-end, which is what supersession is for). It stops being defensible when
the superseder dies permanently - `contact_no_phone`, `no_conversation`,
`tenant_not_on_roster`, `invalid_schedule` all reach that state AFTER the
claim-skip. Those are pre-existing, so this is **not a new defect**; the branch's
only contribution is one more non-sending outcome (the new
`ReminderNamesUnavailableError` deferral, which is unbounded - ledger item 7).

It is worth recording because of the FIX SCOPE: an engineer implementing item 8
as written fixes `supersededBySlot`, ships, and leaves the runtime twin with the
same wrong equivalence. One sentence in item 8 pointing at `supersededInBatch`
prevents that.

---

## N4. LOW - CONFIRMED - the fix sanitizes names but not the address, and both land in the same rendered sentence

`app/src/lib/tourContacts.ts` `inertName` covers `firstName` / `lastName`.
`composeTourReminderBody` (`app/src/messages/tourCopy.ts:101-119`) also
interpolates `{where}` and `{addressLine}`, both derived from
`formatStreet(unit.address)`, which nothing sanitizes. Proved:

```
address "1 {tenantFirstName} Way", confirmation:
  Hey, your tour is set for Thu, Jul 23 at 3:00 PM at 1 {tenantFirstName} Way.

address "1 {where} Way", morning_of:
  Hey Alice, looking forward to having you tour at 3:00 PM today.
  Does that still work for you? Address is 1 {where} Way.
```

No re-EXPANSION occurs - `where` and `addressLine` are declared LAST on every
tour entry, so nothing re-scans their values. I verified all four orderings
(`{tenantFirstName}`, `{propertyContactName}`, `{where}`, `{addressLine}` inside
an address, on both `confirmation` and `morning_of`): every one stays literal.
So this is not the B2 vulnerability - unit addresses are also staff/import
entered behind auth, not public-intake reachable.

What it is: a literal `{token}` in a tenant-facing SMS, and an inconsistency the
fix wave created. `inertName`'s docblock says sanitizing at this source "closes
the tour path"; it closes the NAME half. The exhaustive matrix in
`tourCopy.test.ts` asserts `expect(body).not.toMatch(/\{[A-Za-z]/)` but only
over clean fixture addresses, so it cannot see this.

**What I would change.** Either run `formatStreet`'s output through the same
strip, or reword the docblock to say "closes the NAME path" so the next reader
does not assume the whole body is brace-free.

---

# Part 2 - the fix diff, read cold

## `inertName` - no defect found

`app/src/lib/tourContacts.ts:30-51`. I went at it on each axis the charge names.

- **Legitimate names.** No Latin-script personal name contains `{` or `}`.
  Staff free-text decorations use parentheses (`"Maria (PM)"`), which are
  untouched. Nothing else in the app round-trips this value - the DASHBOARD
  still renders the stored name, so the only divergence is between what the
  panel shows and what the SMS says, for a name that was never a name.
- **Interaction with the trim.** Strip-then-trim is the correct order and the
  test pins it: `'{ }'` -> `' '` -> `''` -> read as absence. Reversed
  (`.trim().replace(...)`) it would yield `' '`, length 1, and return a
  single-space "name" - which the second new test would catch. Also correct for
  `'{ Dana }'` -> `'Dana'` and for the pre-existing whitespace-only case.
- **Downstream behaviour change, benign.** A brace-only property-contact name
  now resolves `undefined`, which flips `idFor`'s
  `hasPropertyContactFirstName` and degrades an `en_route` on a landlord-led
  tour to the self-guided entry. That is the same degradation absence already
  produced, preview and send agree (`withholdPreview` keys on read FAILURE, not
  absence), and it beats rendering `"Hey Alice, {} will be headed that way
  shortly."`
- **Other vectors.** Covered in N4 (address: unsanitized but order-safe) and N2
  (`relay.member_added`: a different module, out of this fix's scope by design).
  The override path is inert - no `tour.*` call site passes `overrides`, and
  `settingsToOverrides` maps only `welcome.sms` and `missed_call.autotext`.
- **Coverage of the five compose consumers.** All five build `names` from
  `resolveTourContactNames` and nothing else (`jobs/tourReminders.ts:701`,
  `routes/tourReminders.ts:230` and `:668`, `routes/relayGroups.ts:243`,
  `routes/contactTimeline.ts:944`), so one helper really is the whole surface.
  The e2e harness builds `names` by hand, but that is expectation-side only.

## The new tests ARE tests

Both fail with `inertName` reverted to a bare `.trim()`:

- `'{where}'.trim()` is `'{where}'`, so
  `expect(r.names.tenantFirstName).toBe('where')` fails.
- `'{ }'.trim()` is `'{ }'` (braces are not whitespace), length 3, so
  `expect(r.names.tenantFirstName).toBeUndefined()` fails.

The second also pins the strip-before-trim ordering, which is the non-obvious
half.

## The rest of the fix diff

Actions 5, 6 and 7 are comment/prose edits; I checked each against the thing it
now quotes. The `booked_too_late` label quote matches
`dashboard/src/api/types.ts:1280` verbatim. Both timezone comments now name
`day_before` correctly. The flake issue's two HTML comments are properly nested
again with no orphaned `-->`, and the frontmatter delimiter at `:12` is intact.
No finding in any of them.

---

# Part 3 - adjudications contested

## B1 - I accept the disposition, I contest the record

I read spec 8.1 and spec section 2. **The decision not to touch the machinery in
Phase A is right** and I withdraw any implication otherwise: 8.1 puts cross-rung
supersession out of scope in terms, the fix reorders rule evaluation, and section
2's ruling ("the founder asked for no confirmation text", Phase B item 2 stops
arming `confirmation` at the moment the pause lifts) means the lost rung is one
already slated for deletion. The pause bound is real.

What I contest is **the accuracy of the band statement that shipped in its
place** - see N1. Three checkable errors, plus a second corpse family, plus a
measured 7-hour band under a supported setting. The ledger is the artifact Phase
B will plan from, and item 8 currently understates the problem it exists to
preserve. Fix the paragraph, not the code.

One thing the adjudication got right that I want to confirm rather than contest:
the fix-wave report flagged its own derivation that `confirmation` is the ONLY
reachable victim. **The 9,216-case sweep confirms it** - every corpse hit had
`confirmation` as the victim, under all three window configurations. `day_before`
cannot be one, for exactly the reason the report gives.

## B6 - I accept the conformance half, I contest closing it with "no action"

I read spec 6.1. It gives the resolver as an explicit snippet
(`unitContacts(unit).find(primaryContact) ?? nonEmpty(unit.landlordId)`), and the
build reproduces it exactly, empty-string guard included. **The rejection of
B6(b) - "names the unit's contact, not the tour's roster" - is correct and I
withdraw it.**

B6(a), the missing tenant de-dupe, I do not think "answers a different question"
disposes of. The output does not care which question the rule answers:

```
unit.landlordId === tour.tenantId  (an import or a mis-picked landlord)
  resolved: tenantFirstName "Alice", propertyContactFirstName "Alice"
  en_route / landlord_led ->
    "Hey Alice, Alice will be headed that way shortly.
     Can you please text here when you're on the way?"
```

Sent to Alice. Spec 6.3's degradation ladder handles ABSENCE and FAILURE; it has
no rule for IDENTITY, and `rosterResolution` - the resolver 6.1 says to reuse -
does carry the guard one line below the snippet that was copied
(`rosterResolution.ts:280`, `if (propertyContactId !== tenantId)`).

Not a Phase A fix, and not worth reopening the build. My challenge is only to
the disposition: this is a FILE, not a NO ACTION. Two lines in the Phase B
ledger, or its own low issue, so it is not rediscovered from a founder screenshot.

## B2, B3, B4, B5, B7 - not contested

Rulings and actions all match what I found. B7(b), the dead
`TourTimes.morningOf` mirror, is still dead as the fix-wave report notes; I agree
with routing it as a keep-or-drop call rather than a defect.

---

# Part 4 - are the fixes real?

## B2 - CONFIRMED closed end to end, not just in the helper

Composed through the real pair (`resolveTourContactNames` ->
`composeTourReminderBody`), hostile values on every name field:

```
tenant firstName "{propertyContactName}"  (the cross-boundary leak)
  Hey propertyContactName, confirming your tour tomorrow at 3:00 PM.
  Does that still work for you?

tenant firstName "{where}", address supplied
  Hey where, confirming your tour tomorrow at 3:00 PM. Does that still work for you?

tenant firstName "{addressLine}", morning_of + address
  Hey addressLine, looking forward to having you tour at 3:00 PM today.
  Does that still work for you? Address is 412 Oak St Apt 2.

tenant lastName "{propertyContactName}", no_show_checkin  (the full-name join)
  Hi Al! Do you need to reschedule?

landlord firstName "{tenantName}", en_route / landlord_led
  Hey Alice, tenantName will be headed that way shortly.
  Can you please text here when you're on the way?
```

No expansion, no braces, on any path. The landlord's name is no longer
retrievable by naming yourself after it. Closed.

## B1, B3, B4, B5, B7 - documentation actions, verified present and accurate

Item 8 rewritten (content contested in N1, but the merge-base evidence it quotes
is correct - I re-derived it). Both new issues exist and parse. The label quote,
the two timezone comments and the e2e booking comment all match what they now
describe. The flake issue's comments nest correctly.

---

# Gates run from the free lane, on `b208285d`

The fix wave ran four test files, `typecheck`, `issues` and scoped `eslint`. It
did **not** run a full suite or the smoke gate. I closed that:

- `npm run smoke` - **EXIT 0**.
  `smoke-dist: OK - 1356 import specifier(s) across 239 emitted file(s) resolve
  under plain Node.`
- `npm test` (ALL workspaces, bare, clean access key `hcreviewb003`) -
  **EXIT 0**. App: 346 files passed / 1 skipped, 6242 tests passed / 11 skipped,
  0 failures, 195.87s. Dashboard and the two fake-twilio workspaces green
  behind it (the last, `fake-twilio-web`, 13 files / 111 tests). The one skipped
  app file is `staticSmoke.test.ts` (no built dashboard), which self-skips on
  every run.
- Targeted re-run of the twelve tour-area files under a separate clean key -
  **12 passed, 491 tests passed**.

I did not re-run `npm run e2e`; nothing in `b208285d` touches a runtime path the
harness exercises (one comment in one spec file, one pure string helper covered
by unit tests).

---

# Nothing found at these severities

No BLOCKING finding. No HIGH finding - N1 is the largest, and it is a
documentation-accuracy defect on an artifact whose underlying behaviour was
correctly ruled out of scope. No new defect in `inertName`, in the three
duplicated preview blocks, in the failure/absence split, or in the seed writers
beyond what round 1 already recorded.
