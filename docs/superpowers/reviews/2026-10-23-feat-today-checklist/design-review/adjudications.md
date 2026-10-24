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
</content>
</invoke>
<invoke name="Bash">
<parameter name="command">cd W:/tmp/today-checklist && git status --short && git add docs/superpowers/specs/2026-10-23-today-checklist-design.md docs/superpowers/reviews/2026-10-23-feat-today-checklist/design-review/spec-r1-reviewer-a.md docs/superpowers/reviews/2026-10-23-feat-today-checklist/design-review/spec-r1-reviewer-b.md docs/superpowers/reviews/2026-10-23-feat-today-checklist/design-review/adjudications.md && git commit -q -m "docs(spec,records): today-checklist spec r2 after design review round 1 - shares stop restarting the clock, Identify unknown-only (Cameron), call/relay stamp points, live emits, wire fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git log --oneline -1