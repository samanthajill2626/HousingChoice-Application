# Implementation plan - per-recipient delivery visibility

Rev 2 (folds plan review round 1 - two reviewers, 32 findings, 30 accepted)
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
implement. A test that passes before the implementation proves nothing - delete
it and write a real one. Where a step below says its red state cannot exist,
believe it and do not fake one.

---

## 0. Decisions this plan makes so the builder does not have to

These were left open in rev 1 and each has more than one defensible answer. They
are settled here; do not re-litigate mid-build.

**D-a. How staleness is DISABLED.** Rev 1 said "omitting the staleness inputs
reproduces today's behavior exactly". That is false as stated: `slot.sentAt` is
a per-slot clock a caller cannot withhold, so a slot could still age even with
no message clock passed. The rule is therefore explicit and total:

> Staleness is evaluated ONLY when `nowMs` is supplied. With `nowMs`
> undefined, `isStaleLeg` returns false for every slot regardless of `sentAt`,
> and `presentRelayDelivery` cannot select branch 2 or 3.

That single rule is what makes the ten existing pure-layer assertions green, and
it is also the mechanism for D-b.

**Two traps in that rule, both of which have already bitten this plan:**

1. **`presentDeliveryStatus` is EXEMPT and keeps the opposite convention.** Its
   `nowMs` is a DEFAULTED parameter (`nowMs: number = Date.now()`,
   `deliveryStatus.ts:88`), so passing `undefined` re-arms the real clock rather
   than disabling anything. Its documented opt-out is withholding the TIMESTAMP
   (`deliveryStatus.ts:80-83`), not the clock. So one module now has two
   meanings for the name `nowMs`. Do not "harmonise" them - changing
   `presentDeliveryStatus`'s signature moves the 1:1 rule, which is forbidden.
   Comment the divergence at both definitions.
2. **Therefore `presentLegDelivery` must delegate by withholding the
   TIMESTAMP.** When staleness is disabled it calls
   `presentDeliveryStatus(slot.status)` with NO second argument. Passing
   `presentDeliveryStatus(slot.status, someTimestamp, undefined)` silently
   re-arms `Date.now()` and defeats both D-a and D-b - every `sent` leg on an
   imported row would read "Sent - not confirmed". This is the single easiest
   way to build this feature wrong; write the test for it (S1.5).

**One clock per bubble.** `MessageBubble` computes its `nowMs` ONCE and passes
the same value to the rollup, to every row, and to the accessible name. Three
independent `Date.now()` reads in one render can disagree with each other, which
is exactly the class of contradiction this feature exists to remove.

**D-b. The imported guard (spec S5).** `Timeline.tsx` withholds `nowMs` when
`msg.imported === true`, exactly as the 1:1 path already withholds its timestamp
at `Timeline.tsx:577`. Composed with D-a, an imported row can never show a stale
state anywhere. NOTE the honest reachability: the importer writes no
`delivery_recipients` (`app/src/lib/import/apply.ts` stamps `imported_from` on
conversations and messages but no per-recipient map), so no row should carry
both today. The spec requires the guard anyway so the rule holds by
construction. Task it; do not skip it because it looks unreachable.

**D-c. The ticker lives in `Timeline`, not in `MessageBubble`.** One interval
per thread, not one per bubble. It bumps a `now` value that reaches bubbles by
the same prop path `rosterKind` already uses (`Timeline` -> `StreamItem` ->
`MessageBubble`). This choice determines the acceptance-3a test, so it is fixed
here. Verified: that prop path is real and there is no `React.memo` anywhere in
`Timeline.tsx`, so a bump genuinely re-renders every bubble.

**`now` INITIALISES TO `Date.now()` AT MOUNT, never to `undefined`.** Under D-a
an undefined clock means "staleness off", so initialising lazily would make the
first render of every thread show no escalation at all - and the 8/23 headline
case, where the founder opens a thread whose leg went quiet hours ago, would
render exactly as it does today until a tick fired a minute later. D-a's failure
mode is SILENT-OFF, which is safe against false reds and dangerous against
missing ones; this is the one place that asymmetry bites. Test the first render,
not just the tick.

**D-c2. The ticker's `nowMs` must reach the same place the imported guard
does.** A bubble whose clock is withheld (D-b) contributes NOTHING to the run
condition - see S4.1.

