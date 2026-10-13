# Plan research - Matching (spec 5.3, 5.6, section 8): findings

Reader: plan-research, Matching area. Tree: W:\tmp\last-heard-from @ f6aba402
(main merged 2026-10-13). Spec: docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md
(revision 5). Corrections and ambiguities only; byte-exact code lives in the
gitignored reference (.superpowers/sdd/plan-research/matching-reference.md).

Main's merge did NOT touch audienceResolution.ts, broadcasts.ts,
shareRecipientState.ts, RecipientPreview.tsx, BroadcastsList.tsx,
useBroadcastsList.ts, ContactSearchField.tsx or ListingsList.tsx. It changed
BroadcastComposer.tsx / AudienceFilters.tsx (voucher-size pre-fill only),
broadcasts.spec.ts (one new test, :264-281), unitsRepo.ts and units.ts (the
units recipients route moved). None of that touches the review step.

## A. Must resolve before the plan

A1. NAME COLLISION - `app/src/lib/sendOutcome.ts` ALREADY EXISTS (113 lines,
the Twilio send-failure vocabulary: SEND_UNCONFIRMED_CODE,
RECONCILE_CHECK_DELAYS_MS, classifySendFailure...). It is imported by 14
app/src modules (incl. shareRecipientState.ts:24, broadcastFanOut.ts,
sendMessage.ts, broadcastsRepo.ts) and 14 tests, and `app/test/sendOutcome.test.ts`
exists. Spec 5.4 (spec:511, :546) and 5.6 (spec:805, :833-835) put
`effectiveDecline`, `deriveSendOutcome`, `isEligibleRecipient` and
`FOLLOW_UP_QUIET_MS` / `FOLLOW_UP_LOOKBACK_MS` there. The exported type name
`SendOutcome` (spec:549) also already exists at app/src/adapters/webPush.ts:28.
Recommend a new module, e.g. `app/src/lib/listingSendOutcome.ts` (test
`app/test/listingSendOutcome.test.ts`) and a type name such as
`ListingSendOutcome`; update every spec reference.

A2. CONTRADICTION - hand-added declined rows. G3 (spec:88-90) and the
section 8 e2e (3) (spec:994-995) say a declined tenant shows UNCHECKED "both in
the audience and when hand-added"; 5.3 (spec:460-462) says it starts unchecked
"unless it was hand-picked". Today every hand-add is a seed that starts
CHECKED (RecipientPreview.tsx:216-242; share-skip-fix D5, pinned by
RecipientPreview.test.tsx:290-307 for already-sent). Recommend 5.3's rule (a
pick is deliberate -> checked, tagged "Not interested"; the `annotate`
suffix warns BEFORE the pick) and reword G3 and e2e (3) to "tagged Not
interested; a filter-proposed declined row starts unchecked".

A3. The Follow up tab cannot be a `BroadcastsFilter` value.
useBroadcastsList sends every non-'all' filter as `?status=`
(useBroadcastsList.ts:77, :86-88) and the server 400s an unknown status
(broadcasts.ts:1043-1045). The tab needs its own view component and hook;
because hooks are unconditional, either keep useBroadcastsList running while
Follow up is shown or split the current list body into a child component.
Also state: (a) tab state is local `useState` (BroadcastsList.tsx:44), not URL
- decide whether Follow up gets a URL (e.g. `?tab=follow-up`) so the
Properties "<n> waiting" pill can link to it; (b) the count in the tab label
means the follow-ups fetch runs on Matching mount whatever tab is active; (c)
the tabs have role=tab but no tabpanel/aria-controls today.

A4. E2E (6) "a send older than 24 hours" (spec:1001-1003) has NO SEAM. A
send's `sentAt` is the fan-out's provider instant (now); the lean e2e world
seeds no `listing_sends` (only cast.ts / matrix.ts, the full profile); dev.ts
has no listing-send fixture and no clock seam (seams listed in the
reference, section 16). The plan must add a dev-only seam (e.g. a
`/__dev/listing-send-fixture` writing a backdated LISTED row through
`putShareMemory`) or an e2e-only threshold override, or rescope (6) to unit
tests plus an API-level check. LOOKBACK has the same problem.

