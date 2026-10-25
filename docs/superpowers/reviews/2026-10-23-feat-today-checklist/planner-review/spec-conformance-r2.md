# Spec-conformance review, round 2 - feat/today-checklist (planner review)

- Reviewer: the round-1 spec-conformance reviewer (Claude Opus 5.5), continued.
- Authority: `docs/superpowers/specs/2026-10-23-today-checklist-design.md` r8 as
  amended at 8c833d33 (section 3, the truncated Quiet shares note).
- Change under review: `4508f61f..8c833d33` (48a6c8f2 PFW1-1, f941b098 PFW1-2,
  0826ba2b PFW1-3, 8c833d33 spec amendment). Also re-swept the whole branch state
  at 8c833d33 for anything round 1 (mine or adversarial.md) missed.
- Read: the fix diff, the amended spec section 3, `planner-review/adjudications.md`,
  `planner-review/adversarial.md`, and the touched and neighbouring source
  (Today.tsx, QuietShares.tsx, sendEmailMessage.ts, e2e/performance/routes.ts,
  e2e/support/today.ts, FollowUpView.tsx, services/followUps.ts,
  lib/seed/performance.ts, repos/messagesRepo.ts relayMemberKey,
  repos/toursRepo.ts). Plans and other review folders not read.
- Read-only: no test, build, npm or npx run; no state-changing git. ASCII only.

## Summary

| Verdict (points new or changed this round) | Count |
|---|---|
| CONFORMS | 9 |
| PARTIAL | 0 |
| MISSING | 0 |
| DEVIATES | 0 |

Round-1 table stands otherwise: 131 CONFORMS, 3 PARTIAL. Row 45 (the truncated
note) now conforms to the amended spec text.

| Severity (new findings this round) | Count |
|---|---|
| blocking | 0 |
| high | 0 |
| medium | 0 |
| low | 2 |
| info | 3 |

Headline: both fixes are correct, not merely plausible. The one thing nobody has
said yet is R2-1: PFW1-1 turns a CAP into a permanent state. Once more than 100
properties are available, Today can never read "All caught up" again, on any
load, until the walk is paged or the cap raised. That follows the amended spec's
letter. It is a product consequence Cameron should hear before merge, not a code
defect.

## 1. Spec point table (new or changed points)

| # | Spec point | Verdict | Evidence |
|---|---|---|---|
| R2-a | 3 (amended): note copy "Only the first 100 available properties were checked." | CONFORMS | dashboard/src/routes/today/QuietShares.tsx:38, 219-223 (note at 220) |
| R2-b | 3 (amended): the section shows the note even with no property lines | CONFORMS | QuietShares.tsx:189, 200-217 (the list is rendered only when properties > 0; the heading and help line always render) |
| R2-c | 3 (amended): a truncated read is never "All caught up" | CONFORMS | dashboard/src/routes/today/Today.tsx:513, 539 |
| R2-d | 2.1: an empty AND complete section is still not rendered | CONFORMS | QuietShares.tsx:189 (`properties.length === 0 && !quiet.truncated`); Today.test.tsx control case |
| R2-e | 2.3 / 2.5: the unavailable and fallback paths are unchanged by the fix | CONFORMS | QuietShares.tsx:165-181 run before the new branch; `quiet.truncated` is read only on status 'ok' |
| R2-f | 6.3: seeding (the first property open) still keys on the first property, not on the section's first render | CONFORMS | QuietShares.tsx:160-167; truncated-empty leaves `seeded` false |
| R2-g | 7.3 W3: stamp after SES accepts, at the row's instant, never failing the send; ONE contact.updated as the send's last event | CONFORMS | app/src/services/sendEmailMessage.ts:543-553; the adapter-throw path (472-481) still returns before any stamp |
| R2-h | 7.3: every post-send step failing still stamps; nothing marks the mail failed | CONFORMS | sendEmailMessage.ts:490-541 (each step is caught); app/test/sendEmailMessage.test.ts "every post-send bookkeeping step failing" |
| R2-i | 6.4: Follow up tab unchanged (fixer flag 2: the empty state is returned before the truncated note) | CONFORMS | dashboard/src/routes/broadcasts/FollowUpView.tsx:221-232 untouched, which is what 6.4 requires |