**D-d. Row markup and its accessible handles.** The list is a `<ul>` with
`aria-label="Delivery by recipient"`; each row is an `<li>`. This gives the e2e
`getByRole('list', { name: ... })` / `getByRole('listitem')` instead of a
`data-testid`, satisfying the accessibility-first rule in
`e2e/support/selectors.md:1-12`, and it gives the unit tests a non-vacuous
handle.

**D-e. The row timestamp uses the module's existing `formatTime`** - the same
helper that builds the `meta` line at `Timeline.tsx:551-560`. No new formatter.

**Timezone hazard, and how tests avoid it.** `formatTime` renders LOCAL time,
while `sentAt` and `deliveredAt` are UTC (`Z`-suffixed) provider/server strings
- unlike `msg.at`, which is naive-local. No suite in this repo pins `TZ`, so an
exact-string timestamp assertion would be the first timezone-dependent test in
the codebase and would pass on one machine and fail on another. **New tests
assert that a timestamp is PRESENT or ABSENT, and match it loosely (a
time-shaped pattern), never an exact clock string.** Do not add a `TZ` pin to
the shared setup to make an exact assertion possible; that is a suite-wide
change for one test.

**D-f. Writing the queued label in new tests.** The shipped label for `queued`
carries a non-ASCII ellipsis, and AGENTS.md requires ADDED lines to be ASCII.
Write the ellipsis as a unicode escape (backslash-u-2026) inside the string
literal instead of typing the character: the source line stays all-ASCII and
still evaluates to the real label. Do NOT compare against
`presentDeliveryStatus('queued')`: an assertion that the delegate returns what
the delegate returns is self-referential and would pass even if the delegation
broke. Do not "fix" the shipped label.

---

## Slice order and why

S1 (pure presenter) -> S2 (naming) -> S3 (rendering) -> S4 (ticker) -> S5
(surfaces + e2e) -> S6 (issues). Each slice self-gates with `npm run typecheck`
and the dashboard unit suite. e2e runs once, in S5, when the path is end-to-end.

The order is a dependency order: S3 cannot render rows without S2's labels or
S1's presentations, and S4's run condition is defined in terms of S1's
`isStaleLeg`.

**Correcting rev 1's account of the mid-build state:** after S1 the suite is
fully GREEN, not partially red - the new code is additive and, by D-a, dormant
until a caller passes `nowMs`. The first behavior change lands in S3. Do not go
looking for a red suite that should not exist.

---

## S1 - The pure presenter layer

All in `dashboard/src/routes/contact/deliveryStatus.ts` and its test. No
component touched.

### S1.1 `isQuietSince` - the single clock comparison

RED: the boundary is inclusive at exactly `STALE_SENT_AFTER_MS`, exclusive one
millisecond under, and false for a non-finite input.

GREEN: `export function isQuietSince(atMs: number | undefined, nowMs: number):
boolean` - note `number | undefined`, because its first caller passes
`sentAtMs?: number` (`deliveryStatus.ts:85-89`) and a `number`-only signature
does not typecheck there.

