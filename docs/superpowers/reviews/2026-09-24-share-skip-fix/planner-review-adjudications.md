# Planner's independent review - adjudications (share-skip-fix Branch A)

Date: 2026-09-25. Branch tip reviewed: `3abc9796` (source `813c0c44`, main
merged). Two reviewers dispatched by the planner after the orchestrator's
handback: spec-conformance (`planner-review-conformance.md`, 6 findings,
17 of 18 items DELIVERED) and plan-blind adversarial
(`planner-review-adversarial.md`, 14 findings). Both READ-ONLY. The planner's
own gate runs on `3abc9796` (`.superpowers/planner-gates/`): typecheck 0,
smoke 0, npm test 0 (369/191/21/34/13 files, 0 `[dynamoAdmin]` lines), e2e 0
(278 passed, 20.0m), eslint exit 1 = the 14 pre-existing errors in the same
five files the handback baselines.

Verdict shape: no BLOCKING finding from either reviewer; one planner fix wave
(below), then the gates again, then the UI eyeball, then the merge verdict.

## Conformance findings

- C1 (MEDIUM) - the handback lacks the D1 census numbers; the claim-mismatch
  count sizing the phone-claim issue was never captured. ACCEPT: the verbatim
  prod apply line and the zero-rungs census reading are now committed in
  `cameron-runs-2026-09-25.md`; the census line is recorded as lost (scrolled
  out of the terminal) and a read-only re-run was offered to Cameron, not
  required. The dev runs are recorded as done, numbers not captured.
- C2 (LOW) - send-counter trip evidence is wider than the spec's audit-event
  definition. ACCEPT (precision): spec D1/D2 now state the widening and the
  invariant it rests on (v11). No code change.
- C3 (LOW) - I3's second clause holds only on D6's two surfaces (the property
  Activity card and the landlord timeline still read "Sent to N tenants").
  ACCEPT as a Branch B note: the B stub's D5(c) now says it must RELABEL, not
  merely recount. No change to A (spec R5-3 rejected widening D6).
- C4 (LOW) - RUNBOOK still says the runs are owed. ACCEPT: the section now
  records both environments DONE 2026-09-25 with the prod counts, keeps the
  procedure for re-runs and breaker resumes, and drops the pinned-worktree
  instruction (run from `main` once merged).
- C5 (LOW) - "share" shorthand in RUNBOOK copy. ACCEPT: "property send".
- C6 (LOW) - the WP2 issue still lists placement nudges among the texts the
  switch stops. ACCEPT: corrected.

## Adversarial findings

- A1 (MEDIUM) - D5 still counts never-attempted / never-delivered FAILED slots
  (no_contact, transient_cap, enqueue_failed, 30007/30005/30006) and a
  stranded share's queued slots; whether a failed tenant counts depends on the
  other recipients. REJECT as a change to A - this IS the interim rule the
  spec records (D5 second bullet, section 8's accepted tradeoff, spec R5) and
  Branch B's attempts rule replaces it; the e2e pins it as interim on purpose.
  ACCEPT the precision part: the repo comment no longer claims "a retry may
  have delivered" in general - it names 30003 as the only retried code and
  the never-delivered codes that count anyway, and points at section 8 and B.
- A2 (MEDIUM) - a person's share failing 30003 on a switched-off thread is
  retried as automated (refused `manual_mode`), reads "will retry", stays
  "Already sent"; the retry drops the I8 recipient. DEFER, already routed:
  the retry path and the 30003 wording are `feat/retry-send-window`'s (its
  relay in the handback names this case); "a retry follows the original
  sender" is WP2 item 3; the population is breaker-tripped rows only after
  the bulk enable. The I8 drop on retry is added to the RSW relay below.
- A3 (LOW) - every dashboard share is a person's send, blasts included: no
  breaker metering, reaches breaker-tripped rows, audited `automated: false`
  with no actor. REJECT (by design): spec D4 says the creator decides,
  Cameron's rule is that staff sends never read the switch; blasts are paced
  by the token bucket; `created_by` on the share carries the actor. Recorded.
