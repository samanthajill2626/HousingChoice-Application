# Founder rulings on the open questions (2026-09-24)

Cameron's answers to "Open questions for the human" in [`handback.md`](handback.md)
and to finding 1 of
[`parent-final-spec-conformance-findings.md`](parent-final-spec-conformance-findings.md).
The code followed the approved spec until these rulings; each row says what
changed as a result.

| Item | Ruling | Follow-through |
| --- | --- | --- |
| Q1 - the four gate refusals (`retry_group_closed`, `retry_member_removed`, `retry_number_changed`, `retry_opted_out`) log at ERROR | Log them at WARN | MERGED to `main` @`685f2ede` (fast-forward of `fix/relay-gate-refusal-warn`). Gates on that commit: typecheck 0, `npm test` 0 with DynamoDB Local, smoke 0, touched-file lint clean, e2e 275 passed (19.4m). The send-time refusal (for example `breaker_open`) stays ERROR. |
| Q3 - the destination digest is an unkeyed, reversible hash | Accepted as is: obscure and very low risk. No HMAC. | None. Revisit only if the exposure changes, for example logs shipped outside AWS. |
| Q4 - alarm volume from one dead handset in an active group | Superseded by a narrower rule once the research showed the real risk: nothing re-sends a text more than 15 minutes after the original went out. A late 30003 (a carrier giving up after holding a text for hours or days) otherwise triggers a retry of out-of-context content, because neither retry path checks the message's age. A declined retry shows as a plain failed attempt. Alarm thresholds unchanged. | Feature mission `feat/retry-send-window` (both retry paths, honest "will retry" copy, a manual-Retry guard, native group text). |
| 1.1 / F11 - the stranded claim window | Severity lowered to low: it needs an abrupt kill between two writes, and deploys drain in-flight requests. Not fixed. | [`relay-retry-stranded-claim-window`](../../../issues/relay-retry-stranded-claim-window.md) |
| Q5 - the retry bubble's row reads plain `Delivered` beside its `delivered 1/1 on retry` chip | Update the text | [`relay-retry-bubble-row-reads-plain-delivered`](../../../issues/relay-retry-bubble-row-reads-plain-delivered.md) (low, open) |
| Final review finding 1 - four retry-state strings beyond the approved D19 tables | Approved as shipped | None. The strings are the chip's `- 1 retrying - Phone unreachable (error 30003)` and `- 1 not confirmed - Phone unreachable (error 30003)` suffixes, and the rows `Queued - not confirmed - Phone unreachable (error 30003)` and `Sent - not confirmed - Phone unreachable (error 30003)`. |
