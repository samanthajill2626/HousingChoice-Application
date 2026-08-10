---
id: ai-run-log-hot-path-round-trips
title: Suggestion accept/dismiss and the suggestions list cost many more DynamoDB round trips than before
type: debt
severity: low
status: open
area: app/suggestion-resolution
created: 2026-08-09
refs: app/src/services/suggestionResolution.ts:450, app/src/services/suggestionResolution.ts:496, app/src/repos/suggestionResolutionRepo.ts:527, app/src/repos/extractionRepo.ts:388, app/src/routes/suggestions.ts:101
---

**Problem.** The crash-safe resolution journal made the accept/dismiss hot path
roughly 3x more chatty than the pre-branch code, which resolved a suggestion in
about 4-5 round trips. A scalar accept on the happy path now costs about 13-16:

- `routes/suggestions.ts:128` `getSuggestion` (Get)
- `suggestionResolution.ts:450` journal `get` (Get), `:479` `getSuggestion`
  (Get), `:484` `contacts.getById` (Get), `:490` `findByPhone` (Query, phone
  targets only)
- `:496` `claim` (TransactWrite), `:281-284` `commit*Effect` (TransactWrite),
  `:314` journal re-Get, `:330`/`:341`/`:348` activity or `advancePhase`
  (TransactWrite), `:357` journal re-Get, `:367` `setVerdict` (1 Update on the
  happy path, up to ~5 on the fallback ladder at `aiRunsRepo.ts:324-410`),
  `:387` `advancePhase` (TransactWrite), `:393` journal re-Get, `:402`
  `complete` (TransactWrite)
- `routes/suggestions.ts:147` `listSuggestionsByContact` (Query) and `:161`
  `contacts.getById` with `consistentRead` (Get)

Two adjacent inflations ride along. `extractionRepo.putSuggestion` went from
main's single conditional Put to **3** calls per write - two parallel
ConsistentRead Gets (`extractionRepo.ts:388-397`) plus one TransactWrite
(`:436-460`), retried up to 4 times on conflict. And the abandoned-journal
recovery hook added to the ordinary suggestions GET
(`routes/suggestions.ts:101` -> `suggestionResolutionRepo.ts:527 listJournals`)
issues a 12-key ConsistentRead **BatchGet on every contact view**, whether or
not any journal exists, so simply opening a contact is now 2 round trips instead
of 1.

None of this is a defect: each extra call buys crash-safety or a correctness
fence, and at staff-tool volume (a handful of navigators, tens of resolutions a
day) the latency and cost are irrelevant. Filed so the cost is on record rather
than rediscovered.

**Suggested fix.** Nothing now. Revisit if suggestion volume or contact-view
traffic grows by an order of magnitude. The cheapest wins, in order: skip the
recovery BatchGet unless a cheap marker says a journal may exist; return the
post-commit journal state from `commit*Effect`/`advancePhase` so the three
re-Gets at `:314`/`:357`/`:393` disappear; and let `putSuggestion` do a single
optimistic TransactWrite, reading only after a conditional failure.
