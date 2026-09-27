---
id: roster-action-lost-on-post-claim-error
title: A deferred roster action (open a group / add a member) is lost when anything throws after claimApply, including reads that ran before any side effect
type: bug
severity: med
status: open
area: app/rosters
created: 2026-09-25
refs: app/src/jobs/rosterActions.ts:474, app/src/jobs/rosterActions.ts:497, app/src/jobs/rosterActions.ts:505, app/src/jobs/rosterActions.ts:512, app/src/jobs/rosterActions.ts:637, app/src/services/rosterProvision.ts:335, app/src/services/rosterProvision.ts:346, app/src/services/rosterProvision.ts:398, app/src/services/rosterProvision.ts:603, app/src/services/rosterProvision.ts:647, app/src/services/rosterProvision.ts:716, app/src/services/relayMembers.ts:136, app/src/services/relayMembers.ts:164, app/src/services/relayMembers.ts:193, app/src/services/relayMembers.ts:219, app/src/services/relayMembers.ts:230, app/src/services/relayMembers.ts:259
---

**Problem.** The pending roster-action poll applies roster changes an operator
confirmed but deferred (for example out of quiet hours): open a tour or
placement relay group, or add a contact to one. It claims the row with
`claimApply` (`app/src/jobs/rosterActions.ts:497`) and then performs the action;
any throw is logged at ERROR ("the action did not happen and will not retry",
`:508-511`) and rethrown (`:512`) into the poll's per-row catch (`:637-644`).
The claim is one-way by design (`:27-29`, `:500-504`): re-running an open that
already bought a pool number, or an add that already announced, is worse than a
loud log. The pending banner disappears and nothing happened.

The design reasoning covers failures DURING or AFTER a side effect. It does not
fit three other cases the same catch receives:

- **Reads before any durable change.** `addMemberToRelay`'s conversation read
  (`app/src/services/relayMembers.ts:136`) and member-name resolution (`:164`);
  the placement path's existing-thread read
  (`app/src/services/rosterProvision.ts:603`). A transient read failure here
  retires an action that could simply have been retried. The poll already has
  the right verdict for this: `wait` leaves the row unclaimed for the next tick
  (`rosterActions.ts:474-480`) - but it is only reachable from validation,
  before the claim.
- **Failures that the callee already cleans up.** The tour path's
  `claimGroupThread` (`rosterProvision.ts:335-340`) and provisioning
  (`:346-385`, which releases its claim on failure), and the placement twin
  (`:647-681`): after the release, a retry would be safe, yet the action is
  still retired.
- **A failure after the member is fully added.** `addMemberToRelay`'s audit
  append (`relayMembers.ts:230`) is unguarded and runs after the roster write
  (`:219`). If it throws, the member IS on the roster, the join announcement
  (`:259-271`) is skipped, and `rosterActions.ts:510` logs "the action did not
  happen", which is false.

Filed as med (the sweep rated it low-to-medium): what is lost is an action an
operator explicitly confirmed, and the one ERROR line it leaves is wrong in the
last case.

**Suggested fix.** Group: not a send - local error handling; no reconcile
involved (see the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9). Let the apply report "nothing happened yet" distinctly from "partly
happened": a pre-side-effect failure (and a failure the callee has already
released) returns the row to pending like `wait`; a failure after the add
reports the add as done; only a genuinely partial action keeps today's one-way
ERROR. Guard `relayMembers.ts:230` so a failed audit write cannot skip the
announcement.

**Related.**
[relay-member-added-lost-under-job-marker](./relay-member-added-lost-under-job-marker.md)
(the announcement this path enqueues),
[pending-roster-actions-uncapped-walker](./pending-roster-actions-uncapped-walker.md).
Sweep finding F8 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
