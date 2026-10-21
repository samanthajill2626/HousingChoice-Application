# Flyer trim and flyer / join leads - design

Status: DRAFT revision 1 (2026-10-21), for the adversarial review, then
Cameron's spec gate.
Branch: `feat/flyer-leads` (worktree `W:\tmp\flyer-leads`, cut from main @b7959e2a)
Tracker:
- Sam's 2026-10-21 flyer feedback (relayed by Cameron);
- Improvements Tracker item #13 "Flyers and leads";
- a subzone-matching fix Cameron asked for in the same conversation.
Review records: `docs/superpowers/reviews/2026-10-21-flyer-leads/` (intent.md
holds Cameron's decisions verbatim).

Vocabulary: a `unit` in code is a "property" in staff copy and a "home" in
tenant copy (documentation/GLOSSARY.md). The 1:1 conversation of a contact
is shown on the contact page as its thread (`Timeline`).

Context:
- Main already holds the landlord requirements / property fields change
  (#11 + #12, spec `2026-10-20-property-requirements-design.md`, merged
  e46cc770, NOT deployed yet). This spec changes several of its flyer
  decisions (its D3 and D11).
- Where the two disagree, this spec wins.

## 1. Goal

1. The public flyer no longer publishes rent, lease terms, accessibility,
   pets or deposit. Sam: "This is information I will want but does not
   need to be on the flyer." Every one of those fields stays in the system,
   on the forms and on the property page, as Staff only.
2. The flyer page carries tracker #13's changes:
   - the address is the heading (the "A home for you" heading is gone);
   - "Same-day tours available" appears on every flyer;
   - the housing authority line is bolder;
   - the sign-up box is reworded so it does not read like a tour request.
3. A sign-up from someone who is ALREADY a contact, on the flyer or on
   /join, no longer sends them the welcome text. It is recorded in their
   thread, and their conversation is marked unread so staff see it in the
   inbox.
4. A flyer sign-up, from a new or an existing contact, puts the property on
   the contact's properties-sent list, because they have seen it.
5. Similar properties treat "se11", " SE11 " and "SE 11" as the same
   subzone.

Why:
- Sam would rather talk rent, deposit, pets and lease terms through with
  each tenant than publish them.
- Flyers now travel through caseworkers. Tenants filled in the sign-up box
  as if it booked a tour, and existing tenants got the welcome text in the
  middle of an ongoing conversation; their sign-up left no trace on the
  dashboard.

## 2. Decisions

### D1. The public projection drops the trimmed fields

`toUnitFlyer` (`app/src/lib/unitFields.ts`) and its `UnitFlyer` type no
longer carry these keys:
- `rent_min`, `rent_max`;
- `lease_terms`, `accessibility`;
- the Pets item: `pets`, `no_pets`, `pet_fee`;
- the Deposit item: `deposit`, `deposit_one_month`, `deposit_flexible`.

The keys are REMOVED from the payload, not sent as null. "Off the flyer"
means the public endpoint never returns them; hiding them in the page is not
enough. The dashboard's `PublicFlyer` type (`dashboard/src/routes/public/publicApi.ts`)
drops the same keys.

`application_fee` stays, with "No application fee" for 0 as today. So do
beds, baths, voucher sizes, accepted authorities, address, area, utilities
("Tenant pays"), washer / dryer, same-day RTA, video and listing link.

Stale page: a flyer page loaded from the OLD dashboard bundle and fed by the
NEW app would read the missing keys as `undefined`. Its rent line would then
render "$undefined" (`rentRange` checks `!== null`). The app and dashboard
ship in one release, the flyer page fetches once on load, and a fresh load
gets the new bundle. The window is a tab opened before the deploy that
re-fetches after it; that cannot happen without a reload, which loads the
new bundle. Accepted, with no compatibility shim.

### D2. The tags follow the projection

The D10a tag table (`PROPERTY_FORM_FIELDS`, `app/src/lib/requirements.ts`,
and its dashboard mirror `dashboard/src/routes/listing/requirements.ts`) and
the requirement registry (`REQUIREMENT_ITEMS`) re-tag every removed field
**Staff only**:
- the form rows Rent min, Rent max, Accessibility and Lease terms;
- every field of the Pets item (No pets, Pets (details), Pet fee);
- every field of the Deposit item (One month's rent, Fixed amount,
  Flexible / payment terms available). Deposit notes were already staff
  only.

Application fee and "No application fee" stay **On flyer**.

Consequences, all by construction:
- The parity walk (`app/test/propertyFormFlyerParity.test.ts`) keeps
  proving that each tag agrees with what `toUnitFlyer` publishes. Its pinned
  35-row table changes for those rows only.
- The landlord form's Requirements fieldset shows Staff only for Pets and
  Deposit. Its "On property flyers" tag now appears only on the
  application-fee pair. The landlord legend text is unchanged.
- **The "Tenants see this on the public flyer." note shows only where the
  field is tagged On flyer.**
  - Today the property forms pass `publicNote` by hand on Tenant-paid
    utilities, Accessibility and Lease terms. The requirement fields derive
    it (`RequirementsFields.tsx`: text field AND on_flyer).
  - After this change the note stays only under Tenant-paid utilities.
  - To stop the hand-set prop drifting from the tag again, `TaggedField`
    renders the note only when `visibility === 'on_flyer'`. A test pins
    that a Staff only field never shows the note, even with
    `publicNote` set.

### D3. The flyer page (tracker #13)

`dashboard/src/routes/public/FlyerPage.tsx`, the ready state, top to bottom:

1. **Photos**, unchanged.
2. **Heading = the address**, as a link to the existing Google Maps search
   (`mapsHref`).
   - The h1 reads the street line (line1, then line2, joined by ", "). A
     second, smaller line in the same link reads "city, state zip".
   - The separate Address detail row is removed, since the heading replaces
     it.
   - Fallbacks:
     - no street line, but a city or state: the h1 reads the city line;
     - no address at all: the area when one is recorded;
     - otherwise the plain text "Home for rent".
   - The "A home for you" text is gone everywhere.
   - *Planner's call:* the wording of that last fallback.
3. **"Same-day tours available"**, a highlighted line directly under the
   heading, on EVERY flyer (Sam, tracker #13: on every flyer, for
   advertising).
   - It is static page copy, not a property field.
   - The per-property "Same-day RTA" detail row is a different thing
     (Request for Tenancy Approval) and stays as it is.
4. **Facts**: beds, baths, and "Fits a ... voucher". The rent fact is
   removed.
5. **The housing authority line** ("Accepts: ...") is visibly stronger than
   today: bold, larger than body text, full-contrast color. The wording is
   unchanged.
6. **Detail rows**, in this order, each shown only when recorded:
   Application fee, Tenant pays, Washer / dryer, Same-day RTA, Video tour,
   Listing.
   - Removed: Address (now the heading), Deposit, Pets, Pet fee,
     Accessibility, Lease terms.
   - The helpers that only those rows used (`petsLabel`, `depositLabel`,
     `rentRange`) are deleted.
7. **The sign-up box**, for the bare-link (`form`) variant only:
   - heading: "Sign up for home alerts";
   - text: "We'll text you about this home and others that fit your
     voucher. Signing up does not book a tour.";
   - button: "Sign up".
   - The thank-you keeps its heading "Thanks - you're all set!". Its text
     becomes "We'll text you about this home and others that fit your
     voucher." *(Planner's call: the old "a team member will be in touch"
     read like a tour promise.)*
   - Cameron approved this copy to build; Sam reviews it afterwards.

