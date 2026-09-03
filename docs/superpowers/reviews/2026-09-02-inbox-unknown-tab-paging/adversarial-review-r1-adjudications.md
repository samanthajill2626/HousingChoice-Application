# Adversarial review R1 - adjudications (feat/inbox-unknown-tab-paging)

Reviewer: plan-blind adversarial (opus), diff `main...5de0bc90` + repo only.
Findings: `adversarial-review-r1.md` in this directory. Seven findings, none
blocking or high. Six ACCEPTED, one REJECTED. No decision about what is built
changed; every accepted item is a comment or doc precision edit, so this is the
terminal round unless the re-review finds something new.

| # | sev | verdict | disposition |
| --- | --- | --- | --- |
| 1 | MED | ACCEPT | Both stale test comments rewritten: the cap now "requires a deferral cursor naming this row"; the mutation probe names the current first clause and says to replace it with `true`. |
| 2 | MED | ACCEPT (comment) / REJECT (positional alternative) | The comment now states the real condition: progress whenever the SAME row is at the head on two consecutive requests, and what happens otherwise (defer again with a new `d`, WARN, visible state, no server loop). The positional-match alternative is REJECTED: firing the step-over on "cursor carries `d` and the position is unchanged" regardless of which contact is failing would drop a row that was never retried - the exact defect class this change exists to close. The unreachable-by-test counter-case needs the head row to change on EVERY consecutive request during an outage; accepted as a stated limit, not fixed. |
| 3 | LOW | REJECT | `contactId` is the contacts table's hash key and the trailing key of `byTypeStatus`; DynamoDB refuses an empty String in any key attribute, so no item with `contactId: ''` can be read from the index and reach the encoder. The decoder's rule mirrors the same fact it already applies to `k.contactId`. An encoder guard would silently convert an impossible item into a cursor with no `d`, which is the worse failure (a row deferred forever). (R2 conceded the verdict and contested the clause "keeps the impossible case loud": the 400 is unlogged and the dashboard swallows it, so it is not loud either. Conceded; the rejection rests on reachability alone.) |
| 4 | LOW | ACCEPT | The decoder comment now carries the robustness-not-security disclaimer for `d`: shape only, unsigned, a forged `d` costs the forger one un-retried row on their own walk and reaches nothing else. |
| 5 | LOW | ACCEPT | Reworded: the read never uses `conv.type` to decide QUEUE MEMBERSHIP; it still reads it to exclude relay-group threads (class b). |
| 6 | LOW (pre-existing) | ACCEPT | The stale "lines 1731-1737" locator is replaced with the function's position by name. |
| 7 | LOW (pre-existing) | ACCEPT | One sentence added to `dashboard/src/api/paging.ts` naming `/api/inbox` and `/api/ai-runs` as the two routes that clamp and fall back rather than 400, so nobody "re-syncs" them to the convention. |

Gates after the fix wave: code changes are comments only plus one dashboard
comment, so typecheck, the two touched test files, and gate-5 lint on the
touched files are re-run; e2e is not (no behaviour changed).
