# Plan research - outcome area (spec 5.4, 5.5, I2, I3, section 8) - FINDINGS

Reader: plan-research, outcome area. Tree: W:\tmp\last-heard-from @ f6aba402
(main merged 2026-10-13). Corrections and ambiguities only; byte-exact quotes
are in the gitignored reference
(`.superpowers/sdd/plan-research/outcome-reference.md`). Spec line numbers
refer to `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`.

## A. Contradicted by the tree

A1. `tenant_required` already exists on main as `contact_not_tenant`. POST
/api/tours runs `requireTenantContact` after body validation and before any
write: 404 `tenant_not_found`, 409 `{ error: 'contact_not_tenant', contactKind }`
(app/src/routes/tours.ts:350-359; app/src/services/contactTypeGuards.ts:66-76,
:99-117), pinned by app/test/toursCreateContactType.test.ts:56-149. Drop the 400
`tenant_required` from spec 5.4 (:585-589), section 8 (:978) and section 11
(:1091-1092). The "UNVERIFIED" picker claim (:587-589) is TRUE: the form loads
tenants only (dashboard/src/routes/tours/ScheduleTourForm.tsx:180) and already
shows the contact-type sentence (:328-335 via dashboard/src/lib/contactTypeErrors.ts:26-47).

A2. The Interested route bypasses the I2 guard. Step (4) creates through
`toursRepo.create` directly (spec :637-640), skipping the CONSISTENT tenant read
that caseworker integrity requires on every tour create
(contactTypeGuards.ts:60-76). The route's own type knowledge comes from an
eventually consistent contacts batch. The plan should call `requireTenantContact`
before the create and map its errors (sendContactTypeError, or to
`interested_unsupported`).

A3. `lastMarkedAt` is broader than D11 says. D11 and 5.4 call it the instant a
tour was "created, rescheduled or reopened" (spec :174-176, :533-535). The PATCH
route stamps it on ANY status change or any new time (app/src/routes/tours.ts:1328-1338),
which includes scheduled->toured, requested->toured ("already toured") and
canceled->scheduled, and reopenIf stamps it too (app/src/repos/toursRepo.ts:785-821;
app/src/routes/tours.ts:1701). The model doc says the same
(app/src/repos/toursRepo.ts:111-114; app/src/lib/toursModel.ts:214-218). The consequence
is concrete: a tenant tours, says no, and staff later record "Toured". That
supersedes the decline, and the row flips to Interested/Toured. The planner
should either accept this and state it in the spec, or narrow the activity rule.
No stored field distinguishes "rescheduled" from "marked toured".

A4. `TourSignal` is a wire type, so adding `latestActivityAt` to it leaks. Spec
:531 says `deriveTourSignal` "gains `latestActivityAt` on its result". That
result is `ListingSendRow.tour` (app/src/repos/listingSendsRepo.ts:116;
dashboard/src/api/types.ts:2951-2954, :2966), and route tests pin `tour` with
`toEqual({ tourId, state })` (app/test/listingSendsApi.test.ts:228, :263,
:295). Use a separate result type (or a sibling pure function), or strip the
field in `toListingSendRow`.

A5. "The same shared writer tours use" (spec :646-648) does not fit.
`recordTourEvent` (app/src/lib/tourEvents.ts:29-55) requires a `tourId`. It
writes the LANDLORD's timeline too (recordPersonMilestone,
app/src/lib/personEvents.ts:77-109), a `units#` row whose payload is
`{ tourId }` only, and a `tours#` row. `listing_declined` and
`listing_decline_cleared` have no tour. The plan needs a new writer, and the
spec must decide three things:
- (a) Tenant-only or a landlord copy. A decline is not deal news for the
  landlord; see the dual-party rule at personEvents.ts:6-9.
- (b) refType/refId: `unit`/unitId like `listing_sent`
  (app/src/jobs/broadcastFanOut.ts:1249-1257), or `tour` for
  `listing_interested`.
- (c) The unit-audit payload keys. Only whitelisted keys reach the Activity
  wire (app/src/routes/units.ts:243-274):
  - `contactId` (drives the contactName enrichment, units.ts:1528-1543);
  - `actor` (hoisted to `actorId`, app/src/repos/auditRepo.ts:91-97);
  - `tourId` for interested (gives the row a link).

  `by`/engine is NOT whitelisted, so "(auto)" cannot show on the property
  Activity card without extending the projection and the dashboard mirror
  (dashboard/src/api/types.ts:3132-3152).

A6. The Timeline does not take labels from its variant switch. The contact
Timeline renders the SERVER label verbatim
(dashboard/src/routes/contact/Timeline.tsx:467-469). `milestoneVariant`
(:424-444) only picks a color and defaults to neutral, so it needs no change.
"Not interested in <address>" etc. are written by the outcome route in
`activityEvents.record({ label })`, so the route needs the unit's address
(`formatStreet` / `formatAddress`, app/src/lib/address.ts:90-126; the unit is
already read for `tour_type`). The property Activity labels ARE dashboard-side,
in `describeUnitActivity` (dashboard/src/routes/listing/listingFormat.ts:170-232,
where `who = contactName ?? contactId` at :172).

