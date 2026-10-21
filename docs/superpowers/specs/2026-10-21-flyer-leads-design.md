# Flyer trim and flyer / join leads - design

Status: DRAFT revision 2 (2026-10-21). It folds in review round 1 (two
reviewers, 18 merged findings, all accepted) and goes to round 2, then
Cameron's spec gate. Adjudications:
`docs/superpowers/reviews/2026-10-21-flyer-leads/design-review/adjudications.md`.
Branch: `feat/flyer-leads` (worktree `W:\tmp\flyer-leads`, cut from main @b7959e2a)
Tracker: Sam's 2026-10-21 flyer feedback (relayed by Cameron); Improvements
Tracker item #13 "Flyers and leads"; and a subzone-matching fix Cameron asked
for in the same conversation.
Review records: `docs/superpowers/reviews/2026-10-21-flyer-leads/`. intent.md
holds Cameron's decisions verbatim.

Vocabulary: a `unit` in code is a "property" in staff copy and a "home" in
tenant copy (documentation/GLOSSARY.md). A contact's 1:1 conversation is
shown on the contact page as its thread (`Timeline`).

Context: main already holds the landlord requirements / property fields
change (#11 + #12, spec `2026-10-20-property-requirements-design.md`, merged
e46cc770, NOT deployed yet). This spec changes several of its flyer
decisions (its D3 and D11). Where the two disagree, this spec wins.

## 1. Goal

1. The public flyer no longer publishes rent, lease terms, accessibility,
   pets or deposit. Sam: "This is information I will want but does not
   need to be on the flyer." All of those fields stay in the system, on the
   forms and on the property page, as Staff only.
2. The flyer page carries tracker #13's changes:
   - the address becomes the heading;
   - "Same-day tours available" appears on every flyer;
   - the housing authority line is bolder;
   - the sign-up box is reworded so it does not read like a tour request.
3. A sign-up from someone who is ALREADY a contact, on the flyer or on
   /join, no longer sends them the welcome text. It is recorded in their
   thread, and their conversation is marked unread so staff see it in the
   inbox.
4. A flyer sign-up for a property the contact has never been sent puts that
   property on their properties-sent list, because they have seen it, with
   its own "Signed up from the flyer" state. This applies to tenant and
   unknown contacts, new or existing.
5. Similar properties treat "se11", " SE11 " and "SE 11" as the same
   subzone.

Why: Sam would rather talk rent, deposit, pets and lease terms through with
each tenant than publish them. Flyers now travel through caseworkers.
Tenants filled in the sign-up box as if it booked a tour. Existing tenants
got the welcome text in the middle of an ongoing conversation, and their
sign-up left no trace on the dashboard.

## 2. Decisions

### D1. The public projection drops the trimmed fields

`toUnitFlyer` and its `UnitFlyer` type (`app/src/lib/unitFields.ts`) no
longer carry these keys:
- `rent_min`, `rent_max`;
- `lease_terms`, `accessibility`;
- the Pets item: `pets`, `no_pets`, `pet_fee`;
- the Deposit item: `deposit`, `deposit_one_month`, `deposit_flexible`.

The keys are REMOVED from the payload, not sent as null. "Off the flyer"
means the public endpoint never returns them; hiding them in the page is not
enough. The dashboard's `PublicFlyer` type
(`dashboard/src/routes/public/publicApi.ts`) drops the same keys.

`application_fee` stays, with "No application fee" for 0 as today. So do
beds, baths, voucher sizes, accepted authorities, address, area, utilities
("Tenant pays"), washer / dryer, same-day RTA, video and listing link.

**Old flyer pages.** A flyer page from the OLD dashboard bundle, fed the NEW
payload, would crash on render. `textOrNull(undefined).trim()` throws, so the
user sees a white page, not a stray value. This is accepted. The page
fetches once on load, and nothing caches the bundle: the app container
serves the dashboard and CloudFront does not cache the default behavior.
Getting the new payload therefore needs a load, and a load brings the new
bundle.

