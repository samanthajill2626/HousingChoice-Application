# Spec adversarial review - round 3 adjudications

Reviewer A, continued. Report: `spec-r3-reviewer-a.md`. 10 findings plus an
adjudication audit and an explicit not-terminal verdict.

**Outcome: 10 ACCEPT, 0 rejected.** Three findings changed decisions, so
round 3 is NOT terminal. Round 4 follows and is the HARD CAP.

## Accepted

| # | finding | verdict |
|---|---|---|
| 1 HIGH | **No traversal probe reaches the filesystem at any depth.** `send`'s `UP_PATH_REGEXP` (`node_modules/send/index.js:61`, tested `:431`) answers 403 before joining the root, so the decoy set is empty and "verify the decoy is readable" could not have detected it | ACCEPT, verified. The regex matches `..` with either separator on the normalized path; Express decodes `%2e%2e%2f` first, so every probe including the `/assets/`-prefixed and backslash variants is rejected untouched. **The decoy idea is dropped entirely** - it was wrong in v1, wrong differently in v2, and given an undetecting reachability check in v3. The probes carry over unchanged; a POSITIVE CONTROL is added instead (finding 9), which is the check that was actually missing. |
| 2 HIGH | The asymmetric hook contract is stated at the HELPER layer where it cannot hold - `indexStatus` never throws, so the fail-closed branch is inert for it, and a TTL hook copied from that shape would silently restore the `ValidationException` risk | ACCEPT. Redesigned to ONE contract at the helper (always fail closed), with `db-update-gsis`'s tolerance kept inside `indexStatus`'s own `catch` - which is where a caller's tolerance belongs. Two contracts in one helper is an invitation to the next defect. |
| 3 MEDIUM | The `DeleteTable` "tolerate RIU" fix feeds `waitUntilTableNotExists` (`db-create.ts:64,76`), carrying the identical flat-20s first tick the spec just removed from the create path, on every `npm test` teardown | ACCEPT, verified at `db-create.ts:64` and `:76`. Recorded as PRE-EXISTING: that waiter and its slow tick are there today, and the previous behaviour (throw outright) is strictly worse than reaching it. Noted as a watch item, measured if it shows in teardown timing; `db-create.ts` stays out of scope. |
| 4 MEDIUM | The "reproducible" enumeration returns 29 lines across 9 files, not the quoted "~25 sends and 3 waiter sites across 11 files", and its pattern cannot see `waitUntilTableNotExists`, hiding `db-create.ts` entirely | ACCEPT. Quoting a count that the command contradicts is the same defect as v2's exhaustive-sounding sample. The pattern now includes `waitUntilTableNotExists`, and the spec directs the builder to work from the command's OUTPUT rather than any count written here. |
| 5 MEDIUM | `enableTtlIfNeeded` now nests a retried read inside a retried mutation as its own verification hook - the nested-retry objection the spec itself used to exclude the SDK waiter | ACCEPT. Specified: the verification hook is called at most ONCE per failed attempt and is never itself retried. |
| 6 MEDIUM | The bounded `DescribeTable` poll has a ceiling no one can compute ("well inside the caller's budget"), no exhaustion behaviour, and no disposition under the reads-are-not-covered rule | ACCEPT. Now fully specified: 100ms interval, 10s ceiling (argued against both the 60s hook budget and DynamoDB Local's own 10s lock timeout), rethrow the original `ResourceInUseException` with the observed status on exhaustion, and the poll's own reads are explicitly uncovered - a failed read counts as "not ACTIVE yet". |
| 7 MEDIUM | The QUIET fallback permits a comparison biased toward the fix by ~5x on the one signal called durable, with only a LABEL rather than a use restriction - while Deliverable 2 lets it close the anchor | ACCEPT, and it is the round's most consequential finding after 1. A label the reader may ignore is not a control. Now a USE RESTRICTION: **a mixed contended/quiet pair may not close the anchor issue.** It may support "no regression"; the anchor then stays open with the pair recorded. |
| 8 MEDIUM | Baseline-first ordering does not protect the baseline - install plus warm-up plus 3 runs can outlast the neighbours, and the fallback covers only the post-fix arm | ACCEPT. Per-run labels required; no averaging across a machine whose load changed mid-arm. |
| 9 LOW | The fixture has no positive control that `express.static` serves a real file, so a mis-pointed `distDir` is indistinguishable from a correct one once `GET /` passes off the SPA fallback | ACCEPT, and it replaces the decoy as the thing item 3(a) was actually missing. A real asset is written into the fixture and fetched. |
| 10 LOW | Three loose ends: a literal `<slug>` in the shipped SKIP message; the Risks bullet omits case 7 as the positive half of the inertness proof; case 8 pins that `ensureGsis` retries but not that it still fails OPEN | ACCEPT, all three. Case 8 gains a second case for the fail-open path - without it the move to a fail-closed helper could quietly change `ensureGsis`'s behaviour in the direction the spec says it must not. |

## The adjudication audit (finding 11)

The reviewer audited whether round 2's accepts were implemented in
substance rather than to the letter. Two were not, and both are conceded:

- **R2 #16 was implemented to the letter and missed the point.** I placed
  decoys "at each depth the probes actually reach" without asking whether
  any depth is reachable. Finding 1 is the consequence.
- **R2 #7 was half-applied.** The flat-20s waiter tick was removed from the
  create path and left on the delete path, which the enumeration pattern
  could not even see. Findings 3 and 4 are the consequence.

Everything else was confirmed implemented in substance. **This audit is
worth more than most individual findings**: it caught a class - satisfying
a finding's wording while leaving its mechanism intact - that no fresh
reviewer would have looked for, because only a continued one knows what
the finding meant.

## Status

Not terminal. Findings 1, 2 and 3 each changed a decision. The reviewer's
own assessment is that resolving 1, 2, 3, 6 and 7 should make round 4
terminal; all five are resolved above.

**Round 4 is the HARD CAP.** If it still changes decisions, the skill's
rule applies: stop, and put the open findings to the human as a decision
rather than quietly continuing.
