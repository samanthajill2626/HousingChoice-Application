# Contact comms pane - person-centric 1:1 tabs on tour and placement pages

- Date: 2026-08-03
- Status: approved (Cameron, this session)
- Branch: feat/contact-comms-pane  Worktree: w:/tmp/contact-comms-pane

## Problem

The Tenant and Landlord/PM 1:1 tabs on the tour page (TourConversation) and the
placement page (PlacementConversation) are NOT the contact page's comms pane,
even though staff expect them to be. They are single-conversation transcripts
built on useRelayThread, whose mapper `toTimelineMessage` drops `type: 'email'`
and `type: 'call'` rows by design (correct for relay groups, wrong for 1:1s),
and whose channel resolution binds each tab to ONE arbitrary conversation (the
contact's first non-relay conversation on the inbox page).

Observed + latent bugs this causes on those tabs:

1. Emails invisible (reported). Inbound email threads into the contact's phone
   1:1 server-side (tier 6 in inboundEmail.ts), lands in exactly the fetched
   conversation, and is then dropped client-side. Worse variant: a contact
   whose email arrived before any text has a SEPARATE email-keyed conversation
   the tab never fetches.
2. Calls invisible - same drop line (sibling of the open
   `inbound-calls-invisible-in-inbox` issue; this spec fixes the tour/placement
   surfaces, not the inbox surface).
3. Multi-phone contacts: each phone number is its own conversation by design;
   texts from the non-bound number are invisible.
4. The tab shows an unread dot for messages the transcript never displays
   (inbound email bumps unread_count).
5. No Upcoming section: 1:1-routed tour reminders do not show on the tour page
   itself (useRelayThread's scheduled bucket is empty for 1:1s by design).
6. Missing composer features: no reply-target picker, no email compose, no
   retry-failed-send.

The contact page has none of these problems because it renders the server-merged
person-centric timeline (`GET /api/contacts/:id/timeline` - all 1:1
conversations across every phone AND email address, plus calls, milestones,
upcoming) through the shared `<Timeline>`, which already renders EmailCard and
CallCard.

## Decision (approved)

Make the tenant/landlord 1:1 tabs on tour and placement pages the SAME
person-centric comms pane as the contact page, by extracting that pane from
ContactDetail into a shared component. Full parity was chosen over
"comms-only + this-tour pins": the tabs show all the person's milestone pins
and the Upcoming bucket, with the existing "Comms only" toggle to quiet pins.

Rejected alternatives:
- Just stop dropping email/call in useRelayThread: leaves bugs 3-6 and the
  arbitrary-conversation binding in place.
- Client-side multi-conversation merge in the tour hooks: reimplements the
  /timeline endpoint, badly.

## Design

### 1. New shared component: `ContactCommsPane`

Location: `dashboard/src/routes/contact/ContactCommsPane.tsx`.

Owns everything between "I have a contact + a timeline state" and "a working
comms pane". Moves IN from ContactDetail (move-shaped extraction - the logic
already exists and is hook/util-factored):

- Reply-target resolution (`buildReplyTargets`, selected target state, default
  target, `replyToPhone` footer value, `canSend`).
- Optimistic SMS/MMS send (`postSend` + `onSend`): ensureContactConversation
  create-on-demand for a contact with no thread yet, addOptimistic /
  resolveOptimistic / failOptimistic, synchronous draft clear.
- Email compose + send (`onSendEmail`): existing-email-thread preference,
  phone-thread fallback, `ensureEmailConversation` fallback for phoneless
  contacts, optimistic EmailCard.
- Retry-failed-send (`onRetry`).
- Just-in-time consent gate: 409 `contact_no_consent` -> ConsentCaptureModal
  holding the pending send, deferred retry via `deferredSend`, clear-draft
  signal on success.
- The composer-triggered "Manage email" dialog (EmailManager). The pane calls
  an `onContactUpdated` callback after a save so the OWNER of the contact
  state refreshes (ContactDetail: its useContact; tour/placement pages: their
  contact fetch). ContactDetail's file-pane "Manage email" entry stays where
  it is.
- The `<Timeline>` invocation with the full prop surface (replyTargets,
  selectedConversationId, onSelectTarget, canSend, onSend, onRetry, optedOut,
  clearDraftSignal, emailChannel, upcoming, source, resetScrollKey).

Props (the boundary):

- `contact: Contact` - the person. The pane derives phones, emails, optedOut,
  emailSuppressed itself (contactPhones / contactEmails / flags), so callers
  pass one object.
- `timeline: ContactTimelineState` - the CALLER runs `useContactTimeline`.
  Rationale: ContactDetail derives "Media from comms" (commsMedia) and calls
  `timeline.refetch()` after on-page mutations from OUTSIDE the pane; keeping
  the hook in the caller preserves that without a second fetch or a callback
  maze. Tour/placement pages simply call the hook for the active tab's
  contact.
- Carry-overs the tour page needs: `initialDraft?` / `onDraftSeeded?` (no-show
  check-in seed), `resetScrollKey`. `clearDraftSignal` becomes INTERNAL to the
  pane (its only current use is the consent retry, which moves in).
- `onContactUpdated?: () => void` (EmailManager save).

NOT in the pane (stays in ContactDetail): header band, file pane, suggestion
chips, status pill, opt-out toggles, phone manager, page-level
useMarkContactRead, media gallery, delete/restore, edit form.

### 2. Tour and placement pages

- TourConversation / PlacementConversation keep the three-tab rail, the group
  tab (unchanged: useRelayThread + roster + closed state + this-tour milestone
  interleave), the initial-tab rule, and lazy mount of only the active tab.
- Tenant/Landlord tabs render `<ContactCommsPane>` for the tab's contact
  (tour.tenantId contact / unit.landlordId contact), keyed by contact so
  tab switches REMOUNT (draft isolation - same reason as today's keying).
  `ContactThread`, `NewContactThread`, and the duplicated pendingConsent +
  ConsentCaptureModal plumbing in BOTH files are deleted (the pane owns
  consent now). The "no thread yet" special case disappears: the pane handles
  zero-conversation contacts (first send creates the thread).
- The no-show check-in seed keeps its exact behavior: nonce -> switch to
  Tenant tab, remount with `initialDraft`, cleared once consumed.
- The this-tour milestone injection (`withMilestones`) is REMOVED from the 1:1
  tabs only - the person feed already carries tour/placement lifecycle events
  as milestones (tours.ts / placements.ts / statusTransition.ts write activity
  events; activity-coverage is merged), so keeping both would duplicate pins.
  The GROUP tab keeps the injection (relay threads are excluded from the
  person feed on purpose).
- Landlord-unresolved and contact-load-failure states: keep an empty-state
  message in the tab (the pane requires a loaded contact).

### 3. Unread dots + mark-read

- `useTourChannels` / `usePlacementChannels`: the group channel is unchanged.
  For tenant/landlord the conversation-RESOLUTION logic (`one21`, merge,
  setConversationId injection for 1:1s) is deleted; each tab's unread becomes
  the SUM of `unread_count` across the contact's non-relay conversations on
  the inbox page (same data source as today, sum instead of first-match).
  Existing first-page-only limitation is accepted and unchanged.
- Viewing a 1:1 tab marks the PERSON read via the contact fan-out endpoint
  with a new scope flag (section 4), on the same triggers as the contact page
  (mount while visible, visibility regain, message-persisted while viewing) -
  extend/reuse `useMarkContactRead` with an options bag rather than forking
  it. It must NOT clear the relay group's unread (the Group tab dot and the
  inbox group row must survive viewing a 1:1 tab).
- The group tab keeps single-conversation mark-read
  (`markConversationRead`), exactly as today.

### 4. Server change (the only one)

`POST /api/inbox/:contactId/read` accepts an optional `scope: '1to1'` (JSON
body field). When set, the fan-out filters `type !== 'relay_group'` from the
`conversationsForContact` result before resetting unread. Default behavior
(no scope) is byte-for-byte today's - the contact page does not change.
The unknown-number `POST /api/inbox/read` route is untouched.

Client: `markInboxRead` gains the optional scope param.

### 5. Honesty cleanup

`useRelayThread` returns to being genuinely relay-only. Its email/call drop
comment no longer needs the "defensively" hedge; update the comment to state
the invariant plainly (relay threads never carry email/call 1:1 content).
No behavior change in that file.

## Invariant surfaces (enumerated per the pipeline rule)

Protected state A: conversation `unread_count`.
- Mutators: inbound SMS/MMS append (twilio webhook), inbound email append
  (inboundEmail.ts), call rows (voice webhooks), single-conversation read
  (POST /api/conversations/:id/read), contact fan-out read
  (POST /api/inbox/:contactId/read - MODIFIED here), unknown-number fan-out
  read (POST /api/inbox/read), reseed.
- Readers/renderers: inbox rows + filters, nav unread badge, tour tab dots
  (useTourChannels - MODIFIED), placement tab dots (usePlacementChannels -
  MODIFIED), contact page useMarkContactRead, SSE conversation.updated
  consumers.

Protected state B: 1:1 comms visibility (which surfaces render a person's
messages/calls/emails).
- Renderers: contact page pane (MODIFIED - extraction, must not regress),
  tour 1:1 tabs (MODIFIED), placement 1:1 tabs (MODIFIED), relay-group view
  ConversationDetail (must stay relay-only; inbox routes 1:1 rows to the
  contact page, verified), inbox row last-message previews (untouched), Today
  page reads (untouched).

Plan rule: every MODIFIED surface above gets an explicit task or watch item;
the untouched ones get a no-change assertion in review.

## Testing (Cameron: "significant testing to make sure we don't lose
functionality")

Gates: `npm run typecheck` + `npm test` + `timeout 1500 npm run e2e`, bare,
from the worktree, green on current main at handback.

Unit:
- ContactCommsPane: port/adapt ContactDetail's existing comms-pane tests to
  the extracted component (send, email send + fallbacks, retry, consent 409
  flow, reply targets, canSend for zero-conversation contacts).
- ContactDetail: page still composes header/file/pane; media-from-comms and
  refetch-after-mutation still work against the caller-owned hook.
- useTourChannels / usePlacementChannels: aggregate unread sums across
  multiple non-relay conversations (incl. an email-keyed one), group channel
  untouched, markRead scoping.
- inbox route: scope='1to1' skips relay_group; absent scope preserves today's
  fan-out exactly.
- TourConversation / PlacementConversation: tab switching, no-show seed,
  empty states - updated for the new pane.

E2e (extend existing specs; reuse the email-channel fixtures for inbound
email):
1. An email exchanged with a tenant is visible in the tour page Tenant tab
   and in the placement page tab (EmailCard rendered).
2. Viewing the Tenant tab clears its unread dot WITHOUT clearing the Group
   tab dot or the inbox group row unread.
3. The tour page Tenant tab shows the tour's own upcoming reminders in the
   Upcoming section.
4. Sending SMS from a tour 1:1 tab still works end-to-end (outbox
   assertion), including for a tenant with no prior conversation.
5. Contact page comms pane regression: the existing contact-page e2e specs
   pass unchanged (they are the extraction's safety net).
- Multi-phone visibility (bug 3) is covered at unit level via the timeline
  endpoint contract unless an e2e fixture already seeds a two-number contact
  cheaply.

Live self-QA (harness per profile): drive a tour page, verify email + call
rows render in the Tenant tab, tab dots behave, composer targets correct,
group tab unchanged; screenshot evidence.

Known flakes to honor: tour-reminders-panel-e2e-flake,
conversationdetail-members-mock-suite-flake (re-run before blaming).

## Out of scope

- ConversationDetail / relay-group rendering (correct today).
- Inbox surfacing of calls (`inbound-calls-invisible-in-inbox` stays open for
  the inbox; note this spec on it at handback).
- Server-side email threading rules, quiet hours, anything in worker jobs.
- Pagination of the channel hooks beyond inbox page 1 (pre-existing).

## Post-merge obligations

None expected (no deps, no infra, no schema/GSI change; the inbox route gains
an optional body field only).