This breaks the projection's documented "only ADDS keys" rule
(`unitFields.ts:375-377`), so that comment is rewritten to record this
deliberate removal and the reason it is safe.

### D2. The tags follow the projection

The D10a tag table (`PROPERTY_FORM_FIELDS`, `app/src/lib/requirements.ts`,
and its dashboard mirror `dashboard/src/routes/listing/requirements.ts`) and
the requirement registry (`REQUIREMENT_ITEMS`) re-tag every removed field
**Staff only**:
- the form rows Rent min, Rent max, Accessibility and Lease terms;
- every field of the Pets item: No pets, Pets (details), Pet fee;
- every field of the Deposit item: One month's rent, Fixed amount,
  Flexible / payment terms available. (Deposit notes were already staff
  only.)

Application fee and "No application fee" stay **On flyer**.

Consequences, all by construction:
- The parity walk (`app/test/propertyFormFlyerParity.test.ts`) keeps
  proving each tag agrees with what `toUnitFlyer` publishes. Its pinned
  35-row table changes only for those rows, and so do the pinned shapes in
  `unitFields.test.ts` / `requirements.test.ts`.
- The landlord form's Requirements fieldset shows Staff only for Pets and
  Deposit. Its "On property flyers" tag remains only on the application-fee
  pair. The landlord legend text is unchanged.
- **The "Tenants see this on the public flyer." note shows only where the
  field is tagged On flyer.**
  - Today the property forms pass `publicNote` by hand on Tenant-paid
    utilities, Accessibility and Lease terms. The requirement fields derive
    it (`RequirementsFields.tsx`: text field AND on_flyer).
  - After this change the note stays only under Tenant-paid utilities.
  - To stop the hand-set prop drifting from the tag again, `TaggedField`
    renders the note only when `visibility === 'on_flyer'`. A test pins
    that a Staff only field never shows the note, even with `publicNote`
    set.

### D3. The flyer page (tracker #13)

Today the h1 is the property's AREA when one is recorded, and "A home for
you" only when there is none (`FlyerPage.tsx:302`). The address is a detail
row further down.

The new ready state, top to bottom:

1. **Photos**, unchanged.
2. **Heading = the address.** It is a link (`target="_blank"`) to the
   existing Google Maps search (`mapsHref`).
   - The h1 reads the street line: line1, then line2, joined by ", ".
   - A second, smaller line in the same link reads "city, state zip"
     (blank parts left out).
   - The link keeps the sr-only " - open in Google Maps" suffix that the old
     Address row carried, for WCAG 2.5.3 and the new-tab disclosure.
   - The separate Address detail row is removed, and its helper
     `addressLines` is deleted.
   - Fallbacks:
     - no street line but any of city / state / zip: the h1 reads that
       city line;
     - no address at all: the area, as plain text, when one is recorded;
     - otherwise the plain text "Home for rent". *(Planner's call: the
       wording.)*
   - "A home for you" no longer appears anywhere.
3. **The area**, when recorded AND an address is the heading: a line
   directly under the heading. The neighborhood is never dropped.
4. **"Same-day tours available"**: a highlighted line, on EVERY flyer (Sam,
   tracker #13: on every flyer, for advertising).
   - It is static page copy, not a property field.
   - The per-property "Same-day RTA" detail row is a different thing
     (Request for Tenancy Approval) and is unchanged.
5. **Facts**: beds, baths, and "Fits a ... voucher". The rent fact is
   removed.
6. **The housing authority line** ("Accepts: ..."), visibly stronger than
   today: bold, larger than body text, full-contrast color. The wording is
   unchanged.
7. **Detail rows**, in this order, each shown only when recorded:
   Application fee, Tenant pays, Washer / dryer, Same-day RTA, Video tour,
   Listing.
   - Removed: Address (now the heading), Deposit, Pets, Pet fee,
     Accessibility, Lease terms.
   - Deleted helpers: `petsLabel`, `depositLabel`, `rentRange` and
     `addressLines`. `flyerMoney` stays, because `applicationFeeLabel` uses
     it.
8. **The sign-up box**, for the bare-link (`form`) variant only:
   - heading: "Sign up for home alerts";
   - text: "We'll text you about this home and others that fit your
     voucher. Signing up does not book a tour.";
   - button: "Sign up";
   - the thank-you keeps its heading "Thanks - you're all set!", and its
     text becomes "We'll text you about this home and others that fit your
     voucher." *(Planner's call: the old "a team member will be in touch"
     read as a tour promise.)*

   Cameron approved this copy to build; Sam reviews it afterwards.

