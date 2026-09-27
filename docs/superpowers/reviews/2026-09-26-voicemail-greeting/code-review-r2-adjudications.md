# Code review R2 - adjudications (build orchestrator)

Round 2 = a FRESH opus reviewer (AUTO mode; the resume ban holds), briefed
with both round-1 reports, the round-1 adjudications, the fix-wave report,
the fix-wave diff and the full post-fix branch diff; charged in order with
(1) what round 1 missed, (2) the fix diff reviewed cold, (3) challenges to
round-1 rulings, (4) whether FW1-FW9 are real. Report:
`code-review-r2.md` @aef90b91.

Verdict: no MUST-FIX, no SHOULD-FIX. No new finding in production code (a
fresh consumer/mutator sweep came up clean). FW1-FW9 all real; FW1-FW4 each
proven to fail against the pre-fix code. Three NOTEs on the fix diff and one
mild challenge.

| id | ruling | change |
|---|---|---|
| F1 (NOTE, CONFIRMED: the FW4 route pin fails with the harness projection reverted only through its `GET /api/settings` assertion; its 404 also passes through the object-missing branch) | ACCEPT - a pin should fail through the assertion that names it. | In `voicemailGreetingRoutes.test.ts`'s foreign-key case, also store an object at the FIXED key, so the audio 404 can only come from the projection; prove it by reverting the projection. |
| F2 (NOTE, CONFIRMED: the FW7 memory comments omit lib-storage's transient `Buffer.concat` copy, so the peak is about 2x the file, ~10 MiB at the cap) | ACCEPT - FW7's purpose was accuracy. | Both comments (`voicemailGreeting.ts` gate docstring, `settings.ts` route block) state the transient peak (about twice the accepted file while lib-storage concatenates its part). |
| F3 (NOTE, CONFIRMED: `voicemail-greeting-concurrent-writes-unserialized` names only the put-to-record window; two of the four failing interleavings start with the DELETE's remove-to-delete gap) | ACCEPT - wording. | One-line correction in the issue body. |
| C7 challenge (mild: spec 4.3 still carries the disproven reason for the `stream.pipeline` ban, so a maintainer who sees the 400 arrive may undo it) | ACCEPT as a docs-only ERRATUM; no decision changes. | Spec 4.3 gains one erratum line (the original sentence is kept): measured on Node 24.14.1, pipeline does not stop the 400 from being written; it never drains the refused body, so the keep-alive connection stalls until the server's keep-alive timeout resets it - the rule stands for that reason and the route tests pin it through connection reuse. |

Agreed by the round-2 reviewer: the round-1 rulings on A1 (accepted by spec
4.3 Concurrency), A7, C4, C8 (and for C8: lib-storage sends its single
PutObject only after the body is fully read, so nothing is left to drain on
the 500 path).

These four are comment, docs and test-strength polish with no runtime
change; they land as one small follow-up commit set verified by the
orchestrator (diff read + the affected test file run + typecheck/lint), not
another review round.
