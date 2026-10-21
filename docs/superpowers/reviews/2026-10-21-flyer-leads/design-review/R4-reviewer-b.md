# Flyer leads design - adversarial review R4 (reviewer B, final round)

Spec: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md`, revision 4
(@e8fe644f; diffed against rev 3 @845d427a). Also read: the round 3 rulings
in `adjudications.md`.
Read-only: nothing edited, staged, committed or run beyond reads and grep.
Line references are `path:line` in `W:\tmp\flyer-leads`. UNVERIFIED marks a
claim I could not prove from the code.

Verdict: one finding changes what gets built (finding 1). The rest are
wording a zero-context builder needs.

---

## 1. [MEDIUM] The token write does NOT protect the decline refusal: `setDeclined` never changes `shares_op`, so a decline recorded between the read and the write is raced past - the opposite of what rev 4 promises and tests

**What rev 4 says** (spec lines 382-394): the current-decline test "is made
inside the ledger's conditional write, on the same consistent read the token
write is conditioned on ... So a decline recorded concurrently is never raced
past". Section 5 tests it: "This includes the decline landing concurrently
with the write". Section 4 keeps `putShareMemory`'s signature unchanged
(spec line 551).

**The code.**
- `applyShareLedgerEntry` reads the row with `getByKeyConsistent`
  (`shareLedger.ts:183`). The predicate CAN see `declined` and `sentAt` on
  that read: it is the whole item, and both attributes are on it
  (`listingSendsRepo.ts:81-120`).
- The write it decides from, `putShareMemory`, is conditioned ONLY on
  `shares_op` (`#op = :tok`, or `attribute_not_exists(#op)`;
  `listingSendsRepo.ts:341-345`).
- `shares_op` is the SHARE-MEMORY change token, stamped only by
  `putShareMemory` (`:316,323`). The decline writers "touch ONLY `declined`
  and `updated_at`" (`listingSendsRepo.ts:17-20`).
  - `setDeclined`: `SET #declined = :declined, #updatedAt = :now`
    (`:375`).
  - `clearDeclined`: `SET #updatedAt = :now REMOVE #declined` (`:407`).
- The harness fake does the same (`twilioWebhookHarness.ts:3644-3650`).

**The race.**
1. The flyer path reads the row: no decline.
2. Staff click Not interested (`units.ts:1671`), and the write lands; the
   token is unchanged.
3. `putShareMemory` succeeds on the unchanged token.
4. `sentAt` moves past the decline, and `effectiveDecline` stops counting it
   (`listingSendOutcome.ts:47-58`).

The decline staff just recorded is cleared by a public request: the rev 3
defect R3-1 fixed, through the one window the spec says is closed. The
section 5 concurrency test cannot pass against the mechanism as named.

**Implies.** Pick one, and list it in section 4 (the "signature unchanged" line
changes for either):
- (a) `putShareMemory` takes an optional decline expectation, ANDed into its
  ConditionExpression: `attribute_not_exists(declined)`, or
  `declined.at = :readAt` as read. A failed condition re-reads through the
  existing `false` -> re-apply loop (`shareLedger.ts:182-189`). Every other
  caller passes none, so the dev fixture and the broadcast paths are
  unchanged.
- (b) `setDeclined` / `clearDeclined` also stamp a fresh `shares_op`, so any
  ledger write that read the old row loses its condition and re-reads. This
  widens the token's meaning; concurrent broadcast ledger writes then retry
  (bounded by `MAX_REAPPLY`).

Either way, keep the section 5 test, and run it against the real repo in the
conformance suite as well as the fake.

---

## 2. [LOW] "A decline the ledger still counts" is not the test the spec defines: tours are ignored, and a later tour cancellation then strands a sign-up at "No reply yet"

Rev 4 states the test as "a decline at or after its current `sentAt` (a
decline the ledger still counts ...)". These are not the same rule.
`effectiveDecline` also drops a decline once any tour for the pair was created
after it (`listingSendOutcome.ts:47-58`), and that supersession is durable
even after the tour is canceled (`listingSendsRepo.ts:106-118`). The ledger
write has no tour data in hand: tours are not on the row, and
`applyShareLedgerEntry` reads only the row.

