# Planner's independent review - adjudications

Reviewers: spec-conformance (handback as claims list) and PLAN-BLIND
adversarial (diff + repo + standing charter only). Reports:
`planner-review-conformance.md`, `planner-review-adversarial.md`.

Conformance: CONFORMANT-WITH-NOTES, 2 LOW. Adversarial: 12 findings, 0
blocking after adjudication. The adversarial reviewer was deliberately blind
to the spec and every prior round, so several of its findings rediscover
declared costs or pre-existing seams - that is the design working, and the
adjudication below is where the withheld context gets applied.

## Adversarial findings

| # | finding | ruling |
|---|---|---|
| 1 (HIGH) | `filter=unread` batches per multi-party row, up to the page limit | DECLARED COST, not a defect. Spec section 3 In-table (amended at plan review): "one batch per multi-party row on unread", riding beside the per-row point read that loop already does by design; bounded by MAX_INBOX_LIMIT. Adjudicated twice before (plan review B6, orchestrator round A-3). |
| 2 (HIGH) | `/group-members` resolves by phone with NO delete check and WRITES the name into the stored roster - the rung the new guards fall back to | TRUE, PRE-EXISTING, OUT OF SCOPE by the spec's own Out list ("Left exactly as is"). The seam means rung 2 can serve a deleted contact's name that route seeded. Disposition: one line added to the resolved issue's residue stamp (post-battery commit); changing the route is its own change with its own blast radius. |
| 3 (HIGH) | "Snapshot nothing refreshes" repeated as fact in new comments; `api.ts:2113`'s "the inbox row stays stale" log string is now false | ACCEPT for the branch's OWN comments - fixed in the working tree (participantNames.ts header now names the group_text converge exception; commits after the battery). The `api.ts:2113` log string sits in the excluded route: NOT edited (out-list), recorded here instead. |
| 4 (MEDIUM) | Three name rules over one group_text roster; the phone-keyed write-back can persist the wrong person's name on a moved number | Pre-existing, twice-documented: spec 2.1 says "NOT a full reconciliation, deliberately", and the duplicate-phone hazard at `contactsRepo.ts:1011-1016` is tracked by the M1.6 import dedupe. No action. |
| 5 (MEDIUM) | The display projection cannot see the legacy `contact.name` field, so a name-only contact renders differently on the 1:1 row vs the group row | Known rung difference, deliberately not unified (round 1 A6/B2: re-pointing inbox's helper was a REGRESSION). Census issue documents it. Population unverified by the reviewer; no action this branch. |
| 6 (MEDIUM) | The `isDeleted` guard landed on `pushSenderLabel`/`maskedPartyLabel` but not the 1:1 push titles (`twilio.ts:1057, :2300`) | TRUE and pre-existing there (those sites were contact-first before this branch and were not in scope). The wave-1 guard created a group-vs-1:1 inconsistency. OPEN QUESTION FOR CAMERON (added to the verdict): a two-line follow-up if wanted; not this branch. |
| 7 (MEDIUM) | `resolveRosterNames`'s blanket catch reports a TypeError as a read failure | Real nit; in production the repo always has the method, and the known fake-gap case was handled by patching the sibling fakes explicitly. No action; noted for the next consumer. |
| 8 (MEDIUM) | `contactName.ts` census comment undercounts | ACCEPT - fixed in the working tree (points at the issue file instead of enumerating; commits after the battery). |
| 9 (LOW) | A single-token name passes the mask unshortened | A first name IS the masked form of a one-token name; "never an unmasked full name" refers to first+surname. Edge noted, no action. |
| 10 (LOW) | group_text header still converges after a round trip | Pre-existing design (`GroupTextView` convergence), out of scope. |
| 11 (LOW) | relay-groups card batches the self id it already holds | Harmless, pinned deliberately. No action. |
| 12 (LOW) | `buildToday` fallback change untested | The 404-only offline fallback; a unit test there costs more than the guard protects. Accepted. |

Clean hunts recorded by the reviewer and worth keeping: no new writes anywhere
in the diff, Today's zero-added-reads claim verified true, wire shapes closed,
O(1) batches on all four hoisted arms, no PII in logs, the masked call label
strictly more private than main's.

## Conformance findings

| # | finding | ruling |
|---|---|---|
| 1 (LOW) | Two boundaries lack a route-level read-budget pin (calls passthrough, group-threads card) | Accepted as a note; both are one batch by construction and module-pinned. Follow-up-worthy only if a future edit un-hoists one. |
| 2 (LOW) | Spec In-table says the close-nag batches over `listRelayGroups('open')`; code batches the due-filtered subset (strictly cheaper) | Spec-text drift; the record (this file) is the reconciliation. No code change. |

## Post-battery actions (planner, comment/docs only)

1. Commit the two comment-accuracy edits (participantNames.ts header,
   contactName.ts census pointer).
2. Add one residue line to `group-roster-name-snapshot-never-refreshed`'s
   stamp: the `/group-members` phone-keyed write-back can seed a deleted or
   (on a moved number) wrong contact's name into the stored fallback rung.
3. Nothing else. No code changes; the verdict does not depend on these.
