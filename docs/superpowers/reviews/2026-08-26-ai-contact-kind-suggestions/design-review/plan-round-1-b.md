# Adversarial plan review - round 1B

## Findings

### 1. [BLOCKING] Backend treats a whitespace-padded custom role as Property Manager

**What is wrong:** The proposed backend full-kind resolver trims `role` before it tests for `Property Manager`. That makes `{ type: 'landlord', role: ' Property Manager ' }` compare as `property_manager` and therefore lets a pending Property Manager suggestion be stamped `accepted`. The spec requires the exact preset role; every other non-empty custom role is not a comparable supported kind. The dashboard's existing preset detector is exact, not trimmed, so the two boundaries will disagree for the same stored contact.

**Evidence:** Spec D8 requires `type: 'landlord'` plus the **exact** `Property Manager` role, and classifies every other non-empty custom role as unsupported (`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:224-242`). The plan's resolver does `const role = ... contact.role.trim() : ''` and then accepts `role === PROPERTY_MANAGER_ROLE` (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:983-999`); its truth-table tests omit whitespace-padded `Property Manager` (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:931-959`). Existing dashboard code tests the untrimmed value against `PM_ROLE` (`dashboard/src/routes/contact/KindPicker.tsx:41-45`).

**Implication:** An arbitrary custom role that merely normalizes to the preset can be recorded as an AI acceptance, violating the audit semantics and creating UI/backend kind disagreement. The resolver must compare the raw stored string exactly for the preset and only use emptiness logic appropriate to the spec; add both leading/trailing-whitespace regression cases.

### 2. [HIGH] The shown classification drain never reads a post-write candidate when the pre-write snapshot is empty

**What is wrong:** D11 explicitly requires the classification writer to drain an older-revision type row that appears after the contact write even when there was no pre-write type suggestion. The plan's implementation says the first candidate is `pendingTypeBefore`, and only performs the consistent `getSuggestion` after an attempted delete. With `pendingTypeBefore === undefined`, there is no candidate to delete and no specified initial post-write read. The promised race test asserts this case but the literal algorithm cannot reach it.

**Evidence:** The spec requires a bounded consistent read/drain after a kind-changing PATCH and says a post-write type row must not be left without a review surface (`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:309-337`). The plan requires a red test for “no pre-write type row, inject one after the contact write” (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1094-1106`), but defines the first drain candidate as `pendingTypeBefore` and only reloads after `suggestion_changed_or_absent` or a successful delete (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1145-1175`). There is no first consistent read for an empty snapshot.

**Implication:** A stale extraction can publish a revision-0 type row just after an Unknown-to-known PATCH, and this route will return with that row pending. The Unknown card disappears and generic type acceptance is deliberately refused, so the stale item remains in Today with no resolution path. Specify an unconditional first post-write consistent read when the snapshot is empty (and test the exact order).

### 3. [MEDIUM] The E2E “red state” is scheduled after the implementation it is supposed to precede

**What is wrong:** Task 6 adds the Partner/Property Manager flows only after Tasks 1-5 have implemented the behavior, then directs the builder to verify that those flows fail “before Tasks 1-5.” There is no executable point in the stated order where that instruction is true, so it cannot prove the tests detect the missing behavior.

**Evidence:** The dependency order places Task 6 after Tasks 1-5 (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:55-57`). Task 6 creates the two flows in steps 2-3 (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1630-1693`) and immediately says to run them with an expected pre-Tasks-1-5 failure (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1695-1703`).

**Implication:** The new end-to-end proof may be green on first run without ever demonstrating a meaningful red state. Move the test creation/run before the implementation tasks, or replace the impossible instruction with an explicit, observable post-implementation acceptance command and rely on the earlier component/backend red tests for TDD evidence.

## Attacked areas that held

- The plan keeps type suggestions on the existing PATCH route rather than routing them through generic suggestion acceptance; the existing resolver already rejects `target === 'type'` with `accept_type_via_triage` (`app/src/services/suggestionResolution.ts:203-205`), and Task 4 retains that test (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1190-1199`).
- The proposed contact-repository revision increment is inside the existing single DynamoDB `UpdateCommand`, which currently returns `ALL_NEW` (`app/src/repos/contactsRepo.ts:1152-1211`); Task 2 explicitly puts `if_not_exists(...)+1` in that same update and tests concurrent updates (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:291-378`).
- The two-table delete is correctly planned as a DynamoDB transaction with an absent-or-zero condition for legacy revision zero, not a read followed by an independent delete (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:473-521`), matching the spec's explicit transaction requirement (`docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md:339-351`).
- The named user-facing renderers are covered: the current Unknown card raw-capitalizes the wire value (`dashboard/src/routes/contact/UnknownFile.tsx:28-30,95-118`), while Task 5 introduces a canonical label map for both the card and type decision ledger and keeps raw panes untouched (`docs/superpowers/plans/2026-08-26-ai-contact-kind-suggestions.md:1281-1322,1529-1564`).
