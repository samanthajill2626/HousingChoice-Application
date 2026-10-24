# Spec design review - adjudications

Spec: `docs/superpowers/specs/2026-10-23-today-checklist-design.md`.
Reviewers: A (`spec-r1-reviewer-a.md`) and B (`spec-r1-reviewer-b.md`), both
opus, same brief, independent. ACCEPT = the spec was edited; REJECT = no edit,
with the reason; DEFER = filed.

## Round 1 (spec r1 @f58d7b71 -> r2)

Two findings were put to Cameron as decisions (2026-10-23), and he took the
recommended option on both:

- Shares restarting the clock (A5, B18, B14, A5's W8-vs-7.2 point): "Shares
  don't restart". Shares and broadcasts no longer stamp `last_reached_out_at`;
  each share runs its own clock from its own `sentAt`. DECISION CHANGED.
- Identify membership (A9, B1): "Unknown type only". Identify rows only for
  owners of type `unknown`; team member and typed owners' unknown_1to1 threads
  emit no Today row. DECISION CHANGED.

| Finding | Verdict | What changed / why |
|---|---|---|
| A1, B3 live-update premise false (tour create emits nothing; calls and queued relay posts emit no conversation.updated) | ACCEPT | Verified `routes/tours.ts:404-418` and no emit in `routes/units.ts`. Section 8 rewritten: add `tour.updated` on both create paths; stamp helper emits `contact.updated` after a stamp; time-based appearance stated. DECISION CHANGED (new emits). |
| A2, B11 unknowns cannot be cleared from their page | ACCEPT (copy) | Verified `UnknownFile.tsx:7-9`. Unknowns stay in scope (Cameron's ruling: everything on the Follow up tab). 6.2 now states how an unknown leaves (reach out, identify, Inactive) and drops the false justification. A Properties sent list for unknowns is a non-goal. |
| A3, B10 Tours to book unbounded, no age-out | REJECT | An unbooked request is exactly the must-do the section exists for: book it or cancel it. Prod read-only count 2026-10-23: 13 requested, 11 aged 0-9 days, one 17, one 64 - no flood. The blast-rules 14-day bound (`broadcasts.ts:707-725`) answers a different question (is a request still a live HOLD on audiences). Row shows "Requested N days ago" so stale ones get canceled. Recorded in 5.4. |
| A4, B2 tour rows need time and property on the wire; tours today sorted by name | ACCEPT | `TodayItem` gains optional `at` and `unitLabel`; router gains a units repo; Tours today ordered by time. DECISION CHANGED (wire). |
| A6, B4 call stamp at originate rings the staff cell first | ACCEPT | Verified `originateCall.ts:153-198`. W6 stamps in the outbound whisper-gate branch when the `<Dial>` to the target is returned, after the DNC re-check. DECISION CHANGED (writer location). |
| A7 staff-written relay intros classed as system | ACCEPT | New W7: an intro whose `intro_body` staff wrote stamps like a team post. Default intro copy stays system. |
| A8, B8, B9 past tours: count includes deleted tenants; off-range rows' place in oldest-first | ACCEPT | 5.3: label every Past row so the count is what Today qualifies; off-range rows go last. Verified `useTodayPastTours.ts:52-56`, `useTours.ts:317-321`. |
| A10, B12 existing tests that pin the old page not listed | ACCEPT | Section 9 lists them as a floor; accessible-name pattern stated in section 2. |
| A11, B13 cost of running the Follow up computation per load; truncated flag | ACCEPT (partly) | 6.5 states the read budget; wire carries `truncated`. No cache now (prod has tens of available properties); a docs/issues entry records the follow-up. |
| B6 no mechanism to get last_reached_out_at out of buildFollowUps without changing its wire | ACCEPT | 6.1: split buildFollowUps into an internal core + the unchanged Follow up projection; subset reasoning stated. |
| B7 failure isolation scoped to the contacts read only; tours read has no posture | ACCEPT | 2.5: ANY throw in quiet shares or tours to book makes that section unavailable; route stays 200; `toursToBook` status on the wire. |
| A12 W1 cannot stamp the judged recipient at the route; stamp races the event | ACCEPT | W1/W2 stamp inside `sendMessage` behind a staff-outreach option; `contact.updated` after the stamp closes the race. |
| B5 stamps land after the triggering SSE; calls trigger no refetch | ACCEPT | Same fix as A1/A12 (post-stamp `contact.updated`). Inbound order marked UNVERIFIED for the plan to check per path. |
| A13, B15 seed derivation contradicts "no stored field separates staff" | ACCEPT | W11 dropped: seeds carry no `last_reached_out_at`; tests drive a real staff send. |
| A14, B17 fallback contradictions; fallback can claim All caught up | ACCEPT | 3.1: fallback emits its unknown rows in `identify`; a fallback load counts quiet shares and Tours to book unavailable, so no "All caught up". |
| A15 type filter order vs deleted-contact skip | ACCEPT | Section 4: type filter first. |
| A16, B16 Identify oldest-first over capped reads; capped counts | ACCEPT (stated) | 5.2 and 2.1 state the caps; volume is 8. |
| A17 slogans (subtitle overclaims; lower section "never largest" unenforced) | ACCEPT | Rule 2 names the two badge-covered exceptions; subtitle adds "New messages are in the Inbox."; "never largest" replaced by what keeps it small. |
| A18a, B19a touch result is 'written', not 'moved' | ACCEPT | 7.3 corrected; pointer-row guard named. |
| A18b four places, not three | ACCEPT | 7.3 lists all four, create path included. |
| A18c per-phone suppressed relay members stamped without receiving the post | ACCEPT | W4 stamps per leg SENT in the relay fan-out, so a suppressed member (no leg) is not stamped; this also makes a queued post stamp when it actually goes out. DECISION CHANGED (writer location). |
| A18d 2026-06-16 dashboard design doc not superseded | ACCEPT | Header note + section 10. |
| B19b no refresh when a share crosses its threshold | ACCEPT (stated) | Section 8, last bullet. |
| B19c first-open-property ambiguity | ACCEPT | 6.3 opening rule rewritten. |
| B19d canceled requested tour reappears in quiet shares | ACCEPT (stated) | 5.4: intended. |
| B19e subtitle overclaims | ACCEPT | As A17. |

Round 1 changed decisions (two by Cameron, five by adjudication), so round 2
runs. Reviewer A is continued for round 2 (both landed similar accepted
counts; A found the unique relay-intro and suppressed-member surfaces).
<invoke name="Bash">
<parameter name="command">cd W:/tmp/today-checklist && git status --short && git add docs/superpowers/specs/2026-10-23-today-checklist-design.md docs/superpowers/reviews/2026-10-23-feat-today-checklist/design-review/spec-r1-reviewer-a.md docs/superpowers/reviews/2026-10-23-feat-today-checklist/design-review/spec-r1-reviewer-b.md docs/superpowers/reviews/2026-10-23-feat-today-checklist/design-review/adjudications.md && git commit -q -m "docs(spec,records): today-checklist spec r2 after design review round 1 - shares stop restarting the clock, Identify unknown-only (Cameron), call/relay stamp points, live emits, wire fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git log --oneline -1
## Round 2 (spec r2 @e6b5a3cb -> r3), reviewer A continued

Reviewer A conceded the round-1 REJECT of A3 (Tours to book unbounded): the
prod count and the "Requested N days ago" text justify it.

| Finding | Verdict | What changed / why |
|---|---|---|
| R2-1 W6 awaited stamp between press-1 and the Dial; target resolution drops the contactId | ACCEPT | W6 stamps after the TwiML response is sent; `resolveOutboundTarget` carries the contactId. Writer timing changed. |
| R2-2 W7 points at the wrong loop (intro goes through sendRelayAnnouncement) | ACCEPT | W7 stamps in `sendRelayAnnouncement`'s member loop, gated on the intro kind + staff-edited body. |
| R2-3 manual Retry of a failed share text stamps | ACCEPT | W2 excludes a retried row carrying `broadcast_id`. |
| R2-4 post-stamp event still races an eventually consistent BatchGet | ACCEPT | Today's call to the contacts batch passes `consistentRead: true`. DECISION CHANGED (read mode). |
| R2-5 one contact.updated per relay leg multiplies reloads | ACCEPT | One event per send operation: contact.updated for 1:1/email/call, one conversation.updated per relay/group post after its loop. DECISION CHANGED (event mechanism). |
| R2-6 W5 stamps suppressed group-text members | ACCEPT | W5 skips slots seeded `excluded`. |
| R2-7 per-leg stamp location, queued-post instant, sent_unrecorded, reconcile adoption | ACCEPT | W4 stamps in the fan-out loop (not `sendOneRelayLeg`), on sent or sent_unrecorded, at leg send time; reconcile relay-leg adoption does not stamp. |
| R2-8 2.5 vs 3 contradiction on unit lookups | ACCEPT | 2.5: a label lookup failure degrades to the unitId. |
| R2-9 help line and 6.2 copy made untrue by r2 decisions | ACCEPT | Help line adds "sending another property does not"; 6.2 no longer says identifying removes the row. |
| R2-10 #30 active-team-member pin tests are inverted, not moved | ACCEPT | Section 9 names them. |
| R2-11 labeling every Past row re-reads tenants on every tour.updated | ACCEPT (stated) | 5.3 states the cost (~23 point reads per debounced reload). |
| R2-12 fallback shows two section errors it never tried | ACCEPT | 2.5: one "Some sections can't load right now." line on the fallback. |

Round 2 changed decisions (read mode, event mechanism), so round 3 runs.

## Round 3 (spec r3 @2f58ebcb -> r4), reviewer A continued - TERMINAL

| Finding | Verdict | What changed / why |
|---|---|---|
| R3-1 the worker's after-loop conversation.updated must come from a fresh consistent read (consumers set unread_count from it); relayFanOut has no event bus; no touchLastActivity | ACCEPT | 7.3 states all three. Precision of the r3 mechanism, not a new decision. |
| R3-2 getRecipientDisplaysByIds has no consistentRead option today | ACCEPT | 6.1 corrected: an interface change + FollowUpsDeps pass-through + fakes. |
| R3-3 W5/W7 stamp timing relative to existing emits | ACCEPT | 7.3: W5 stamps before its existing emit; W7 takes the after-loop fresh-read event. |
| R3-4 W6 post-response stamp needs an awaitable test seam | ACCEPT | Section 9. |

No finding changed what gets built (the reviewer agreed: "this round can be
terminal"), so the review STOPS here after 3 rounds.

Totals: round 1 37 findings (A 18, B 19, overlapping), round 2 12, round 3 4.
One REJECT in total (A3/B10 Tours to book unbounded), conceded by reviewer A in
round 2. Two findings went to Cameron as decisions (shares do not restart the
clock; Identify unknown-only).

## Round 4 (backfill section 7.5 only, added at the spec gate) - spec r5 @28d33501 -> r6

Cameron added the backfill at the spec gate (2026-10-24); round 4 reviewed only
section 7.5. All eight findings ACCEPTED and folded into 7.5:

| Finding | Change |
|---|---|
| R4-1 call filter counts calls never dialed | calls count only with `answered_at` or a `call_outcome` |
| R4-2 slot status does not mark a sent leg; group slots keyed by phone, 'excluded' marks suppression | relay: slot sid / sent instant; group text: resolve phone -> contact, skip 'excluded' |
| R4-3 Quo rows pass relay and call categories | every category requires `author` 'teammate' and no `imported_from` |
| R4-4 one-to-one category must be typed; queued emails | type sms/mms/email; email only once it left for SES |
| R4-5 staff-edited intros are stored as 'system' | plan picks body-match or skip; dry run reports it |
| R4-6 read the window by sort key, keep the full scan | key-condition Query `tsMsgId >= floor`; no last_activity_at pre-filter |
| R4-7 pre-deploy run leaves a gap | run AFTER the deploy |
| R4-8 Send-now rows: approximate join available | plan picks join or count; dry run reports it |

R4-1 and R4-2 change what the backfill stamps, but both correct the filters
inside the human's backfill decision; neither changes the design of the
feature. Round 4 is the cap; the review ends here, and the spec stands as r6.
