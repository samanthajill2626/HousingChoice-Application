# Code review round 2 - Reviewer B (adversarial, plan-blind) - feat/last-heard-from

Scope: the round-1 fix wave 177bae7a..72c522f0 (`.superpowers/review/fixwave1-diff.txt`),
read cold, plus a re-sweep of every consumer and mutator of what it touched: the
outcome route's write order and its 503 shape (`app/src/routes/units.ts`,
`dashboard/src/lib/listingOutcomeErrors.ts`, SendRosterRow, FollowUpView), the
follow-ups contacts read (`app/src/services/followUps.ts`, RECIPIENT_PROJECTION), the
FollowUpView heading name (and the e2e `groupFor` that matches it), and the contact
header facts layout. Read-only besides one throwaway file,
`app/test/adv-r2.review-tmp.test.ts` (run singly twice, then deleted; outputs
`.superpowers/review/adv-r2-run1.txt`, `adv-r2-run2.txt`). `git status --short` is
clean afterwards. The only other file read is `adjudications-round1.md`.

Counts: BLOCKER 0, MAJOR 0, MINOR 2 (both new, both introduced by the ADV-3 reorder),
NIT 3 (new). Round-1 closures: ADV-2 closed, ADV-3 closed for the case it named,
ADV-1 comment and pin accurate (with the challenge in section 3).

---

## 1-2. New findings (the fix diff read cold, and the re-sweep)

### R2-1 - MINOR - CONFIRMED

**The post-create clear is unconditional, so it erases a decline another staff member
writes WHILE the tour is being created. The adjudication's claim that the new order
"cannot lose another staff member's decline" is false.**

Where: `app/src/routes/units.ts:1307` decides `declineEffective` from the row read at
the top of the request; `:1313` creates the tour (plus the listing_interested
activity and audit writes); `:1330` then calls `clearDeclined`, which removes whatever
`declined` is stored at that moment (`app/src/repos/listingSendsRepo.ts:386`: REMOVE
`declined`, with no condition on the record the click read).

Interleaving: A's row shows the pair declined (record D1). A clicks Interested: A reads
the row, sees D1 effective, and starts `tours.create`. B, on another screen, clicks
Not interested: `setDeclined` writes D2, timestamped after A's tour. A's clear then
removes D2. Final state: Interested, with no decline stored. B's `listing_declined`
event sits on the timeline, but the state no longer shows it. The old order (clear
first) left D2 standing in this same interleaving, because A's tour `createdAt` was
older than D2. The reorder widens the lost-update window from "between read and
clear" to "the whole create plus two event writes".

Proof: the harness `toursRepo.create` was wrapped to run B's `setDeclined` (at now+1s)
after the real create and before returning. The POST came back 200 with outcome
`interested`. Stored `declined` was undefined. Events were
`["listing_interested","listing_decline_cleared"]` (`adv-r2-run1.txt`, R2-1).

Smallest fix: compare-and-clear. Pass the decline the click read
(`row.declined.at`) to `clearDeclined` as a condition (`#declined.#at = :readAt`). A
lost condition means someone re-declined: skip the clear and the event, and let the
re-projection answer the truth (`not_interested`).

### R2-2 - MINOR - CONFIRMED

**A clear that THROWS after the create answers a bare 500 although the tour was
written. The copy says "Couldn't save - try again.", the retry never clears the
decline, and under the ADV-1 rule that decline comes back when the tour is
canceled.**

Where: `app/src/routes/units.ts:1330`. A thrown `clearDeclined` escapes the handler.
The `wrote` flag (`:1314`) only shapes the late 503 (`:1386`), so a mid-branch throw
gets the generic 500. The route comment at `:1225` justifies the reorder with "a
failed clear after a create leaves a tour whose createdAt already supersedes the
decline". The ADV-1 pin (`app/test/listingSendOutcome.test.ts`, "ADV-1 PIN") says
that supersession lasts only while the tour qualifies.

Scenario: a DynamoDB throttle on the clear. Staff see "Couldn't save - try again." and
retry. The retry finds the new tour (GSI permitting), judges the stored decline
ineffective, and so writes nothing: 200 Interested, with the decline still stored.
Weeks later the landlord cancels the tour, and the pair flips back to "Not
interested". That undoes the explicit Interested click. If the retry lands inside the
byUnit GSI lag, it instead creates a SECOND tour (the I3 shape, now provoked by our
own error copy).

Proof (`adv-r2-run1.txt` R2-2, `adv-r2-run2.txt` R2-2c):
- `clearDeclined` throws: the response is 500 `{"error":"internal server error"}`, no
  `saved`, one tour written, events `["listing_interested"]`.
- With the clear restored, the retry answers 200 `interested`, and the stored
  `declined` is still `{"at":"2026-07-01...","by":"staff"}`.
- After the created tour is set to `canceled`, GET recipients reads `not_interested`.

