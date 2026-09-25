# Spec review round 3 - adjudications

Spec v3 @fc89dd0a. Reviewer B continued (`spec-review-r3.md`, 8 findings). Every
code claim re-verified by the planner. Contested from round 2: R2-3, in part
(exhausted chains) - upheld by the reviewer with evidence and ACCEPTED here.

| # | Finding | Verdict | Decision changed? | What changed in spec v4 |
|---|---|---|---|---|
| R3-1 | Pre-branch retries never recorded the share; after the D6 repair the ledger counts a delivered-on-retry tenant while every D5 surface says not sent (double-text direction); D1 does not size it | ACCEPT | YES (repair remit, I7) | The post-deploy repair pass also reconciles historical shares' recorded attempts from message retry lineage, so the ledger and every D5 surface agree for history; D1 sizes those recipients; I7 names the repair's second write target |
| R3-2 | During a 30003 wait the derived label reads "Not sent" beside a row saying "will retry"; "none is in flight" is redundant or reintroduces pending; "Failed" never defined | ACCEPT (precision) | No | D5(e) label set is Sending / Sent / Not sent, derived only from D5 counting; "in flight" clause removed; the label reads "Not sent" during a retry wait by design (section 8 already accepts the window; the row explains the retry) |
| R3-3 | Contest of R2-3: an exhausted chain IS recordable (retry_attempt on the failed message), so a permanently false "will retry" on exhausted rows is avoidable; relay already has promise-free copy | ACCEPT the contest for exhausted chains | No (copy) | D7: 30003 with retries exhausted reads "Phone unreachable - retries exhausted"; with retries remaining keeps "will retry" (a refused retry stays the accepted limitation) |
| R3-4 | Overlapping attempts: an older `sent` plus a newer failed attempt is neither counted nor all-failed; the row shows the newest failure for a recipient counted by an earlier delivery; I9 does not say a delivery survives a later attempt | ACCEPT (precision) | No | D5: the row shows the outcome that decides the count (delivered if any attempt delivered, else the newest attempt); an older attempt still `sent` keeps the recipient eligible to count on its delivery (rule already says any delivered attempt counts; stated). I9: a recorded delivery is never erased by a later attempt |
| R3-5 | I8 silent on the automatic retry's gates; Do Not Contact sets only the contact flag, so claim 2's "opt-out is per number" overstates | ACCEPT (precision) | No | I8: the automatic retry is the existing retry job with today's gates (out of scope per non-goals). Claim 2 corrected: STOP and carrier suppression are per number; Do Not Contact is a contact flag |
| R3-6 | "Select all" unchecks already-sent rows including seeded ones, blocking Send in the one-to-one flow | ACCEPT (same rule, one more control) | No | D5(a)/I4: Select all keeps seeded rows checked |
| R3-7 | An enqueue-failed share reads "Not sent" with rows still "Sending..." and its only true explanation (the stored "enqueue failed" alert) suppressed | ACCEPT (precision) | No | D5(e): the stored failure alert is suppressed only when the derived label is "Sent"; a queued slot of a share that is not `sending` presents as "Not sent" |
| R3-8 | Storing up to four attempts per recipient changes the byte budget the 1500-recipient cap was sized on | ACCEPT (bound stated) | No | D5: the per-recipient record holds the newest attempt and whether any attempt delivered - never a list - so the recipient cap's budget grows by one small field |

Decisions changed this round: R3-1 only (the repair's remit and I7). Round 4 is
the hard cap; it runs as the terminal round. If it changes a decision, the open
findings go to Cameron with the spec.
