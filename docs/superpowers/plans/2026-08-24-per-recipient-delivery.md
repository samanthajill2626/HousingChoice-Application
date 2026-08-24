# Implementation plan - per-recipient delivery visibility

Spec: `docs/superpowers/specs/2026-08-24-per-recipient-delivery-design.md` (rev 4)
Branch: `feat/per-recipient-delivery`  Worktree: `W:\tmp\per-recipient-delivery`
Base: `main` @ f0e5ab46

Assume NO context beyond this file, the spec, and the repo. Read the spec first;
this plan does not restate its rulings, it sequences them.

Human decisions confirmed 2026-08-24, do not revisit:

- A leg with no clock proving it started NEVER escalates. Silence on the
  never-dispatched class is accepted (spec S3, the cost paragraph).
- The inbound half is DEFERRED and filed, not built (spec 2.2).

TDD throughout: write the failing test, watch it fail for the RIGHT reason, then
implement. A test that passes before the implementation is a test that proves
nothing - delete it and write a real one.

## Slice order and why

S1 (pure presenter) -> S2 (naming) -> S3 (rendering) -> S4 (ticker) -> S5
(surfaces + e2e) -> S6 (issues). Each slice self-gates with
`npm run typecheck` and the dashboard unit suite. e2e runs once, in S5, when the
path is end-to-end.

The order is a dependency order, not a preference: S3 cannot render rows without
S2's labels or S1's presentations, and S4's run condition is defined in terms of
S1's `isStaleLeg`. **Mid-build the branch is not shippable** - after S1 the
rollup counts stale legs that no row explains, and after S3 the escalation
computes but nothing re-renders it. That is expected; do not "fix" it early.

---

## S1 - The pure presenter layer

All in `dashboard/src/routes/contact/deliveryStatus.ts` and its test. No
component touched. This is where the real coverage lives.

### S1.1 `isQuietSince` - the single clock comparison

RED: a test asserting the boundary is inclusive at exactly
`STALE_SENT_AFTER_MS`, exclusive one millisecond under, and false for a
non-finite input.

GREEN: export `isQuietSince(atMs: number, nowMs: number): boolean` -
`Number.isFinite(atMs) && nowMs - atMs >= STALE_SENT_AFTER_MS`.