## 2. Findings

### R2-1 (low) - NEW: past 100 available properties, Today can never read "All caught up" again

- Spec: 1 "Today holds only things that must happen today"; 2.3 "All caught up shows
  when every CHECKLIST section (1-7) is empty and settled"; amended 3 "a truncated read
  is never 'All caught up'".
- Code:
  - app/src/services/followUps.ts:46, 146-164: the walk is capped at 100 and `truncated`
    is structural. It is true on EVERY load while more than 100 units are available.
  - dashboard/src/routes/today/Today.tsx:513, 539: `!quietTruncated` gates
    allCaughtUp.
  - QuietShares.tsx:189, 200-223: the section then renders a heading, the help line
    and the note, with no rows.
- Scenario: the org reaches 101 available properties. From then on, every Today
  load shows a "Quiet shares" section holding only "Only the first 100 available
  properties were checked." There is nothing the VA can do to clear it. The page
  never reads done, even on a day when every section is empty.
  - This differs in kind from the precedents the fix cites (R1-1 refresh failed,
    R3-1 past-tours reload failed). Those are transient unknowns that the next good
    load clears; this one is permanent.
  - It also puts a non-actionable item above the line, against rule 1.
- Why low: prod holds tens of available properties (spec 6.3/6.5), so it is not
  reachable today.
- Ask: put it in front of Cameron with the merge verdict. The real remedy is to page
  the Quiet shares walk past 100, or raise its cap; the Follow up tab can keep its
  own 100. That belongs in `docs/issues/today-quiet-shares-read-cost.md` (or a
  sibling) as the trigger to act on before available properties reach 100. No code
  change is required for this merge, because the code does what the amended spec
  says.

### R2-2 (low) - fixer flag 1: the perf-pages Today terminal has no state for the truncated-empty Quiet shares section

- Spec: 9 lists `e2e/performance/routes.ts` "(headings and All caught up)" among the
  pins to update deliberately.
- Code: e2e/performance/routes.ts:405-416. TODAY_TERMINAL counts as ready on any of
  the seven checklist LISTS, as empty on "All caught up", and as error on the three
  alerts. The truncated-empty state has no list, no "All caught up" and no alert:
  the note is `role="status"` (QuietShares.tsx:219).
- Scenario: a perf world with more than 100 available units and every checklist
  section empty. The sample reads `unknown` and fails as a misattributed
  ready_timeout.
  - Not reachable with today's seed. Base units are 16 (lib/seed/performance.ts:40),
    and any scale large enough for over 100 units also scales placements and tours,
    whose rows give the page a list.
  - `perf:pages -- local|hosted-dev` is human-run only.
- Fix (small): add the note to the terminal's settled set, for example
  `locator('text', 'Only the first 100 available properties were checked.')` as a
  ready alternative. Otherwise file it beside the existing perf-pages TODOs. Not a
  merge blocker.

### R2-3 (info) - fixer flag 3: `settling` ignores the truncated flag

- Code: Today.tsx:546. With Quiet shares truncated-empty, everything else empty, At a
  glance empty and past tours still `idle`, `settling` is true. The spinner shows
  ABOVE a rendered Quiet shares heading and note until past tours settle.
- Spec: 2.3 asks only that "All caught up" never flash; it says nothing about the
  spinner. The spinner is truthful here, because past-tours rows may still arrive.
