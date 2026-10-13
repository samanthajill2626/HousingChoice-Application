# Code review round 3 - Reviewer B (adversarial, plan-blind) - feat/last-heard-from

Scope: fix wave 2 (d790d199..9e22ee6e, `.superpowers/review/fixwave2-diff.txt`, read
with `git diff -w`) cold, plus a re-sweep of every reader of
`deriveTourActivityAt` / `effectiveDecline` and every caller of `clearDeclined`.

Readers re-swept:
- units recipients, `app/src/routes/units.ts:263`;
- contact listings-sent, `app/src/routes/contacts.ts:1265`;
- follow-ups, `app/src/services/followUps.ts:164`;
- preview labels, `app/src/routes/broadcasts.ts:484`;
- the outcome route, `units.ts:1328`.

`clearDeclined` callers: `units.ts:1359` (compare-and-clear) and `units.ts:1389`
(Undo, unconditional). No other caller exists in app/src or app/scripts.

Also checked: every tour writer that can move a pair's `createdAt`. There are only two
creators (POST /api/tours and the outcome route). There is no tour delete route, and
the tour PATCH allowlist (`app/src/routes/tours.ts:159`) cannot change `tenantId`,
`unitId` or `createdAt`, so tour supersession cannot be undone by a later tour edit.

Method: one throwaway file, `app/test/adv-r3.review-tmp.test.ts`, was run singly
(`.superpowers/review/adv-r3-run1.txt`, 6/6 passed) and then deleted;
`git status --short` is clean. Only `adjudications-round2.md` was read among the
records. The shared Playwright browser was not used.

Counts: BLOCKER 0, MAJOR 0, MINOR 1 (new), NIT 1 (new). Closures: R2-1 through R2-5 are
all real.

---

## 1-2. New findings

### R3-1 - MINOR - CONFIRMED (also my challenge to the "Undo stays unconditional" flag)

**Undo (`clear`) is still an unconditional REMOVE, so it erases a decline another
staff member records while the Undo is in flight. In one shape it does this silently:
no event, and not counted as a write.**

Where: `app/src/routes/units.ts:1388-1395`. `hadDecline` is judged on the row read at
the top of the request. `clearDeclined(unitId, contactId)` (`:1389`) then removes
whatever is stored at write time, and `wrote = hadDecline` (`:1395`). This is the same
lost-update class as R2-1, which was accepted as MINOR and fixed for Interested only.

Interleavings, proved in the harness world. Staff B's `setDeclined` was injected
between the Undo's row read and its clear, through the recipient read that sits
between them:
- **(a) A read D1 and Undoes it; B re-declines (D2).** D2 is removed. The events are
  `["listing_decline_cleared"]` (for D1), and the answer is 200 `no_reply`. B's own
  `listing_declined` event is left on the timeline, contradicting the state.
