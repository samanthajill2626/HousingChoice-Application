# P1 - spec conformance review, feat/flyer-leads

Reviewer: independent spec-conformance reviewer (planner review, P1).
Spec: `docs/superpowers/specs/2026-10-21-flyer-leads-design.md` rev 6,
including section 7. Code: `git diff main...HEAD` at c860883b in
`W:\tmp\flyer-leads`. Plans and earlier review records were NOT read.

Method: every decision (D1-D10), section 7 amendment, exact copy string,
"unchanged" promise and section 5 test item was traced to its code and its
test. Every reader of the changed state was searched in `app/` and
`dashboard/`: the five `deriveListingSendOutcome` callers, every dashboard
`outcome` reader, every reader of `listing_sends.shares` / `broadcastId` /
`via`, the timeline mapper and pin renderer, every `on_flyer` tag table, every
consumer of the flyer projection, the inbox / unread-feed readers of the
bumped thread, the repair script, the backfill audit reader, the Matching
blast default check and the dev fixture. One throwaway probe was run after
`planner.end` existed (F1) and then deleted; the tree is clean.

## Summary

Conformance table: 71 items.

| Verdict | Count |
|---|---|
| CONFORMS | 67 |
| PARTIAL | 3 |
| MISSING | 0 |
| DEVIATES | 1 |

Findings: 8.

| Severity | Count |
|---|---|
| BLOCKING | 0 |
| HIGH | 0 |
| MEDIUM | 0 |
| LOW | 2 (F1, F2) |
| INFO | 6 (F3-F8) |

Every exact user-facing string in the spec matches the code character for
character (pin labels, flyer heading fallbacks, "Same-day tours available",
the sign-up box heading / text / button, the thank-you text, the roster words
and chip). Every "unchanged" promise holds: no field (consent included) is
written to an existing contact, the `[Rent]` merge field and its template are
untouched, nothing stored is deleted or backfilled, the application fee stays
on the flyer, the subzone stays staff only, the property Activity card and
the Matching composer's sent hint are untouched. Whitespace: the sign-up body
is trimmed (app-wide body trim plus `parseHousingFairBody`), the subzone
compare normalizes, and the flyer page trims address parts and the area; the
server's `validateAddress` already trims and drops blank address parts, so no
untrimmed path was found in a touched surface.

## Conformance table

