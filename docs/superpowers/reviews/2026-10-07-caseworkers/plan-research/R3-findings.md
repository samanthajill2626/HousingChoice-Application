# R3 findings - direct property shares to partners (D20, I2) - the send path

Plan research for branch B (`feat/caseworkers` @ 97ac55ee), spec revision 13.
Reader R3. Findings only; the surface tables, invariant enumeration and test
pins (byte-exact) live in the gitignored reference
`.superpowers/sdd/plan-research/R3-reference.md`.

Severity: HIGH = the plan cannot be written correctly without a ruling or a
named extra step; MEDIUM = a builder would guess; LOW = precision.

## Confirmed as the spec states (no action)

- Both fan-out mint sites hard-code `'tenant_1to1'`:
  `app/src/jobs/broadcastFanOut.ts:871` (send pass) and `:1386` (reconcile
  adoption). `conversationTypeFor` is exported at
  `app/src/lib/voiceMasking.ts:28-39` and already maps partner ->
  `partner_1to1`.
- Every gate is type-agnostic: `fenceFor` (`broadcastFanOut.ts:261-281`),
  the send wrapper (`app/src/services/sendMessage.ts:483-484` refuses only
  relay/group thread types), `hasSmsConsent`
  (`app/src/lib/smsCompliance.ts:101-103`).
- Filter-resolved audiences stay tenant-only with no change:
  `app/src/routes/broadcasts.ts:130-132`,
  `app/src/services/audienceResolution.ts:147`. The recipient search stays
  tenant-only with no change: `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:273`.
- Properties-sent rows load for every contact type: route
  `app/src/routes/contacts.ts:1168-1199` (no type guard), loader
  `dashboard/src/routes/contact/useContactFile.ts:144`; `units` also load for
  every contact (`:141`), so PartnerFile's card adds no new GET.
- A partner's reply is never extracted: `app/src/jobs/extraction.ts:457`
  skips a `partner` contact even on an `unknown_1to1` thread.

## Findings

### F1 (HIGH) - the spec's neutral-wording list misses five tenant-worded share surfaces

D20 says wording goes neutral "everywhere it is tenant-only today" and then
lists surfaces; the list misses:
1. The property page's kebab item "Send to tenants"
   (`dashboard/src/routes/listing/ListingActionsMenu.tsx:107`, JSDoc `:16`).
   Pinned by `ListingDetail.test.tsx:980-990`,
   `e2e/tests/dashboard-next/broadcasts.spec.ts:143`,
   `e2e/scenarios/steps.ts:1054`. The spec names only the card action's
   aria-label "Send this property to tenants" (`ListingDetail.tsx:1027`).
2. The Matching list empty state, which quotes that kebab item AND "a
   tenant's Properties sent" (`dashboard/src/routes/broadcasts/BroadcastsList.tsx:132-133`)
   - stale on both counts once partners have the card.