Smallest fix: two parts.
1. In the Interested branch, clear any STORED decline whenever one exists (an explicit
   Interested click overrides every earlier decline). Record `listing_decline_cleared`
   only when it was effective. A retry then repairs a failed clear, and the ADV-1
   resurrection cannot follow an explicit Interested.
2. Catch a throw after `wrote = true` and answer 503 `saved: true`, so the copy
   reads "Saved - reload to see the change." and no retry is invited.

### R2-3 - NIT - CONFIRMED

**`saved: true` on a clear that changed nothing.**

Where: `app/src/routes/units.ts:1368`. The clear branch sets `wrote = true` whenever
`clearDeclined` answers 'ok'. That includes a row with no decline: the repo's REMOVE of
an absent attribute plus `updated_at` succeeds. A late 503 then tells staff "Saved -
reload to see the change." when nothing changed. This sits outside A-3's stated intent
("only when the click wrote").

Proof: an Undo on a row with no decline, with the re-read forced empty, answered 503
`{"error":"outcome_unavailable","saved":true}` with no events (`adv-r2-run1.txt`
R2-3).

Fix: set `wrote` from `hadDecline` on the clear branch.

### R2-4 - NIT - CONFIRMED (code reading; round-1 miss)

**FollowUpView throws away the re-projected row and assumes the outcome it asked
for.**

Where: `dashboard/src/routes/broadcasts/FollowUpView.tsx:79-80`. On a 200 it resolves
the row as `interested` or `not_interested` from the REQUEST, reading only `row.tour`.
The route returns the re-projected row so that callers show the truth. SendRosterRow
hosts (ListingDetail, ContactDetail) apply it.

Scenario: the R2-1 interleaving seen from B's side, or any clock-ordered race. The
server answers `not_interested` (or `interested`), while the Follow up row shows the
other chip until reload.

Fix: resolve from `row.outcome` (and `row.tour`), not from the request.

### R2-5 - NIT - CONFIRMED (code reading; round-1 miss)

**A route-mode Interested click whose property lost its `tour_type` since the page
loaded is a dead end.**

Where: the server answers 409 `tour_type_required` (`app/src/routes/units.ts`, the
Interested branch). `outcomeErrorCopy` maps every non-saved error to "Couldn't save -
try again." (`dashboard/src/lib/listingOutcomeErrors.ts`). Both call sites
(`dashboard/src/routes/broadcasts/FollowUpView.tsx:130` and
`dashboard/src/routes/contact/Card.tsx:357`) keep calling the route.

Consequence: every retry fails the same way until a reload switches the row to form
mode.

Fix: on 409 `tour_type_required`, fall through to the form path (FollowUpView already
knows the URL, and SendRosterRow has `onOpenTourForm`), or give it its own copy.

Not raised: the typeless-contact skip (`app/src/services/followUps.ts:156`). Type is a
required index attribute (`contacts.update` refuses to remove it), so no real row
reaches it; the comment states the skip. The facts-line flex change has no other
`.facts` rule or consumer in the module, and the e2e `groupFor` still matches
`^<line1>` under the new `aria-label`.

## 3. Rulings challenged

- **ADV-1, kept as specified.** I accept the literal reading of spec 5.4. The ruling
  is not independent of the ADV-3 fix, though. The reorder's own justification
  (`units.ts:1225`) relies on tour supersession being durable, and the pin says it
  is not. R2-2 shows the combined effect: an explicit Interested click can leave a
  decline that later resurrects. Whatever Cameron decides on the narrower
  alternative, the R2-2 fix (clear any stored decline on Interested) is needed under
  the current rule.
- **NO CHANGE list (ADV-4..ADV-7): accepted** as recorded. These are spec-anchored or
  deliberate mirrors, and the rationale given is accurate.

## 4. Are the round-1 fixes real?

- **ADV-2: real, CLOSED.** `buildFollowUps` now reads through
  `getRecipientDisplaysByIds(ids, { requireComplete: true })`. I checked every
  attribute it reads against RECIPIENT_PROJECTION (`app/src/repos/contactsRepo.ts`,
  the projection block): firstName, lastName (`contactDisplayName` reads only these
  two), phone, type, role, status, deleted_at, sms_opt_out, sms_unreachable and
  last_heard_from_at are all present. The test fake now projects to exactly those
  attributes and fails on any whole-item read. The 503 contract holds: an
  `IncompleteBatchReadError` still rejects.
- **ADV-3: real for the case it named, CLOSED.** A failing create leaves the decline
  and the timeline untouched: re-run proof answered 500, stored `declined` intact, no
  events (`adv-r2-run1.txt`, R2-A). It introduces R2-1 and R2-2 above.
- **ADV-1 comment and pin: accurate.** The `listingSendsRepo.ts` header now matches
  behaviour. The pin runs on the real `deriveTourSignal` and `deriveTourActivityAt`
  (not a reimplementation) and covers canceled, no_show and closed-not-a-fit.
- **Weakened tests: none.** The two rewritten pins (the event-order test, and the
  FollowUpView heading assertions) are explicitly marked as knowing rewrites, and
  both still assert content.
