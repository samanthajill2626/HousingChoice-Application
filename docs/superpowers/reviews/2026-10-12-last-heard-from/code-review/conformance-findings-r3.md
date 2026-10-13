# Code review round 3 - Reviewer A (SPEC CONFORMANCE) - feat/last-heard-from

Date: 2026-10-13. Tree: a015b937 (fix wave 2 = d790d199..9e22ee6e, plus the
deferral issues). Same brief and rules. Inputs read: `adjudications-round2.md`,
spec 14.7 (`spec:1340-1363`), `.superpowers/review/fixwave2-diff.txt` with the
live files re-read in full (the outcome route `app/src/routes/units.ts:1207-1442`),
`fixwave2-report.md`, `adversarial-findings-r2.md`, the five new
`docs/issues/*` files. The shared Playwright MCP browser was NOT used.

Counts (round 3): BLOCKER 0, MAJOR 0, MINOR 0, NIT 2, plus one ruling on the
fixer's Undo flag. All round-2 items (A R2-1..R2-4, B R2-1..R2-5) are CLOSED;
section 4 has the evidence.

## 1. New findings

### R3-1 NIT (CONFIRMED) - 14.7 makes tour CREATION durable, but not a revival or reschedule

- Where: `app/src/lib/listingSendTour.ts:120` (a non-qualifying tour
  contributes `createdAt` only), spec 14.7 (`spec:1343-1354`), the 14.7 PIN
  (`app/test/listingSendOutcome.test.ts` "a MARK never supersedes").
- What is wrong: D11 (`spec:184-185`) says "A tour created OR REVIVED by a
  PERSON after a decline means the tenant changed their mind". 14.7 quotes it
  with an ellipsis ("a tour created ... by a PERSON") and calls tour
  supersession DURABLE. It is durable only for a creation. A person's
  reschedule or reopen after the decline does supersede it while the tour
  qualifies (its `lastMarkedAt` counts). `lastMarkedAt` is ONE field, though,
  and a later cancel / no-show / not-a-fit overwrites it, so the decline comes
  back. That is exactly the "superseded, then resurrected" shape 14.7 set out
  to remove. It is no longer path-dependent (all revivals go through the one
  PATCH), so it is not R2-1 again. But 14.7's "durable" headline and its claim
  that "a MARK never supersedes on its own" overstate it: here a mark
  UN-supersedes.
- Failing scenario: a tour created 06-20; the tenant declines 07-01; the
  tenant changes their mind and staff reschedule the tour 07-05 - the row
  reads Interested; the landlord cancels 07-10 - the row is Not interested
  again. That drops it from Follow up and unchecks it in Matching.
- Proof: throwaway `app/test/conformanceA3.review-tmp.test.ts` (deleted),
  pure case "R3 probe: a REVIVAL / reschedule ... is NOT durable": reschedule
  -> `effectiveDecline` false; the same tour then canceled -> true. Run:
  `cd app; npx vitest run test/conformanceA3.review-tmp.test.ts` -> 4 passed
  (`.superpowers/review/reviewerA-r3-tmp.log`).
- Smallest fix: (a) cheapest and honest - say in 14.7 and the PIN comment
  that durability covers a CREATION, and that a revival or reschedule
  supersedes only while the tour qualifies, because the model keeps one
  `lastMarkedAt`. Add it to the reversal note for Cameron. (b) A durable
  revival would need the decline itself retired when a person revives or
  reschedules after it (e.g. the tours PATCH clears the pair's stored decline
  in that case). That is a product call; file it beside
  `share-retry-supersedes-decline` if wanted.

### R3-2 NIT (CONFIRMED, docs) - the glossary's "Not interested" did not follow 14.7

- Where: `documentation/GLOSSARY.md:495-496` - "Not interested = a recorded
  decline not superseded by a later send or later tour activity".