A5. The preview handler has no `listing_sends` or tours dependency.
BroadcastsRouterDeps (broadcasts.ts:93-118) lacks `listingSendsRepo` and
`toursRepo`, and the broadcasts mount (api.ts:1083-1105) forwards neither.
Add both deps and pass the SHARED instances `listingSends` (api.ts:604) and
`tours` (api.ts:637) as the units mount does (api.ts:965-967). The app test
harness already supplies both through api deps
(app/test/helpers/twilioWebhookHarness.ts:5444-5446).

## B. Under-specified for a literal builder

B1. FollowUpItem (spec:823-829) omits fields 5.4 says every outcome-serving
row carries: `interestedMode` (spec:669-672; the list's Interested action on a
property with no `tour_type` must navigate to `?tour=new&tenantId=`) and
`declined` (Undo after an in-session Not interested). Add them, or say the
list never shows Undo.

B2. `unitLabel` ("the short address"): no server helper of that name exists.
The dashboard `shortAddress` is `formatAddress(address) || unitId`
(dashboard/src/routes/listing/listingFormat.ts:137-142); the app has
`formatAddress` (app/src/lib/address.ts:112). Name the server formula, or send
the raw address and format client-side.

B3. `conversationId?` (spec:827): the server cannot fill it without a
conversations lookup per row. The dashboard already has
`ensureContactConversation` (dashboard/src/api/endpoints.ts:1759-1765 ->
POST /api/contacts/:id/conversation, app/src/routes/contacts.ts:2029,
idempotent create-or-get). Recommend dropping `conversationId` from the wire;
Text calls ensureContactConversation, then navigates to
`/conversations/:conversationId` (App.tsx:268).

B4. "No reply yet, N days" / "Replied, quiet N days" (spec:781-782): N is
undefined. The mockup (mockups.html:149-166) implies N = whole days since
`waitingSince` (Dario sent Oct 2 -> 10 days on Oct 12; Tasha heard Oct 7 -> 5).
State the formula (floor of ms / 86400000, per section 7) and whose clock.

B5. The 100-unit cap (spec:797-799): units `byStatus` is HASH-ONLY
(app/src/lib/tables.ts:108), so the cut drops an arbitrary set; and the
soft-delete FilterExpression (unitsRepo.ts:631-641) makes Limit-ed pages
short, so the walk must follow `lastEvaluatedKey` until 100 kept units or
exhaustion. The harness fake listByStatus returns everything when no limit is
passed (twilioWebhookHarness.ts:2909-2916).

B6. Hand-added rows need status / housing authority / last heard from: the
Row model (RecipientPreview.tsx:38-54) has none of them, and added rows are
built from `tenantCandidates` (:184-242), the raw contacts from
`getAllContacts({ type: 'tenant' })` (BroadcastComposer.tsx:280-286), which
carry `status` and `housingAuthority` (dashboard types.ts:2167, :2238) and will
carry `last_heard_from_at` once 5.1 adds it to the dashboard Contact type. A
declined add is detected with `declinedContactIds` the same way `priorIds` is
used at :226. Partner seeds carry no `housingAuthority` (broadcasts.ts:463-468),
so that column is blank for partners - say so.

B7. Accessible-name separator: today's names use an em dash (U+2014) -
`<name> <em dash> already sent` / `<name> <em dash> consent not recorded`
(RecipientPreview.tsx:417-423); spec 5.3 (spec:468-470) writes ASCII " - ".
Nothing pins the em-dash ACCESSIBLE names (grep of dashboard tests and e2e),
so switching all three to " - " is safe; say whether the existing two change
too, so one list does not mix separators. The visible no-consent TAG text
keeps its em dash (pinned by a2p-compliance.spec.ts:387, :442).

