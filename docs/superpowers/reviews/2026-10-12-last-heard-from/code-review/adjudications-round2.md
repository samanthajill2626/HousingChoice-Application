# Code review round 2 - orchestrator adjudications

Date: 2026-10-13. Inputs: `conformance-findings-r2.md` (Reviewer A, continued:
0 / 0 / 1 MINOR / 3 NIT; A-1, A-2, A-3 confirmed fixed) and
`adversarial-findings-r2.md` (Reviewer B, continued, plan-blind: 0 / 0 / 2 MINOR
/ 3 NIT; ADV-2 and ADV-3 confirmed fixed, the ADV-1 comment and pin accurate).
Both reviewers found the round-1 ADV-3 reorder introduced new defects (B R2-1,
R2-2; A R2-2) - the orchestrator's round-1 claim that the reorder "cannot lose
another staff member's decline" was wrong.

## Rulings

- A R2-1 (MINOR) ACCEPTED, and it REVERSES the round-1 ADV-1 ruling. The
  outcome after "decline -> a later tour -> that tour canceled" depended on the
  path that created the tour: the Interested route DELETES the decline record
  (so the pair reads No reply yet / Replied), POST /api/tours does not (so the
  decline came back). Spec D11 says every tour-creating path supersedes, and 5.4
  says a superseded record "stays on the row and is simply ineffective". Both
  readings of the spec cannot hold at once; the one that honors D11's stated
  intent - a person creating a tour after a decline means the tenant changed
  their mind - is DURABLE supersession, which also removes the path-dependence.
  Ruling: `deriveTourActivityAt` counts the createdAt of EVERY tour for the pair
  (qualifying or not) and the lastMarkedAt of QUALIFYING tours only (Reviewer B's
  round-1 "narrow alternative"); a cancel / no-show / not-a-fit MARK never
  supersedes on its own (so canceling a tour BECAUSE of the decline keeps the
  decline effective). Spec amended on-branch as 14.7. The round-1 ADV-1 PIN is
  rewritten knowingly to pin the new rule (both directions). RAISED FOR CAMERON in
  the handback as reversible (one function + its tests).
- B R2-1 (MINOR) ACCEPTED. Compare-and-clear: `clearDeclined` gains an optional
  expected-record condition (`#declined.#at = :readAt`); the Interested branch
  clears only the decline it READ. A lost condition (someone re-declined) skips
  the clear and its event; the re-projection answers the truth. Never a 404 from
  the clear inside the Interested branch (the row was counted at read time).
  The harness fake mirrors the condition.
- B R2-2 (MINOR) ACCEPTED - both parts: (1) Interested clears the decline it
  read WHATEVER its effectiveness (an explicit Interested overrides every earlier
  decline), recording `listing_decline_cleared` only when it was effective;
  (2) any throw after `wrote = true` answers 503 `{ error:
  'outcome_unavailable', saved: true }` (logged), never a bare 500.
- A R2-2 (NIT) - same as B R2-2 (2).
- B R2-3 (NIT) ACCEPTED. The clear branch sets `wrote` from `hadDecline`.
- B R2-4 (NIT) ACCEPTED. FollowUpView resolves an action from the RETURNED row
  (`row.outcome`, `row.tour`), not from the outcome it asked for.
- B R2-5 (NIT) ACCEPTED. A 409 `tour_type_required` on a route-mode Interested
  click falls through to the form path (SendRosterRow calls `onOpenTourForm` when
  the host gives one; FollowUpView navigates to the property form URL) instead of
  a dead-end "try again".
- A R2-3 (NIT) ACCEPTED. File the deferrals in docs/issues (orchestrator, after
  the fix wave): the app/dashboard address-formatter split (A-2), a share retry
  superseding a decline (ADV-4), the performance world lacking a derived last
  heard from (ADV-5), mount-time clocks on long-lived surfaces (ADV-6), and
  identical Undo accessible names on a contact page's Properties sent rows (A
  R2-4). ADV-7 stays a deliberate mirror (no issue).
- A R2-4 (NIT) FILED, no change: on a contact page every row is the same contact,
  so the Undo buttons share one accessible name (`Undo not interested for
  <name>`, the copy table's exact string, pinned by e2e); the Mark buttons carry
  the address. A copy change that adds the address is a follow-up.
- Self-QA disclosure (A): Reviewer A used the shared MCP browser page at
  22:00:38Z while the orchestrator's section-6 pass was running. That pass
  starts every surface with its own `page.goto` and its readings were coherent
  with the fixtures; it is re-run anyway on the post-fix-wave-2 tip (the outcome
  route changed).

## Re-review

Both reviewers are continued once more on the fix-wave-2 diff with the same
four-part charge (what was missed; the fix diff cold; challenge rulings; closures).