- What is wrong: since 14.7, "tour activity" has a narrow meaning. It is a tour
  CREATED after the decline (even one later canceled), or a QUALIFYING tour
  rescheduled or reopened after it. It is never a cancel, no-show or
  not-a-fit mark. A reader of the glossary would count a cancel as activity.
  AGENTS.md asks for the glossary to be updated in the same change when a
  domain definition drifts. (14.7 also overrides 5.4's "a superseded record
  stays on the row" for the Interested path, which now clears even a
  superseded record. That is explicit in 14.7 and section 14 wins, so no
  action is needed there.)
- Smallest fix: one glossary sentence in the terms above (plus R3-1's caveat).

## 2. Re-walk (what is still missed?) - 5.4 as amended by 14.7, and D11/14.7 on every outcome surface

- Every outcome surface derives supersession through the ONE function, fed
  with ALL the pair's tours (no status filter before it): units recipients
  `units.ts:263`; outcome route `units.ts:1328`, judged on the tours as read,
  before the create; contact listings-sent `contacts.ts:1265`; follow-ups
  `followUps.ts:164`; preview labels `broadcasts.ts:484`. The tours reads are
  unfiltered GSI queries (`toursRepo.ts:412-418`). There is no dashboard-side
  derivation: cards, groups, Follow up and Review recipients render the
  server's `outcome` / `declinedContactIds`. The proof that both creating paths
  now agree after a cancel is in section 4.
- Outcome route vs 14.7, line by line - the order is:
  1. create, then `listing_interested` (`:1334-1345`);
  2. compare-and-clear of the decline READ, whatever its effectiveness
     (`:1357-1371`), with the cleared event only when it was effective;
  3. never a 404 from that clear;
  4. one guard that turns any throw after a write into 503 `saved: true`
     (`:1439-1441`);
  5. a throw before any write stays the generic 500.

  The Undo branch's `wrote = hadDecline` (`:1395`) matches 14.7's "an Undo
  with nothing to undo". A compare that loses after a create still counts the
  create as the write; one that loses with no create gives the plain 503 /
  truthful 200. All conform.
- New 409 fall-through copy: there is none by design. A route-mode Interested
  answering 409 `tour_type_required` opens the form path silently - the
  property card's URL form (`ListingDetail` `openTourForm`), the contact
  page's per-row form (`onOpenTourForm`), or Follow up's `tourFormPath`
  (`FollowUpView.tsx:89`). That is D14's own behavior ("the click opens the
  Schedule tour form"), reached late. SendRosterRow shows "Couldn't save - try
  again." only when a host passes no `onOpenTourForm` (`Card.tsx:329`), and no
  host with an Interested button omits it today (ListingDetail passes it for
  every row; ContactDetail always wires it into TenantFile). Conforms.
- Spec-internal consistency of 14.7 with I2 (only the route writes
  `declined`): holds - the compare-and-clear is the same writer. With 5.4: the
  step reversal and the `saved` rule are stated explicitly. With D11 and the
  glossary: R3-1 and R3-2.

## 3. Rulings

- The fixer's flag - Undo clears unconditionally. Ruling: NO CHANGE. The flag
  is CONFIRMED in mechanics: the "R3 probe: Undo ..." case in the throwaway
  above - a re-decline landing between the route's row read and its clear is
  removed. But the server-side window is only the recipient BatchGet (no create
  and no events before the clear, unlike the Interested branch B R2-1 fixed).
  The race that matters - a card loaded with decline D1 while a colleague since
  recorded D2 - is NOT closed by a server-read compare at all, because the
  route reads at request time. The only real fix is for the client to send the
  `declined.at` it displayed (already on the wire for a `not_interested` row,
  `listingSendsRepo.ts` `ListingSendRow.declined`), and to call
  `clearDeclined(..., { expectedAt })`, answering the truth on a lost compare.
  That is a contract addition with low value: last writer wins, and both the
  `listing_declined` and `listing_decline_cleared` events stay on the
  timeline, so the history is honest. Record it (handback or a low issue); do
  not add a server-read compare to Undo - it would look like protection
  without being any.
- A R2-1 reversal (durable supersession): agreed - it removes the
  path-dependence I proved - subject to R3-1's precision note.
- B R2-2 part 1 (Interested clears a superseded record with no event): agreed.
  Under 14.7 the only way a superseded decline can still come back is a
  superseding share that later fails (`spec:539-542`); clearing on an explicit
  Interested closes that too. The removed record's `listing_declined` event
  stays and the `listing_interested` event explains the state, so 5.4's "the
  history lives in the events" still reads correctly.
- B R2-2 part 2, B R2-3, B R2-4, B R2-5, A R2-3 (issues filed), A R2-4 (filed,
  no change), ADV-7 (no issue): agreed.

## 4. Closures

| item | status | evidence |
|---|---|---|
| A R2-1 (path-dependent resurrection) | CLOSED (R3-1 residual) | `listingSendTour.ts:120`; throwaway "A R2-1 closed": Interested-path and Tours-page-path tours, both later canceled, both read `no_reply`; PIN rewritten both ways (`listingSendOutcome.test.ts`, 46/46) |
| A R2-2 (clear throws after create -> 500) | CLOSED | throwaway "A R2-2 closed": 503 `{ error: 'outcome_unavailable', saved: true }`, one tour; fixer pin `listingSendOutcomeApi.test.ts:499` |
| A R2-3 (deferrals untracked) | CLOSED | a015b937: `address-formatter-app-vs-dashboard-split`, `share-retry-supersedes-decline`, `perf-world-lacks-last-heard-from`, `mount-time-clocks-on-long-lived-surfaces`, `contact-card-undo-names-identical` |
| A R2-4 (identical Undo names) | CLOSED as filed | `docs/issues/contact-card-undo-names-identical.md` |
| B R2-1 (post-create clear erases a concurrent decline) | CLOSED | compare-and-clear `listingSendsRepo.ts` (`#declined.#at = :readAt`), route `units.ts:1359`; harness parity; `listingSendsRepo.integration.test.ts` 14/14 on DynamoDB Local; route pins :544, :570, :592 |
| B R2-2 part 1 (clear the read decline whatever its effectiveness) | CLOSED | `units.ts:1357-1371`; pins :356, :373, :397 |
| B R2-2 part 2 (no bare 500 after a write) | CLOSED | `units.ts:1439-1441`; my throwaway above; :499 |
| B R2-3 (Undo with nothing to undo is not `saved`) | CLOSED | `units.ts:1395`; :181 |
| B R2-4 (Follow up resolves from the returned row) | CLOSED | `FollowUpView.tsx:83-85`; `FollowUpView.test.tsx` 22/22 |
| B R2-5 (409 tour_type_required dead end) | CLOSED | `Card.tsx:329`, `FollowUpView.tsx:89`, `listingOutcomeErrors.ts` `isTourTypeRequired`; `SendRosterRow.test.tsx` 22/22, `listingOutcomeErrors.test.ts` 3/3 |

Runs, singly. App:
- `listingSendOutcomeApi` 41
- `listingSendOutcome` 46
- `listingSendTour` 25
- `listingSendsRepo.integration` 14 (no `[dynamoAdmin]` line)

Dashboard:
- `SendRosterRow` 22
- `FollowUpView` 22
- `listingOutcomeErrors` 3

The throwaway ran 4/4 and was then deleted. Logs are in
`.superpowers/review/reviewerA-r3-*.log`. `git status --short` shows none of
my files.

Still owed by the orchestrator (not a finding): the full `npm run e2e` gate
and the self-QA re-run on the fix-wave-2 tip. The outcome route was
restructured under one guard and outcomes changed under 14.7. No e2e asserts
the old resurrection or the "Couldn't save" copy (grep of the three new
specs), so no spec edit is expected.