| # | Spec item | Verdict | Code file:line | Test file:line | Note |
|---|---|---|---|---|---|
| 1 | D1 projection removes the ten keys (absent, never null) | CONFORMS | app/src/lib/unitFields.ts:480-508 | app/test/publicIntake.test.ts:398-436; app/test/unitFields.test.ts:682,741,802; e2e/tests/dashboard-next/flyer-leads.spec.ts:410-414 | exact-keys and `in` checks |
| 2 | D1 `UnitFlyer` and dashboard `PublicFlyer` drop the keys | CONFORMS | app/src/lib/unitFields.ts:403-430; dashboard/src/routes/public/publicApi.ts:31-55 | dashboard/src/routes/public/publicApi.test.ts:125 | |
| 3 | D1 application fee ("No application fee" for 0) and the other public keys stay | CONFORMS | app/src/lib/unitFields.ts:493-507 | app/test/unitFields.test.ts:820; dashboard/src/routes/public/FlyerPage.test.tsx:446 | |
| 4 | D1 "only ADDS keys" comment rewritten with the removal and its safety argument | CONFORMS | app/src/lib/unitFields.ts:385-401 | - | CloudFront default behavior is caching_disabled (infra/modules/cloudfront/main.tf:209); the service worker is push-only (dashboard/src/main.tsx:22-37) |
| 5 | D2 REQUIREMENT_ITEMS: every Pets and Deposit field Staff only (app and mirror) | CONFORMS | app/src/lib/requirements.ts:87-104; dashboard/src/routes/listing/requirements.ts:100-112 | app/test/requirements.test.ts:99; dashboard/src/routes/listing/requirements.test.ts:383 | |
| 6 | D2 PROPERTY_FORM_FIELDS: Rent min/max, Accessibility, Lease terms, Pets, Deposit rows Staff only | CONFORMS | app/src/lib/requirements.ts:540-548; dashboard/src/routes/listing/requirements.ts:264-287 | app/test/propertyFormFlyerParity.test.ts:180-210 | |
| 7 | D2 parity walk green; a wrong tag still fails it | CONFORMS | app/src/lib/requirements.ts | app/test/propertyFormFlyerParity.test.ts:262-293 | both flip directions pinned |
| 8 | D2 landlord form: "On property flyers" only on the fee pair; legend unchanged | CONFORMS | dashboard/src/routes/listing/FlyerTag.tsx:23-40 (unchanged) | dashboard/src/routes/contact/ContactEditForm.test.tsx:1459; e2e/tests/dashboard-next/contact-detail.spec.ts:187-203 | |
| 9 | D2 `TaggedField` renders the note only when On flyer; pinned | CONFORMS | dashboard/src/routes/listing/TaggedField.tsx:51-66 | dashboard/src/routes/listing/TaggedField.test.tsx:35 | |
| 10 | D2 hand-set `publicNote` stays only on Tenant-paid utilities | CONFORMS | dashboard/src/routes/listing/ListingEditForm.tsx:531,545,558; dashboard/src/routes/listing/UnitCreateForm.tsx:666,680,693 | dashboard/src/routes/listing/ListingEditForm.test.tsx:648,667; dashboard/src/routes/listing/UnitCreateForm.test.tsx:1070 | requirement fields derive it (RequirementsFields.tsx:153); none is a text field On flyer now |
| 11 | D3 heading = address Maps link (`target="_blank"`), h1 = line1, line2 joined ", " | CONFORMS | dashboard/src/routes/public/FlyerPage.tsx:113-142,318-329 | dashboard/src/routes/public/FlyerPage.test.tsx:509,560; flyer-leads.spec.ts:347-358 | |
| 12 | D3 city line "city, state zip" as a smaller second line; omitted when it is the h1 | CONFORMS | FlyerPage.tsx:121-141; FlyerPage.module.css (.subline) | FlyerPage.test.tsx:531-558; FlyerPage.styles.test.ts:54 | |
| 13 | D3 sr-only " - open in Google Maps" suffix kept | CONFORMS | FlyerPage.tsx:325 | FlyerPage.test.tsx:107,509 | |
| 14 | D3 Address row removed, `addressLines` deleted | CONFORMS | FlyerPage.tsx (helper gone) | FlyerPage.test.tsx:281 | |
| 15 | D3 fallbacks: city line, then area as plain text, then "Home for rent" | CONFORMS | FlyerPage.tsx:136-142 | FlyerPage.test.tsx:123,544-546 (zip only),571,579-585 | |
| 16 | D3 "A home for you" nowhere | CONFORMS | FlyerPage.tsx (string gone; grep of dashboard/src finds none) | FlyerPage.test.tsx:592 | |
| 17 | D3 area line directly under an address heading | CONFORMS | FlyerPage.tsx:330 | FlyerPage.test.tsx:531 | |
| 18 | D3 "Same-day tours available" on every flyer, static copy | CONFORMS | FlyerPage.tsx:336; FlyerPage.module.css:113-121 | FlyerPage.test.tsx:637,645; FlyerPage.styles.test.ts:45 | both CTA variants |
| 19 | D3 facts: beds, baths, voucher; rent fact removed | CONFORMS | FlyerPage.tsx:338-355 | flyer-leads.spec.ts:364-369,404 | |
| 20 | D3 authority line bold, larger than body, full contrast; wording unchanged | CONFORMS | FlyerPage.module.css:105-110; FlyerPage.tsx:360 | FlyerPage.styles.test.ts:38; FlyerPage.test.tsx:668 | |
| 21 | D3 detail rows order; removed rows; `petsLabel`/`depositLabel`/`rentRange` deleted; `flyerMoney` kept | CONFORMS | FlyerPage.tsx:363-405 | FlyerPage.test.tsx:281,602; flyer-leads.spec.ts:371-378 | |
| 22 | D3 sign-up box: "Sign up for home alerts" / text / "Sign up" | CONFORMS | FlyerPage.tsx:438-443 | FlyerPage.test.tsx:677-688; flyer-leads.spec.ts:416-424 | JSX joins the two text lines with one space |
| 23 | D3 thank-you heading kept; text "We'll text you about this home and others that fit your voucher." | CONFORMS | FlyerPage.tsx:427-431 | FlyerPage.test.tsx:187 | |
| 24 | D3 unchanged: `?cta=text`, unavailable state, tap-to-text prefill, CTA at bottom | CONFORMS | FlyerPage.tsx:145-153,411-421 | FlyerPage.test.tsx:196,228,659,690 | |
| 25 | D3 320px wrap; the heading block is the tap target | CONFORMS | FlyerPage.module.css:25,43-47,68 | FlyerPage.styles.test.ts:21,25,34; flyer-leads.spec.ts:427-445 | |
| 26 | D4 `findByPhone` stays the one lookup; a live holder of any type is existing | CONFORMS | app/src/routes/public.ts:489,530-533 | app/test/publicSignupLeads.test.ts:124 | |
| 27 | D4 an existing contact is never changed (name, type, status, voucher, authority, consent, welcome flag) | CONFORMS | public.ts:530-533,593 | publicSignupLeads.test.ts:124; publicIntake.test.ts:1236-1257 | |
| 28 | D4 deleted path: no conversation, send, pin, unread, sent-list row; audit on that contact with `deletedContact: true`; `{ ok: true }` | CONFORMS | public.ts:495-528 | publicSignupLeads.test.ts:176,814 | see F7 |
| 29 | D5 welcome only when this request created the contact; flag still set; no re-welcome | CONFORMS | public.ts:593-618 | publicSignupLeads.test.ts:165; publicIntake.test.ts:208-245 | |
| 30 | D6.1 one pin and one bump per contact per source per 24h; "no property" source shared | CONFORMS | public.ts:128,637-652 | publicSignupLeads.test.ts:411,436,454,467,481 | |
| 31 | D6.1 `hasEventSince`: key range, type + ref filter, paginated, ConsistentRead (AR12) | CONFORMS | app/src/repos/activityEventsRepo.ts:149-154,214-245 | app/test/activityEventsRepo.integration.test.ts:215; app/test/activityEventsRepoConsistentRead.test.ts:40; harness conformance twilioWebhookHarnessRepoAdditions.integration.test.ts:1413 | |
| 32 | D6.1 a failed read fails OPEN | CONFORMS | public.ts:649-651 | publicSignupLeads.test.ts:506 | |
| 33 | D6.1 the cap governs pin and bump only; the flyer entry every time | CONFORMS | public.ts:654-704 | publicSignupLeads.test.ts:670,944 | |
| 34 | D6.2 `signed_up` type; the three labels exact; unit ref only for a shareable flyer | CONFORMS | public.ts:156-167,659-668; activityEventsRepo.ts:77 | publicSignupLeads.test.ts:199,270,481; app/test/contactTimeline.test.ts (D6 pass-through) | |
| 35 | D6.2 `<address>` = `formatAddress`, else unitId; `<First Last>` typed and trimmed | CONFORMS | public.ts:165-166,209-210 | publicSignupLeads.test.ts:258 | |
| 36 | D6.3 touch, then increment, then ONE event from the touched image with the returned count; failed increment still emits; failed touch emits nothing | CONFORMS | public.ts:381-402 | publicSignupLeads.test.ts:199,237,533,547,561 | see F6 (group-thread guard, an addition) |
| 37 | D6.3 thread typed by `conversationTypeFor`; new contacts `tenant_1to1` | CONFORMS | public.ts:584 | publicSignupLeads.test.ts:165,297 | |
| 38 | D6.3 public router `events` dep defaulting to `appEvents` | CONFORMS | public.ts:355; harness wiring twilioWebhookHarness.ts:5811-5817 | publicSignupLeads.test.ts:199 | |
| 39 | D6.4 failures never reach the public page; logs carry the marker and no PII | PARTIAL | public.ts:584-585,718-731 | publicSignupLeads.test.ts:497-563; publicIntake.test.ts:125 | F1 |
| 40 | D6 new contacts: welcome first, then pin and unread; a refused welcome still pins and marks | CONFORMS | public.ts:593-672 | publicSignupLeads.test.ts:350,381 | |
| 41 | D6 / AR2 / AR11 / R2 #5 audit fields: existingContact, deletedContact, recorded, sentRecorded, sentSkipped (all values incl. refused, deleted), consentVersion | CONFORMS | public.ts:140-146,496-510,718-731 | publicSignupLeads.test.ts:783-960; publicIntake.test.ts:1282-1340 | |
| 42 | Sec 4: the backfill audit reader still works | CONFORMS | app/scripts/backfill-join-housing-authority.ts:221-229 (unchanged) | app/test/backfillJoinHousingAuthority.test.ts:241 | |
| 43 | D7 flyer entry through the ledger path: key `flyer`, attempt `<ISO>#flyer`, counted by acceptance, countedAt from the key | CONFORMS | app/src/services/shareLedger.ts:205-230,276-296; app/src/lib/shareLedgerKeys.ts:17-27 | app/test/shareLedgerFlyer.test.ts:47; app/test/shareLedgerKeys.test.ts:19 | |
| 44 | D7 tenant or unknown only; landlord / partner / other get pin and bump but no entry | CONFORMS | public.ts:688-704 | publicSignupLeads.test.ts:297,699,859-865 | |
| 45 | D7 `summarize` maps `flyer` like `individual`; `via` untouched | CONFORMS | shareLedger.ts:135-140 | app/test/shareLedger.test.ts:102; shareLedgerFlyer.test.ts:47 | see F8 |
| 46 | D7 newest counted entry wins; no reply / replied -> signed_up; a tour stays interested | CONFORMS | shareLedger.ts:135-140; listingSendOutcome.ts:73-89 | publicSignupLeads.test.ts:572,595,649 | |
| 47 | D7 current decline (`effectiveDecline(row, undefined)`) refuses the flyer write, decided on each round's read, flyer key only | CONFORMS | shareLedger.ts:212,285,291-293 | shareLedgerFlyer.test.ts:76,90,103,113,135; publicSignupLeads.test.ts:610,630,928 | |
| 48 | D7 "a public request can never undo a staff decision" | PARTIAL | shareLedger.ts:276-296; app/src/routes/units.ts:1596,1690 | - (proof B in the issue) | F2; filed as docs/issues/flyer-signup-decline-click-race.md |
| 49 | D7 / O1 both decline writers stamp a fresh `shares_op`; harness fake and NO-RESET comment changed | CONFORMS | app/src/repos/listingSendsRepo.ts:19-26,388,401,423,435; app/test/helpers/twilioWebhookHarness.ts:3667,3678 | shareLedgerFlyer.test.ts:145; app/test/listingSendsRepo.integration.test.ts:155,242 | |
| 50 | D7 repeat sign-ups move sentAt forward; an equal / older instant is `refused` (AR2) | CONFORMS | shareLedger.ts:87-99 (order rule) | shareLedgerFlyer.test.ts:124 | |
| 51 | D7 the lost flyer write has its own ERROR line; a decline refusal logs INFO | CONFORMS | shareLedger.ts:286-293 | shareLedgerFlyer.test.ts:76,179 | |
| 52 | D7 no "Property sent" milestone for a flyer entry | CONFORMS | shareLedger.ts:276-296 (no activity write) | publicSignupLeads.test.ts:572 | |
| 53 | D7 residual: an uncounted pair's "Property text failed" pin reads "Property sent" | DEVIATES | app/src/routes/contactTimeline.ts:731-732 | contactTimeline.test.ts (D7 residual PIN) | F3 (benign; spec text over-states) |
| 54 | D7 the repair script's census does not mis-forecast a flyer entry | CONFORMS | app/scripts/repair-share-outcomes.ts:824-834 (unchanged; summarize-based) | app/test/repairShareOutcomes.test.ts:808 | |
| 55 | D7 an unknown contact's entry is on the property's Sent to card at once | CONFORMS | units.ts:267-299 | publicSignupLeads.test.ts:699; listingSendsApi.test.ts:591 | |
| 56 | D8 order decline > tour > replied > signed_up; ONE helper in `lib/shareLedgerKeys.ts` (AR1); callers pass the stored row | CONFORMS | listingSendOutcome.ts:73-89; shareLedgerKeys.ts:37-47; callers contacts.ts:1324, units.ts:259,279, followUps.ts:175, broadcasts.ts:612 | listingSendOutcome.test.ts:261,273,286; listingSendsApi.test.ts:586; followUps.test.ts:350; broadcastApi.test.ts:3510; listingSendOutcomeApi.test.ts:708 | listing_sends reads carry no projection and the byContact GSI projects ALL |
| 57 | D8 `signed_up` never waits: no Follow up row, no "<n> waiting" | CONFORMS | listingSendOutcome.ts:130 | listingSendOutcome.test.ts:292; followUps.test.ts:350 | see F5 (session-only display) |
| 58 | D8 a later counted share returns the pair to the normal outcomes | CONFORMS | shareLedgerKeys.ts:37-47 | listingSendsApi.test.ts (D8 describe, second case); listingSendOutcome.test.ts (later share case) | |
| 59 | D8 roster row "Signed up from the flyer <date>"; chip "Signed up" | CONFORMS | dashboard/src/routes/contact/Card.tsx:274-276,351,370-372 | dashboard/src/routes/contact/SendRosterRow.test.tsx:166,176; ContactDetail.test.tsx:1146; ListingDetail.test.tsx:3118 | |
| 60 | D8 the row offers the waiting row's actions; Request a tour stays partner-only | PARTIAL | Card.tsx:357-410; ListingDetail.tsx:1357-1362 | SendRosterRow.test.tsx:181,196; listingSendOutcomeApi.test.ts:711,725 | F4 (unknown rows get Not interested only) |
| 61 | D8 Sent to card: signed_up under Interested when eligible, else Not eligible | CONFORMS | dashboard/src/routes/listing/listingFormat.ts:352 | dashboard/src/routes/listing/listingFormat.test.ts:430 | |
| 62 | D8 Matching blast keeps the tenant checked (excludes only not_interested) | CONFORMS | app/src/lib/blastAudienceRules.ts:181-183; broadcasts.ts:612-619,828-844 | broadcastApi.test.ts:3510 | `alreadySent` reads broadcasts only |
| 63 | D8 wire unions (activity type, outcome) mirrored; endpoints pass the row through | CONFORMS | dashboard/src/api/types.ts:2935,3155 | dashboard/src/api/endpoints.test.ts (signed_up pass-through) | |
| 64 | D9 subzone: strip all whitespace, uppercase, empty never matches, no fuzzy, area and reason text unchanged | CONFORMS | app/src/lib/similarUnits.ts:58-71,136 | app/test/similarUnits.test.ts:247-310 | no other subzone comparison exists in app/ or dashboard/ |
| 65 | D10 whitespace | CONFORMS | public.ts:209-217; similarUnits.ts:58-60; FlyerPage.tsx:59-63,107-124 | FlyerPage.test.tsx:560,587 | |
| 66 | Sec 7 AR13 nameless resolved recipient labelled by formatted phone; missing contact unchanged | CONFORMS | units.ts:207-213,287 | listingSendsApi.test.ts:629 | see F8 (also extended to Follow up) |
| 67 | Sec 3 / 4 unchanged: `[Rent]` field, no backfill, subzone staff only, property Activity card, composer sent hint, dev fixture and seeds | CONFORMS | not in the diff: resolveTemplate.ts, dev.ts:1433-1484, seeds, listingFormat audit-row mapping | publicIntake.test.ts (subzone absent) | |
| 68 | Sec 4 docs: GLOSSARY, selectors.md, issue notes | CONFORMS | documentation/GLOSSARY.md; e2e/support/selectors.md; docs/issues/*.md (5 files) | - | |
| 69 | Sec 5 e2e: the new flyer layout; an existing tenant's flyer sign-up; an existing contact on /join | CONFORMS | - | flyer-leads.spec.ts:314,448,622,673 | |
| 70 | Sec 5 e2e repairs | CONFORMS | - | public-pages.spec.ts:204-250,268-290; property-requirements.spec.ts; contact-detail.spec.ts:187-203; listing-photos.spec.ts:242 | |
| 71 | Sec 5 the pins that expected an existing contact to be welcomed change | CONFORMS | - | publicIntake.test.ts:208-245,1236-1257 | |

## Findings

### F1 - LOW - an audit (or conversation-resolve) failure answers 500 after the pin, the unread bump and the flyer entry were written

Spec D6.4: "Failures never reach the public page. Every step after the
contact is resolved or created is best-effort ... The response is
`{ ok: true }`".

Code: the enumerated steps are best-effort (public.ts:641-704), but the two
steps that bracket them are not:
- the final `audit.append` (public.ts:718-731) has no try/catch, and it now
  runs AFTER the new writes;
- `createOrGetByParticipantPhone` / `setParticipantsIfAbsent`
  (public.ts:584-585), which for an existing landlord, partner or unknown
  contact with no thread now CREATES a thread.

The deleted path's `audit.append` (public.ts:496) is unguarded too. Both
unguarded writes predate this branch, but the branch put new writes in front
of the final one.

Scenario (proved with a throwaway probe against the harness, since deleted):
an existing tenant signs up on a shareable flyer while `auditRepo.append`
throws (a DynamoDB throttle) -> the response is 500
`{ error: 'internal server error' }`, but the pin is written, the thread is
incremented and the flyer entry is written. The person sees an error and
re-submits. The retry is inside the 24-hour cap, so it is audited with
`recorded: false`, and the first sign-up has no audit row at all. D7 notes
"When the D6 cap also skipped the pin, the audit row is the only trace". On
the deleted path an audit throw leaves no trace whatsoever.

Severity LOW: a rare infrastructure failure, the visible state is correct,
and the behavior is pre-existing for the audit. A one-line try/catch around
each audit append (log, still `{ ok: true }`) would make D6.4's sentence true
as written.

### F2 - LOW - the decline click race: one ordering still lets a public sign-up supersede a staff decline

Spec D7: "A sign-up never clears a decline ... It also means a public request
can never undo a staff decision." O1 closes the order in which the decline
lands between the ledger's read and its write (proved by
shareLedgerFlyer.test.ts:145).

Code: the outcome route stamps the decline instant `at` (units.ts:1596) before
an un-tokened `setDeclined` (units.ts:1690). Suppose a flyer sign-up takes its
instant after `at`, and its ledger write (shareLedger.ts:276-296) lands before
the decline does. Then the decline is born older than the new `sentAt`, and
`effectiveDecline` drops it (listingSendOutcome.ts:49-61).

Scenario: staff click Not interested on a tenant's pair while the tenant's
flyer sign-up is in flight, with a slow `setDeclined` -> the click answers
`signed_up`, the row does not move to Not interested, and the timeline still
records "Not interested". A second click sticks.

The builders already filed this, with a reproduction and a suggested fix, as
`docs/issues/flyer-signup-decline-click-race.md` (severity low). It is listed
here only because the spec states the guarantee without this residual. The
spec's D7 residual list should name it.

### F3 - INFO - the D7 "Property text failed -> Property sent" residual is narrower in code than in the spec

Spec D7 residual: "An UNCOUNTED pair (a text that failed) becomes counted,
and its old 'Property text failed' pin reads 'Property sent'
(`contactTimeline.ts:732`)."

Code: `propertySentWords` (contactTimeline.ts:731-732) reads the pin's OWN
share entry whenever the pin carries a share id. Only a pin with no share id,
or with no entry for its share, reads the pair-level `counted`.

Scenario: a broadcast pin whose share failed keeps "Property text failed"
after a flyer sign-up counts the pair. Only a pre-branch, id-less pin flips
to "Property sent". The behavior is correct and pinned (contactTimeline.test.ts,
"flyer-leads D7 residual (PIN)"); the spec text over-states the residual and
can be corrected.

### F4 - INFO - an unknown contact's signed_up row offers Not interested only

Spec D8: "the row offers the same actions a waiting row offers (Interested
and Not interested; 'Request a tour' stays as today's partner-only rule, so
it does not appear on these tenant / unknown rows)."

Code: `canInterested` requires `row.interestedSupported`
(Card.tsx:358), which the server sets only for tenants (units.ts:295,
contacts.ts:1337). An unknown recipient's row on the property's Sent to card
therefore shows "Signed up" with a Not interested button and no Interested
button. SendRosterRow.test.tsx:196 pins that deliberately.

This follows the governing clause, "the same actions a waiting row offers",
because an unknown contact's waiting row has no Interested either, and a tour
needs a tenant. But the parenthetical reads as if both actions show on unknown
rows. This is a spec-wording ambiguity, not a defect; the spec could say
"Interested for tenants".

### F5 - INFO - the Follow up tab can show a signed_up pair as waiting for the rest of a session

Spec D8: "`signed_up` is never 'waiting' ... not on the Follow up tab".

Code: FollowUpView.tsx:83-85 un-resolves a row whose action answer is
neither interested nor not_interested, so the row goes back to its loaded
waiting display.

Scenario: a Follow up row (no_reply) -> the tenant signs up from the flyer
(the pair becomes signed_up) -> staff click Not interested, then Undo -> the
Undo answers `signed_up`, but the row shows "No reply yet, N days" and counts
in "1 waiting" until the next load. Pinned on purpose
(FollowUpView.test.tsx:234); server-side Follow up never lists the pair.
Cosmetic and transient.

### F6 - INFO - an unspecified group-thread guard on the unread mark

Spec D6.3 resolves the thread with `createOrGetByParticipantPhone` and
always touches and increments it.

Code: markSignupUnread skips the touch, the increment and the event when the
resolved thread is a relay or group thread (public.ts:382-385; logged as step
`touch`, reason `group_thread`). That happens only when the typed phone is a
relay pool number. The guard prevents reopening a closed relay group and
bumping a thread nobody wrote to. The pin, the entry and the audit are
unaffected.

This is a benign safety addition beyond the spec text. The spec could
record it.

### F7 - INFO - the deleted path audits `existingContact: false`

Spec D6 lists `existingContact` and `deletedContact` without saying how they
combine.

Code: public.ts:503-504 writes `existingContact: false, deletedContact: true`
on the deleted path. That matches D4's definition (only a LIVE holder is an
"existing" contact).

A future reader of `deleted-contact-web-signup-silent` evidence must key on
`deletedContact`, not `existingContact`. This is noted so the recovery work
does not misread the pair.

### F8 - INFO - additions and accepted furniture worth knowing

These are not violations.

- AR13's phone label is also applied to Follow up names (followUps.ts:92-98).
  This is consistent with the Sent to card, and unknown contacts can now
  reach Follow up after a reply.
- The timeline pin CSS change (Timeline.module.css: `.pill` wraps,
  `min-width: 0`, the computed radius) applies to EVERY pin, not only
  sign-up pins.
- A pair created by a flyer sign-up alone stores `via: 'broadcast'` (the
  `putShareMemory` first-write default) and serves it on the wire
  (listingSendsRepo.ts:270). The spec accepts this ("`via` is untouched ...
  nothing renders"), and no reader in app/ or dashboard/ branches on it.
- The ledger's `lost` and `declined` lines carry unitId / contactId, not the
  phone marker (shareLedger.ts:219-222,292). D6.4 asks for the marker, but
  the ids identify the pair better, and the audit carries `sentSkipped`.
