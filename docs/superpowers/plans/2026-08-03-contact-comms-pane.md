# Contact Comms Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tenant/landlord 1:1 tabs on tour and placement pages the
contact page's person-centric comms pane (emails, calls, all threads,
milestones, upcoming, full composer), backed by a completed person activity
feed (dual-party tour/placement events).

**Architecture:** (1) Server write-side completion: tour/placement lifecycle
activity events recorded against BOTH tenant and the unit's landlord;
tour_group_opened/tour_converted become person events; the landlord
property-audit interleave drops its now-redundant tour pins. (2) Extract
ContactDetail's comms machinery into a shared `ContactCommsPane`; tour and
placement pages mount it per 1:1 tab via a thin `ContactCommsTab` wrapper
that owns `useContactTimeline`. (3) Channel hooks stop resolving 1:1
conversations - tabs aggregate unread and mark the PERSON read.

**Tech Stack:** Express 5 + DynamoDB repos (app), React 19 + vitest
(dashboard), Playwright (e2e). ESM throughout - relative imports end `.js`.

**Authoritative spec:** `docs/superpowers/specs/2026-08-03-contact-comms-pane-design.md`
(v4). Where this plan and the spec disagree, the spec wins; flag the
discrepancy in the slice report. Spec file:line refs may drift a few lines -
they are anchors, not gospel.

## Global Constraints

- Gates (bare, real exit codes, NEVER piped): `npm run typecheck`,
  `npm test`, `timeout 1500 npm run e2e` - e2e only from the worktree.