- **(b) A read NO decline** (A's page was stale: someone already undid it) **and B
  declines meanwhile.** B's decline is removed with NO event at all, the answer is 200
  `no_reply`, and `wrote` is false. A late 503 would therefore say "Couldn't save -
  try again" although a decline was deleted.

Proof (`adv-r3-run1.txt` R3-1a, R3-1b): stored `declined` is undefined after both.
Events were `["listing_decline_cleared"]` and `[]` respectively.

Smallest fix (reuses wave 2's primitive):
- When `hadDecline`, pass `{ expectedAt: row.declined.at }`.
- When `!hadDecline`, write nothing and go straight to the re-projection.
- Treat a lost compare like the Interested branch does: no event, no 404, and the
  re-projection answers the truth. A row that stopped counting still re-projects to
  the plain 503.

### R3-2 - NIT - CONFIRMED (code reading)

**"Durable" supersession is not durable across a contact-type change.**

Where: `app/src/lib/listingSendOutcome.ts:74-76`. A non-tenant recipient reads no
tours, so `tourActivityAt` is dropped entirely.

Scenario: tenant declines, a tour is created afterwards (superseded, per spec 14.7),
and later the contact is converted to a caseworker (partner). The pair reads "Not
interested" again: on the property card, on the Follow up list, and in the preview
labels. The new header (`app/src/repos/listingSendsRepo.ts:109-118`, "stays
superseded ... whichever path created it") does not hold on this path. It is rare,
and it is how the B11 rule ("a non-tenant never reads a tour") interacts with 14.7.

Fix, if wanted: let a non-tenant read the tour createdAt for supersession only (still
never the signal). Alternatively, scope the header claim to tenant recipients.

Cold-review items checked and judged sound:
- The compare-and-clear condition (`listingSendsRepo.ts` clearDeclined): it aliases
  `#at` and binds `:readAt` only when used. An absent record fails the comparison. Its
  fake (`app/test/helpers/twilioWebhookHarness.ts`, clearDeclined) answers the same.
  Both are held by the new DynamoDB Local integration cases (stale `at`, absent
  record, uncounted row, clear-once).
- The try-guard (`units.ts:1439-1441`) rethrows when nothing was written, so a
  pre-write failure (requireTenantContact, a create that throws) stays the generic
  500. A post-write throw becomes a logged 503 `saved: true`, guarded by
  `res.headersSent`. `wrote` turns true only after a resolved create, an
  `ok` setDeclined, an `ok` compare-and-clear or an Undo that read a decline.
  Nothing else in the guarded region can throw after a write except the clear and
  the projection: event writes are best-effort, and the re-read has its own catch.
  The one wrong `wrote` is R3-1(b).
- The 409 `tour_type_required` fall-through: `ApiError.code` is the body's `error`
  (`dashboard/src/api/client.ts:74-80`), so `isTourTypeRequired` is live on both
  surfaces. SendRosterRow falls back to the error line when there is no form host.
- FollowUpView resolves from `row.outcome` / `row.tour`. A waiting answer unresolves
  the row and keeps its actions.
- No test was weakened. The two "knowing rewrites" (the FollowUpView mocks now return
  real outcomes, and the 14.7 pin) assert more than before.

## 3. Rulings

- **"Undo still clears unconditionally" (fixer's flag): challenged.** See R3-1. The
  primitive already exists, and leaving Undo outside it keeps a silent, event-less
  deletion path (b).
- **Durable supersession (my round-1 alternative, adopted as spec 14.7): agreed.**
  It removes the path-dependence Reviewer A found. Two residues remain: R3-2, and
  the accepted tradeoff that canceling a tour CREATED after the decline (the tenant
  re-engaged, then said no again verbally) leaves the pair Waiting until staff click
  Not interested again. The second is correct under the rule and should be in the
  handback's note to Cameron. The harness proof: a canceled tour created after the
  decline -> `no_reply` (R3-2 case in `adv-r3-run1.txt`).
- **The other round-2 rulings, and the filing of ADV-4/5/6 and A R2-4 as issues:
  accepted.**

## 4. Closures (proved; `adv-r3-run1.txt`)

- **R2-1 - REAL.** B's decline, recorded during A's create (`at` after the tour),
  survives with `staffId: usr_b`. The answer is 200 `not_interested`, and the only
  event is `listing_interested` (R3-c1).
- **R2-2 - REAL, both parts.**
  - A clear that throws after the create answers 503
    `{"error":"outcome_unavailable","saved":true}` with one tour (R3-c2a).
  - The retry answers 200 `interested` and CLEARS the stored decline (R3-c2b).
  - Canceling that tour afterwards reads `no_reply`, not `not_interested` (R3-c2c).
- **R2-3 - REAL.** An Undo with nothing to undo and a failed re-read answers the plain
  `{"error":"outcome_unavailable"}` (R3-c3). The exception is R3-1(b), where something
  WAS removed.
- **R2-4 - REAL.** Verified by code reading and the new FollowUpView cases. The view
  resolves from the returned row, and a re-declined answer shows Not interested + Undo.
- **R2-5 - REAL.** Verified by code reading and the new SendRosterRow / FollowUpView
  cases. A 409 `tour_type_required` opens the form path with no error line on both
  surfaces.