- A4 (LOW) - `TransactionConflictException` on a live app write during the
  apply is not retried by the SDK and can strand a share or 500 a 1:1 send.
  REJECT for A (recorded tradeoff in RUNBOOK step 3; a millisecond window per
  row; the bulk apply is DONE on both environments; single-mode resumes touch
  one row). The RUNBOOK already says "run it at a quiet moment".
- A5 (LOW) - `isOptedOutCode(undefined)` files any code-less skip as an
  opt-out forever. ACCEPT as an issue amendment: the drift-guard issue now
  carries the hazard and the two remedies (legacy backfill or a
  every-skip-carries-a-code test). No change here (the legacy rule is spec D7).
- A6 (LOW) - the wrapper trusts the caller's `recipient`; the opt-out log
  names the recipient when the duplicate's flag caused the refusal. ACCEPT
  the log precision (both ids and both flags logged); REJECT the binding
  check (one internal caller, the fan-out, which resolved the contact by the
  same key it sends to; a mismatch is a programming error, not an input).
- A7 (LOW) - rule copies that must change in lockstep. ACCEPT in part: the
  three-bucket sum is now ONE `skippedTotal` helper used by the chip and the
  label; the repo comment names the harness mirror instead of claiming "ONE
  place". The census's copy of the reminder job's one-to-one pick and the
  prose invariant behind the send-counter rule stay (spec v11 records the
  invariant; WP2 must revisit).
- A8 (LOW) - the lean fixture's promises: test 1's send makes conv-0002 the
  newest inbox row for later specs. ACCEPT: the spec now reseeds in
  `afterAll` (the `deleted-contact-resurfacing.spec.ts` pattern). The
  `imported_from: 'quo'` value stays (it matches the connecting relay group's
  seed stamp and the census counts any string); the comment no longer claims
  it is the importer's value. The "no automated sends to Dario" guard stays
  comment-only (a convention, like every other fixture promise).
- A9 (LOW) - the RUNBOOK section was a pre-merge, machine-specific
  instruction. ACCEPT (with C4).
- A10 (LOW, UNVERIFIED) - a bare address + link may draw carrier filtering.
  REJECT as a change (Sam's #4 asks for exactly this text); RECORD as a watch
  item for the handback: the 30007 rate on one-to-one property sends.
- A11 (LOW) - a skipped+failed share with zero deliveries reads "Sent".
  REJECT (adjudicated at the whole-branch review; spec R5-3 rejected widening
  D6; Branch B's derived labels replace it).
- A12 (LOW) - the soft-deleted skip line logs a `phone#` contactKey. DEFER:
  filed `broadcast-fanout-logs-phone-keyed-contactkey` (four sites, three
  pre-existing; one helper fixes all).
- A13 (LOW) - `resolveTemplateForTenant` is dead code. ACCEPT: removed with
  its unused constant; its backend-parity tests re-pointed at
  `resolveTemplateForUnit` (the parity they proved is the unit tokens').
- A14 (LOW) - raw internal codes reach staff copy. REJECT (filed already:
  `broadcast-skip-code-drift-guard`).

## The fix wave (planner, one commit)

Code: `share-skip-fix.spec.ts` afterAll reseed; `resolveTemplate.ts` +
test (dead code removed, parity tests re-pointed); `broadcastFormat.ts` +
`StatChips.tsx` (`skippedTotal`); `sendMessage.ts` (opt-out log names both
records); `broadcastsRepo.ts` and `lean.ts` (comments). Docs: RUNBOOK
(status, wording, import window), spec v11 (D1/D2 evidence), WP2 issue
(nudges), drift-guard issue (addendum), new issue (phone# log), B stub
(relabel), `cameron-runs-2026-09-25.md`. Every gate re-run after it; the
results are in `planner-verdict.md`.

## Relays added for the siblings

- RSW: the automatic 30003 retry re-sends `automated: true` AND without the
  `recipient` item, so it loses both of A's guarantees for a staff share
  (person's send; I8's fenced recipient) - A2 above.