- ASCII-only in every added line (specs, tests, labels, comments):
  `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0.
- Commit discipline: bare `git status` read before EVERY commit; stage and
  commit by EXPLICIT pathspec; Co-Authored-By trailer naming the authoring
  model.
- Never rewrite source files with PowerShell Get-Content/Set-Content - Edit
  tool only.
- No new deps. No infra commands. No message-catalog changes needed (activity
  labels are dashboard-facing pins, not automated outbound copy - keep the
  existing inline-label convention of activityEvents.record callers).
- `unit` in code/data; "property" only in human-facing landlord/staff copy.
- Milestone labels: some EXISTING label literals contain a real
  arrow character ("Stage -(arrow)- ..." in statusTransition.ts/history.ts).
  Do not add NEW non-ASCII of your own; when a new label parallels an
  existing one, copy the neighboring code's exact literal (the ASCII rule
  binds ADDED lines you author, not pre-existing literals you reuse).

## File Structure (locked decomposition)

Server:
- Modify `app/src/repos/activityEventsRepo.ts` - two new ActivityEventType members.
- Modify `app/src/routes/tours.ts` - recordTourEvent dual-party; group-open person events.
- Modify `app/src/routes/placements.ts` - recordPlacementMilestone dual-party; tour_converted person events.
- Modify `app/src/services/statusTransition.ts` - recordStageMilestone dual-party (uses existing deps.unitsRepo).
- Modify `app/src/routes/contactTimeline.ts` - LANDLORD_FEED_TYPES minus tour_*; delete dead unitAuditToMilestone tour branches.
- Modify `app/src/lib/seed/history.ts` - tourMilestones/placementMilestones vocabulary + landlord party.

Dashboard:
- Modify `dashboard/src/api/types.ts` - TimelineMilestoneType members.
- Modify `dashboard/src/routes/contact/Timeline.tsx` - milestoneVariant/milestoneHref entries; controlled commsOnly pair.
- Create `dashboard/src/routes/contact/ContactCommsPane.tsx` - the shared pane (send/email/retry/consent/EmailManager/deleted-lock + Timeline mount).
- Create `dashboard/src/routes/contact/ContactCommsTab.tsx` - tour/placement per-tab wrapper (owns useContactTimeline; loaded-contact gate).
- Modify `dashboard/src/routes/contact/ContactDetail.tsx` - left pane becomes a ContactCommsPane call.
- Modify `dashboard/src/routes/tours/useTourChannels.ts` + `dashboard/src/routes/placements/usePlacementChannels.ts` - state shape, aggregate unread, markPersonRead.
- Modify `dashboard/src/routes/tours/TourConversation.tsx` + `dashboard/src/routes/placements/PlacementConversation.tsx` - mount ContactCommsTab; delete ContactThread/NewContactThread/consent plumbing; keep group tab.
- Modify `dashboard/src/routes/conversation/useRelayThread.ts` - comment honesty only.

Tests named per task below. E2e: extend `e2e/tests/dashboard-next/` +
`e2e/tests/flows/` specs per Slice 6.

---

## Slice 1 - server write-side completion

### Task 1.1: New activity event types + dashboard mapping

**Files:**
- Modify: `app/src/repos/activityEventsRepo.ts:31` (union)
- Modify: `dashboard/src/api/types.ts` (TimelineMilestoneType union - grep `tour_outcome` to find it)
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (milestoneVariant ~:302, milestoneHref ~:322)
- Test: `dashboard/src/routes/contact/Timeline.test.tsx`

**Interfaces:**
- Produces: `ActivityEventType` includes `'tour_group_opened' | 'tour_converted'`; TimelineMilestoneType mirrors it. Later tasks record these types.

- [ ] Step 1: Write failing dashboard test: a milestone item `{kind:'milestone', type:'tour_group_opened', label:'Group text opened', refType:'tour', refId:'t1'}` renders a pin linking to `/tours/t1`, and `type:'tour_converted'` with `refType:'tour'` likewise (assert link href + label text; follow the existing milestone render tests in Timeline.test.tsx).
- [ ] Step 2: Run `npm test --workspace dashboard -- Timeline` - expect FAIL only if the union rejects the literal at compile time in the test file; if it renders via the `default` branches, tighten the assertions to the variant class you add next so the test genuinely fails first.
- [ ] Step 3: Add both members to both unions; add milestoneVariant entries (reuse the variant the existing `added_to_group_text` uses for `tour_group_opened`, and the `placement_opened` variant for `tour_converted`) and milestoneHref cases (refType 'tour' -> `/tours/<refId>` already generic - verify, only add if the switch is type-keyed).
- [ ] Step 4: Run the test - PASS. Run `npm run typecheck` - PASS.
- [ ] Step 5: Commit: `git add app/src/repos/activityEventsRepo.ts dashboard/src/api/types.ts dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.test.tsx && git commit -- <same paths>`.

### Task 1.2: recordTourEvent dual-party

**Files:**
- Modify: `app/src/routes/tours.ts:208-235` (recordTourEvent)
- Test: `app/test/toursApi.test.ts`

**Interfaces:**
- Consumes: `units.getById(unitId)` (already injected in the router at ~:189); `activityEvents.record({contactId,type,label,refType,refId})`.
- Produces: every recordTourEvent call site (306/629/631/634/637/640/648) now writes tenant AND landlord person events. Point-in-time rule: landlord = `(await units.getById(tour.unitId))?.landlordId` at event time; absent/empty/throw -> skip landlord write silently (log.error best-effort branch), never fail the route.

- [ ] Step 1: Failing tests in toursApi.test.ts (follow its existing harness): (a) POST /api/tours with scheduledAt on a unit WITH landlordId -> activityEvents contains tour_scheduled for tenantId AND for landlordId (same label/refType/refId); (b) unit with NO landlordId -> tenant event only; (c) units.getById rejects -> route still 2xx, tenant event present, no landlord event.
- [ ] Step 2: Run `npm test --workspace app -- toursApi` - FAIL.
- [ ] Step 3: Implement inside recordTourEvent: after the tenant record try-block, a second guarded block: resolve landlordId via units.getById(tour.unitId) inside its own try/catch; when non-empty string, `activityEvents.record({contactId: landlordId, type, label, refType:'tour', refId: tour.tourId})`.
- [ ] Step 4: Tests PASS; typecheck PASS.
- [ ] Step 5: Commit (explicit paths).

### Task 1.3: tour_group_opened person events

**Files:**
- Modify: `app/src/routes/tours.ts` group-open route (~:877-890)
- Test: `app/test/toursApi.test.ts` (or the group-open suite if it lives in relayApi.test.ts - grep `tour_group_opened` in app/test to confirm; extend where the route is already driven)

**Interfaces:**
- Consumes: Task 1.1 types; Task 1.2's landlord-resolve pattern.
- Produces: opening a tour group writes `tour_group_opened` ("Group text opened", refType 'tour', refId tourId) for tenant + landlord, ALONGSIDE the existing tours# audit row.

- [ ] Step 1: Failing test: drive the group-open route on a tour whose unit has a landlord -> two person events with type tour_group_opened; the tours# audit row still written. Include the `connecting` (no pool number yet) path if the harness supports it - the pin still fires (spec parity note).
- [ ] Step 2: FAIL run.
- [ ] Step 3: Implement (reuse the same dual-party helper shape as 1.2 - factor a small local `recordPersonEvents(tour, type, label)` in tours.ts if it keeps the three call sites DRY). REWRITE the in-code comment at ~:877-879 which currently documents the opposite decision.
- [ ] Step 4: PASS + typecheck.
- [ ] Step 5: Commit.

### Task 1.4: tour_converted person events

**Files:**
- Modify: `app/src/routes/placements.ts` conversion path (~:736-746)
- Test: `app/test/placementsApi.test.ts`

**Interfaces:**
- Consumes: Task 1.1 types; units repo already injected (~:361).
- Produces: converting a tour writes `tour_converted` ("Converted to placement", refType 'tour', refId tourId) for tenant + landlord; existing tours# audit + placement_opened events unchanged.

- [ ] Step 1: Failing test: drive the tour->placement conversion route on a landlorded unit -> tour_converted events for both parties, PLUS the pre-existing placement_opened tenant event still present (now also landlord per Task 1.5 - order the two tasks' assertions accordingly; if 1.5 is not yet built, assert placement_opened tenant-only here and let 1.5 update it).
- [ ] Step 2: FAIL run. Step 3: implement dual-party record next to the audit append. Step 4: PASS + typecheck. Step 5: Commit.

### Task 1.5: placement milestones dual-party (BOTH writers)

**Files:**
- Modify: `app/src/routes/placements.ts:436-448` (recordPlacementMilestone + its call sites 565/750/855-871)
- Modify: `app/src/services/statusTransition.ts` recordStageMilestone (~:214-232) + its transitionPlacement call site
- Test: `app/test/placementsApi.test.ts`, `app/test/statusTransition.test.ts`, `app/test/transitionRoutes.test.ts`

**Interfaces:**
- Consumes: existing `StatusTransitionDeps.unitsRepo` (already REQUIRED in deps - no dep addition needed, spec's "gains a dependency" is satisfied by USING it).
- Produces: `recordPlacementMilestone(tenantId, type, label, placementId, unitId)` - new trailing unitId param (every call site has it in scope: created.unitId at 565/750, item.unitId at 855-871). `recordStageMilestone(tenantId, placementId, toStage, lostCategory, lostHasText, unitId)` likewise (transitionPlacement has the loaded placement). Both resolve landlord point-in-time and dual-write.

- [ ] Step 1: Failing tests: (a) placements.ts create route -> placement_opened for tenant + landlord; (b) THE TRANSITION ROUTE (POST /api/placements/:id/transition, via transitionRoutes.test.ts or statusTransition.test.ts - whichever drives the route; at least ONE test must go through the ROUTE, spec A-B1) non-terminal move -> stage_changed for both parties; terminal move -> placement_closed for both; (c) unit without landlord -> tenant-only, route still 2xx.
- [ ] Step 2: FAIL run. Step 3: implement both writers (same guarded pattern as 1.2; in statusTransition.ts use deps.unitsRepo.getById). setTenantStatus/deriveTenantStatus/contact_status_changed stay tenant-only - do not touch.
- [ ] Step 4: PASS + typecheck. Step 5: Commit.

### Task 1.6: LANDLORD_FEED_TYPES swap + dead-branch deletion

**Files:**
- Modify: `app/src/routes/contactTimeline.ts` (~:228 LANDLORD_FEED_TYPES; ~:505-517 unitAuditToMilestone tour branches)
- Test: `app/test/contactTimeline.test.ts`

**Interfaces:**
- Produces: LANDLORD_FEED_TYPES = broadcast_sent, listing_status_changed, unit_contact_added, unit_contact_removed ONLY. unitAuditToMilestone loses its tour cases (and mapTourAuditToMilestoneType + tourAuditLabel become dead if tour-only - delete them too if nothing else imports them; typecheck confirms).

- [ ] Step 1: Failing test: a landlord contact with (a) a direct tour_scheduled activity event AND (b) a units# audit tour_scheduled row -> the timeline returns exactly ONE tour pin (the direct event); broadcast_sent audit rows still interleave.
- [ ] Step 2: FAIL (today it returns two). Step 3: implement. Step 4: PASS + typecheck (fix any now-unused-symbol errors by deleting the dead helpers). Step 5: Commit.

### Task 1.7: seed vocabulary parity

**Files:**
- Modify: `app/src/lib/seed/history.ts` (tourMilestones ~:670, placementMilestones ~:632, and their call sites - grep `tourMilestones(` / `placementMilestones(` in app/src/lib/seed/)
- Test: `app/test/seedHistory.test.ts`

**Interfaces:**
- Produces: `tourMilestones(tour, landlordId?)` emits the full live-writer vocabulary per the tour's walk (reuse tourTrail's per-status sequence logic): tour_scheduled / tour_took_place (existing) + tour_no_show / tour_canceled / tour_outcome where the trail models them, + tour_group_opened (when groupThreadId) + tour_converted (when convertedPlacementId) - each for tenant AND (when landlordId given) landlord. `placementMilestones(placement, landlordId?)` mirrors its existing rows to the landlord. Callers pass the unit's landlordId (they hold the unit).
- CONSTRAINT: full-profile only (historyItems is already gated); NEVER touch `app/src/lib/seed/lean.ts`.

- [ ] Step 1: Failing tests in seedHistory.test.ts: a no_show tour with a landlordId yields tour_no_show rows for both parties; a converted tour yields tour_converted for both; placementMilestones with landlordId yields dual placement_opened/stage_changed/placement_closed rows; WITHOUT landlordId, byte-identical to today's tenant-only output (regression guard).
- [ ] Step 2: FAIL. Step 3: implement, keeping `makeActivityRow` and the T[k] clock (the "section 4.6" comment) intact. Step 4: PASS + typecheck; run `npm test --workspace app -- seed` to catch sibling seed suites. Step 5: Commit.

### Slice 1 gate

- [ ] `npm run typecheck` EXIT 0; `npm test` EXIT 0 (all workspaces). Fix or report; commit any stragglers by pathspec.

---

## Slice 2 - Timeline plumbing + ContactCommsPane extraction

### Task 2.1: Timeline controlled commsOnly

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (~:808 useState + the toggle button + TimelineProps)
- Test: `dashboard/src/routes/contact/Timeline.test.tsx`

**Interfaces:**
- Produces: optional `commsOnly?: boolean; onCommsOnlyChange?: (v: boolean) => void` on TimelineProps. When BOTH provided -> controlled (internal state unused); when absent -> exactly today's uncontrolled per-mount behavior. The toggle button calls onCommsOnlyChange in controlled mode.

- [ ] Step 1: Failing test: render Timeline with `commsOnly={true}` + a spy onCommsOnlyChange and a milestone item -> the pin is hidden and clicking the toggle fires the spy with false (no internal flip).
- [ ] Step 2: FAIL. Step 3: implement (standard controlled/uncontrolled pattern: `const effective = props.commsOnly ?? internal;` handler routes to the right setter). Step 4: PASS + typecheck (existing uncontrolled tests stay green). Step 5: Commit.

### Task 2.2: Extract ContactCommsPane

**Files:**
- Create: `dashboard/src/routes/contact/ContactCommsPane.tsx`
- Create: `dashboard/src/routes/contact/ContactCommsPane.test.tsx`
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx` (delete the moved block; mount the pane)
- Test: existing `dashboard/src/routes/contact/ContactDetail.test.tsx` must stay green (it is the extraction's net)

**Interfaces:**
- Produces (the pane's contract - spec section 2 is authoritative):

```tsx
export interface ContactCommsPaneProps {
  contact: Contact;                       // never null; caller gates
  timeline: ContactTimelineState;         // caller-owned useContactTimeline
  initialDraft?: string;
  onDraftSeeded?: () => void;
  emptyLabel?: string;
  resetScrollKey: string;
  onContactUpdated?: (updated: Contact) => void; // EmailManager/consent sync
  onRestore?: () => void;                 // deleted-note button (ContactDetail only)
  commsOnly?: boolean;                    // controlled toggle passthrough
  onCommsOnlyChange?: (v: boolean) => void;
}
```

- Moves IN (from ContactDetail, keep the code and its comments - this is a
  MOVE, not a rewrite): buildReplyTargets wiring + selectedConvId state +
  replyToPhone/replyToLabel + canSend (incl. `!deleted` gate); postSend /
  onSend / deferredSend / onSendEmail (with existingEmailConvId memo +
  ensureEmailConversation fallback) / onRetry; pendingConsentSend state +
  ConsentCaptureModal mount (onRecorded applies the updated contact to the
  pane's LOCAL override, calls timeline.refetch(), fires onContactUpdated);
  managingEmails state + EmailManager mount (onChanged -> local override +
  timeline.refetch() + onContactUpdated); clearDraftSignal state (internal);
  the FULL Timeline mount (spec section 2 prop list incl. deleted/onRestore/
  optedOut/emailChannel/emptyLabel/commsOnly passthroughs).
- Pane-local: `const [override, setOverride] = useState<Contact|null>(null);
  const effectiveContact = override ?? props.contact;` - phones/emails/
  optedOut/emailSuppressed/deleted all derive from effectiveContact.
- STAYS in ContactDetail: useContact/useContactTimeline hooks, header, file
  pane, suggestions, status pill, opt-out toggles, PhoneManager, file-pane
  EmailManager entry, useMarkContactRead, media gallery (commsMedia over the
  caller-owned timeline.items), delete/restore handlers (restore handler is
  PASSED DOWN as onRestore), the five external timeline.refetch call sites.

- [ ] Step 1: Write ContactCommsPane.test.tsx FIRST by PORTING the comms-pane cases from ContactDetail.test.tsx to the component (mock the same endpoints module): SMS send happy path + optimistic bubble; send with no thread -> ensureContactConversation then send; consent 409 -> modal -> onRecorded retries and clears draft; email send into existing email thread / phone fallback / ensureEmailConversation for phoneless; retry; deleted contact -> composer locked, canSend false, note WITHOUT button when onRestore absent and WITH button when present; NEW: two-conversation contact (two phones) -> both threads' messages render and both reply targets offered (spec m7).
- [ ] Step 2: Run - FAIL (component does not exist).
- [ ] Step 3: Create the pane by MOVING the code; rewire ContactDetail to `<ContactCommsPane contact={contact} timeline={timeline} resetScrollKey={contactId} onContactUpdated={(c) => setContact(c)} onRestore={onRestore} />` (key={contactId} stays on the mount).
- [ ] Step 4: Pane tests PASS; ContactDetail.test.tsx PASS UNCHANGED (adjust only mechanical mock paths if the module split forces it - behavior assertions must not change); typecheck PASS.
- [ ] Step 5: Commit.

### Slice 2 gate

- [ ] `npm run typecheck` + `npm test` EXIT 0.

---

## Slice 3 - channel hooks

### Task 3.1: useTourChannels / usePlacementChannels rework

**Files:**
- Modify: `dashboard/src/routes/tours/useTourChannels.ts`, `dashboard/src/routes/placements/usePlacementChannels.ts`
- Test: `dashboard/src/routes/tours/useTourChannels.test.tsx`, `dashboard/src/routes/placements/usePlacementChannels.test.tsx`

**Interfaces:**
- Produces (both hooks, mirrored):

```ts
export interface TourChannelsState {
  status: 'loading' | 'ready' | 'error';
  group: { conversationId: string | null; unread: number };   // unchanged semantics
  tenant: { unread: number };                                  // SUM over non-relay convs involving the contact
  landlord: { unread: number };
  setGroupConversationId: (conversationId: string) => void;    // narrowed from setConversationId
  markGroupRead: (conversationId: string | null, unread: number) => void;  // unchanged single-conv path
  markPersonRead: (key: 'tenant' | 'landlord', contactId: string | undefined, unread: number) => void;
}
```

- markPersonRead: no-op when contactId undefined or unread <= 0; zeroes that key's unread locally; `void markInboxRead({ contactId }).catch(() => {})`.
- Aggregate: `sum(unread_count)` over `s.type !== 'relay_group' && involvesContact(s.participants, contactId)` from the same getConversations page; keep the SSE-debounced refetch + forId reset; the group channel keeps the merge/preserve-id logic; DELETE the 1:1 one21/merge machinery.

- [ ] Step 1: Failing hook tests: two non-relay conversations (one phone-keyed, one email-keyed via participants roster) with unread 2 and 3 -> tenant.unread === 5; a relay_group with unread never counts; markPersonRead('tenant', id, 5) -> local zero + markInboxRead called with {contactId}; markPersonRead with unread 0 -> no call; group markRead unchanged.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS + typecheck. The renames break TourConversation/PlacementConversation compilation: in THIS task make only the MINIMAL mechanical call-site edits there (property/function names, passing the contactId argument) so typecheck goes green with today's behavior intact; the real consumer rewrite is Slice 4.
- [ ] Step 5: Commit.

### Task 3.2: relay-group exclusion pinning test (server)

**Files:**
- Test: `app/test/inboxFeed.test.ts` (or a new `app/test/contactThreads.test.ts` if inboxFeed's harness does not fit)

- [ ] Step 1: Failing-or-green-by-construction test, stated as the INVARIANT PIN (spec M3): create a contact + their phone 1:1 + a relay_group whose participant_phone is the POOL number and whose participants include the contact -> `conversationsForContact` returns the 1:1 only; POST /api/inbox/:contactId/read resets the 1:1's unread and leaves the relay group's unread intact.
- [ ] Step 2: Run (may pass immediately - that IS the pin; keep it). Step 3: none beyond the test. Step 4: suite green. Step 5: Commit.

---

## Slice 4 - tour + placement consumers

### Task 4.1: ContactCommsTab wrapper

**Files:**
- Create: `dashboard/src/routes/contact/ContactCommsTab.tsx`
- Create: `dashboard/src/routes/contact/ContactCommsTab.test.tsx`

**Interfaces:**
- Produces:

```tsx
export interface ContactCommsTabProps {
  contact: Contact;            // REQUIRED loaded contact - caller gates on null
  emptyLabel: string;
  initialDraft?: string;
  onDraftSeeded?: () => void;
  commsOnly: boolean;
  onCommsOnlyChange: (v: boolean) => void;
}
// Renders: const timeline = useContactTimeline(contact.contactId);
//          <ContactCommsPane contact={contact} timeline={timeline}
//            resetScrollKey={contact.contactId} ... passthroughs ... />
// (no onRestore, no onContactUpdated - tour/placement pages need neither)
```

- HARD RULE (spec B2): the component takes a loaded Contact, so useContactTimeline can never see ''. It is mounted ONLY when its tab is active.

- [ ] Step 1: Failing test: renders the pane for a contact (timeline fetch mocked); mounting never calls the timeline endpoint with an empty id (assert the mocked getContactTimeline received contact.contactId).
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS + typecheck. Step 5: Commit.

### Task 4.2: TourConversation rewire

**Files:**
- Modify: `dashboard/src/routes/tours/TourConversation.tsx`
- Test: `dashboard/src/routes/tours/TourConversation.test.tsx`, `dashboard/src/routes/tours/TourDetail.test.tsx`

**Interfaces:**
- Consumes: ContactCommsTab (4.1), reworked channels (3.1).
- Behavior contract: three tabs unchanged (labels, initial-tab rule, unread dots now aggregate); group tab byte-identical (useRelayThread + roster + closed + withMilestones(tourMilestones)); tenant/landlord tabs render `<ContactCommsTab>` when their Contact prop is loaded, else the existing empty-state copy; tenant pane KEY = `` `${tour.tenantId}:${seedKey}` `` (seed nonce remounts even when already on the tab - spec M1), landlord KEY = contactId; no-show seed flows via initialDraft/onDraftSeeded exactly as today; mark-read effect calls markPersonRead(activeKey, contactId, unread) for 1:1 tabs and markGroupRead for group; page-level shared `const [commsOnly, setCommsOnly] = useState(false)` passed to both tabs (spec A-M2); DELETE: ContactThread, NewContactThread, pendingConsent + ConsentCaptureModal import/state, clearSignals, oneToOnePhone, oneToOneDeleted plumbing (the pane owns all of it); tourMilestones keeps flowing to the GROUP tab only - the pane has no milestone-injection prop at all, so the 1:1 injection ends in this task BY CONSTRUCTION (state that loudly in the slice report); Task 5.1 then verifies the residue and owns the revertible closure commit.
- [ ] Step 1: Update/extend the failing tests FIRST: tab switch remounts (draft isolation); no-show nonce WHILE ALREADY ON TENANT TAB seeds the composer (new case, spec M1); deleted tenant -> locked composer note without restore button (keep the just-merged deleted-lock assertions green THROUGH the rewrite); unread dot from aggregate; emptyLabel copy "No messages with <first name> yet" preserved (TourDetail.test.tsx:1045).
- [ ] Step 2: FAIL. Step 3: rewire. Step 4: PASS + typecheck; run the WHOLE dashboard suite. Step 5: Commit.

### Task 4.3: PlacementConversation rewire

**Files:**
- Modify: `dashboard/src/routes/placements/PlacementConversation.tsx`
- Test: `dashboard/src/routes/placements/` suites + `dashboard/src/routes/placements/PlacementDetail` tests as affected

Same contract as 4.2 minus the no-show seed (placement page has none) and
minus tourMilestones (its 1:1 tabs inject none today). Group-open
provisioning stays page-local (provisionPlacementRelay ->
setGroupConversationId). Guard: PlacementDetail passes a placeholder
`tenantId: ''` while loading - the tab renders the empty state until the
CONTACT object is loaded (never mount ContactCommsTab from a bare id).

- [ ] Steps 1-5 as in 4.2 (tests first, fail, rewire, green + typecheck, commit).

### Slice 4 gate

- [ ] `npm run typecheck` + `npm test` EXIT 0.

---

## Slice 5 - injection removal residue + honesty cleanup (own commit, revertible)

### Task 5.1: confirm 1:1 injection is fully gone + useRelayThread comment + issue closures

**Files:**
- Modify: `dashboard/src/routes/tours/TourConversation.tsx` (only if any 1:1 milestone plumbing residue remains), `dashboard/src/routes/conversation/useRelayThread.ts` (comment ~:42-46 only)
- Modify: `docs/issues/tour-1to1-optimistic-team-label.md`, `docs/issues/comms-panes-missing-optout-note.md` (frontmatter `status: resolved` + one-line resolution note pointing at this branch)

- [ ] Step 1: `rg "tourMilestones" dashboard/src/routes/tours/` - assert it flows ONLY into the group channel; remove residue if any.
- [ ] Step 2: Rewrite the useRelayThread drop comment: relay threads never carry email/call 1:1 content (no "defensively" hedge). No behavior change - `git diff` on that file shows comments only.
- [ ] Step 3: Close both issues (status + resolution line).
- [ ] Step 4: typecheck + dashboard suite green.
- [ ] Step 5: Commit as its own commit: "feat(tours): person-feed pins replace the 1:1 injection" + closures.

---

## Slice 6 - e2e + full gates + live self-QA

### Task 6.1: e2e additions (spec Testing e2e items 1-5; reuse existing fixtures)

**Files:**
- Modify/extend: `e2e/tests/dashboard-next/` (tour + placement detail specs - follow existing spec-file naming; email inbound fixture lives in `e2e/tests/flows/email-inbound.spec.ts` - reuse its injection seam, do not invent one)
- `e2e/scenarios/steps.ts` for any new shared steps (accessibility-first selectors per e2e/support/selectors.md)

- [ ] Step 1: Write the five new assertions as spec'd: (1) tenant email visible on tour Tenant tab + placement tab (EmailCard); (2) viewing Tenant tab clears the tenant's whole inbox row, Group dot + inbox group row survive; (3) SELF-GUIDED tour -> Upcoming reminders on the Tenant tab; (4) SMS send from tour 1:1 works incl. no-prior-conversation tenant (outbox assertion); (5) this tour's lifecycle pins on Tenant AND Landlord tabs sourced from the person feed (schedule -> pin both tabs; group-open -> pin both tabs).
- [ ] Step 2: Run the touched specs from the e2e workspace dir (filtered), then the FULL `timeout 1500 npm run e2e` from the worktree root - EXIT 0. Named must-pass-unchanged: dashboard-next/landlord-activity.spec.ts, dashboard-next/contact-detail.spec.ts, dashboard-next/inbox-comms.spec.ts, flows/email-inbound.spec.ts, flows/email-outbound.spec.ts, dashboard-next/outbound-mms.spec.ts, dashboard-next/a2p-compliance.spec.ts, dashboard-next/deleted-contact-resurfacing.spec.ts, e2e/tests/scenarios/quiet-hours.spec.ts. Known flakes (re-run before blaming; report both runs): tour-reminders-panel-e2e-flake, conversationdetail-members-mock-suite-flake, tourdetail-composer-footer-suite-flake, inbox-specs-flaky-shared-tasha-state.
- [ ] Step 3: Commit e2e work by pathspec.

### Task 6.2: live self-QA (harness per profile)

- [ ] e2e:session stack + Playwright MCP (--isolated; never lane 0): tour page - email + call rows in the Tenant tab; tab dots (group survives 1:1 view); composer targets; landlord tab cross-property history renders (accepted, screenshot); no-show seed while on tenant tab; deleted-contact note; placement page equivalents; 360x640 tour comms pane check (note findings on docs/issues/comms-pane-overflows-on-short-viewports.md). Screenshots to .playwright-mcp/.
- [ ] Reseed etiquette: `POST /__dev/reseed?profile=full` for the demo-world pin checks (seed vocabulary parity visible on landlord tabs).

### Final gate (on a QUIET tree)

- [ ] `npm run typecheck` EXIT 0; `npm test` EXIT 0; `timeout 1500 npm run e2e` EXIT 0 - quoted exit codes in the handback. Branch already based on current main (merged pre-plan @b41551c1); if main moved AGAIN during the build, STOP and ask before a second main-merge (one-main-sync rule).

---

## Watch items (carry into every slice report)

- Spec section "Watch items for the plan" (n1/n2/n4, A-m4 legacy duplicate, A-M2 pin-volume residual) - verify, do not silently fix.
- Deleted-contact resurfacing x fan-out mark-read: pin the interaction test (spec section 5) in Slice 3 or 4 (unit level: fan-out read dismisses the resurfaced row - server behavior already exists; the NEW part is only that tour/placement tabs now trigger it).
- Never touch lean.ts; never run infra; e2e only from the worktree.