Then refactor `presentDeliveryStatus` to call it. **It must keep its `sent`-only
gate.** `deliveryStatus.test.ts:197-201` ("leaves every OTHER status alone no
matter how old") must pass VERBATIM afterwards - run that file and confirm
before moving on. One shared COMPARISON, never one shared PREDICATE.

### S1.2 `RelayDeliverySlot` gains both clocks

`deliveryStatus.ts:102-106` becomes
`{ status: DeliveryStatus; errorCode?: string; sentAt?: string; deliveredAt?: string }`.
Both, not just `sentAt` - S3.1 renders `deliveredAt` on a delivered row and
would otherwise hit a typecheck wall mid-slice.

No test, and **no red state exists for this step** - adding optional fields
cannot fail `tsc`, and the wire type already carries both
(`api/types.ts:1532-1538`). Rev 1 claimed a typecheck failure here; it was
wrong.

### S1.3 `isStaleLeg` - the eligibility table

RED: one test per row of the spec's S3 table, plus D-a:

- `sent` + parseable `sentAt` -> ages from `sentAt`
- `sent` + no `sentAt` -> ages from `messageAtMs`
- `sent` + UNPARSEABLE `sentAt` -> falls to the no-clock row; does not age from
  `sentAt`, does not crash
- `queued` + parseable `sentAt` -> ages from `sentAt`
- **`queued` + no `sentAt` -> NEVER stale, however old.** Title the test with
  both cases it protects: a released connect-when-ready hold, and a send whose
  fan-out never ran.
- `queued_pending` -> never stale
- `delivered` / `failed` / `undelivered` -> never stale
- **`nowMs` undefined -> false for every slot above, including ones with a
  `sentAt`** (D-a)

GREEN: `isStaleLeg(slot, messageAtMs: number | undefined, nowMs: number |
undefined): boolean`, exhaustive over `DeliveryStatus` via a `switch` so a
future member is a typecheck failure rather than a silent default, **delegating
the actual comparison to `isQuietSince`**. That delegation is spec S3's
one-comparison ruling and is the only thing that gives S1.1 a caller; an earlier
draft of this plan dropped the clause and left `isQuietSince` orphaned.

### S1.4 `presentRelayDelivery` - six branches, optional clock

RED: the six branches from the spec's table, whole-object as the file already
does. Branch 0 (`null`) is EXISTING and pinned at `deliveryStatus.test.ts:123` -
do not rewrite it, just do not break it.

New signature: `presentRelayDelivery(slots, messageAtMs?, nowMs?)`, obeying D-a.

ADD clock-passing twins beside `:38-40`, `:41-43` and `:62-65` - same arrays
plus `sentAt` and a `nowMs`. Do NOT edit those three; they stay as the no-clock
contract.

Assert, rather than assume, that `K` (failed) and `J` (stale) are disjoint: a
hard-failed leg is terminal so `isStaleLeg` is false for it. Branch 2's label
adds them, so their disjointness is load-bearing.

### S1.5 The per-leg presenter

RED, then GREEN: `presentLegDelivery(slot, rosterKind, messageAtMs?, nowMs?)`
returning `DeliveryPresentation | null`:

- opted-out (`errorCode === 'contact_opted_out'` ALONE, on `failed` OR
  `undelivered`) -> product-aware label per spec S4(b), `isFailure: false`
- stale `sent` -> `Sent - not confirmed`
- stale `queued` -> `Queued - not confirmed`, and a test asserting the two
  differ
- otherwise -> delegate to `presentDeliveryStatus`
- a `queued` leg carrying a transient `errorCode` -> NOT a failure, reason does
  NOT render

**`null` case:** `presentDeliveryStatus` returns null for an unrecognised
status. A row whose presentation is null renders the member's name and NO state
chip - never a blank row, never an invented state. Test it.

**This function, not `presentDeliveryStatus`, owns the new labels.**
`broadcastFormat.ts:108` and `Timeline.tsx:920` call `presentDeliveryStatus` and
must not move - after S1, run the broadcasts tests and confirm.

Gate S1: `npm run typecheck`, then the dashboard suite. Both green.

---

## S2 - Naming a recipient

### S2.1 Extract the key matcher

`lib/memberAttribution.ts:75-77` already matches a member against EITHER key
convention. EXTRACT it (do not re-implement) as an exported helper taking a key
and a roster and returning `ConversationParticipant | undefined`. `senderLabel`
then calls it, and ITS existing tests must pass unchanged - that is the proof
the extraction was faithful.

### S2.2 The row-label resolver

**Define the key discriminator once, here, and export it**: a key is
phone-keyed iff it starts with `phone#`; the number is the remainder, formatted
with `formatPhoneDisplay` (`lib/phone.ts`). S2.2 and S3.2 both branch on this
and MUST agree - a second copy is how they drift.

RED: one test per spec S2 case:

1. roster non-empty + match -> `groupMemberLabel(member)`. Cover BOTH key
   conventions.
2. roster non-empty + NO match -> former-member wording; phone-keyed shows the
   formatted number, contactId-keyed shows no number.
3. **roster ABSENT or EMPTY -> no membership claim.** Phone-keyed shows the
   formatted number; contactId-keyed shows the neutral unnamed-recipient label.
   Assert explicitly that the former-member wording is ABSENT. This is the case
   that would otherwise tell a founder every recipient had left the group
   whenever a roster fetch failed - the default state on two surfaces.

GREEN: return a label AND the discriminator, not a pre-baked string. S6's
accessible name consumes the same data and must not re-derive it differently.

Gate S2: typecheck + dashboard suite.

---

## S3 - Rendering the rows

`Timeline.tsx` and `Timeline.module.css`.

### S3.1 The gate and the rows

Replace the `Object.values(...)` at `Timeline.tsx:602` so the KEYS survive.

The list's gate is the spec's single predicate - `outbound` AND at least one
slot AND parent status not `queued_pending` - **evaluated independently of the
rollup's null-ness.** Do not reuse `deliveredSummary !== null`; that is the
exact defect spec review round 1 caught.

Render rows only while `revealed` is true (conditional render, NOT a CSS
`display` rule). Markup per D-d. Roster order, unmatched keys last in map-key
order. Rows do NOT `stopPropagation` (spec S1) - a builder adding it defensively
violates a locked decision.

Per row: label (S2), presentation (S1.5), timestamp via D-e (`deliveredAt` when
delivered, `sentAt` whenever the slot has one), and a reason only when the row's
own presentation `isFailure`.

Pass `nowMs` per D-b: withheld when `msg.imported === true`.

CSS: a new list block in `Timeline.module.css` reusing the existing `TONE_CLASS`
tone colours. Do not import `ConversationDetail.module.css` or the broadcasts
`DeliveryBadge` - the spec rules both out.

### S3.2 The rollup and the accessible name

Wire the rollup call to pass the clock (same imported guard). Add `role="img"` +
`aria-label` to whichever chip actually renders:

- rollup present -> the rollup chip (`Timeline.tsx:656-664`)
- rollup null with a non-empty map -> the MESSAGE-LEVEL chip
  (`Timeline.tsx:644-655`)

**The accessible name uses the SAME clock as the chip it names** - pass it the
same `nowMs` (or the same withheld undefined). A name computed against a
different clock than its own visible label is a contradiction a reader cannot
resolve.

Name shape per spec S6, including its case-3 clause (omit the per-recipient
recital when the roster is absent AND every key is contactId-keyed). `title`
stays for mouse users. Repo precedent for the construct: `AutoBadge.tsx:25`.

**`role="img"` is applied ONLY in the two cases bulleted above** - a bubble with
no `delivery_recipients` map at all (every 1:1 bubble, and the MMS fixture at
`Timeline.test.tsx:560-570`) gets NEITHER, because it has no rollup and does not
meet the branch-0 condition either.

Consequence, stated so it is not "handled" away: `Timeline.test.tsx:570` asserts
`queryByRole('img')` is absent on an MMS bubble, and it is the repo's only
unnamed-img guard. **If that assertion goes red, the implementation applied the
role unconditionally - that is a REGRESSION to fix in the source, not an
assertion to scope.** An earlier draft of this plan pre-authorised weakening it;
that permission is WITHDRAWN.

**Also known:** on a RELAY all-opted-out bubble the message-level chip reads the
queued label, because the relay fan-out never moves the parent status off
`queued`. The visible chip is therefore wrong there TODAY, before this change.
Attaching the accessible name is still correct - the name supersedes the visible
text for assistive technology and will read accurately. Do not fix the visible
chip here; FILE it (S6.4).

### S3.3 Tests

In `Timeline.test.tsx`. **Every list assertion, positive AND negative, must
drive the reveal first** - click the bubble body text, which bubbles to
`toggleMeta`. A `queryBy`-absent assertion without a click passes on a
completely broken build; phrase the negatives as "revealed, and still no list".

Cover: rows per member under both key conventions; roster order; all three S2
cases end-to-end; **row timestamps** (present on delivered and on any leg with
`sentAt`, absent otherwise - this is half of spec acceptance 1 and rev 1 omitted
it); no list for `queued_pending`, for an empty map, or on an inbound bubble; a
list for the all-opted-out map ALONGSIDE the message-level chip; the imported
guard (D-b) showing no stale state on an imported row carrying a synthetic map;
`toHaveAttribute('role','img')` and `toHaveAccessibleName(...)` on BOTH chip
variants.

Never write `toBeVisible()` about the reveal - `vite.config.ts:98` sets
`css:false`, so it would be vacuous.

### S3.4 The re-baseline census - three assertions, each for a stated reason

Per spec 6.1, corrected by plan review:

| Assertion | Change | Reason |
| --- | --- | --- |
| `Timeline.test.tsx:910` | expectation moves to branch 3 | `RELAY_OUT`'s `c2` is `sent` with no `sentAt`, so row 2, so stale against the pinned clock |
| `Timeline.test.tsx:999` | **override the fixture LOCALLY** | Its intent is the neutral branch. **`RELAY_OUT` is SHARED** - it is spread into `:917`, `:941`, `:955`, `:968`, `:983`, `:1009` and used directly at `:909` - so re-dating the const (rev 1's instruction) would silently un-stale `:910` and delete the feature's only Timeline-level re-baseline. Give THIS test its own `at`/slots instead. **Compute that `at` from the pinned clock in code** (e.g. an offset from `new Date()` under the pin), not as a hardcoded date string: `RELAY_OUT.at` is naive-local, so a literal chosen to sit "near the pinned clock" shifts by the machine's UTC offset and would go stale on some developers' machines and not others. |
| `GroupTextView.test.tsx:1017` | tighten the regex | Its `sent` leg is stale under the pinned clock, but `getByText(/delivered 1\/2/)` is a SUBSTRING match that still passes. Tighten it so it can actually fail. |

**Any OTHER rollup assertion that goes red is a REGRESSION, not a re-baseline.**
Specifically `:932`, `:949`, `:962`, `:976`, `:991`, `:1021` must stay green
untouched. If one fails, stop and diagnose; do not edit it.

Gate S3: typecheck + dashboard suite.

---

## S4 - The ticker

### S4.1 The hook

Per D-c: hosted by `Timeline`, one interval per thread, bumping a `now` that
reaches bubbles by the existing prop path.

Run condition, all three clauses required: at least one rendered outbound leg is
non-terminal AND eligible to age AND not yet stale. The middle clause is
load-bearing - without it the interval never stops for the very legs the human
decided stay silent. Coarse interval (order of a minute), visibility-gated per
`GroupTextView.tsx:152-166`, cleaned up on unmount, no network.

**A bubble whose clock is WITHHELD contributes nothing to the run condition**
(D-c2). An imported row (D-b) has no clock, so every one of its legs is
non-terminal and can never become stale - which satisfies "non-terminal AND not
yet stale" for ever and would spin the interval permanently on exactly the
fixture S3.3 now requires. "Eligible to age" must be evaluated against the SAME
withheld clock the rows use, not against the slot shape alone. This is the third
distinct way this run condition has failed to terminate; test it.

### S4.2 Tests

Release the `Date` pin then install fake timers - `vi.useRealTimers()` then
`vi.useFakeTimers()`, the sequence `dashboard/src/test/setup.ts:27-30`
documents. Do NOT suppress the ticker under test.

**RESTORE THEM.** An `afterEach` in the ticker's describe block must call
`vi.useRealTimers()` and let `setup.ts`'s `beforeEach` re-pin. Leaving fake
timers installed wedges every `waitFor` in the rest of `Timeline.test.tsx`,
which is 1600+ lines and mostly async. Prefer putting these tests in their own
file beside the others (the repo already splits Timeline coverage by topic -
`Timeline.mms.test.tsx`, `Timeline.email.test.tsx`) so the blast radius of a
timer mistake is one small file.

Prove:
- a not-yet-stale leg escalates after advancing past the boundary, with no
  refetch and no re-mount (this proves spec acceptance 2);
- the interval STOPS once every eligible leg is stale;
- a thread of only terminal legs schedules nothing;
- **a thread whose only non-terminal legs are INELIGIBLE schedules nothing**
  (spec acceptance 3a).

**Observable for the three absence proofs:** do NOT use `vi.getTimerCount()` -
it is polluted by `CallCard`'s own timer and by RTL internals. Spy on
`window.setInterval` and assert it was not called, or assert behaviourally that
advancing a long way leaves the rendered chip text unchanged. Name which you
used in the test title.

Gate S4: typecheck + dashboard suite.

---

## S5 - The other surfaces, then e2e

### S5.1 Component tests

- `GroupTextView.test.tsx`: one group-text-keyed case. That file uses bare
  `vi.fn()` re-armed via `mockReset().mockResolvedValue()` in `beforeEach`, with
  `cleanup()` BEFORE `restoreAllMocks()` in teardown. Re-arm every mock you
  touch or adopt the `AnyAsyncMock` form from `ConversationDetail.test.tsx:34-47`.
  Getting this wrong reproduces `conversationdetail-members-mock-suite-flake`.
- `ConversationDetail.test.tsx`: one relay-arm case. Zero delivery-chip coverage
  today.

### S5.2 E2E

Spec file: extend `e2e/tests/dashboard-next/group-text-reply-all.spec.ts` or add
a sibling in the same directory. Product: NATIVE GROUP TEXT, because that is
where a stalled leg is armable end to end. Recipe:

1. reseed, dev-login, open the group thread;
2. arm one member's line with
   `setDeliveryOutcome(request, { partyNumber, profile: { kind: 'stall' } })`
   (`e2e/fixtures/fakeTwilio.ts:258`) - it stalls at `sent`;
3. send from the composer;
4. reveal the bubble by clicking it;
5. assert via `getByRole('list', { name: 'Delivery by recipient' })` and its
   `listitem`s (D-d) that the delivered member and the stalled member are named
   with the right states.

Staleness stays in the unit layer - 15 real minutes is not an e2e. A leg stuck
at `queued` cannot be armed through the fixture's documented signature (it
exposes `failState` while the engine's option is `stallAt`); do not add a seam.

Do NOT add a stale fixture to the `lean` profile - it is the byte-stable e2e
world.

**Rev 1's instruction to scope the two `group-text-stop.spec.ts` locators is
WITHDRAWN.** It was premised on rows sitting in the DOM permanently. The
conditional render removed that: no test in that spec reveals a bubble, so no
row exists there, and the accessible name is an ATTRIBUTE which `getByText`
does not match. Leave those locators alone unless a run actually shows a
collision.

Add a `selectors.md` row for the new list and for the bubble reveal; neither is
documented today.

### S5.3 The five surfaces in a browser

Spec acceptance 7. **Use the hermetic interactive lane and nothing else:**
`npm run e2e:session` from THIS worktree, then drive it with the Playwright MCP.
Never `:5174` / `:8080` - those are the human's live stack and AGENTS.md forbids
touching them.

No seed carries `delivery_recipients`, so create the state the same way S5.2
does: arm a stalled leg, send from the composer, then look. Four surfaces must
render the list - relay `ConversationDetail`, `GroupTextView`,
`PlacementConversation`, `TourConversation`. The contact page must render NO
list and be visually unchanged. Do not infer any of the five from "it is the
same component".

Also verify here, because only a browser can: the spec's chip-wrap question -
the longest branch-2 string sharing the revealed meta row with the transport
line (spec S3), and that S6's name is present on the chip while collapsed
(spec S6 consequence 1, that S2 resolution runs unconditionally).

Gate S5: the full four - `npm run typecheck`, `npm test`, `npm run smoke`,
`npm run e2e` - run BARE from the worktree, never piped.

---

## S6 - Issues (any time)

File four, using `docs/issues/_TEMPLATE.md`, then run `npm run issues`:

1. **The inbound half.** Deferred by human decision. Record the reviewer's
   finding that it is cheaper than it looks: the list's gate is independent of
   the rollup, so widening it adds rows only and renders no new chip.
2. **The bubble reveal is not keyboard-reachable.** Pre-existing; this feature
   makes the consequence worse. Note the blocker: the bubble already nests
   interactive children (a Link, a Retry button), so it cannot simply become a
   button.
3. **A relay-observed 21610 keeps the raw code** while the group path translates
   it to `contact_opted_out`, so only the group case is excluded from the
   denominator.
4. **A relay all-opted-out message shows the queued label for ever.** The relay
   fan-out never moves the parent status off `queued`, so the message-level chip
   claims a send is in progress for a message that was sent to nobody. Found
   during this design; pre-existing; not fixed here.

---

## Definition of done

1. All four gates green from the worktree, BARE, with real exit codes quoted.
2. The THREE assertions in the S3.4 census are the only pre-existing delivery
   assertions changed, each with its stated reason in the commit message. (Plus
   `Timeline.test.tsx:570` IF the `role="img"` collision materialises - scoped,
   not deleted.)
3. `deliveryStatus.test.ts:197-201` passes verbatim - the 1:1 rule did not move.
4. Broadcasts are untouched: `broadcastFormat.ts` / `DeliveryBadge.tsx` have no
   diff and their tests pass.
5. Every spec acceptance item has a test or a named browser check.
6. No fake timers escape their describe block.
7. `main` synced ONCE at the final pre-handback step, not chased repeatedly.
8. ASCII-only on every added line (see D-f). Explicit paths on every commit;
   never `git add -A`. A `Co-Authored-By` trailer naming the authoring model.
