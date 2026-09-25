# Spec review round 2 - adjudications

Spec v2 @479e0841. Reviewer B continued (`spec-review-r2.md`, 12 findings) with
reviewer A's round-1 report as cross-check. Every code claim was re-verified by
the planner before ruling. Contested adjudications from round 1: none (M13, M15
conceded; M11 not contested).

The round's verdict on itself: v2's retry rule was the right direction and the
wrong mechanism. It leaned on a "retry pending" state the one-to-one retry chain
never records (refusals, unscheduled retries and errored jobs all exit silently).
v3 replaces it with a rule built only on recorded facts.

| # | Finding | Verdict | Decision changed? | What changed in spec v3 |
|---|---|---|---|---|
| R2-1 | "Retry pending" has no durable end; a refused/unscheduled/errored retry leaves the recipient counted forever (Sam's symptom, reintroduced) | ACCEPT. Verified the webhook swallows an enqueue failure and the retry job returns silently on a refusal | YES | D5 has no pending state. An attempt is a text actually sent; a retry that never sends is not an attempt and changes nothing. A recipient counts when any attempt delivered, or the newest attempt is queued/sent. During a retry's backoff the recipient reads not sent (section 8) |
| R2-2 | Retries as slot writers reverse the forward-only terminal-slot rule; a one-recipient share can finalize `failed` ("all recipients failed") before its retry delivers; the hermetic fake makes that race real | ACCEPT | YES | New invariant I9: a recorded outcome leaves `failed` only through a newly sent attempt for that recipient; per-attempt delivery stays forward-only. D7: a share's label and its failure alert derive from D5 ("Sent" when any recipient counts, even with stored status `failed`); section 7 forbids asserting the stored lifecycle in the retry scenario |
| R2-3 | Pending, exhausted and refused retries all render as "Phone unreachable - will retry" plus the Retry hint, inviting a double send | PARTIAL | No | With no pending state the pill/chip contradiction is gone. REJECTED new copy for exhausted/refused: a refused retry is unrecorded, so truthful wording is not derivable, and the same wording and Retry affordance are pre-existing on the conversation timeline (WP2 owns retries). D5(d) now names the limitation |
| R2-4 | Section 9 lets Cameron cut the retry rule that D6 depends on | ACCEPT | YES | The retry rule is not optional; section 9 asks Cameron to confirm it, with no cut option |
| R2-5 | "Latest attempt" is wrong when attempts overlap (a delivered staff Retry followed by a failed automatic attempt) | ACCEPT | YES | Any delivered attempt dominates (D5) |
| R2-6 | Hand-added tenants start unchecked but come back pre-checked after a re-preview; D5(a) and I4 encode the flip | ACCEPT | YES | A hand-picked tenant is a seed from the moment they are added and stays pre-checked, tag shown - one rule for every seeded row |
| R2-7 | D6 wording: "never a share whose attempt failed" and "a delivered retry re-counts" disagree with D5 | ACCEPT | No (wording) | D6 restated in D5's terms: a pair counts while any share of it counts; re-counts on a newly sent attempt or a new share; describes its latest counted share |
| R2-8 | I8 covers consent but not the deleted-contact gate (same phone-first lookup); opt-out is legitimately per number; silent on the staff Retry | ACCEPT | YES (I8 widened) | I8: consent AND deletion judged on the resolved recipient; opt-out per number; a staff Retry is an ordinary staff send with today's gates, and if refused it is not an attempt |
| R2-9 | The 30003 e2e scenario needs an injectable retry backoff, a dev seam section 5 never lists | ACCEPT | No (surface listed) | Section 5 lists the seam (relay precedent) |
| R2-10 | D4 does not say how a failed users-table read is treated; each option is bad | ACCEPT, resolved by removing the read | YES | D4: the authenticated draft route records at creation that the share is a person's share (its session was just verified as a staff user); the send job reads the record; absent = automated. No lookup on the send path, so no read-failure case, and a removed member's draft keeps its record |
| R2-11 | "Until someone closes it" names a remedy that does not exist | ACCEPT | No (wording) | D5 says the stuck share's queued slots count permanently; pre-existing, tracked in `throw-for-redelivery-defeated-by-job-marker` |
| R2-12 | The WP2 issue still says "shares that staff start" and uses the banned shorthand | ACCEPT | No (wording) | Issue reworded to "property sends staff create" and GLOSSARY nouns |
| R2-M13 nit | "every other skip goes to its own bucket" reads as one bucket per reason | ACCEPT | No | "one other-skipped bucket" |
| R2 claim-3 nit | "after creation only the breaker writes it" sits beside the import's if-absent write | ACCEPT | No | Reworded |

Decisions changed this round: R2-1, R2-2, R2-4, R2-5, R2-6, R2-8, R2-10. Round 3
required (same continued reviewer, re-review charge). Hard cap: round 4.