- No change needed. If anyone touches it, the spinner comment ("a page with nothing
  else to show") is now slightly inaccurate.

### R2-4 (info) - the spec amendment did not update the Status / revision line

- Spec: docs/superpowers/specs/2026-10-23-today-checklist-design.md:3-12 still reads
  "r8 (2026-10-24 ...)". The 8c833d33 change to section 3 (line 196) is recorded
  only inline, as "(planner handback review ADV-1 ...)".
- The rule (never caught up when truncated) is normative and changes 2.3's
  behaviour, but 2.3 itself does not mention it, so a reader of 2.3 alone misses it.
- Suggest one clause in 2.3 ("...and the Quiet shares read was not truncated (3)")
  and a status note. Docs only.

### R2-5 (info) - the fix is right, and its tests pin the right things

- PFW1-1:
  - Today.test.tsx asserts the withhold AND the control: the same load read in full
    is caught up, with no Quiet shares heading.
  - QuietShares.test.tsx asserts the truncated-empty layout: heading, help line,
    status note; no list and no buttons.
  - Both would fail on the round-1 code. A regression to `return null`, or a dropped
    `!quietTruncated`, is caught.
- PFW1-2: the ordering test checks invocation order against the alias, queued->sent,
  the parked apply, lastSeen, touchLastActivity, the sent message.persisted and
  conversation.updated. It also checks that contact.updated is the very last emit.
  Correct against 7.3 "ONE live event per send operation, after its stamps".
- Correct, not just plausible: in sendEmailMessage.ts, nothing between the SES accept
  (line 470) and the stamp (line 552) can return early or throw. Every step (a)-(d)
  is caught, and the stamp runs on every sent path, the redirected path included
  (`effectiveConversationId` is used only for logs and the alias).

## 3. Fresh sweep - what else was checked this round

Areas I re-read for things round 1 and the adversarial review could have missed:

- Backfill relay and group slot keys: `relayMemberKey` returns the bare contactId
  for a contact member (repos/messagesRepo.ts:196-200), and `groupMemberKey` is
  `phone#<e164>` (services/groupMembers.ts:42-44). So
  backfill-last-reached-out.ts:345-355 folds real contactIds, and :373-375 resolves
  phone keys. Clean. If the key had been prefixed, the backfill would have skipped
  every relay stamp without a sound; it is not.
- Tours to book on deleted tours: tours have no soft delete (repos/toursRepo.ts),
  so `listByStatus('requested')` cannot surface a removed tour. Clean.
- Stale copy of the old note: none left in tracked source or docs. The only hits are
  in the gitignored `.superpowers/sdd/plan-drafts/S5.md`, and in a test comment that
  quotes the old text on purpose.
- PFW1-3 docs: both issue additions are accurate against the code they cite
  (useToday.ts fetchNow abort; today.ts tours_to_book sequential loop;
  useContact.ts / ContactCommsPane.tsx).
- e2e `expectTodayReady` (e2e/support/today.ts:45-49) waits only for the page
  heading, so the new state cannot wedge the e2e suite. Only the perf terminal
  (R2-2) is affected.

## 4. Contesting the adjudications

- SC-1: accepted. It is filed, transient and one round trip.
- SC-2: conceded. With no time join for nudges, `excluded_nudge_body` IS the count
  the backfill could not tell apart, and it is reported
  (backfill-last-reached-out.ts:147, 437). The over-exclusion needs a byte-identical
  catalog body.
- SC-3, SC-4, SC-5, SC-6: accepted as recorded residue.
- ADV-2 (stamp on provider acceptance): agree with NO CHANGE. Spec 7.3 "Edge rules"
  says it outright: "An SMS the provider accepts and that fails later keeps its
  stamp".
- ADV-3 (fail-open on an unreadable owner): agree with NO CHANGE. Spec 5.2 says "a
  thread whose owner cannot be resolved keeps today's behavior", and the code reads a
  failed read as "cannot be resolved" (today.ts:984-989). Failing closed would
  contradict that sentence.
- ADV-6 (the AI count caps at 20): agree. Spec 2.1 and 2.4 accept the 20 cap
  explicitly.
- ADV-1 ruling itself: the fix matches the ruling and the amended spec. My only
  contest is not the fix but its long-run consequence, which is R2-1. The ruling
  calls ADV-1 "not reachable in prod today", and R2-1 is the same reachability with
  a permanent outcome. That deserves a stated trigger in the issue registry, not
  silence.
