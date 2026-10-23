# S2 slice report - transition route and live notify (tracker #30)

Branch feat/unknown-inactive. Commits: e93c49ab (S2.1), b780bc40 (S2.2),
ee62140e (S2.3), b3d4560f (S2.4), 74d11b88 (S2.5), 4390f193 (S2.5b, OR-3),
d6f41875 (S2.6), 836992eb (S2.7), e39b88d5 (S2.8), cf9972d2 (S2.9 useContact
+ OR-5), 940c1313 (S2.9 second commit, OR-4).
Every task went RED for the plan's stated reason, then GREEN. `npm run
typecheck` exit 0 after every task that changed a type, export or import, and
at slice end. eslint on all 22 S2-touched files: exit 0. Dashboard
directories run at slice end (src/routes/today, src/routes/inbox,
src/routes/contact, src/api): 105 files, 2228 passed.

## Required records (plan S2.10 Step 3)

C2 - the bridge needs no change, confirmed. app/src/lib/eventBridge.ts:45
subscribes `for (const name of APP_EVENT_NAMES)`; app/src/routes/internal.ts:34
validates against `new Set(APP_EVENT_NAMES)`. Neither file changed. The only
bridge-side test change is app/test/eventBridge.test.ts:42-45 (9 -> 10, plus a
`toContain('contact.updated')`); app/test/internalRoute.test.ts gained a
contact.updated round trip that went RED as 400 before the event existed.

C4 - `contact.updated` is deliberately NOT in the harness recorder
(app/test/helpers/twilioWebhookHarness.ts:616-623): tests assert
`world.emitted` by exact equality after a status webhook and after a contact
PATCH, so recording it would turn those red for a reason unrelated to their
subject. Every S2 test subscribes its own listener. Citation correction
(WORKLIST D): the status-webhook exact assert is app/test/sse.test.ts:384
(base :364-387); the PATCH one is app/test/contactTriage.test.ts:151 (base
:85-96).

Vendor SDK import - app/src/services/statusTransition.ts:14 now imports
`ConditionalCheckFailedException` from `@aws-sdk/client-dynamodb`. Against the
letter of AGENTS.md "Vendor SDK imports belong in app/src/adapters", in line
with existing practice (precedent app/src/services/caseworkerConversion.ts:12).

StatusTransitionCommittedError path - no `contact.updated` when the write
committed and the required audit then failed (the route answers 500, an open
page is not notified). AR3 says "every successful call"; this is that
reading, pinned by the (PIN) case in app/test/statusTransition.test.ts.
TODO(suggestion-status-accept-contract-drift) (services/statusTransition.ts:235)
already tracks the 500.

Known extra reads, accepted. After the operator's own header change the
contact page applies the route's response and then re-reads once more on the
echoed `contact.updated`. A PATCH that changes the type and drains a type
suggestion emits both `suggestion.updated` and `contact.updated`, so useContact
re-reads twice (now latest-wins, OR-5). OR-4 adds one debounced timeline GET
per status/type change for the open contact. Each is one GET on a user action,
never on page load.

Writers that change status or type but emit no `contact.updated` (outside
AR3's two emitters; not changed, nothing filed per AR14):
- the caseworker conversion commit, app/src/services/caseworkerConversion.ts:533-547
  (emits suggestion.updated :373 and conversation.updated :391 only);
- the AI status-suggestion accept (journal path), app/src/routes/suggestions.ts:190-191
  (suggestion.updated only: Today refetches on it, the inbox does not);
- the derived tenant status, app/src/services/statusTransition.ts:352
  (deriveTenantStatus);
- the import (app/src/lib/import/apply.ts has no event bus).

W8 (plan round 2 R2P-4) - the Today/Inbox drop-without-reload rests on one
debounced refetch (dashboard/src/routes/today/useToday.ts:39, 300 ms; the
inbox's scheduleRefetch, useInbox.ts:553-559) over eventually consistent
reads: the (unknown, needs_review) byTypeStatus GSI at
app/src/routes/today.ts:870, the default GetItem behind the AR8 skip at
app/src/routes/today.ts:362, and the inbox Unknown-tab GSI read at
app/src/lib/unknownQueue.ts:350. Same pattern as conversation.updated.
DynamoDB Local is always consistent, so the e2e cannot see a stale read. A
known prod-only residual risk; no mechanism change.

Untrimmed input paths: none. `toStatus`, `status` and `type` are fixed keys
validated against allowlists; `contactId` is a path id.

## What the tree held that the plan got wrong / divergences

- app/src/routes/statusTransition.ts:263-268 (S1 report item 1): the plan's
  S2.4 Edit B anchored on the ASCII line :266 only and would have left :265's
  em dash and section sign beside the new text. Per the dispatch I replaced
  :265-266 WHOLE (now :266-269) with ASCII text naming the D1 lists (tenant,
  landlord, unknown needs_review|inactive, partner/team_member
  needs_review|active|inactive). Committed in S2.4 (b3d4560f).
- S2.5's anchors held exactly after S1 (AR24: the 'contact triaged' log call
  is unchanged at contacts.ts:2194-2197). S2.5 declares `priorType`
  (contacts.ts:1655); S1 declared none (AR16).
- S2.9 is two commits (the WORKLIST allows it): cf9972d2 useContact + OR-5,
  940c1313 useContactTimeline OR-4.
- S2.5b adds one (PIN) beyond OR-3's two REDs (see OR-3 below) and a
  comment-only edit of the 409 path's guard list (contacts.ts:1989-1993).

## WORKLIST items

- OR-3 (S2.5b, 4390f193). (i) `touchesStatus = 'status' in parsed.patch`
  joins the consistent-read condition (app/src/routes/contacts.ts:1637-1643).
  (ii) `statusTypeGuards` (:1686-1692) is `guardAsRead(stored, 'type')` when
  the body carries `status` and no `type`, `stored` exists, and the
  requirement guards hold no `type` clause; it joins the write's guards
  (:1974). A lost guard is the existing 409 contact_changed (:2003): nothing
  written, audited, timelined or emitted. Tests in the S1.1 status-only
  describe of app/test/contactTriage.test.ts: RED (1) :1164 re-type to
  landlord between the read and the write -> 409 contact_changed, stored
  (landlord, active), no milestone, no contact_updated audit, no
  contact.updated (old code: 200 and (landlord, inactive) stored); RED (2)
  :1154 first getById is `{ consistentRead: true }` (old code: no options);
  (PIN) :1197 a status + requirement body on a landlord carries exactly ONE
  `type` clause (catches a double push). Pin grep: no test in app/test pinned
  an eventually consistent read for a status-only body, so nothing flipped.
  The nearest pins, unchanged: contactTriage.test.ts:1003-1021 (type/role
  bodies consistent; its name-only arm stays eventually consistent) and the
  GET-only pins landlordRequirementsPatch.test.ts:68-88.
- OR-4 (940c1313). useContactTimeline subscribes `onContactUpdated` and calls
  scheduleRefetch only when the event names its own contact
  (dashboard/src/routes/contact/useContactTimeline.ts:545-550). The test's
  `lastHandlers` type is widened; RED - an event for the open contact refetches
  after the debounce; PIN - another contact's event does not (waited past the
  300 ms debounce).
- OR-5 (cf9972d2). `refetchInPlace` takes a `useRef` sequence number per
  re-read and drops a response that is no longer the latest
  (dashboard/src/routes/contact/useContact.ts:68-91). The RED was staged:
  with the plan's refetchInPlace in place but no sequence, the test (two
  events, the first GET answering LAST) failed because the late
  "Intermediate" contact overwrote "Final"; with the sequence it is GREEN.
  The initial-load fetch (useContact.ts:30-45) is not part of the sequence
  (unchanged). Residual, not changed: `setContact` (the operator's own save)
  does not bump the sequence, so a re-read issued before a save can land
  between the save and the echo re-read and briefly show the pre-save
  contact until the echo re-read lands.
- OR-20: every committed file's added lines are ASCII against 916258ae (each
  of the 22 files printed 0); `git diff -U0 916258ae -- app dashboard` prints
  0; `grep -c 'u2192' app/src/services/statusTransition.ts` prints 2.
- OR-22: a bare `git status` before every `git add`; at no commit was
  anything staged that I had not staged.

## Record-only lines (WORKLIST section D, S2 bullet)

- The PATCH's contact.updated emit (contacts.ts:2207-2213) follows
  non-best-effort awaits after the write (the linked-thread reads and
  applyTriage :2124-2139, the contact_updated audit :2170), so a committed
  write that then throws sends no event (s2-notify 2).
- W8 citations: today.ts:870 (GSI), today.ts:362 (GetItem), unknownQueue.ts:350
  (inbox Unknown-tab GSI read) - above (s2-notify 4).
- C4 citation correction - above (s2-notify 5).
- docs/issues/staff-notes-stale-page-overwrite.md:15-17 ("there is no contact
  SSE event, and `useContact` refetches only on `suggestion.updated`") is
  superseded by S2.9; resolved issue, no edit (AR14) (s2-notify 6).
- The D3 tenant-retype double contact.updated (the PATCH, then
  setTenantStatus) is handled by OR-5 on the contact page; Today, the inbox
  and the timeline coalesce it in their debounce (s2-notify 1).
