# Slice 5a - the relay 30003 override

Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.
Base for this step: `5305c7f0` (main already merged at `8c8b7100`; no further
sync performed). Dashboard-only, plus one harness doc line. No `app/src` change.

Commits:

- `9c5cfe7d` feat(dashboard): stop promising a retry on relay legs that failed 30003
- `1c72d172` test(dashboard): pin the relay 30003 override, and every position it must not reach
- `f1347e3b` docs(e2e): record the product-dependent 30003 row string
- (this report, committed separately)

---

## 1. What shipped

### `dashboard/src/routes/contact/deliveryStatus.ts`

- `:610-612` - the new `RELAY_ERROR_CODE_REASONS` map, one entry. Its header
  comment (`:588-609`) states D19 (no relay retry exists, so the promise is false
  in both worlds), D20 (why this is scoped by product instead of edited into
  `ERROR_CODE_REASONS`), and why the carrier code is kept while the promise is
  dropped.
- `:619-627` - `DeliveryReasonOptions` gains `relay?: boolean` beside `media`,
  each with its own doc line. `RelayDeliveryOptions extends
  DeliveryReasonOptions` already, so the rollup's options bag carries the flag
  with NO signature change to `presentRelayDelivery` and no change to the
  `deliveryReason` call inside it.
- `:694-707` - the `??` chain in `deliveryReason`, now three arms, with the
  order argued in a comment directly above it.

**The exact relay 30003 string, verbatim, is the map value:**

    Phone unreachable

**What an operator reads** (the template at the end of `deliveryReason` appends
the tail; nothing in this slice appends anything):

    Phone unreachable (error 30003)

On a row that is `Undelivered - Phone unreachable (error 30003)`; on the rollup
`delivered 1/2 - 1 failed - Phone unreachable (error 30003)`; in the recital
`Lars Landlord: Undelivered, Phone unreachable (error 30003).`

Separator: a plain ASCII hyphen everywhere it appears, supplied by `chipText`.
The shipped 1:1 entry's U+2014 EM DASH was NOT copied into any new line, and
that entry is byte-untouched.

**Precedence as shipped, in the `mapped` chain:**

1. `MMS_ERROR_CODE_REASONS` when `opts.media === true`
2. `RELAY_ERROR_CODE_REASONS` when `opts.relay === true`
3. `ERROR_CODE_REASONS`

`INTERNAL_CODE_REASONS` still early-returns ahead of all three, so slice 5b's two
codes are unaffected by either flag - asserted, not assumed.

### `dashboard/src/routes/contact/Timeline.tsx`

- `:867` - `isRelayLeg`, ONE derivation from `rosterKind` inside `MessageBubble`,
  feeding both leg-scoped sites below. The same argument the single `isMms`
  already makes for media, and the mechanical half of D21.
- `:914` - the rollup call (`presentRelayDelivery`) gains `relay: isRelayLeg` in
  the options bag it already builds.
- `:1068` - the per-recipient row's `deliveryReason` call gains
  `relay: isRelayLeg`.
- `:587` - `recipientSummaryName` (the accessible-name recital) passes
  `relay: rosterKind === 'relay'`; it takes `rosterKind` as a parameter already.
- `:862` - the message-level chip is UNCHANGED, and now carries a comment saying
  the omission is a decision, not an oversight: this site reads the MESSAGE's
  `error_code`, and the only code that reaches it is the native-group-text
  aggregate, whose retry is real.
- `:1413` (`EmailCard`) and `DeliveryBadge.tsx` are untouched; neither has a
  product input, which is what makes "none" free at those sites rather than
  something to guard.

The six-site table as built matches the plan exactly: three overridden, three
not.

---

## 2. The positions, each proven

| # | position | site | test file : line : name |
|---|---|---|---|
| 1 | relay rollup chip | `deliveryStatus.ts:416` | `deliveryStatus.test.ts:386` "drops the retry promise from a RELAY rollup, keeping the carrier code"; component-level in `Timeline.delivery.test.tsx:471` |
| 2 | accessible-name recital | `Timeline.tsx:587` | `Timeline.delivery.test.tsx:471` - the `toHaveAccessibleName` assertion inside it |
| 3 | per-recipient row | `Timeline.tsx:1068` | `Timeline.delivery.test.tsx:471` - the revealed-row assertion inside it |