A7. The D12 error-surface fix belongs in props, not in useContactFile (spec
:700-703). `loadSlice` ALREADY returns `{ status: 'error' }` distinct from
`'pending'` (dashboard/src/routes/contact/useContactFile.ts:51-63), and a 503 is
not a 404, so it yields `'error'`. The collapse happens later:
- ContactDetail passes `listingsSentPending={file.listingsSent.status !== 'ready'}`
  (dashboard/src/routes/contact/ContactDetail.tsx:1176, :1228);
- the cards take that boolean (TenantFile.tsx:58-61, :306-307;
  PartnerFile.tsx:42-45, :168-169).

The fix is a prop change on both cards.

## B. Under-specified for a literal builder

B1. The units router has no activity-events dependency. `UnitsRouterDeps`
(app/src/routes/units.ts:86-126) and the constructor (:344-356) have no
`activityEventsRepo`. app/src/routes/api.ts:958-981 must pass
`activityEventsRepo: activityEvents` (built at api.ts:600). The harness reaches
the router through api.ts.

B2. The contact listings-sent route has no unit context for `interestedMode`.
It reads only the listing rows and the tenant's tours
(app/src/routes/contacts.ts:1220-1251). `interestedMode` (spec :669-672) needs
each row's `unit.tour_type`, and no units batch read carries it
(`getDisplaysByIds` projects unitId + address, best-effort,
app/src/repos/unitsRepo.ts:454-461, :767-800). Two choices:
- add a units join to the route, and decide whether it is required (D12) or
  best-effort;
- derive the mode client-side from `file.units`, which the contact page already
  loads (useContactFile.ts:143) and both cards already receive
  (TenantFile.tsx:57, PartnerFile.tsx:41). The address for accessible names is
  already client-side there too (TenantFile.tsx:107-112).

The property card has `unit.tour_type` locally (ListingDetail.tsx:316).

B3. The wire-row contract is scattered. The per-row block (spec :708-715) lists
`lastHeardFromAt`, `outcome`, `declined` and `interestedSupported`. Other
sections add more fields:
- `interestedMode` (:669-672);
- `recipientMissing` (:691-697);
- `eligible`, units only (:765).

Consolidate them into one contract per endpoint. `toListingSendRow` takes
positional arguments today (listingSendsRepo.ts:179-201); an options object
would scale better. `type` is units-only today, and a parity test pins the
contact side WITHOUT it (app/test/listingSendsApi.test.ts:146-168).

B4. The outcome route's response list (spec :614-621) is missing two answers
that the bullets introduce: 409 `tour_type_required` (:631-634), and the 503
body carrying `saved: true` (:643-645). Add both, plus the I2 errors from A2 if
adopted.

B5. 404 `send_not_found` needs the LISTED rule. `getByKey` returns uncounted
rows too (listingSendsRepo.ts:208-216), and `isListed` is private (:169-171).
Use the exported `ledgerRowCounted` (app/src/services/shareLedger.ts:102-104),
which applies the same rule, or export `isListed`. Spec :504 conditions
`setDeclined` on `attribute_exists(unitId)`, and that alone would succeed on an
uncounted row.

B6. The eligibility rule differs between 5.5 and 5.6. 5.5 (spec :756-765)
lists: not deleted, not opted out, not unreachable, not an inactive or placed
tenant; it adds `deleted_at`, `sms_opt_out`, `sms_unreachable` and `status` to
the projection. 5.6's shared `isEligibleRecipient` (:803-812) also requires a
phone, which is the resolver's scalar `phone` (app/src/services/audienceResolution.ts:154,
already in DISPLAY_PROJECTION, app/src/repos/contactsRepo.ts:1003-1012). Pick
one rule. `status` is a DynamoDB reserved word and needs a placeholder in
RECIPIENT_PROJECTION (contactsRepo.ts:1018-1025, like `#type` / `#role`). The
harness `projectRecipient` (app/test/helpers/twilioWebhookHarness.ts:2219-2226)
must mirror whatever the projection gains.

B7. `getRecipientDisplaysByIds` has no `requireComplete` option today
(contactsRepo.ts:716-720, :1284-1286), although `batchGetByIds` supports it
alongside a projection (:957-1000). The harness fakes ignore `requireComplete`
(twilioWebhookHarness.ts:2270-2285), so a 503-on-incomplete test must reassign
the method to throw `IncompleteBatchReadError` (contactsRepo.ts:622-633).

B8. No seam exists to replace a row in place after an action (spec :749-750):
- useListing exposes no recipients setter and no refetch
  (dashboard/src/routes/listing/useListing.ts:49-70, :131-242);
- useContactFile exposes only a whole-file `refetch` (useContactFile.ts:91-105).

Each hook needs a per-row setter. Mirror the `forId` guard of `setUnit`
(useListing.ts:148-172).

B9. Two gaps in the `?tour=new` / `?tour=new&tenantId=` entry (spec :663-667).

