# Spec review round 4 (terminal) - adjudications

Spec v4 @7ac57f31. Reviewer B continued (`spec-review-r4.md`, 4 findings). No
existing decision was reversed; the reviewer flagged two as needing a new rule.
The planner rules all four as precision edits to decisions already made (the
repair pass, the label rule, the attempt record), which makes this the terminal
round under the stop rule. Cameron sees these rulings at the spec gate and can
override any of them.

| # | Finding | Verdict | What changed in spec v5 |
|---|---|---|---|
| R4-1 | The widened repair has no concurrency rule; I9 as worded forbids the repair's purpose; a repair applying a stale read could overwrite a live post-deploy attempt or delivery | ACCEPT (precision: the same conditional-write rule D2 already states, applied to the repair; I9 carve-out) | D6: every repair write is conditional on the record being unchanged since its read, never erases a recorded delivery or an attempt recorded after deploy, and a dry-run plan is re-read at apply. I9: recording a historical attempt is allowed only by the repair, under that rule |
| R4-2 | The bounded per-recipient record cannot deliver "an older attempt still sent ... if it delivers, they count"; the spec must say how an attempt finds its recipient; duplicate contacts share a conversation | ACCEPT (precision) | D5: an attempt is attributed to the recipient whose text it retried, through the attempt it retried - never by conversation, so two recipients on one phone stay distinct. The record follows the newest attempt; a delivery of a superseded attempt is not recorded (overlap needs a staff Retry during a backoff, the pre-existing double-send case). The "older attempt still sent" sentence is withdrawn |
| R4-3 | Between deploy and the repair, historical delivered-on-retry tenants read not sent and come back pre-checked in a blast; no bound on the gap | ACCEPT (precision: sequencing) | Section 6: the repair runs immediately after deploy, before the first blast, and D1's count says whether the gap holds anyone at all; the gap is stated as accepted |
| R4-4 | D5(e) does not exclude drafts (empty map reads "Not sent") and does not order "Sending" against "Sent" | ACCEPT (precision) | D5(e): a draft keeps "Draft"; "Sending" wins while the share is `sending` and any recipient is queued |

Contested adjudications: none. Review closed after four rounds; spec v5 goes to
Cameron's gate with the full round history.
