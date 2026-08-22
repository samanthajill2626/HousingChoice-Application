---
id: conversationdetail-members-mock-suite-flake
title: ConversationDetail group-view members test flakes in-suite (pass-alone, pass-on-rerun)
type: bug
severity: low
status: resolved
area: dashboard
created: 2026-07-13
resolved: 2026-08-21
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

**Promoted to a scheduled fix (post-mortem #2, 2026-07-17).** Third
sighting this week across two missions (different test cases, same class);
now the dominant gate-noise source - each occurrence costs a triage cycle.
The module-level default-mock fix below is approved work, sized as a small
slice.

**Third sighting (2026-07-21).** Same shape (getConversationMembers mock undefined -> .then TypeError) in the "HARD-disables the composer when the group is closed" case during the unit-photo-transcode planner gate run (full dashboard suite); passed solo 16/16 immediately after on the same commit (040951e1). Untouched surface.

**Fourth sighting (2026-08-03).** Identical shape and case ("HARD-disables the composer...", `.then` TypeError at ConversationDetail.tsx:193) during the relay-area-code-preference gate run; branch touches zero dashboard files. Solo: 1 file green; immediate full `npm test` re-run: green (221/133/32/13). Still the approved-but-unscheduled module-level default-mock fix.

**Resolution (2026-08-21, `fix/test-suite-hardening`).** The module-level API
mocks are now built with promise-returning defaults - `vi.fn(async () => [])`
rather than a bare `vi.fn()`.

Root cause, stated precisely: Vitest 3's `mockReset()` restores the
implementation passed to `vi.fn(impl)`, but a BARE `vi.fn()` returns `undefined`
after reset. Verified rather than assumed - a scratch test confirmed both halves.
So any call landing outside the arranged window (a render during `beforeEach`'s
reset-then-rearm, or an SSE handler firing after a test's arrangement is gone)
got `undefined`, and the component died on
`getConversationMembers(...).then(...)`.

Giving each awaited mock a resolved default makes that window structurally
unreachable while `beforeEach` still overrides them per test. Applied to every
mock the component awaits on an effect path, which is the file-wide audit the
issue asked for rather than a fix for the one named test. 38/38 green.

This one is a genuine fix rather than a re-measurement: the undefined return was
reachable by construction, not a timing guess.