3. "Nothing selected - check at least one tenant to send."
   (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:294`, the
   `empty_audience` 400 mapping).
4. "Flagged tenants you picked stay checked; ..." (`RecipientPreview.tsx:364`),
   pinned by `RecipientPreview.test.tsx:251` and
   `e2e/tests/dashboard-next/share-skip-fix.spec.ts:31`.
5. The ZERO case "No tenants reached" on BOTH the property Activity row
   (`dashboard/src/routes/listing/listingFormat.ts:181`) and the landlord
   timeline (`app/src/routes/contactTimeline.ts:696`); the spec names only
   "Sent to N tenants". Pinned by `listingFormat.test.ts:248-253`,
   `app/test/contactTimeline.test.ts:1264`,
   `e2e/tests/dashboard-next/share-sent-outcome.spec.ts:671`.
Also: the landlord timeline has TWO label sites, not one -
`contactTimeline.ts:695-697` (`sentToLabel`, the read-time recount, applied
at `:1475`) and `:764` (the stored-count fallback in
`unitAuditToMilestone`). The spec's "~760" points at the second only.
Plan: one ruling per item (all five are tenant-only today, so the spec's
own rule says neutral), and list every pin in the reference's section 3.

### F2 (MEDIUM) - surfaces that must deliberately STAY tenant-worded, or a builder will over-apply the rule

"Neutral everywhere it is tenant-only today" will be read literally. These
are accurate because the thing they describe stays tenant-only:
- "Add more tenants by filters" (`BroadcastComposer.tsx:528`) - the filters
  only ever add tenants.
- "Add a tenant" label and input (`RecipientPreview.tsx:461, 472`) - the
  search stays tenant-only (pinned 9 times in `RecipientPreview.test.tsx`).
- "No candidates - add a tenant below." (`RecipientPreview.tsx:400`) points
  at that search; keep or neutralize - rule it.
- `audienceSummary` leads every filter-mode row with "Tenants"
  (`dashboard/src/routes/broadcasts/broadcastFormat.ts:60-61`; used by
  `BroadcastsList.tsx:40`, `BroadcastResults.tsx:209`). It describes the
  filter, but a filter-mode share CAN now carry a partner seed: the composer
  opened from a partner (`?contactId=`) and flipped with "Add more tenants by
  filters" stores `audience_mode: 'filter'` with the seed
  (`broadcasts.ts:550-551`), so its list row reads "Tenants - 2-BR" while one
  recipient is a partner. Rule it (keeping it is defensible: it summarizes
  the filter). Pins if changed: `broadcastFormat.test.ts:29-32`,
  `BroadcastsList.test.tsx:81`.
- The tenant page's "Send a property to this tenant"
  (`dashboard/src/routes/contact/TenantFile.tsx:295`) stays; PartnerFile needs
  its own aria-label (unstated - see F9).

### F3 (MEDIUM) - "partner rows labelled by their role" has no rule for a role-less partner or other types

- Every partner today has NO role (D19 says so), so "labelled by their role"
  yields an empty label for every partner row until a conversion. The
  existing helper `displayKind` (`dashboard/src/routes/contact/contactProfile.ts:63-68`,
  role else `CONTACT_TYPE_LABEL[type]`) gives "Partner"; the spec should say
  so or the plan should.
- A listing-send row's contact can now be any type: a tenant-era send to a
  contact later re-typed landlord / unknown / team_member by the generic type
  change, or converted to a caseworker (who then shows as "Caseworker" on a
  send made while they were a tenant). Rule: label every non-tenant row by
  `displayKind`, or partner rows only.
- A row whose contact does not resolve (deleted id gone, or the best-effort
  batch failed - `app/src/routes/units.ts:1006-1013` swallows the error) has
  no type: the row must render unlabelled, and the wire must OMIT
  `type`/`role` (not null) - `app/test/listingSendsApi.test.ts:223` pins the
  exact shape of a row whose contact is missing.

### F4 (MEDIUM) - the recipients wire change touches a SHARED row shape and a SHARED projection

- `ListingSendRow` / `toListingSendRow` are shared by
  `GET /api/units/:unitId/recipients` (`units.ts:1018`) and
  `GET /api/contacts/:contactId/listings-sent` (`contacts.ts:1196`)
  (`app/src/repos/listingSendsRepo.ts:105-115, 166-186`; dashboard mirror
  `dashboard/src/api/types.ts:2871-2883`). Adding `type`/`role` to the units
  route only breaks `app/test/listingSendsApi.test.ts:146-163` ("the two
  directions return the SAME row" - its `c-x` is a resolvable tenant). The
  spec says only "the recipients rows gain type and role". Plan: optional
  fields, units route only, and amend that pin (the contact-side row's
  contact is the page owner, so the fields would be redundant there).
- The names come from `contacts.getDisplaysByIds`, whose projection
  (`app/src/repos/contactsRepo.ts:913-923`, type `:311-317`) is shared by
  `getDisplayById` and seven other callers. Either widen it (all callers
  then read two more attributes) or add a second projection for this route;
  the plan must pick. `type` and `role` are DynamoDB reserved words
  (placeholders required).
- The test fake models the projection field-for-field
  (`app/test/helpers/twilioWebhookHarness.ts:2155-2168`, "MODELS THE REAL
  DISPLAY PROJECTION"). It must change in the same task, or route tests
  either fail for the wrong reason or pass on a fake that the real repo
  does not match (the "harness fake != real repo" trap).

### F5 (MEDIUM) - Properties sent on a CONVERTED caseworker shows tenant-era history with tour chips

The partner page's new card reads `listings-sent` for the contact, whose tour
chips come from `tours.listByTenant(contactId)` (`contacts.ts:1178-1196`).
For a contact converted from tenant, the card lists the homes sent to them
as a voucher holder, each with a chip linking to their own past tour - while
D19 says "the partner page does not show tenant history". Rule: show the
rows (they are listing sends, which D19's dialog says "stay") with or
without chips. Suppressing chips is a PartnerFile prop choice, no server
change.

### F6 (LOW) - preview voucher facts are wire-only; the dashboard never shows them

D20 ("Preview rows carry voucher size and housing authority only for
tenant-typed recipients") came from design-review adjudication A-F14,
whose premise was "preview shows a partner's authority as voucher facts".
The composer never renders them: `RecipientPreview.tsx:78-93` ignores
`voucherSize`/`housingAuthority`, and no dashboard file reads
`PreviewCandidate.voucherSize` (`dashboard/src/api/types.ts:3268-3285`). The
change is still right (the wire should not call a partner's leftover
authority a voucher fact), but the plan proves it with an API test beside
`app/test/broadcastApi.test.ts:1142-1165`, not a UI test. The lean partner
Renee Carter holds a housing authority (`app/src/lib/seed/lean.ts:175`), so
she is a ready fixture for that negative.

### F7 (LOW) - "a recipient row's fallback name" exists only on the results page

D20 lists it under "the composer preview and results". The composer preview
has no fallback label: a row's name is
`contactDisplayName(first, last, phone)` (`RecipientPreview.tsx:82`). The
only "Tenant" fallback is the results row (`BroadcastResults.tsx:58`, pinned
`BroadcastResults.test.tsx:139-145`); the server comment at
`app/src/routes/broadcasts.ts:290-291` names it.

### F8 (LOW) - what "no open conversation" means, and why the adoption site's change is hard to test

`createOrGetByParticipantPhone` (`app/src/repos/conversationsRepo.ts:1252-1308`)
returns the GSI's open item whatever its type, else the phone CLAIM's
conversation whatever its status and type (`:1303-1304`); 1:1 threads have no
close path (only relay groups close, `:882-886`). So the `type` argument
takes effect only on the FIRST thread ever minted for that phone. D20 and I2
hold as written; the plan's tests should say "no thread for this phone",
not "no open thread".
The adoption site (`broadcastFanOut.ts:1386`) in practice finds the thread
the pass created during PREPARE, before the attempt claim
(`:871` precedes `attempts.claim` at `:876`), so its type argument only
matters if the thread is missing (for example the contact's phone changed
between the pass and the reconcile). A test proving the adoption site mints
`partner_1to1` must call `adoptBroadcastRecipient` directly for a partner
whose phone has no thread. Neither site's minted type is pinned by any
existing test (`broadcastFanOut.test.ts` and `sendReconcile.test.ts` only
pre-mint `tenant_1to1` fixtures for tenants).

### F9 (LOW) - PartnerFile's "+ Send" adds a second strict-mode collision for a bare `name: 'Send'`

`e2e/support/selectors.md:45` documents that a non-exact
`getByRole('button', { name: 'Send' })` collides with the tenant page's
"+ Send" (aria-label "Send a property to this tenant"); four group-text specs
carry the same comment. PartnerFile's new action will collide the same way.
No current spec drives a partner contact page with a bare `'Send'`, but the
plan should name the partner aria-label (unstated in the spec) and update
the selectors.md row.

### F10 (LOW) - e2e data: the lean partner cannot be the share recipient

Renee Carter (`contact-hastaff-0001`, `app/src/lib/seed/lean.ts:160-178`) is
the only lean partner. She has NO consent by design (`lean.ts:153-154`), so
her preview row is disabled ("consent not recorded") and the fan-out would
skip her; she sits in a seeded relay group (`lean.ts:321`); and she is an
expected row on the Possible caseworkers list. A partner-share e2e should
mint a run-unique, consented partner through the API instead of mutating
her. Template flow: `e2e/tests/dashboard-next/matching-entry-points.spec.ts:103-190`.

### F11 (LOW) - the fan-out does not re-check contact type, so "never mints tenant_1to1 for a partner" relies on send-time typing

The route fences type at Send (`broadcasts.ts:434`, `:827`); the fan-out
re-reads flags but not type (`broadcastFanOut.ts:862-869`, `fenceFor`). With
B's change a contact re-typed between Send and the fan-out is texted into a
thread minted for its CURRENT type (a mid-share caseworker conversion mints
`partner_1to1` - good; a mid-share generic re-type to landlord mints
`landlord_1to1` from a share). Pre-existing gap, and I2 still holds; the
plan should say B keeps it (no type re-fence) so no builder adds one
silently.

### F12 (LOW) - persisted keys named for tenants stay; only copy changes

The finalize audit payload key `tenantCount`
(`broadcastFanOut.ts:1584`; read `app/src/routes/units.ts:192, 224, 1321`,
`contactTimeline.ts:760`, dashboard `types.ts:3059`) and the wire field
`ListingSendRow.tenantName` are data. "Recipient wording goes NEUTRAL" is a
copy rule; renaming either is a migration on append-only rows. The plan
should say both stay.

### F13 (LOW) - stale comments a builder will otherwise leave contradicting the code

PartnerFile's header says it "Deliberately omits ... listings-sent"
(`dashboard/src/routes/contact/PartnerFile.tsx:1-9`); AudienceFilters says
"property sends are ALWAYS tenants" (`AudienceFilters.tsx:100-102`);
`resolveSeeds`' doc says "Resolve seed contact ids to sendable tenants ...
type 'tenant'" (`broadcasts.ts:421-424`); the fan-out header says "each
matching TENANT's 1:1 conversation" (`broadcastFanOut.ts:1-6`, `:870`). The
full list is in the reference, section 1.6.

### F14 (LOW, pre-existing) - seed and explicit resolution do not fence deleted contacts

`resolveSeeds` (`broadcasts.ts:430-438`) and the explicit loop
(`:825-830`) accept a soft-deleted contact; the fan-out skips it
(`contact_deleted`, `broadcastFanOut.ts:264-271`). Unchanged by B and
consistent with D20's "every existing gate applies unchanged"; noted so the
new shared tenant-or-partner predicate is not mistaken for the place to add
a deleted check.
