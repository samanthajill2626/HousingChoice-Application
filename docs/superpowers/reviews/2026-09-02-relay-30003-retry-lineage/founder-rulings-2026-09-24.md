# Founder rulings on the open questions (2026-09-24)

Cameron's answers to "Open questions for the human" in [`handback.md`](handback.md)
and to finding 1 of
[`parent-final-spec-conformance-findings.md`](parent-final-spec-conformance-findings.md).
The code followed the approved spec until these rulings; each row says what
changed as a result.

| Item | Ruling | Follow-through |
| --- | --- | --- |
| Q1 - the four gate refusals (`retry_group_closed`, `retry_member_removed`, `retry_number_changed`, `retry_opted_out`) log at ERROR | Log them at WARN | Branch `fix/relay-gate-refusal-warn` @`1b721c23`, a small fix that merges on Cameron's go. The send-time refusal (for example `breaker_open`) stays ERROR. |
| Q3 - the destination digest is an unkeyed, reversible hash | Accepted as is: obscure and very low risk. No HMAC. | None. Revisit only if the exposure changes, for example logs shipped outside AWS. |
| Q4 - alarm volume from one dead handset in an active group | Open. Cameron asked when a powered-off phone actually produces a 30003 before deciding. | Pending. |
| 1.1 / F11 - the stranded claim window | Severity lowered to low: it needs an abrupt kill between two writes, and deploys drain in-flight requests. Not fixed. | [`relay-retry-stranded-claim-window`](../../../issues/relay-retry-stranded-claim-window.md) |
| Q5 - the retry bubble's row reads plain `Delivered` beside its `delivered 1/1 on retry` chip | Update the text | [`relay-retry-bubble-row-reads-plain-delivered`](../../../issues/relay-retry-bubble-row-reads-plain-delivered.md) (low, open) |
| Final review finding 1 - four retry-state strings beyond the approved D19 tables | Approved as shipped | None. The strings are the chip's `- 1 retrying - Phone unreachable (error 30003)` and `- 1 not confirmed - Phone unreachable (error 30003)` suffixes, and the rows `Queued - not confirmed - Phone unreachable (error 30003)` and `Sent - not confirmed - Phone unreachable (error 30003)`. |