The page cannot react to the param today. ListingDetail reads no search params
(imports at ListingDetail.tsx:15; no `useSearchParams`), and the
`/listings/:unitId` element is not keyed (comment at ListingDetail.tsx:223-230).
A partner row's "Request a tour" link on the SAME property page therefore needs
the page to react to a param change while mounted, and to clear the param when
the dialog closes (otherwise Back or a refresh reopens it).

The tenant side will be locked. Passing `tenantId` to ScheduleTourForm LOCKS the
tenant side (ScheduleTourForm.tsx:57-58, :166, :360-363), so the "pre-committed"
tenant (spec :654, :664-667) is read-only. Fine if intended, but the spec should
say so. The form's fetch effect re-runs on `[tenantId, initialUnitId]` (:231).

B10. Soft-deleted property and soft-deleted tenant are unspecified.
ListingDetail hides "+ Tour" on a deleted property (ListingDetail.tsx:1166-1175;
test ListingDetail.test.tsx:1115-1122). Should the outcome route refuse
`interested` on a deleted unit, and should the card hide its actions there? POST
/api/tours does not check the unit at all (tours.ts:332-336). A soft-deleted
TENANT passes `requireTenantContact` by design (toursCreateContactType.test.ts:141-148).

B11. Partner rows still carry the server `tour` field. The contact
listings-sent route attaches `tour` for every row, partners included
(contacts.ts:1244-1249), and PartnerFile drops it client-side
(PartnerFile.tsx:173-178, ruling R3-F5). The spec says partner outcomes ignore
tours (:552, :768-771). Should the server also stop attaching `tour` to partner
rows (it knows the type now)? Unstated.

B12. Card.module.css has no styles for the new row:
- tones are TEXT colors only (`.yes`, `.no`, `.wait`, `.muted`;
  dashboard/src/routes/contact/Card.module.css:196-210);
- TourChip is a colored text link, not a pill (:179-194);
- there is no small-button or row-error class;
- `.li` is a single-line flex row whose label does not wrap (:122-159).

The two-line row, the action buttons and the inline error need new classes.

## C. Existing tests the change inverts (rewrite knowingly, do not delete)

C1. app/test/listingSendsApi.test.ts:
- :64-84, 'c-ghost' with no contact row (becomes `recipientMissing`);
- :146-168, parity between the two directions;
- :200, exact `toEqual`;
- :228, exact `toEqual` including `tour`;
- :298-339, E3 degrade: a tours failure gives 200 chipless rows (becomes D12
  503);
- :379-425, 'c-gone' unresolved row (becomes `recipientMissing`);
- :427-447, a failed display batch gives 200 nameless rows (becomes D12 503).

Keep the PATCH-404 pin at :342-361: the new route is POST
`.../recipients/:contactId/outcome`.

C2. dashboard/src/routes/listing/ListingDetail.test.tsx:
- :559-560 assert that a row's `textContent` EQUALS the name, which breaks once
  rows carry dates and chips;
- :503-518 build rows with no outcome fields, so the wire type change makes
  them non-conforming.

There is no dedicated SendRosterRow or PartnerFile test. TourChip has one
(dashboard/src/routes/contact/TourChip.test.tsx). The partner card is covered
only at ContactDetail.test.tsx:3002-3033.

## D. Line drift since the spec (semantics unchanged unless stated above)

| Spec citation | Now |
|---|---|
| routes/tours.ts:157 (PATCH allowlist) | :159 |
| routes/tours.ts:298-307 (event writer) | :300-308 |
| routes/tours.ts:325-327 (tenantId required) | :327-331 |
| routes/tours.ts:392-396 / :397-401 | :411-415 |
| routes/units.ts:183-246 (audit reader) | :210-274 (projection) + :1469-1548 (route) |
| routes/units.ts:1002-1034 | :1071-1130 |
| routes/units.ts:1029 | :1110 |
| dashboard/src/api/types.ts:2703 | :2715 |
| dashboard/src/api/types.ts:2943 | :2955 |
| dashboard/src/api/types.ts:3119 | :3131 |
| ListingDetail.tsx:1304-1312 | :1403-1412 |
| ListingDetail.tsx:1057-1058 | :1155-1156 |
| ListingDetail.tsx:194 (useContacts, 5.7) | :212 |
| ContactDetail.tsx:1306-1313 | :1348-1362 |
| ContactDetail.tsx:1134 | :1176 and :1228 |
| ContactDetail.tsx:539 (useContacts, 5.7) | :561 |
| ScheduleTourForm.tsx:3 / :310-318 | :2-5 / :311-321 |
| listingSendsRepo.ts:277-280 | :276-285 |

Unchanged and verified:
- listingSendsRepo.ts:71-97;
- services/shareLedger.ts:112-120 (the spec omits the `services/` prefix);
- listingSendTour.ts:41-45;
- toursRepo.ts:559;
- toursModel.ts:214-218;
- activityEventsRepo.ts:27-31;
- contactsRepo.ts:943-951, :986-998, :1018;
- contacts.ts:1229-1248;
- Card.tsx:79-82, :218-247;
- Timeline.tsx:428-444;
- useContactFile.ts:51-61 (but see A7);
- lib/contactProfile.ts:9-24.
