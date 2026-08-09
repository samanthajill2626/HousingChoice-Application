---
id: suggestion-status-accept-contract-drift
title: Accepting a status suggestion now gates on an allowlist and answers 400, diverging from setTenantStatus
type: debt
severity: med
status: open
area: app/status
created: 2026-08-09
refs: app/src/services/suggestionResolution.ts:174, app/src/services/statusTransition.ts:579, app/src/services/statusTransition.ts:587, app/src/services/statusTransition.ts:218
---

**Problem.** Two related drifts around status semantics, both introduced by the
AI run-log branch and both deliberately left alone by its fix wave (touching
status semantics was ruled out of scope).

1. **New allowlist gate with a new error vocabulary.**
   `app/src/services/suggestionResolution.ts:174-177`:

   ```ts
   if (target === 'status') {
     if (!statusAllowlistFor(contact.type).includes(suggestion.suggestedValue)) {
       throw new SuggestionResolutionError(400, 'invalid_suggestion_value');
     }
   ```

   Main routed a status accept straight to `setTenantStatus`, whose documented
   contract is that it "always applies (subject only to the entity existing)"
   (`app/src/services/statusTransition.ts:579`). The accept path now has a
   pre-check the service itself does not have, and it replaces main's
   `409 <TransitionRefusedError code>` / `404 <entity>_not_found` answers with a
   flat `400 invalid_suggestion_value`. Two callers of the same domain operation
   therefore enforce different rules and report failure differently.

2. **`StatusTransitionCommittedError` is caught nowhere in production.**
   Declared at `statusTransition.ts:218-221` and thrown at `:587` when the
   post-write `auditRepo.append` fails. `grep -rn StatusTransitionCommittedError
   app/src` returns only the declaration and that throw; the sole catchers are in
   `app/test/statusTransition.test.ts:402-403`. Every pre-existing caller of
   `setTenantStatus` therefore sees a generic wrapper whose whole point (the
   write already committed - do not retry) is carried only on `.cause`, and no
   route or service acts on it.

**Suggested fix.** Decide where status policy lives, then make one place own it.
Either push the allowlist check down into `setTenantStatus` (and let the accept
path surface whatever that service refuses, restoring main's 409/404 codes), or
bless the accept-side gate and document that suggestion accepts are strictly
narrower than a direct status set. Separately, either catch
`StatusTransitionCommittedError` where it matters (the callers that would
otherwise retry a committed transition) or delete the wrapper and let the audit
failure propagate with its own type.