Then refactor `presentDeliveryStatus` to call it. **`presentDeliveryStatus` must
keep its `sent`-only gate.** `deliveryStatus.test.ts:197-201` ("leaves every
OTHER status alone no matter how old") must pass VERBATIM afterwards - run that
file and confirm before moving on. This is the trap the spec's S3 mechanism
section exists to prevent: one shared comparison, NOT one shared predicate.

### S1.2 `RelayDeliverySlot` gains `sentAt`

`deliveryStatus.ts:102-106` becomes
`{ status: DeliveryStatus; errorCode?: string; sentAt?: string }`.
`npm run typecheck` is a gate and this is the first thing it fails on. No
behavior change; no test of its own.

### S1.3 `isStaleLeg` - the eligibility table

RED: one test per row of the spec's S3 table, including the two that carry the
human's decision:

- `sent` + parseable `sentAt` -> ages from `sentAt`
- `sent` + no `sentAt` -> ages from `messageAtMs`
- `sent` + UNPARSEABLE `sentAt` -> falls to the no-clock row, does NOT age from
  `sentAt` and does NOT crash
- `queued` + parseable `sentAt` -> ages from `sentAt`
- **`queued` + no `sentAt` -> NEVER stale, however old** (the released-hold and
  never-dispatched cases; name both in the test title)
- `queued_pending` -> never stale
- `delivered` / `failed` / `undelivered` -> never stale

GREEN: `isStaleLeg(slot: RelayDeliverySlot, messageAtMs: number | undefined,
nowMs: number): boolean`, exhaustive over `DeliveryStatus`, delegating the
comparison to `isQuietSince`.

Prefer an exhaustive `switch` over a set-membership check so a future
`DeliveryStatus` member is a typecheck failure rather than a silent default.

### S1.4 `presentRelayDelivery` - six branches, optional clock

RED: the six branches from the spec's table, asserted whole-object as the file
already does. Branch 0 (`null`) is EXISTING - `deliveryStatus.test.ts:123`
already pins it; do not rewrite that test, just do not break it.

New signature: `presentRelayDelivery(slots, messageAtMs?, nowMs?)`. **The
staleness inputs are OPTIONAL and omitting them must reproduce today's behavior
exactly** - that is what keeps the ten existing assertions green.

Also add the three clock-passing twins the spec's 6.1 names, for `:38-40`,
`:41-43` and `:62-65`. Do not edit those three; ADD twins beside them, so the
file states both the no-clock contract and the real one.

Watch the counting: `K` (failed) and `J` (stale) are disjoint by construction -
a hard-failed leg is terminal so `isStaleLeg` is false for it - but assert that
rather than assuming it, because branch 2's label adds them.

### S1.5 The per-leg presenter

RED, then GREEN: `presentLegDelivery(slot, rosterKind, messageAtMs?, nowMs?)`
returning a `DeliveryPresentation | null`, covering:

- opted-out (`errorCode === 'contact_opted_out'` ALONE, on `failed` OR
  `undelivered`) -> product-aware label per spec S4(b), `isFailure: false`
- stale `sent` -> `Sent - not confirmed`
- stale `queued` -> `Queued - not confirmed` (must DIFFER from the above; a test
  asserting they differ is worth its line)
- otherwise -> delegate to `presentDeliveryStatus` for the plain status
- a `queued` leg carrying a transient `errorCode` -> NOT a failure, and its
  reason must NOT render

**This function, not `presentDeliveryStatus`, owns the new labels.**
`broadcastFormat.ts:108` and `Timeline.tsx:920` call `presentDeliveryStatus` and
must not move - after S1, re-run the broadcasts tests and confirm.

Gate S1: `npm run typecheck`, then the dashboard suite.

---

## S2 - Naming a recipient

### S2.1 Extract the key matcher

`lib/memberAttribution.ts:75-77` already matches a member against EITHER key
convention. EXTRACT it (do not re-implement) as an exported helper taking a key
and a roster and returning the matched `ConversationParticipant | undefined`.
`senderLabel` must then call the extracted helper and its existing tests must
pass unchanged - that is the proof the extraction was faithful.

### S2.2 The row-label resolver

RED: one test per spec S2 case, and the case-3 test is the one that matters:

1. roster non-empty + match -> `groupMemberLabel(member)` (name, else formatted
   number). Cover BOTH key conventions.
2. roster non-empty + NO match -> former-member wording; phone-keyed shows the
   formatted number, contactId-keyed shows no number.
3. **roster ABSENT or EMPTY -> no membership claim.** Phone-keyed shows the
   formatted number; contactId-keyed shows the neutral unnamed-recipient label.
   Assert explicitly that the former-member wording is ABSENT here. This is the
   case that would otherwise tell a founder every recipient had left the group
   whenever a roster fetch failed, which happens by default on two surfaces.

GREEN: the resolver. Return a label AND a discriminator the row can use, not a
pre-baked string - S6's accessible name needs the same data and must not
re-derive it differently.

Gate S2: typecheck + dashboard suite.

---

## S3 - Rendering the rows

`Timeline.tsx` and `Timeline.module.css`.

### S3.1 The gate and the rows

Replace the `Object.values(...)` call at `Timeline.tsx:602` so the KEYS survive.
The list's gate is the spec's single predicate - `outbound` AND at least one
slot AND parent status not `queued_pending` - **evaluated independently of the
rollup's null-ness.** Do not reuse `deliveredSummary !== null` as the gate; that
is the exact defect round 1 caught.

Render rows only while `revealed` is true (conditional render, NOT a CSS
`display` rule). Roster order, unmatched keys last in map-key order. Rows do NOT
`stopPropagation` - see spec S1; a builder adding it defensively violates a
locked decision.

Per row: label (S2), presentation (S1.5), timestamp (`deliveredAt` when
delivered, `sentAt` whenever the slot has one), and a reason only when the row's
own presentation `isFailure`.

CSS: a new list block in `Timeline.module.css` reusing the existing `TONE_CLASS`
tone colours. Do not import `ConversationDetail.module.css` or the broadcasts
`DeliveryBadge` - the spec rules both out.

### S3.2 The rollup and the accessible name

Wire the rollup call to pass the clock. Add `role="img"` + `aria-label` to
whichever chip actually renders:

- rollup present -> the rollup chip (`Timeline.tsx:656-664`)
- rollup null with a non-empty map (all opted out) -> the MESSAGE-LEVEL chip
  (`Timeline.tsx:644-655`)

Name shape per spec S6, including its case-3 clause (omit the per-recipient
recital when the roster is absent and every key is contactId-keyed). `title`
stays for mouse users. Repo precedent for the construct: `AutoBadge.tsx:25`.

### S3.3 Tests

In `Timeline.test.tsx`. **Every list assertion, positive AND negative, must
drive the reveal first** - click the bubble body text, which bubbles to
`toggleMeta`. A `queryBy...`-absent assertion without a click passes on a
completely broken build; phrase the negatives as "revealed, and still no list".

Cover: rows per member under both key conventions; roster order; all three S2
cases end-to-end; no list for `queued_pending`, for an empty map, or on an
inbound bubble; a list for the all-opted-out map ALONGSIDE the message-level
chip; `toHaveAttribute('role','img')` and `toHaveAccessibleName(...)` on both
chip variants.

Never write `toBeVisible()` about the reveal - `vite.config.ts:99` sets
`css:false`, so it would be vacuous.

### S3.4 The re-baseline - exactly two assertions

Per spec 6.1. `Timeline.test.tsx:910` moves. `Timeline.test.tsx:999` moves, and
its INTENT is the neutral branch, so RE-DATE its fixture near the pinned clock
rather than rewriting the expectation. Tighten
`GroupTextView.test.tsx:1017` from its substring regex so it can actually fail.

**Any other rollup assertion that goes red is a REGRESSION, not a re-baseline.**
Specifically `:932`, `:949`, `:962`, `:976`, `:991`, `:1021` must all stay green
untouched. If one of them fails, stop and diagnose; do not edit it.

Gate S3: typecheck + dashboard suite.

---

## S4 - The ticker

### S4.1 The hook

A small hook beside the timeline (NOT in `deliveryStatus.ts`, which stays pure).

Run condition, all three clauses required: at least one rendered outbound leg is
non-terminal AND eligible to age AND not yet stale. The middle clause is
load-bearing - without it the interval never stops for the very legs the human
decided stay silent. Coarse interval (order of a minute), visibility-gated per
`GroupTextView.tsx:152-166`, cleaned up on unmount, no network.

### S4.2 Tests

Release the `Date` pin then install fake timers - `vi.useRealTimers()` then
`vi.useFakeTimers()`, the sequence `dashboard/src/test/setup.ts:27-30`
documents. Do NOT suppress the ticker under test.

Prove: a not-yet-stale leg escalates after advancing past the boundary, with no
refetch and no re-mount (this is what proves spec acceptance 2); the interval
STOPS once every eligible leg is stale; a thread of only terminal legs schedules
nothing; and **a thread whose only non-terminal legs are ineligible schedules
nothing** (spec acceptance 3a - assert absence, not harmlessness).

Gate S4: typecheck + dashboard suite.

---

## S5 - The other surfaces, then e2e

### S5.1 Component tests

- `GroupTextView.test.tsx`: one group-text-keyed case. That file uses bare
  `vi.fn()` re-armed via `mockReset().mockResolvedValue()` in `beforeEach`, with
  `cleanup()` BEFORE `restoreAllMocks()` in teardown. Re-arm every mock you
  touch or adopt the `AnyAsyncMock` form from `ConversationDetail.test.tsx:34-47`.
  Getting this wrong reproduces `conversationdetail-members-mock-suite-flake`.
- `ConversationDetail.test.tsx`: one relay-arm case. It has ZERO delivery-chip
  coverage today.

### S5.2 E2E

Arm a stalled leg with
`setDeliveryOutcome(request, { partyNumber, profile: { kind: 'stall' } })`
(`e2e/fixtures/fakeTwilio.ts:258`), which stalls at `sent`. Reveal the bubble,
assert the rows appear and name the right member against the right state.

Staleness stays in the unit layer - 15 real minutes is not an e2e. A leg stuck
at `queued` cannot be armed through the fixture's documented signature (it
exposes `failState` while the engine's option is `stallAt`); do not add a seam
for it.

Do NOT add a stale fixture to the `lean` profile - it is the byte-stable e2e
world.

Scope the two locators at `group-text-stop.spec.ts:133` and `:136`: a revealed
bubble adds a third string carrying "opted out" to the same page, and those are
page-wide `getByText` calls today.

Add a `selectors.md` row for the delivery chip and the bubble reveal; neither is
documented.

### S5.3 The five surfaces in a browser

Spec acceptance 7. Four surfaces render the list - relay `ConversationDetail`,
`GroupTextView`, `PlacementConversation`, `TourConversation`. The contact page
renders NO list and must be verified visually unchanged. Do not infer any of the
five from "it is the same component".

Gate S5: the full four - `npm run typecheck`, `npm test`, `npm run smoke`,
`npm run e2e`, run BARE from the worktree, never piped.

---

## S6 - Issues (any time)

File three, using `docs/issues/_TEMPLATE.md`, then run `npm run issues`:

1. **The inbound half.** Deferred by human decision. Record what the reviewer
   established: the list's gate is independent of the rollup, so widening it
   adds rows only and renders no new chip - it is cheaper than it looks.
2. **The bubble reveal is not keyboard-reachable.** Pre-existing; this feature
   makes the consequence worse by putting its payload behind it. Note the
   blocker: the bubble already nests interactive children (a Link, a Retry
   button), so it cannot simply become a button.
3. **A relay-observed 21610 keeps the raw code** while the group path translates
   it to `contact_opted_out`, so only the group case is excluded from the
   denominator.

---

## Definition of done

1. All four gates green from the worktree, BARE, with real exit codes quoted.
2. The two re-baselined assertions are the ONLY rollup assertions that changed.
3. `deliveryStatus.test.ts:197-201` passes verbatim - the 1:1 rule did not move.
4. Broadcasts are untouched: `broadcastFormat.ts` / `DeliveryBadge.tsx` have no
   diff and their tests pass.
5. Every spec acceptance item has a test or a browser check naming it.
6. `main` synced ONCE at the final pre-handback step, not chased repeatedly.
7. ASCII-only on every added line. Explicit paths on every commit; never
   `git add -A`. A `Co-Authored-By` trailer naming the authoring model.