Unchanged:
- the `?cta=text` variant ("Interested in this home?" and "I'm interested -
  text us");
- the unavailable state;
- the tap-to-text prefill;
- the CTA's position at the bottom.

Mobile first: at 320px the heading wraps, nothing overflows its card, and
the link's tap target is the whole heading block.

### D4. Who counts as an existing contact

`POST /public/housing-fair` (`app/src/routes/public.ts`) already dedupes by
phone with `contacts.findByPhone`. That lookup returns ANY contact for the
phone: any type (tenant, landlord, partner, team member, an auto-captured
`unknown`), and a soft-deleted one too.

- **Existing** means `findByPhone` returned a contact that is NOT
  soft-deleted. Every type counts.
- **A soft-deleted match** keeps today's behavior: nothing is created,
  nothing is recorded, and no text is sent. Today's send was already refused
  as `contact_deleted`; the sign-up is now not attempted at all. The lost
  lead is the open issue `docs/issues/deleted-contact-web-signup-silent.md`,
  which this mission does not fix.
- An existing contact is still never CHANGED by a sign-up: no name, type,
  status, voucher size or housing authority is written (the #14 rule, D6 of
  `2026-10-12-join-housing-authority-design.md`).

### D5. The welcome text goes to new contacts only

The welcome text is sent ONLY when this request CREATED the contact. An
existing contact never gets it, from either form, whatever
`housing_fair_welcomed` says.

- This replaces today's rule, which sends the welcome to an existing contact
  never welcomed before. That rule is how a landlord, a caseworker or a
  long-time tenant got the tenant welcome mid-conversation.
- Consequence: a new contact whose welcome failed (refused or errored)
  never gets one from a later sign-up. Staff can text them by hand. The
  consent the web form records stays on the contact the endpoint created.
- `housing_fair_welcomed` is still set after a successful welcome, so the
  history stays readable.

### D6. An existing contact's sign-up is recorded in their thread and marks them unread

For an existing contact (D4), on both forms:

1. **A milestone** is recorded on the contact through
   `activityEventsRepo.record`, with a new event type `signed_up`. It
   renders as a pin in the contact's thread like "Property sent" and the tour
   pins (`MilestonePin`).
   - Labels: inline staff copy, the same convention as "Property sent"; not
     the message catalog, which holds outbound sends only.
   - Flyer, property shareable (the same test as today's flyer attribution):
     "Signed up from the flyer for <address> as <First Last>", with refType
     `unit` and refId the unitId, so the pin links to the property.
     `<address>` is `formatAddress(unit.address)`, falling back to the
     unitId, as the tour-request label does.
   - Flyer, property NOT shareable (missing, deleted, or not in a shareable
     status - a race, since that flyer would show "no longer available"):
     "Signed up from a flyer as <First Last>", with no ref.
   - /join: "Signed up on the join page as <First Last>", with no ref.
   - `<First Last>` is the name typed on the form, trimmed (the body is
     already trimmed app-wide and the parser trims again). *Planner's call:*
     it is shown because the contact itself is never renamed (D4), and an
     auto-captured `unknown` contact has no name otherwise.
2. **The 1:1 conversation is marked unread and bumped to the top of the
   inbox**, using the inbound-message pattern
   (`routes/webhooks/twilio.ts`):
   - `conversations.incrementUnread`, then `touchLastActivity` (status open,
     `last_activity_at` = now), then emit `conversation.updated` from the
     touched image.
   - The conversation is the one the route already resolves
     (`createOrGetByParticipantPhone`). For a landlord or a partner it is
     their own 1:1 thread.
   - The public router gains an `events` dependency, defaulting to
     `appEvents`.
   - The inbox preview stays the newest message, as for any other non-message
     bump. The row is unread and on top; the pin is inside.
3. **Repeat sign-ups.** When the same contact already has a `signed_up`
   milestone from the SAME source within the last 24 hours, the request
   records no new milestone, sets no unread and does no bump. A source is the
   unitId, or "join". The check is a query of the contact's activity events
   over the last 24 hours. The response is still `{ ok: true }`.
   *Planner's call:* this stops someone re-submitting, or abusing a known
   phone number, from flooding a thread or the inbox.
4. A milestone or unread write that FAILS does not fail the request. It is
   logged with the phone marker and no PII, and the response stays
   `{ ok: true }`, matching how a failed welcome is handled.
   *Planner's call:* the sign-up must never error on the public page.

NEW contacts:
- Created as today (status, capture source, unit of interest, consent), with
  the welcome text sent.
- They get the same `signed_up` milestone. *Planner's call:* a uniform
  history, and the pin names the flyer.
- They are NOT marked unread: the welcome text is outbound, and new leads
  already surface as Needs review / Onboarding.

### D7. A flyer sign-up puts the property on the properties-sent list

When a sign-up carries a unitId for a shareable property (the same test as
today's flyer attribution), the property is recorded on that contact's
properties-sent list (`listingSendsRepo`, the list on the tenant and partner
pages and on the property page). This applies to new and existing contacts
alike.

- **It counts as sent** (tracker #13, decided Oct 1: "It counts as sent,
  since they have seen the property"). It is listed with `sentAt` = the
  sign-up time. Like any counted send, it then follows the existing
  reply/no-reply follow-up rules, so it can appear on the Follow up tab when
  nothing else happens.
- **Its source is `flyer`, a third kind beside broadcast and individual.**
  No reader may treat it as a broadcast:
  - the wire carries no `broadcastId` for it;
  - it never has a pending share state, so the "Property sent" wording
    helper never looks for a message row for it.
  
  It is written through the same ledger path every share uses
  (`applyShareLedgerEntry` -> `putShareMemory`), with an attempt key whose
  ISO prefix gives `countedAt`.
- **Contact types:** only a tenant gets the row. The list is a tenant's
  record of homes offered. A flyer sign-up from a landlord, partner, team
  member or `unknown` contact gets the milestone and the unread mark (D6),
  but no row. *Planner's call.*
- **A repeat flyer sign-up** for the same property within 24 hours writes
  nothing new (the D6 rule). A later one moves `sentAt` forward, as a re-send
  does.
- **No "Property sent" milestone** is written for a flyer row. The
  `signed_up` pin already says which flyer.
- **Known limit:** the Matching composer's "already sent this property"
  hint reads broadcasts, so it does not know about a flyer row. Unchanged
  and accepted.

### D8. Similar properties match the subzone ignoring case and spacing

`scoreArea` in `app/src/lib/similarUnits.ts` compares subzones after
normalizing both: remove ALL whitespace, then uppercase.
- "se11", " SE11 " and "SE 11" are the same subzone.
- A value that normalizes to empty never matches.
- No fuzzy matching: "SE1" and "SE11" stay different.
- The area comparison is unchanged. Fuzzy matching on free text waits for
  the new matching engine (Work Package 1).

The "Same subzone" reason text is unchanged. Stored values are not rewritten
(no backfill). Saves already trim the subzone (the 2026-10-20 spec, D3).

### D9. Whitespace

Cameron's standing rule: typed input is trimmed before it is stored or
compared. This change adds no new stored typed input:
- the sign-up body is trimmed app-wide and by the parser;
- the milestone label is built from those trimmed values;
- the subzone comparison normalizes (D8).

A reviewer who finds an untrimmed path in a surface this change touches
reports it.

## 3. Out of scope

- Subzone AUTO-FILL from the address: a separate feature with its own
  session. Research is in `W:\tmp\subzone-autofill-research\research-report.md`.
- A subzone dropdown: rejected by Cameron.
- The `[Rent]` broadcast merge field: unchanged, by Cameron's decision.
- Any stored-data change: no backfill and no deletion. The trimmed fields
  keep their values.
- Deleted-contact sign-ups (D4), the Matching composer's sent hint (D7),
  and fuzzy matching beyond the subzone.
- #13's "AHA Housing Fair link defaults to AHA": already shipped with #14.

## 4. Surfaces (write and read) - every one is a plan task or a watch item

Public projection (D1, D2):
- writers: `toUnitFlyer` and `UnitFlyer` (`app/src/lib/unitFields.ts`);
- the tag tables: `REQUIREMENT_ITEMS` and `PROPERTY_FORM_FIELDS` in
  `app/src/lib/requirements.ts`, plus the dashboard mirror with its drift
  test;
- readers:
  - `GET /public/units/:unitId/flyer` (`app/src/routes/public.ts`);
  - `PublicFlyer` and `FlyerPage.tsx`;
  - `FlyerTag` / `TaggedField` / `RequirementsFields`;
  - `ListingEditForm.tsx` and `UnitCreateForm.tsx` (the `publicNote`
    props);
  - the landlord form (`ContactEditForm`) through `RequirementsFields`;
  - the parity test;
  - `FlyerPage.test.tsx`, `publicApi.test.ts`, `TaggedField.test.tsx`,
    `RequirementsFields.test.tsx` and `ContactEditForm.test.tsx`;
  - e2e `public-pages.spec.ts`, `property-requirements.spec.ts` (tags and
    flyer rows), `contact-detail.spec.ts` (the landlord Pet fee tag) and
    `listing-photos.spec.ts` (the "I'm interested" button), plus
    `e2e/support/selectors.md`.

Sign-up handling (D4-D7):
- the writer: `POST /public/housing-fair` (`public.ts`) and its deps (add
  `activityEventsRepo`, `listingSendsRepo` / the share-ledger service and
  `events`), wired in `app.ts` and in the test harness
  (`app/test/helpers/twilioWebhookHarness.ts`);
- the milestone type: `activityEventsRepo` types, the timeline mapper
  (`contactTimeline.ts`), and the dashboard `MilestonePin` with its
  activity-type union;
- the properties-sent kind: `ListingSendVia` and `putShareMemory` (the `via`
  write), `shareLedger.ts` (the key -> wire mapping), `shareAttemptOrder.ts`
  (`countedAt`);
- readers of the sent list:
  - `contacts.ts` (the sent list), shown in `TenantFile` / `PartnerFile` /
    `SendRosterRow`;
  - `units.ts` (the property's sent list and the outcome route), shown in
    `ListingDetail`;
  - `followUps.ts`, `broadcasts.ts` and `contactTimeline.ts`
    (`propertySentWords`);
- the seeds and the dev fixture are unchanged; a reader must still accept
  their `broadcast` / `individual` rows;
- audit: the `housing_fair_signup` audit event adds `existingContact`,
  `recorded` (milestone written) and `sentRecorded` booleans. No PII.

Similar properties (D8): `similarUnits.ts` `scoreArea` and its tests.

## 5. Tests (behavior to prove; the plan names files)

- **Projection:** the flyer JSON for a fully filled property contains none
  of the D1 keys. The parity walk is green with the new tags. A
  deliberately wrong tag still fails it (the existing mutation case, updated).
- **Flyer page:**
  - the address heading links to Maps; each fallback works;
  - "A home for you" never appears;
  - "Same-day tours available" appears with and without any property field;
  - no rent, deposit, pets, pet fee, accessibility or lease row, even when
    the payload is hand-fed those keys (a stale-payload case);
  - the new sign-up copy, the thank-you text and the bolder authority line.
- **Tags:**
  - Pets / Deposit / Rent / Accessibility / Lease terms read Staff only on
    both property forms;
  - the landlord form shows "On property flyers" only on the
    application-fee pair;
  - the public note never shows on a Staff only field.
- **Sign-up, in the app (fake world):**
  - an existing tenant on the flyer: no outbound; one `signed_up` milestone
    with the flyer label; the conversation unread and bumped; one
    `conversation.updated`; one counted flyer row on the sent list;
  - the same on /join: the join label, and no sent-list row;
  - an existing landlord on the flyer: milestone and unread, but no row and
    no welcome;
  - a soft-deleted match: nothing recorded, nothing sent;
  - a new contact on the flyer: the welcome sent, the milestone, NOT
    unread, the row;
  - a repeat within 24 hours: nothing new; after 24 hours: a new milestone
    and `sentAt` moves;
  - the milestone write failing: still `{ ok: true }`.
  - The existing pins that expected an existing contact to be welcomed change.
- **Sent list:** a flyer row is listed for the contact and the property,
  carries no `broadcastId` on the wire, and is never pending. Existing
  broadcast and individual rows read exactly as before.
- **Subzone:** case, outer spaces and inner spaces match; "SE1" vs "SE11"
  does not; blank never matches.
- **e2e:**
  - the flyer page shows the new layout and none of the removed rows;
  - an existing tenant signing up from a flyer gets no new outbound text,
    their inbox row is unread, and the thread shows the pin, the property
    on their sent list;
  - an existing contact signing up on /join gets the pin and the unread
    mark with no outbound text.
  - Specs follow `e2e/support/selectors.md`.

## 6. Rollout

- No infrastructure, Terraform, secrets, migration or backfill.
- One app + dashboard release. If it merges before #11 + #12 is deployed,
  both ship together, and tenants never see the pets / deposit flyer rows
  that #12 added.
- Sam reviews the sign-up copy after the build.
