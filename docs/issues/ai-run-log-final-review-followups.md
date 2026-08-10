---
id: ai-run-log-final-review-followups
title: AI run log - remaining findings from the final independent review
type: debt
severity: low
status: open
area: app
created: 2026-08-09
refs: .superpowers/design-review/final-conformance.md, .superpowers/design-review/final-adversarial.md
---

**Context.** Two independent reviewers (spec-conformance and plan-blind
adversarial) reviewed `feat/ai-run-log` at its final tip. BOTH returned PASS
with no P0 and no P1. All ten adjudicated worklist items were verified closed
with tests that can fail. These are the remaining findings, carried here rather
than fixed, so nothing is lost at merge. Two got their own files:
`ai-run-log-recovery-hook-unbounded` and `ai-run-log-decisions-count-miscounts`.

**Honesty and reporting**

1. An accept refused as `superseded_by_human_edit` answers HTTP 200 with the
   suggestion already deleted; the outcome type cannot express a refusal, and
   the guard behind it reads one eventually-consistent value.
   (`suggestionResolution.ts:578,416,618`; `routes/suggestions.ts:150-166`)
2. `suggestion_resolution_lost` copy tells the operator "nothing changed" while
   the server comment above the throw says the domain effect may have
   committed. (`types.ts:1194-1196,1219`; `suggestionResolution.ts:409-415`)
3. Two error codes promise "the list now shows its real state" but the ApiError
   branch never refetches and the SSE is not guaranteed.
   (`ContactDetail.tsx:269-272`; `types.ts:1209,1215`)
4. The F8 terminal path skips its verdict stamp on `already_completed`, leaving
   that decision `pending` - "nobody has looked" - forever.
5. `domainCommitted` is set true for `superseded_by_human_edit`, where no domain
   effect committed.
6. A refusal arriving without usage counts is classified `errorKind: 'driver'`.
   (`adapters/extraction.ts:213-219`)

**Robustness**

7. `?limit` between 0 and 1 yields `Limit: 0` -> ValidationException -> 500 plus
   an ERROR log; the repo's own `parseLimit` exists but is not used.
   (`aiRuns.ts:52-56`)
8. `before`/`from`/`to` are unvalidated - not injectable, but a malformed filter
   silently returns an empty page on a forensic surface.
9. `deps.now()` and `newRunDraft` sit OUTSIDE the per-row backstop, so a throw
   there aborts the remaining rows in the batch - the one place the per-row
   isolation guarantee is not held. (`jobs/extraction.ts:567,600,629-630`)
10. An unchunked BatchGet sits exactly on the 100-key ceiling while its sibling
    added on the same branch does chunk. (`aiRunsRepo.ts:154-167`)
11. `setVerdict`'s fallback can mint an unconsumable `inflight#` marker for a
    TTL-reaped run. (`aiRunsRepo.ts:413-435`)
    Trigger: literally cannot occur until 90 days of runs exist, since nothing
    has been TTL-reaped before then. Revisit when the first runs approach the
    TTL horizon.
12. The lease fence is re-adopted rather than enforced (`journal = refreshed`
    with no same-token check); benign only because every effect is
    independently idempotent. (`suggestionResolution.ts:421,462,479`)
    Trigger: the moment anyone adds a NON-idempotent effect to the resolution
    protocol, the fence must be enforced (compare tokens and bail). An in-code
    warning now sits above the first re-adoption site in
    `suggestionResolution.ts` so the constraint is visible where it bites.
13. A persistent journal-table error after the domain commit surfaces as a 500
    where main answered 200.
    Trigger: first sighting in any environment - it needs a real failure to
    characterize before choosing a remedy.
14. `putSuggestion` retries 4x with no backoff and its catch issues two
    consistent reads before the retryability check, which can mask the original
    error.
    Trigger: first observed contention in production.

**Cost**

15. Every SKIPPED extraction now writes a run record plus 3-4 pointer rows
    (5-6 items) where main wrote zero. Skips are the steady-state outcome. This
    is the design's deliberate "why did it not fire" evidence, but the volume
    was not costed.
    Trigger: 30 days of production run data - costing needs real volume, and
    guessing now would be premature optimization on a staff tool.
16. Contact PATCH adds N sequential `getSuggestion` reads ahead of the write,
    including for non-extractable fields.
    Trigger: 30 days of production run data, same reasoning as item 15.

**Accessibility and UI**

17. Run row `aria-label` is the bare UUID, suppressing all row content from
    assistive tech. (`AiRunList.tsx:47`)
18. `aria-label` on `role=generic` elements is ignored by AT but honored by
    Testing Library and Playwright, so those tests assert on something a screen
    reader never exposes. (`AiRunsSection.tsx:37`)
19. No affordance anywhere navigates to a CONTACT-SCOPED run log; the scope
    deep-link is reachable only by hand-editing the URL. (The Settings tab
    itself is present and correctly admin-gated - verified live.)
    Trigger: a product decision, not a bug - build it when the humans decide
    the contact page should link to its runs.
20. The decision ledger iterates DynamoDB map order while `DECISION_TARGETS` is
    declared to be the display order.
21. Detail pane omits the run time that spec section 9 lists in the header.
22. A second chip click is silently swallowed while another is in flight
    (pre-existing).
    Trigger: pre-existing on main, not this feature's regression - pick it up
    with any general suggestion-chip UX pass.

**Hygiene**

23. Dead `try { ... } catch (error) { throw error; }` in the commit dispatch.
24. A comment promising "Ids only" sits one line above
    `log.warn({ runId, target, err })` - not a leak today, but the comment and
    the code disagree.
25. `StatusTransitionCommittedError` is thrown and caught by nobody outside its
    own test.
26. `e2e/support/selectors.md` is now factually wrong about FlagPills and has no
    row for the new surface.
27. Fault-injection hooks (`afterBoundary`) ship inside the production request
    path.
    Trigger: the next time the crash suite is touched - removing them now means
    rewriting that suite for no behavioral gain.
28. A helped commit loses its `suggestion.updated` SSE when the request then
    fails with a non-`SuggestionResolutionError`.

**Attribution note (cosmetic, no action required).** Commits `002fe2a5`,
`ea1cbedd`, `f80c957a`, `dd894e83`, `0520eb8a`, `cd898692` and `3a6b913c` carry
a `Co-Authored-By: Claude Opus 4.5` trailer from an orchestrator briefing error;
the authoring model was Claude Opus 5. History was deliberately NOT rewritten -
a message-only rebase would invalidate every commit hash referenced across the
ledger, the reports and these issue files.
