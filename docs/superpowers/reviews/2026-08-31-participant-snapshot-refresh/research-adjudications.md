# Research adjudications - live-tree drift check (2026-09-01)

Inputs: `research-A-findings.md` (Today + Inbox), `research-B-findings.md`
(contacts / relay / roster), `research-C-findings.md` (webhooks / audit / e2e /
issues), `research-D-findings.md` (invariant sweep + repo facts), all committed
at a32fa7ed. Decided by the build orchestrator before the first slice. The
byte-exact reference behind each citation is run state
(`.superpowers/sdd/research-*-reference.md`); the merged per-task worklist the
implementers receive is `.superpowers/sdd/worklist.md`.

Code under the plan is byte-identical to b702a81c (only docs moved since), so
every plan line number was directly comparable. 28 findings; 0 rejected; 1
blocking (C-1); 2 accepted with a deviation from the plan text (C-5, D-F1).

| id | sev | finding (short) | decision |
|---|---|---|---|
| A-F1 | high | Task 3 relay RED value is `With Ann Tenant`, not `With Ann` (relayThreadLabel keeps the full name) | ACCEPT - red values corrected in the T3 brief; green values stand |
| A-F2 | med | Task 3 group RED array is `['With Ann & (404) 555-0112', 'With Ann & Marcus']` | ACCEPT - T3 brief |
| A-F3 | low | harness relay filter is :779 (key built :777) | ACCEPT - comment cites :777-781 |
| A-F4 | low | buildToday `formatPhone` is file-local | ACCEPT - no import |
| A-note | - | `.map(groupRowFor)` is point-free at :1237/:2358 | arrow wrappers declared LOAD-BEARING in the T3 brief |
| B-F1 | med | contacts.ts relay-groups region starts :1188 | ACCEPT |
| B-F2 | med | group-threads title assertion vacuous (first-token label) | ACCEPT - contact gets a different FIRST name (Marc Renamed) so the title pin is real |
| B-F3 | med | relayGroups.ts replace region :481-506 | ACCEPT |
| B-F4 | med | rosterEdits.ts phrase split across :454/:455 | ACCEPT - rewrap the docblock by hand, comments only |
| B-F5/6/7 | low | relayApi pins :427-448/:450-470; seedRelay :57; GET /conversations/:id handler :1996 | ACCEPT - informational |
| B-F8 | low | rosterActionsPoll.test.ts also reads describeRoster | ACCEPT - added to T6 verification |
| B-pins | - | zero preview recipient expectations move; a body change is unreachable | RECORDED - T6 still runs the suites and reports |
| C-1 | BLOCKING | Task 7 group-push test mutates a thread the webhook has not created yet | ACCEPT - redesigned: first post creates the thread, roster made stale, contact pushed, second post with a distinct MessageSid, assert `pushBroadcasts[1]` body; must be RED (`Old Ana: ...`) or STOP |
| C-2 | high | `status: closed` is not a valid issue status | ACCEPT - `resolved` + `resolved: 2026-09-01` |
| C-3/4 | high | audit lane run needs `AWS_ACCESS_KEY_ID=hclane<L>` and `--confirm` | ACCEPT - the lane run moves to the orchestrator's self-QA on a `full`-profile lane; T8 ships code + unit tests only |
| C-5 | high | Task 10's `N < 30 -> close` rule is invented; the issue demands perf:pages on the imported dataset | ACCEPT WITH DEVIATION: record the harness N as the spec asks, leave the issue OPEN, say why; the handback flags it as a spec deviation for Cameron |
| C-6 | med | README's `npm run e2e -- --grep` form does not forward | ACCEPT - `npm run e2e -w @housingchoice/e2e -- --grep "renaming a contact"` |
| C-7 | med | consolidate issue title/refs still say six | ACCEPT - title and refs updated with the body |
| C-8 | med | voice.ts:123-128 comment would contradict the new docblock | ACCEPT - T7 rewrites it |
| C-9/10/11 | low | persist site :1011; describe span :494-528; seed path is app/src/lib/seed/performance.ts; :890 is a template literal | ACCEPT - informational; the audit-number caveat is carried to the handback |
| D-F1 | med | `GET /api/conversations` (`toConversationSummary`) ships the stored name; Today's offline fallback renders it | OUT OF SCOPE by the spec's own text (S1 limits the client fallback to a guard; decision 4 forbids unnecessary reads). Named in the group-roster issue's residue and in the handback as a sub-threshold worry |
| D-F2 | low | SSE `conversation.updated` carries the raw roster; no consumer reads it | OUT OF SCOPE - named in the residue list |
| D-F3 | low | `relay_opted_out_members[].name` is a third snapshot | NO ACTION - today.ts:631-636 already applies the chain (contact -> stored -> phone) |
| D-F4 | low | spec calls the thread header "redundant"; it paints the stored name first, then converges | INFORMATIONAL - handback notes it |
| D-F5 | low | the real getDisplaysByIds never rejects | KEEP the T1 throw test, commented as a contract guard |
| - | trivial | contacts.ts `log` is :917 | noted |

Nothing here faults a spec DECISION. Every accepted item is plan text or a
fixture value; the two deviations (C-5, D-F1) both hold the spec's scope
narrower than the plan or a reader would have widened it, and both are
surfaced for the human rather than decided silently.