Positions 1, 2 and 3 are asserted in ONE test on purpose (`:471`, "drops the
retry promise on a RELAY 30003 leg at all three positions, code intact"). D21
says a partial fix is worse than none; a test that could go green with one
position fixed would not be testing D21 at all. The rollup and the recital are
read before the reveal, the row after it.

The negative is page-wide in that test (`queryByText(/will retry/)` absent),
which is also the F4 pin: it covers `Timeline.tsx:862`, the message-level chip,
against ever picking a code off a SLOT. Research F4 is right that the site's
safety otherwise rests on data facts in files this branch does not edit
(`services/groupDelivery.ts` propagates a leg's code to the message row for
NATIVE GROUP TEXT only), so it is now pinned by behavior rather than asserted in
a table.

**What must NOT change, each with its own case:**

| exclusion | test |
|---|---|
| native group text (D20) | `Timeline.delivery.test.tsx:516` "keeps the retry promise on the SAME leg in a native GROUP TEXT" - identical slot map, EXPLICIT `rosterKind: 'group_text'` through `<Timeline>`, all three positions |
| base map, no product input | `deliveryStatus.test.ts:694` "keeps the retry promise everywhere else - 1:1 and native group text" |
| message-level chip (`:862`) | `Timeline.delivery.test.tsx:577` "leaves the MESSAGE-LEVEL chip on the base copy, relay default notwithstanding" - a failing bubble with no roster map, in a timeline whose `rosterKind` defaults to relay |
| EmailCard (`:1413`) | `Timeline.email.test.tsx:96` "keeps the BASE 30003 copy on an outbound email failure" (new `describe('EmailCard (outbound delivery chip)')` - the file's existing block is inbound-only) |
| broadcast badge | `StatChips.test.tsx:127` "keeps the retry promise on a broadcast recipient 30003 - the override is relay-scoped" |
| every other code on a relay leg | `deliveryStatus.test.ts:725` "leaves every OTHER code alone on a relay leg" (30005, 30006, 30007, 21610, unmapped, and a 5b internal code) |

The group-text pin is written the way research F1 demands: THROUGH `<Timeline>`
with an explicit `rosterKind`, never by rendering `MessageBubble` directly.
`rosterKind`'s operative default is the `Timeline` component's own destructuring
default - `MessageBubble`'s is dead in production because `Timeline` passes the
prop unconditionally - so a pin written against `MessageBubble` would prove
nothing about the product.

The badge case is NEW rather than a strengthening of the existing "appends the
Twilio error reason on a failure", which asserts `/Phone unreachable/i` - a
substring BOTH copies satisfy, so it could not have caught a leak.

**Precedence [RULING F2], pinned three ways:**

- `deliveryStatus.test.ts:708` "lets the MEDIA hedge win over the relay override
  on an attachment leg" - 30005 and 30006 with BOTH flags set.
- `deliveryStatus.test.ts:717` "falls through the media map to the relay override
  for a 30003 attachment leg" - the other half: the media map holds no 30003, so
  a relay MMS leg lands on the relay copy, not on the base.
- `Timeline.delivery.test.tsx:544` "keeps the MMS hedge on a relay ATTACHMENT
  leg, and still overrides its 30003" - one rendered relay MMS bubble carrying
  both codes at once. This is the CALL-SITE half: the flags are handed over
  together at three places, and adding `relay` must not displace `media`.

The sets are disjoint today, so no shipped behavior depends on the order - which
is why it is a test rather than a comment. `deliveryStatus.test.ts:799` (the
`Object.prototype` sweep) gained a relay pass: the new map is a bare object
literal too, and read with `map[code]` it would hand a relay leg a function
where the signature promises a string.

---

## 3. TDD - the RED run

Tests were written first and run against the un-flagged presenter.

    .superpowers/gates/s5a-red.log   exit 1
    Test Files  2 failed | 2 passed (4)
    Tests  5 failed | 123 passed (128)

The five RED failures were exactly the five cases that require the override; the
control cases (group text, email, badge, media-wins) were green from the start,
which is what they are for. From the log, the rendered relay row before the fix:

    Undelivered - Phone unreachable <U+2014> will retry (error 30003)

Implementation then landed and all four files went green.

---

## 4. Gates

Fast gates only, per the slice dispatch. No `npm test`, no `npm run e2e`.

    npm run typecheck  (worktree root)                exit 0
      .superpowers/gates/s5a-typecheck.log - all six workspaces, no diagnostics

    npx vitest run <the four touched test files>      exit 0
      .superpowers/gates/s5a-green.log
      "Test Files  4 passed (4)"
      "Tests  128 passed (128)"

One extra run, not required by the dispatch: the three dashboard route trees that
host every `deliveryReason` consumer, to catch a regression in a file this slice
did not touch.

    npx vitest run src/routes/contact src/routes/broadcasts src/routes/conversation   exit 0
      .superpowers/gates/s5a-neighbours.log
      "Test Files  76 passed (76)"
      "Tests  1381 passed (1381)"

Gate 5 (eslint) was not run: it is the orchestrator's branch-level gate and its
file list is the branch's, not this slice's.

ASCII: every added line across the six files was byte-scanned (`git diff` `+`
lines against `[^ -~]`) - zero hits. Every em dash that an expectation needs is
built with `String.fromCharCode(0x2014)`, named `EM_DASH` where it is used more
than once. NOTE for anyone editing these files: the Edit tool in this session
converted a typed `\u2014` escape into the literal character, so a JS escape is
not a safe way to keep such a line ASCII here - the codepoint call is.

---

## 5. The selectors.md decision - CHANGED, and why

`e2e/support/selectors.md:49` was edited. The reasoning, recorded because the
dispatch asked for the decision either way:

- The documented row SHAPE does NOT change. The line promises "`Failed`/
  `Undelivered` (with the reason and raw code appended)", and a relay 30003 still
  reads exactly that - only the sentence differs. This is NOT the contract break
  slice 5b had to record, where two codes deliberately render with no tail.
- It was still changed, on the precedent inside that same line: it already
  enumerates a PRODUCT-DEPENDENT pair (`Not sent - opted out (Twilio skips them)`
  on a group text versus `Not sent - opted out` on a relay). 30003 is now the
  second such pair, and a spec author arming a 30003 with `setDeliveryOutcome`
  has no other place to learn which sentence to expect on which product.
- The note also states which assertion proves the change - the NEGATIVE, at the
  rollup chip and the accessible-name recital as well as the row - because the
  row is the one position an absence check can pass on vacuously (it is
  conditionally rendered behind the reveal).
- Added text is ASCII: the em dash is written as `+ U+2014 +`, the notation the
  same line already uses for `Sending` + U+2026.

---

## 6. Deviations

**None from the worklist S5a ruling.** The precedence is the ruling's order, the
tail is kept, the em dash was not copied, the group-text pin goes through
`<Timeline>`.

Three judgement calls worth naming:

- **The flag is a boolean `relay`, not a `rosterKind` on the options bag.** It
  mirrors `media` exactly, which is what the plan asked for ("consulted the way
  `media` already selects `MMS_ERROR_CODE_REASONS`"), and it keeps
  `deliveryStatus.ts`'s leaf status - `LegRosterKind` exists in that module, but
  putting a product enum on the shared reason options would invite a second
  product switch inside a function whose whole contract is "code plus hints".
- **Commit order is implementation-then-tests**, matching the branch's precedent
  (slice 5b said the same). The TDD ORDER was honoured in execution and the RED
  is captured in `s5a-red.log`; a knowingly-red commit would poison bisect on a
  shared branch.
- **The `:862` exclusion got a comment as well as a test.** The plan's table row
  says "none", which reads as an oversight to the next editor; the comment says
  it is a decision and gives D20 as the reason.

Not a deviation, but worth stating: three production callers inherit the
override by omitting `rosterKind` - the relay conversation view and the
relay-group tabs on the tour and placement hubs (research F1). That is intended;
all three are relay views. They are not named in the spec's scope list, so this
report is where it is on the record.

---

## 7. What slice 7's e2e must assert

The spec's e2e line is "a relay leg that failed 30003 shows no retry promise".
Concretely, and all of it is required:

1. **Three positions, not one.** The rollup chip, the accessible name on that
   same chip, and the per-recipient row. D21's whole content is that they cannot
   be allowed to disagree, so a spec asserting one of them does not test D21.
2. **The reveal, before the row assertion.** The row list is conditionally
   rendered on a bubble-local `revealed` toggled by a click on the bubble BODY
   (a bare `div`, no role, no name, no test id). An absence assertion written
   without the click passes on a completely broken build - assert
   `toHaveCount(0)` on the list first, then click the body text, exactly as
   `group-text-per-recipient-delivery.spec.ts` already does.
3. **The NEGATIVE is the proving assertion**: `not.toContainText('will retry')`
   at all three positions. A spec that only asserts the new copy is present at
   one position leaves the D21 contradiction reachable.
4. **The tail must be asserted PRESENT**: `(error 30003)` at all three. Half of
   this change is that the carrier code survives; a test that only checks the
   promise is gone would stay green if someone later moved 30003 into
   `INTERNAL_CODE_REASONS`, which would silently delete the code an operator
   needs.
5. Arming: `setDeliveryOutcome` is keyed on the DESTINATION and consumed ONCE, so
   on the lean lane via `createGroupOpen` the create-time intro fan-out must
   SETTLE first or it eats the armed profile.

No group-text e2e is owed by this slice - the exclusion is pinned at unit level
through `<Timeline>` with an explicit `rosterKind`, which is the same component
path the browser runs.
