---
id: contact-page-late-async-writes
title: ContactDetail's status and suggestion actions write their result onto whatever contact is on screen
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-17
refs: dashboard/src/routes/contact/ContactDetail.tsx:694, dashboard/src/routes/contact/ContactDetail.tsx:666
---

**Problem.** `ContactDetail` is RE-RENDERED, not remounted, when the route's
`contactId` changes - the shipped "composer isolation across contact-to-contact
navigation" test pins that. Several of its async actions resolve without checking
whether the contact they were pressed on is still the one on screen:

- the status action (`ContactDetail.tsx:694-713`): a failed status change on
  contact A renders "Couldn't update the status - please try again." on contact
  B's page if the operator navigates during the round trip;
- the suggestion accept/dismiss actions (`setSuggestionBusy` / `setSuggestionError`,
  around `:666-684`): same shape.

The `contactId` reset effect clears these fields on the change, so the carry-over
is not the bug - the LATE WRITE that lands afterwards is. What the operator sees
is an error (or a busy state) about work they did on a different person.

The page already has the right instrument and uses it for the AI-extraction
action (`pressGenerationRef`), and the `inbox-mark-unread` mission added a second
counter for the unread toggle after the adversarial reviewer confirmed the same
hazard there (`unreadGenerationRef`, `ContactDetail.tsx:230`, and the equivalent
mounted-instance guard in `routes/conversation/ThreadUnreadToggle.tsx`). These two
actions were simply never converted; they are pre-existing and outside that
mission's authorized scope, so they are filed rather than fixed.

**Suggested fix.** Give each async action its own generation counter, in the
shape the unread toggle now uses: capture at press time, bump in the `contactId`
reset effect, and on resolution write NOTHING if the generation has moved. Use a
counter PER ACTION rather than sharing one - a shared counter makes independent
actions cancel each other (an extraction press would swallow another action's
resolution).

Each fix is a few lines plus one test per branch; the existing FIX 8 tests in
`ContactDetail.test.tsx` are the template (start the action on A, switch to B
before it resolves, assert nothing renders on B).