So the implementable test is the `sentAt`-only one, and its consequence should
be stated:
- decline, then a tour (outcome Interested), then a sign-up: refused, which is
  harmless while the tour is live;
- after that tour is canceled, the decline stays superseded, the tour signal is
  gone, and the pair reads `no_reply`. It is "waiting" on Follow up
  (`listingSendOutcome.ts:116-131`), although the person signed up - the R2-5
  symptom in this corner.

Accept it as a residual or not, but write the test precisely:
- "the predicate is `effectiveDecline(row, undefined)`" - it reuses the one
  instant rule (`Date.parse`, equal instants effective), not a hand-rolled
  string compare;
- drop the parenthetical "a decline the ledger still counts";
- state the no-`sentAt` case: a pair that stopped counting keeps its
  `declined` record, and `effectiveDecline` with no `sentAt` reads it as
  current, so it refuses. Say that this is intended.

---

## 3. [LOW] Scope the refusal to the `flyer` key explicitly: placed "beside `mayReplace`" in the shared function, it would also refuse broadcast entries

`applyShareLedgerEntry` and `mayReplace` serve EVERY share writer:
- the fan-out, `jobs/broadcastFanOut.ts:1270`;
- the status rollup, `services/shareAttemptOutcome.ts:188`;
- the retry and reconcile jobs;
- the repair script.

A builder who adds the predicate generically refuses the ledger entry of a
broadcast that staff deliberately re-sent to a declined tenant. The text goes
out, but the pair never counts the send. That breaks the last-heard-from rule
that a later counted send supersedes a decline (D11, `listingSendOutcome.ts:44-46`,
GLOSSARY "send outcome"), and it refuses every later delivery receipt for that
share. One sentence: the refusal applies to the `flyer` share key only.

---

## 4. [LOW] A refused flyer write is indistinguishable from a lost one, and nothing logs it

`applyShareLedgerEntry` returns `'refused'` silently. It logs only `'lost'`
(`shareLedger.ts:185,190-193`). After rev 4, `sentRecorded: false` covers five
different causes:
- a current decline;
- an identical-millisecond repeat;
- a lost write;
- a non-tenant/unknown holder;
- a non-shareable unit.

To keep the audit "honest" in a way that helps, record why. For example, add a
`sentSkipped` reason (`'declined' | 'refused' | 'lost' | 'type' | 'unit'`; no
PII) beside `sentRecorded`, and have the flyer path log the decline refusal at
INFO with ids only. If the D6 cap also skipped the pin, the audit row is the
ONLY trace that a declined tenant signed up. The pin and bump still happen
when the cap did not fire, so this is narrow.

---

## Rulings

- **R3-1 (decline loop): direction accepted, implementation contested** -
  finding 1. The refusal rule is right; the race claim is not delivered by the
  token alone.
- **R3-2 (consent prompt residual): concede.** It is stated in D4 with the
  right citation (`smsCompliance.ts:75-87`). Cameron's no-welcome rule
  settles the alternative.
- **R3-3, R3-5, R3-6: concede.** They are stated as written.
- **R3-4 (lost flyer write): concede.** The residual and the separate log line
  are in D7 and section 4. Finding 4 is the complementary refused case.
- **R3-7 (actions and grouping): concede.** "Request a tour" is partner-only
  and eligibility decides the group, matching `Card.tsx:252-254` and
  `listingFormat.ts:345-350`.

## Checked this round and found consistent

- The predicate's inputs (`declined`, `sentAt`) are on the consistent read
  (`shareLedger.ts:183`, `listingSendsRepo.ts:290-295`). Only the write's
  condition is the gap (finding 1).
- The rev 4 D4 residual for a dangling pointer matches `contactsRepo.ts:1301-1312`.
- The rev 4 touch-failure rule ("no increment and no event") is consistent with
  D6.3's ordering.
- The Not eligible filing matches `groupSendRows`' existing order
  (`recipientMissing` first, then eligibility; `listingFormat.ts:345-350`).
