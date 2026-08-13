---
id: import-group-thread-retraction
title: retractImported has no group-thread retraction path, so a corrected import re-run leaves the first population of group threads orphaned in the inbox
type: bug
severity: med
status: open
area: app
created: 2026-08-11
refs: app/src/lib/import/apply.ts:590, app/src/lib/import/apply.ts:254, app/src/lib/import/convertGroups.ts:102, app/scripts/import-apply.ts
---

**Problem.** `retractImported` (`app/src/lib/import/apply.ts:590`) is the
import's undo path. It resolves exactly ONE conversation shape -
`conversationIdFor1to1(person.phone)` - and there is no group-thread retraction
anywhere in the file. So the import can CREATE group conversations it can never
remove.

**Failure walk.** The trigger is a group-identity parity mismatch:

1. The export's `ownNumbers` omits one of the org's numbers (say a founder's old
   org cell). `import:apply` writes every group conversation and every group
   message with ids derived from a roster that still contains that number as a
   phantom member.
2. `import:convert-groups` then runs `checkGroupIdentityParity`
   (`convertGroups.ts:102-121`), which compares the export's `ownNumbers` against
   the deployed `GROUP_IDENTITY_EXCLUDED_NUMBERS`, throws
   `GroupIdentityParityError`, and converts nothing - correctly, because "a
   missing number mints a DIFFERENT conversation id for the same group".
3. The adjudication is "the export was wrong". The corrected re-run derives a
   DIFFERENT id set and mints a SECOND population of group threads.
4. Nothing retracts the first. The 132 orphans remain, indexed as `connecting`
   relay groups, visible in the staff inbox, pointing at nothing and pointed at
   by nothing.

**What the group-texting branch DID fix, and what it did not.** The branch adds
the same `ownNumbers` parity gate UP FRONT, in `import:apply`, before the first
write. That closes the window that CREATES the orphans - the cheap, correct fix,
and it means the scenario above should never occur through the parity route
again.

This issue is the other half: the RETRACTION path that would clean up if a second
group-thread population is ever created anyway. A parity mismatch is not the only
way to get one - see
[group-identity-pool-number-mutability](./group-identity-pool-number-mutability.md),
where an ordinary pool-number retirement forks a thread with no import involved
at all. Today, in every such case, the answer is a hand-written DynamoDB cleanup.

**Suggested fix.** Teach `retractImported` about group threads:

1. Enumerate the group conversations a given import run created. The import
   already stamps its own items, so the stamp is the selector - the same rule the
   1:1 path uses ("a thread holding any message the import did not create is KEPT
   and reported").
2. Retract in the same order the 1:1 path now uses: messages, then thread, then
   contact (contact LAST), so a mid-retract failure leaves recoverable residue
   rather than an orphaned thread under a deleted contact.
3. Report, do not guess. A group thread that has received real post-import
   traffic must be KEPT and named in the report - retracting it would delete
   member speech the import did not create.
4. Keep the operator in the loop: this is a destructive path over 132 real
   threads, so it belongs behind the same `--yes` discipline as the rest of the
   import commands, with a dry run that prints exactly what it would remove.