Unchanged:
- the `?cta=text` variant ("Interested in this home?" / "I'm interested -
  text us");
- the unavailable state;
- the tap-to-text prefill (it still uses the area or "this home" when there
  is no street);
- the CTA's position at the bottom.

At 320px the heading wraps and nothing overflows its card. The whole heading
block is the tap target.

### D4. Who counts as an existing contact

`POST /public/housing-fair` (`app/src/routes/public.ts`) dedupes by phone.
Today it uses `contacts.findByPhone`, which returns the FIRST holder the
`byPhone` index yields (`contactsRepo.ts:1287-1292`). Phones can be shared,
for example since caseworkers (`caseworkerConversion.ts:261-268`), and the
first holder may be soft-deleted while a live one exists.

The route switches to `contacts.findAllByPhone`, then:
- **Live holders exist** (not soft-deleted, any type): the sign-up is from
  an EXISTING contact. It is recorded on ONE of them, chosen by type in this
  order: tenant, then unknown, then partner, then landlord, then any other;
  ties go to the first returned. Deleted holders are ignored.
- **Only deleted holders**: the deleted path, below.
- **No holder**: a NEW contact is created, as today.

An existing contact is never CHANGED by a sign-up (the #14 rule, D6 of
`2026-10-12-join-housing-authority-design.md`): no name, type, status,
voucher size or housing authority. The ONE exception is consent (D6.5).

**The deleted path.** Today the route still resolves a conversation, tries
the welcome (refused as `contact_deleted`) and writes the audit. Under this
spec, a deleted-only match:
- writes no conversation and sends nothing;
- records no milestone, unread mark or sent-list row;
- KEEPS the `housing_fair_signup` audit event, with `deletedContact: true`.

That audit row is the only trace the open issue
`docs/issues/deleted-contact-web-signup-silent.md` relies on; fixing the lost
lead is that issue's job, not this mission's. The response is `{ ok: true }`,
as today.

### D5. The welcome text goes to new contacts only

The welcome text is sent ONLY when this request CREATED the contact. An
existing contact never gets it, from either form, whatever
`housing_fair_welcomed` says.

- This replaces today's rule, which welcomes an existing contact who was
  never welcomed (`public.ts:329,384`). That rule is how landlords,
  caseworkers and long-time tenants got the tenant welcome mid-conversation.
- Consequence: a new contact whose welcome failed (refused or errored) does
  not get one from a later sign-up. Staff can text them by hand; their
  consent was stamped at create.
- `housing_fair_welcomed` is still set after a successful welcome.

### D6. An existing contact's sign-up: a pin in their thread and an unread mark

For an existing contact (D4), on both forms, in this order.

1. **The repeat check.** If the contact already has a `signed_up` milestone
   in the last 24 hours, from ANY source, steps 2 and 3 are skipped.
   - The check is a new repo read,
     `activityEventsRepo.hasEventSince(contactId, type, sinceIso)`: a
     key-range query on the contact's partition for
     `tsEventId > sinceIso`, filtered to `type`, paginated to the end of the
     window.
   - So each contact gets at most one sign-up pin and one inbox bump per 24
     hours. That cap is what stops someone who knows a phone number from
     flooding a thread or the inbox.
   - Residual, accepted: one pin a day per known phone can carry a typed name
     the attacker chose. The name is capped at 100 characters per part, and
     the endpoint's per-IP rate limit applies.
   - If the read fails, it fails OPEN: the pin and the bump are recorded.

2. **The pin.** `activityEventsRepo.record` with a new event type
   `signed_up`. It renders as a pin in the contact's thread, like "Property
   sent" and the tour pins (`MilestonePin`).
   - Labels are inline staff copy, the "Property sent" convention. The
     message catalog holds outbound sends only.
   - Flyer, property shareable (today's flyer-attribution test):
     "Signed up from the flyer for <address> as <First Last>", with refType
     `unit` and refId the unitId, so the pin links to the property.
     `<address>` is `formatAddress(unit.address)`, falling back to the
     unitId, as the tour-request label does.
   - Flyer, property NOT shareable (missing, deleted or unavailable; a
     made-up unitId lands here too): "Signed up from a flyer as
     <First Last>", with no ref.
   - /join: "Signed up on the join page as <First Last>", with no ref.
   - `<First Last>` is the name typed on the form, trimmed. The body is
     trimmed app-wide and again by the parser. *Planner's call:* the name
     is shown because the contact itself is never renamed (D4), and an
     auto-captured `unknown` contact has no other name.

3. **The unread mark.** The contact's 1:1 conversation is bumped to the top
   of the inbox and marked unread:
   - `touchLastActivity` first (status open, `last_activity_at` = now),
     then `conversations.incrementUnread`, then ONE `conversation.updated`
     event carrying the new unread count.
   - Touching first means a failure can never leave a closed thread flagged
     unread but invisible.
   - The thread is resolved with
     `createOrGetByParticipantPhone(phone, conversationTypeFor(contact))`
     (`voiceMasking.ts:28-39`), so a landlord, partner or unknown contact
     with no thread yet gets a correctly typed one. New contacts keep
     `tenant_1to1`, as today.
   - The public router gains an `events` dependency, defaulting to
     `appEvents`.
   - The inbox preview still shows the newest message (`inbox.ts` derives it
     from message rows). The row is unread and on top, and the pin is inside
     the thread.

4. **Failures never reach the public page.** Every step after the contact is
   resolved or created is best-effort: the repeat read, the pin, the touch
   and unread mark, the sent-list write (D7) and the consent stamp (step 5).
   A failure is logged with the phone marker and no PII. The response is
   `{ ok: true }`, as for a failed welcome today.

5. **Consent.** The web form required `smsConsent === true`. When an existing
   contact has NO `consent_method`, the sign-up stamps
   `consent_method: 'web_form'`, `consent_at` and `consent_version`, exactly
   as a create does.
   - Without this, the staff reply that the unread mark invites would be
     blocked by the consent gate (`sendMessage.ts:541-557`,
     `contact_no_consent`).
   - It is the only field ever written to an existing contact (D4).
   - A contact that already has consent is untouched, and opt-out state is
     never touched.
   - *Planner's call, a narrow exception to #14's rule, for Cameron at the
     gate.*

NEW contacts are created as today (status, capture source, unit of interest,
consent), and they get the welcome text. They also get the `signed_up` pin,
for a uniform history in which the pin names the flyer. They are NOT marked
unread: the welcome text is outbound, and new leads already surface as Needs
review / Onboarding. *(Planner's call.)*

The `housing_fair_signup` audit event gains these booleans, with no PII:
- `existingContact`;
- `deletedContact`;
- `recorded` (pin written);
- `sentRecorded` (sent-list entry written);
- `consentStamped`.

### D7. A flyer sign-up puts a NEW property on the properties-sent list

When a sign-up carries a unitId for a shareable property (today's
flyer-attribution test), the contact is a `tenant` or `unknown`, and that
(property, contact) pair has NO counted share yet, the property goes on the
contact's properties-sent list. This applies to new and existing contacts
alike.

- **Mechanism: a share ENTRY, not a new row kind.** `listing_sends` holds one
  row per (unit, contact) pair (`listingSendsRepo.ts:10-12`), with a
  `shares` map of entries. The flyer sign-up adds one entry through the
  ledger path every share uses (`applyShareLedgerEntry` ->
  `putShareMemory`):
  - share key `flyer`;
  - attempt key `<sign-up ISO>#flyer`;
  - state `counted`, by `acceptance`;
  - `countedAt` from the attempt key's ISO prefix.
- **`summarize` maps the key `flyer` like `individual`**, so the pair gets
  no `broadcastId` from it. `via` is untouched: it stays the first-write
  value, which nothing renders.
- **First sight only.** If the pair already has ANY counted entry, sent by
  a broadcast or individually, and whatever its outcome (replied, declined,
  interested), nothing is written to the ledger: the property is already on
  their list. This is why a flyer sign-up never moves an existing pair's
  `sentAt`, never flips a Replied pair, and never supersedes a decline.
- **Residuals, stated.**
  - An UNCOUNTED pair (a text that failed) does become counted. Its old
    "Property text failed" pin then reads "Property sent"
    (`contactTimeline.ts:732`).
  - The repair script's census (`app/scripts/repair-share-outcomes.ts`)
    sees the new entries.
- **A repeat flyer sign-up** for a pair that now holds the flyer entry
  writes nothing: the first-sight rule.
- **No "Property sent" milestone** is written for it. The `signed_up` pin
  says which flyer.
- **Landlord, partner and other contact types** get the pin and the unread
  mark (D6), but no sent-list entry: the list is a record of homes offered
  to someone looking for one. *(Planner's call.)*
- **Known limit, unchanged:** the Matching composer's "already sent this
  property" hint reads broadcasts, so it does not see a flyer entry.

### D8. The send outcome `signed_up`

A pair whose LATEST counted entry is the `flyer` entry reads a new outcome,
`signed_up`. The ONE derivation, `deriveListingSendOutcome`
(`app/src/lib/listingSendOutcome.ts`), checks in this order:

1. decline;
2. tour;
3. replied (last heard from after `sentAt`);
4. then `signed_up` when the latest counted entry is `flyer`, else
   `no_reply`.

Each caller computes "latest counted entry is flyer" from the row's stored
`shares`. No new stored field is added.

- **`signed_up` is never "waiting"** (`isWaiting`). A flyer sign-up is
  therefore not on the Follow up tab and not in the Properties "<n> waiting"
  pill. The person reached out, and the unread mark (D6) already puts it in
  front of staff.
- **A later counted share of the same pair** (staff send it, a broadcast)
  becomes the latest entry, and the pair reads as any sent property again.
- **Renderers:**
  - the roster row (`SendRosterRow` in `Card.tsx`, on the contact page and
    the property page) reads "Signed up from the flyer <date>" in place of
    "Sent <date>";
  - the outcome chip reads "Signed up";
  - every other place that names an outcome treats `signed_up` like an
    interest signal.
  - In particular, the Matching blast for that property keeps the tenant
    checked by default (`blastAudienceRules.ts` excludes only
    `not_interested`).

### D9. Similar properties match the subzone ignoring case and spacing

`scoreArea` in `app/src/lib/similarUnits.ts` compares subzones after
normalizing both: remove ALL whitespace, then uppercase.
- "se11", " SE11 " and "SE 11" are the same subzone.
- A value that normalizes to empty never matches.
- No fuzzy matching: "SE1" and "SE11" stay different.

The area comparison is unchanged; fuzzy matching on free text waits for the
new matching engine (Work Package 1). The "Same subzone" reason text is
unchanged. Stored values are not rewritten (no backfill); saves already trim
the subzone (`unitFields.ts:300-309`).

### D10. Whitespace

Cameron's standing rule: typed input is trimmed before it is stored or
compared. This change adds no new stored typed input:
- the sign-up body is trimmed app-wide and by the parser;
- the pin label is built from those trimmed values;
- the subzone comparison normalizes (D9).

A reviewer who finds an untrimmed path in a surface this change touches
reports it.

## 3. Out of scope

- Subzone AUTO-FILL from the address. It is a separate feature with its own
  session; the research is in
  `W:\tmp\subzone-autofill-research\research-report.md`.
- A subzone dropdown (rejected by Cameron).
- The `[Rent]` broadcast merge field (unchanged, by Cameron's decision).
- Any stored-data change: no backfill, no deletion. The trimmed fields keep
  their values.
- Recovering deleted-contact sign-ups (D4, open issue).
- The Matching composer's sent hint (D7).
- Fuzzy matching beyond the subzone.
- Making a sign-up move "Last heard from". That stays inbound-message-only
  (GLOSSARY); the `signed_up` outcome covers the sent list instead.
- #13's "AHA Housing Fair link defaults to AHA", which already shipped with
  #14.

## 4. Surfaces (write and read) - every one is a plan task or a watch item

**Public projection and tags (D1, D2):**
- the projection: `toUnitFlyer`, `UnitFlyer` and its "only ADDS keys"
  comment (`unitFields.ts`);
- the tag tables: `REQUIREMENT_ITEMS` and `PROPERTY_FORM_FIELDS`
  (`requirements.ts`), plus the dashboard mirror and its drift test;
- `GET /public/units/:unitId/flyer` (`public.ts`);
- the flyer page: `PublicFlyer` and `FlyerPage.tsx` with its CSS;
- the tag components: `FlyerTag` / `TaggedField` / `RequirementsFields`;
- the forms: `ListingEditForm.tsx` and `UnitCreateForm.tsx` (the
  `publicNote` props), and the landlord `ContactEditForm`;
- app tests: the parity test, `unitFields.test.ts`,
  `requirements.test.ts`;
- dashboard tests: `FlyerPage.test.tsx`, `publicApi.test.ts`,
  `TaggedField.test.tsx`, `RequirementsFields.test.tsx`,
  `ContactEditForm.test.tsx`;
- e2e: `public-pages.spec.ts` (including the area-heading assertion),
  `property-requirements.spec.ts` (tags and flyer rows),
  `contact-detail.spec.ts` (the landlord Pet fee tag),
  `listing-photos.spec.ts` (the "I'm interested" button), and
  `e2e/support/selectors.md`.

**Sign-up handling (D4-D7):**
- `POST /public/housing-fair` (`public.ts`) and its deps:
  - existing deps: `contacts.findAllByPhone`;
  - new deps: `activityEventsRepo`, the share-ledger service /
    `listingSendsRepo`, and `events`;
  - wired in `app.ts` and in the test harness
    (`app/test/helpers/twilioWebhookHarness.ts`: its public wiring, the
    activity-events and listing-sends fakes, and the conformance test that
    holds the fakes to the real repos).
- `activityEventsRepo`: the `signed_up` type and `hasEventSince`.
- `contactTimeline.ts`: the timeline mapper for the new type.
- The dashboard: the activity-type union and `MilestonePin`.
- The ledger: `shareLedger.ts` (`summarize` key mapping, and the `flyer`
  key beside `INDIVIDUAL_KEY`), `shareAttemptOrder.ts` (the attempt-key
  form) and `putShareMemory`. Its signature is unchanged, so the dev
  listing-send fixture (`dev.ts:1433-1484`) and the seeds are unchanged.
- Outcome readers (D8):
  - `listingSendOutcome.ts` (`deriveListingSendOutcome`, `isWaiting`);
  - every `deriveListingSendOutcome` caller: `routes/contacts.ts:1324`,
    `routes/units.ts:240,260`, `services/followUps.ts:168`,
    `routes/broadcasts.ts:612`;
  - the wire outcome union in `dashboard/src/api/types.ts` and
    `endpoints.ts`;
  - the renderers: `Card.tsx` (`SendRosterRow`), `ContactDetail.tsx`,
    `ListingDetail.tsx`, `FollowUpView.tsx`;
  - `blastAudienceRules.ts`;
  - `contactTimeline.ts` `propertySentWords` (pin wording on the pair).
- The repair script `app/scripts/repair-share-outcomes.ts`: a watch item.
  It must not mis-forecast a `flyer` entry.
- The property Activity card is unchanged: a sign-up is not a property
  audit.
- The `consent_*` stamp on an existing contact goes through
  `contactsRepo.update`.
- The audit: the `housing_fair_signup` fields (D6).

**Similar properties (D9):** `similarUnits.ts` `scoreArea` and its tests.

**Docs:** `documentation/GLOSSARY.md`:
- lease terms, pets and deposit are staff only;
- the area is the line under the flyer's address heading;
- new terms: the `signed_up` pin and outcome, and the `flyer` share entry.

## 5. Tests (behavior to prove; the plan names files)

**Projection:**
- the flyer JSON for a fully filled property contains none of the D1 keys;
- the parity walk is green with the new tags;
- a deliberately wrong tag still fails it.

**Flyer page:**
- the address heading links to Maps and carries the sr-only suffix;
- every fallback, including zip-only and no address with or without an area;
- the area line appears under an address heading;
- "A home for you" never appears;
- "Same-day tours available" appears on a bare property;
- no rent, deposit, pets, pet fee, accessibility, lease or address row, even
  when a stale payload is hand-fed those keys;
- the new sign-up copy, the thank-you text, and the bolder authority line.

**Tags:**
- Pets / Deposit / Rent / Accessibility / Lease terms read Staff only on
  both property forms;
- the landlord form shows "On property flyers" only on the application-fee
  pair;
- the public note never shows on a Staff only field.

**Sign-up (app, fake world):**
- An existing tenant on the flyer: no outbound text; one `signed_up` pin
  with the flyer label and the unit ref; the conversation touched, unread
  and emitted once; a counted `flyer` entry when the pair was unsent.
- The same tenant with the pair already sent (replied, declined): the pin
  and the unread mark, but the ledger is untouched and the outcome is
  unchanged.
- /join: the join label, and no ledger write.
- An existing landlord with no thread: a `landlord_1to1` thread, the pin,
  unread, and no welcome or ledger write.
- A shared phone with a deleted tenant and a live landlord: recorded on the
  landlord.
- Only deleted holders: no conversation write, no send, no pin; the audit
  has `deletedContact: true`.
- A new contact on the flyer: the welcome sent, the pin, NOT unread, the
  flyer entry.
- A repeat within 24 hours (any source): no second pin and no unread; after
  24 hours, a new pin.
- A made-up unitId: the "from a flyer" label, no ledger write, and the
  24-hour cap still holds.
- Consent stamped only when absent; opt-out untouched.
- The repeat read, the pin, the touch or the ledger write failing: still
  `{ ok: true }`, with the audit flags honest.
- The existing pins that expected an existing contact to be welcomed change.

**Ledger and outcome:**
- a `flyer` entry yields no `broadcastId`;
- the outcome order: `signed_up` vs replied, declined and tour;
- `isWaiting` is false for `signed_up`;
- a later broadcast share returns the pair to the normal outcomes;
- the dashboard row and chip read "Signed up from the flyer <date>" and
  "Signed up".

**Subzone:** case, outer spaces and inner spaces match; "SE1" vs "SE11" do
not; blank never matches.

**e2e:**
- the flyer page shows the new layout and none of the removed rows;
- an existing tenant signing up from a flyer gets no new outbound text,
  their inbox row is unread, the thread shows the pin, and the property is on
  their sent list reading "Signed up from the flyer";
- an existing contact on /join gets the pin and the unread mark, with no
  outbound text.
- Specs follow `e2e/support/selectors.md`.

## 6. Rollout

- No infrastructure, Terraform, secrets, migration or backfill.
- One app + dashboard release. If it merges before #11 + #12 is deployed,
  both ship together, and tenants never see the pets / deposit flyer rows
  #12 added.
- Sam reviews the sign-up copy after the build.