B8. 768px columns: RecipientPreview.module.css has no container query and
BroadcastComposer.module.css `.page` is empty, so "panes 768px and wider"
needs `container-type: inline-size` on `.preview` (the
BroadcastsList.module.css:2-7 pattern) plus `@container (min-width: 768px)`.
`.rows` is a 420px VERTICAL scroll box (RecipientPreview.module.css:69-77): no
conflict with columns, but a header row outside the ul misaligns by the
scrollbar width (use `scrollbar-gutter: stable` or one shared grid template),
and a header inside the ul as an li changes listitem counts and must carry no
checkbox (partner-share.spec.ts:151 asserts exactly 1 checkbox). Recommend a
header outside the list that keeps every row a single li, so the
`li hasText` selectors (broadcasts.spec.ts:173, :178, :186;
matching-entry-points.spec.ts:231; share-skip-fix.spec.ts:152;
share-sent-outcome.spec.ts:359; a2p-compliance.spec.ts:385, :440) hold.

B9. composer-mobile.spec.ts never touches the review step: it covers the
relay-group message composer only (tests at :67, :94, :126). There are no
mobile review-step selectors to keep; drop the hedge at spec:448-450.

B10. Scroll-into-view on add (spec:457-458): the house rule at
dashboard/src/routes/contact/Timeline.tsx:2342-2343 forbids a bare
`scrollIntoView` (it scrolls every scrollable ancestor, moving the page and
the Add-a-tenant field). Use `scrollTop` arithmetic on the ul, or
`scrollIntoView({ block: 'nearest' })` as AllToursView.tsx:530 does. jsdom is
stubbed (dashboard/src/test/setup.ts:50-55); assert with vi.spyOn as
AllToursView.test.tsx:1247 does.

B11. "Select all" and initial checks: initialRows (RecipientPreview.tsx:79-93)
and selectAll (:165-169) use `seeded || !alreadySent`; the declined rule
becomes `seeded || (!alreadySent && !declined)`. Say whether the note at
:363-365 ("Flagged recipients you picked stay checked") changes.

B12. ResolvedContact is NOT persisted anywhere. Its only consumer is
broadcasts.ts; the send paths store `{ status: 'queued' }` per key
(buildRecipientsFrom :358-367, path (c) :933-936); broadcastFanOut.ts does not
import it. The planned "prove the new fields are not persisted" grep
(spec:417-420) is trivially true. The task that matters is the opposite: the
preview candidate projection copies fields EXPLICITLY (broadcasts.ts:710-737),
so `status` and `lastHeardFromAt` reach the wire only if added there - test it.

B13. Preview decline read: `listingSends.listByUnit` already drops un-counted
rows (listingSendsRepo.ts:169-171, :324-335), so a decline on a pair whose
shares all failed is invisible to the preview - consistent with "LISTED only",
but state it. The tours read is one `tours.listByUnit` grouped by tenantId (the
units.ts:1086-1094 pattern). The harness `getManyByIds` ignores
`requireComplete` (twilioWebhookHarness.ts:2278-2285): test the degraded flag
by making listingSendsRepo.listByUnit / toursRepo.listByUnit /
contactsRepo.getManyByIds reject via vi.spyOn.

B14. Properties list count: ListingsList.test.tsx (:7-16) and
ListingsList.urgentState.test.tsx (:31) mock only `./useListings.js`, so put
the follow-ups count fetch in its own hook module (e.g.
listings/useFollowUpCounts.ts); do NOT add it to useListings, which
ToursPage.tsx:664 and :668 also call. The pill belongs in Row's `.meta` span
inside the Link (ListingsList.tsx:120-124), so it joins the link's accessible
name (properties-available-view.spec.ts:183 matches by regex - fine). There is
no separate Available component: the Active tab defaults its status select to
`available`, so show the pill only on `unit.status === 'available'` rows with
`byUnit[unitId] > 0`. The spec does not say what a failed count fetch does;
recommend silence (no pill), never an error over the list.

## C. Mount prefix and infra

