---
id: conversationdetail-members-mock-suite-flake
title: ConversationDetail group-view members test flakes in-suite (pass-alone, pass-on-rerun)
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-13
refs: dashboard/src/routes/conversation/ConversationDetail.test.tsx, dashboard/src/routes/conversation/ConversationDetail.tsx:183
---

**Problem.** One intermittent full-suite failure observed on a branch whose
dashboard/ tree was byte-identical to main (so main-side, not branch-induced):

    FAIL src/routes/conversation/ConversationDetail.test.tsx
      > ConversationDetail group view
      > renders the transcript reply box and the three Details cards
    TypeError: Cannot read properties of undefined (reading 'then')
      at ConversationDetail.tsx:183 getConversationMembers(...).then(...)

The getConversationMembers mock returned undefined for one call - the classic
pass-alone / fail-in-suite signature (cross-test mock state or an unmocked call
window under full-suite load). Solo run: 13/13 green. Immediate full-suite
re-run: green. Same family as the AppFrame/Inbox act() flake sighting
(2026-07-10) and the tour-reminders-panel e2e flake (filed).

**Second sighting (2026-07-17).** Different test case, same file, same class:
"HARD-disables the composer when the group is closed" failed once in a full
suite run during the flyer-full-info planner gate, on a tree whose
dashboard/src/routes/conversation/ dir is byte-identical to main (empty
feature diff). Solo run: 14/14 green. Full dashboard suite re-run: green.
Confirms the cross-test mock-state class is file-wide, not specific to the
members test - the audit suggested below should cover the whole describe.

**Suggested fix.** Make the members fetch mock unconditional for every render
path in that describe (or default-mock getConversationMembers at the module
level to a resolved empty roster), so a mount outside the arranged window can
never see undefined. Audit wouldn't hurt: any test in the file that renders the
group view without arranging the members call.