C1. No infra either way. `/api/*` already has an all-methods CloudFront
behavior (infra/modules/cloudfront/main.tf:157-169), the endpoint is a GET,
and EDGE_MUTATING_PREFIXES (app/src/app.ts:80) plus
app/test/cloudfrontBehaviors.test.ts govern TOP-LEVEL app.ts mounts only.
`docs/issues/public-intake-cloudfront-403.md` does not exist in this tree.
The broadcasts router is mounted at '/' (api.ts:1082-1083), so it can register
either path itself with no new mount. Recommend `GET /api/broadcasts/follow-ups`
(it stays with the router that owns Matching). No route-order collision today:
the router has no `GET /broadcasts/:broadcastId` (only `GET /broadcasts`,
`GET /broadcasts/:broadcastId/results`; PATCH and DELETE on
`/broadcasts/:broadcastId` are other methods). Register it above any future
GET `/:id` and add a test that it is not answered by another handler. If the
spec keeps `/api/matching/follow-ups`, register `router.get('/matching/follow-ups')`
in the same router.

## D. Tests the projection change breaks (update knowingly)

D1. app/test/audienceResolution.test.ts:205-215 asserts the candidate with
`toEqual`; its `tenant()` helper defaults `status: 'active'` (:14-21), so
`status` will appear.

D2. app/test/broadcastApi.test.ts:291-299 asserts preview candidates with
`toEqual`; `seedTenant` defaults `status: 'searching'` (:59-63), so `status`
and `declinedThisProperty: false` will appear. The partner negative to mirror
for "status omitted on a partner seed" is :1168-1205.

D3. Dashboard PreviewResponse literals: `previewOf` in
RecipientPreview.test.tsx:52-63 and BroadcastComposer.test.tsx:234, :491,
:822. The composer's mocks are untyped `vi.fn()` (typecheck will not flag
them), so either make the new response fields required and add them
everywhere, or read them defensively (`?? []`, `=== true`).

D4. Adding `touchLastHeardFrom` to the ContactsRepo interface (5.1) breaks
typecheck in 10 hand-written ContactsRepo fakes in app/test (incl.
audienceResolution.test.ts:24-133). Not a 5.3 change, but its tests fail first.

D5. BroadcastsList.test.tsx mocks api/index.js with importActual plus
overrides (:18-29); a follow-ups call on mount must be added to that mock or
every existing case fires a real request.

## E. Citation drift (spec -> NOW)

- spec:405 `audienceResolution.ts:30-48` -> :30-49 (interface at :31).
- spec:416 push `:158-168` -> :163-173.
- spec:811 hard exclusions `:146-154` -> :149-154 (type fence :149, opt-out
  :152, unreachable :153, phone :154).
- spec:423 preview `broadcasts.ts:710-756` -> handler :646-756 (route at :655);
  :710-737 is the candidate projection.
- spec:126 path (c) `:895-925` -> :890-938.
- spec:427 `RecipientPreview.tsx:110-113`, `:225` -> priorIds :104-107; used
  in addTenant at :226.
- spec:357 `units.ts:1029` and spec:680 `units.ts:1002-1034` -> the units
  recipients route is now units.ts:1076-1123 (moved by main's merge; 5.4/5.5's
  area, noted because the follow-ups join mirrors it).
- spec:904 "All ten ContactSearchField render sites" -> 11 files render it
  (list in the reference, section 10).
- Verified unchanged: broadcasts.ts:440-473; RecipientPreview.tsx:403-453,
  :79-93, :165-169; shareRecipientState.ts:249-268; ContactSearchField.tsx:13
  (the rule spans :8-16); matching-entry-points.spec.ts:228; inboxTime.ts:52-60;
  audienceResolution.ts:129-138.

## F. C6 patch

`git apply --check docs/superpowers/reviews/2026-10-07-caseworkers/C6-proposed-fix.patch`
on f6aba402: exit 0, both files clean. Its source hunks touch old lines :94-100,
:125-138 and :268-274. `annotate` would touch the props interface (:53-64),
the destructure (:83-89) and the option body (:293-304; about +7 after C6).
No overlap, so the separate annotate commit rebases cleanly after C6.

## G. Plan ordering

The preview's `declinedContactIds` needs `effectiveDecline` and
`deriveTourSignal().latestActivityAt` (5.4) plus the `declined` field on
listing_sends; the follow-ups builder needs `isEligibleRecipient`,
`deriveSendOutcome` and `last_heard_from_at` (5.1). The Matching tasks follow
those modules.
