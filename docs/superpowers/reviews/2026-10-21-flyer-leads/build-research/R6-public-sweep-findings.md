# R6 invariant-sweep findings - public exposure, tags, sign-up routing, subzone, whitespace

Reader: R6 (build research, phase 1). Live tree: W:\tmp\flyer-leads
(feat/flyer-leads @031a46d6; app, dashboard, e2e, scripts, fake-twilio
identical to b7959e2a). Rules: .superpowers/sdd/research/RESEARCH-RULES.md.
Charge: sweep the whole repo for every writer and reader of (a) public
exposure of the ten D1 keys, (b) the tag tables / tag components /
`publicNote`, (c) the housing-fair handler's writes and the phone routing its
pin, unread mark and sent-list entry share with other readers, (d) subzone
comparisons, (e) D10 whitespace. Full inventory (every writer/reader with
`path:line`): .superpowers/sdd/research/R6-public-sweep-reference.md.

Counts: BLOCKER 0, MAJOR 2, MINOR 1, NOTE 4.

What was checked and holds (no finding):
- (a) `toUnitFlyer` has ONE runtime caller (routes/public.ts:463); no other
  /public or SPA route serves unit data (housing-authorities names,
  `{ ok: true }`, the opaque 404, /unit-media photos). No `og:` / `twitter:`
  tag or meta / title writer exists; /p/:unitId is the static index.html.
  The service worker has no fetch handler and CloudFront's default behavior is
  CachingDisabled (spec D1's old-bundle premise holds). The message catalog,
  tour / relay / placement job senders, the email sender, the extraction AI
  and the flyer's tap-to-text prefill carry none of the ten keys.
- (a) `[Rent]` is untouched and does NOT read `toUnitFlyer`:
  mergeFields.ts:34-44 `formatRent(unit)` reads the stored UnitItem
  (broadcastFanOut.ts:489, :882); no plan task edits mergeFields.ts,
  resolveTemplate.ts or broadcastFanOut.ts. It is the only remaining
  tenant-facing publisher of any of the ten keys (rent only), out of scope by
  Cameron's decision - but see F1.
- (b) Every tag in the forms is read from the table (formFieldVisibility /
  field.flyer); no hard-coded visibility exists; the requirement cards, Apply
  dialog, composer and property page carry no flyer claim; app runtime reads
  no visibility. Task 2.1 rewrites TaggedField.tsx:14-16; Task 1.1 3c/3g
  rewrite every app-side "PUBLIC on the flyer" comment (unitFields.ts:142 and
  unitsRepo.ts:525 are washer_dryer - still true).
- (c) Invariant B holds in the plan: the only contact writes stay
  `contacts.create` and the welcome flag, both behind `isNew`; the ledger
  touches listing_sends only; the Task 4.2 snapshot is a `structuredClone`, so
  the harness fake's by-reference `findByPhone` cannot make it vacuous.
  `housing_fair_welcomed` has no reader outside public.ts.
  `housing_fair_signup` has one reader, backfill-join-housing-authority.ts:226-229
  (`signupVersion === 2` only); nothing in app or dashboard lists contacts#
  audit. Inbox (inbox.ts:899-920), unread feed (unreadFeed.ts:534-546) and the
  reply gates (sendMessage.ts:493, :511, :537-557) all resolve a thread's
  contact with the same `findByPhone`, so the pin, unread mark and sent-list
  entry land on the contact those three show. D6 never moves
  `last_heard_from_at` (contact field, inbound writers only), so D8's
  `replied` arm is not tripped by the sign-up's own touch. Production injects
  no event bus (index.ts:112), so the router's default appEvents is the SSE
  route's bus.
- (d) The ONLY subzone comparison in app and dashboard is
  similarUnits.ts:53-65 `scoreArea` (route units.ts:2142-2181 ranks every
  available unit, no pre-filter). Matching filters, blast audience rules,
  audience resolution, the property list search (address only,
  unitListFacets.ts:206-209) and the forms never compare subzones. Task 1.2's
  `subzoneKey` matches D9 (JS `\s` also covers TAB / NBSP).
- (e) No untrimmed store/compare path: names trimmed by the parser and
  trimJsonBody; unitId and housingAuthority by trimJsonBody (a urlencoded
  body that skips it cannot pass the boolean consent gate, public.ts:129);
  the pin label's address parts are stored trimmed; subzone stored trimmed and
  compared normalized.

---

## F1 (MAJOR) Rent min / Rent max become "Staff only" while the blast default still texts the rent; the form legend then says Staff only fields "never leave the dashboard"

Plan location: plan section 1 (D2 bullet) and 3.1 Invariant A ("The tag
tables are the forms' claim about it"); Task 2.2 (the mirror re-tag the forms
follow); Task 6.4 step 1a (GLOSSARY "STAFF ONLY ... rent_min / rent_max").
Spec D2 "Consequences" and section 3 ("The `[Rent]` broadcast merge field
(unchanged, by Cameron's decision)"). Not raised in any design or plan review
round (grep of the review records for "never leaves", "[Rent]", the default
template).

Evidence:
- The property forms' legend, `dashboard/src/routes/listing/FlyerTag.tsx:36`:
  "Staff only - never leaves the dashboard." (rendered at
  ListingEditForm.tsx:305 and UnitCreateForm.tsx:416). After D2,
  `formFieldVisibility('Rent min')` / `('Rent max')` (ListingEditForm.tsx:387,
  :400; UnitCreateForm.tsx:522, :535) read `staff_only`.
- The Matching blast default, `dashboard/src/routes/broadcasts/resolveTemplate.ts:30-31`,
  is "Hi [TenantName], a [Beds]-bedroom home at [Address] is available for
  [Rent]/mo. Details: [FlyerLink]", and BroadcastComposer.tsx:447 pre-fills
  EVERY property-first blast with it, rent resolved (resolveTemplate.ts:63-70).
  The server sends it from the stored unit (mergeFields.ts:68, :97;
  broadcastFanOut.ts:489, :882).
- No field that is Staff only today reaches any outbound text (git grep of
  app/src/messages, app/src/jobs, mergeFields.ts for tour_process, tour_type,
  application_process, payment_standard: 0 hits). So D2 makes Rent min / Rent
  max the first Staff only fields the system itself texts to tenants - D2
  turns a true legend line false.
- intent.md records Cameron: "Yes, leave the rent merge field alone. We can
  still add it if we need to." "Still add it" reads as if rent is not in the
  default text today; it is.

Scenario: Sam opens Edit property; Rent min / Rent max are tagged "Staff
only" under the legend "Staff only - never leaves the dashboard." She opens
Matching for that property, keeps the pre-filled text and sends; every
recipient's SMS reads "... is available for $1500/mo. Details: <link>", and
the flyer behind the link no longer shows any rent.

Correction: get a ruling (Cameron's, via the planner) before S2 Task 2.2
lands; do not pick silently. Options:
- (a) Keep `[Rent]` and make the PROPERTY legend's Staff only line true, e.g.
  "Staff only - not on the public flyer." - FlyerTag.tsx:36 (the landlord
  line :41 can stay: no landlord value is ever texted), with its pins
  FlyerTag.test.tsx:37, ListingEditForm.test.tsx:339,
  UnitCreateForm.test.tsx:1061 and e2e property-requirements.spec.ts:260.
- (b) Take `[Rent]` out of the BLAST DEFAULT only (resolveTemplate.ts:30-31);
  the token stays available, so "leave the merge field alone" still holds.
  Update every test that pins the default body (grep `DEFAULT_SEND_TEMPLATE`
  / `is available for`).
- (c) Accept the contradiction and record it: GLOSSARY (Task 6.4 1a) says rent
  still reaches tenants through `[Rent]` in Matching blasts, plus a line in
  the S2 slice report.
Whatever is chosen, Task 6.4 1a's new "STAFF ONLY ... rent_min / rent_max"
sentence should add that rent still goes out through `[Rent]` unless (b) is
taken.

## F2 (MAJOR) The Today page reads the new unread state, and plan 3.1 never names it: a sign-up shows as "Unreplied" with the thread's stored preview (the welcome text, for a new contact)

Plan location: plan 3.1 Invariant E (readers listed: "inbox, unread feed"
only); plan 2.6 step 8 (`touchLastActivity(conversationId, undefined, nowIso)`
leaves `last_message_preview` as it was); S4 Task 4.3; spec D6.3, which
reasons only about the inbox preview (spec :353-355). No task, watch item or
spec line mentions Today (grep "Today" / "buildToday" / "unreplied" in the
plan and spec).

Evidence:
- `app/src/lib/unreadFeed.ts:301` names Today as a consumer of THE unread
  rule ("shared by both layers, Today, and the tests").
- `dashboard/src/routes/today/buildToday.ts:305-316`: every open 1:1 thread
  with `unread_count > 0` becomes an "Unreplied" item whose reason is
  `conv.preview ?? 'Unread message'`; `preview` is `last_message_preview`
  (app/src/routes/api.ts:523-529 `toConversationSummary`), not a message row.
  The name is `participant_display_name`, else the formatted phone
  (:103-111); useToday refetches on conversation.updated.
- `buildToday.ts:287-303`: every OPEN `unknown_1to1` thread, whatever its
  unread count, becomes a needs_you_now item "New inbound - untriaged" with
  `attention: true`. D6's touch reopens a CLOSED thread (spec D6.3), so an
  existing unknown contact's closed thread re-enters it with no inbound at all.
- Related, inbox side: a thread with no message rows (D6 creating a first
  thread for an existing landlord / partner / team member) renders preview
  `last_message_preview ?? ''` with direction defaulted to `inbound`
  (app/src/routes/inbox.ts:677-682); Today then reads "Unread message".

Scenario: a fresh phone signs up from a flyer. The welcome sets
`last_message_preview` to WELCOME_SMS, then D6 touches (preview unchanged)
and increments. Today's Unreplied group lists "(404) 555-0142 - Welcome to
HousingChoice! You're signed up for new properties ..." as if the person had
sent it. An existing tenant's sign-up lists staff's own last outbound text the
same way. The inbox shows the same text but with an outbound direction;
Today shows no direction.

Correction: add Today (`buildToday.ts` :287-303 and :305-316, a consumer of
`isUnreadVisible`) to Invariant E's readers as a watch item, and get a ruling:
- (a) accept and document it (recommended minimum): the GLOSSARY "signed
  up" entry (Task 6.4) and the S4 slice report say a sign-up appears on Today
  under Unreplied (unknown contacts: Needs you now), with the thread's newest
  message as its reason line; or
- (b) give D6's touch a preview, for example the pin label, so
  `last_message_preview` names the sign-up. Its readers are Today, the SSE
  `preview` (lib/events.ts:101) and the inbox's no-message / relay fallback
  (inbox.ts:679, :1273, :1315); the inbox's normal preview comes from message
  rows and is unaffected. This changes plan 2.6 step 8 and Task 4.3's touch
  assertions.

## F3 (MINOR) The dashboard UnitItem comments still say lease terms, pets and deposit fields are on the flyer; no task rewrites them

Plan location: S2 (plan section 6; no task touches `dashboard/src/api/types.ts`).
S5 touches types.ts only for the two unions and the `tenantName` comment.
S1 rewrites the APP twins of these comments (Task 1.1 steps 3c, 3g; coverage
map row "Stale 'PUBLIC on the flyer' comments (app)"), so the two sides would
disagree after the build.

Evidence: dashboard/src/api/types.ts:2570-2571 ("PUBLIC: on the flyer (spec
2026-10-20 D10a)." on `lease_terms`), :2607 (`no_pets`), :2609 (`pet_fee`),
:2611 (`deposit_one_month`), :2613 (`deposit_flexible`), each ending "On the
flyer.". (`rent_min`, `rent_max`, `deposit`, `accessibility` carry no claim.)

Correction: add a comment-only step to Task 2.2 (or 2.3) mirroring Task 1.1
step 3g: those five comments say Staff only since flyer-leads (D2). types.ts
carries non-ASCII, so use the added-lines ASCII check; no test changes.

## F4 (NOTE) D4's "the same contact" holds for the findByPhone readers only; three readers go through the thread's participants link, which a sign-up never rewrites

Plan location: spec D4 ("So the pin, the unread mark, the inbox row and the
reply gates always judge the SAME contact"); plan Task 4.2 step 3c's comment
(accurate: it names only the inbox, the unread feed and the reply gates).

Evidence: inbound attribution trusts the link
(services/contactCapture.ts:142-145); Today links its item through it
(buildToday.ts:119-122); QuickReply names by it (QuickReply.tsx:54).
`setParticipantsIfAbsent` never overwrites, and neither phone add nor remove
relinks a thread (routes/contacts.ts:2723-2770, :2836-2866). The link and
`findByPhone` differ only when a number moved between contacts, or on legacy
duplicate phones.

Scenario: number P is removed from tenant X (a secondary number) and later
added to tenant Y. P's permanent thread is still linked to X. Y signs up on
a flyer: the pin and the flyer entry land on Y and the inbox row shows Y, but
Today's Unreplied item links to X's page, whose mount mark-read cannot clear
P's thread. This is pre-existing for every inbound and inside the spec's
out-of-scope "smarter phone-holder choice". No build change; optionally say
"the inbox, the unread feed and the reply gates" in D4's sentence, as the
route comment already does.

## F5 (NOTE) app/src/lib/address.ts:110 says the flyer never shows the street address; D3 makes the address the flyer's heading

Plan location: Task 1.1 step 3 (S1's sweep of stale flyer comments).
Evidence: address.ts:110 "NOT for the public flyer - the flyer never shows
the street address." (an em dash in source). Stale since flyer-full-info,
which made the address public, and contradicted outright once D3 makes it the
h1. Correction (optional, comment-only): drop the second clause, or say the
flyer formats its own address client-side.

## F6 (NOTE) docs/issues/public-welcome-text-global-cap.md:13 names the flyer form by its old button

Plan location: Task 6.4 (already edits
docs/issues/deleted-contact-web-signup-silent.md). Evidence: :13 'the flyer
"I'm interested" form'; after D3 the button reads "Sign up" (plan 1.1). Its
premise, "every first capture of a phone number sends the welcome" (:15),
stays true under D5. Correction (optional): one-word edit in Task 6.4.

## F7 (NOTE) S4's open "S6 to confirm" item, answered: the new-contact unread mark shifts no existing e2e assertion

Plan location: S4 section E, "S6 (e2e) can rely on" third bullet; S6 Task 6.1.
Evidence: playwright.config.ts:140-141 runs `workers: 1`, not fully
parallel. The only specs asserting an ABSOLUTE unread total or badge reseed
in beforeEach (call-inbox-unread.spec.ts:109-111, inbox-nav-badge.spec.ts:202-206).
Every e2e caller of POST /public/housing-fair signs up a fresh phone
(a2p-compliance.spec.ts:156-200, settings.spec.ts:112, proof-of-send.spec.ts:23,
scenarios/steps.ts:609 via tenant-onboarding.spec.ts:186,
public-pages.spec.ts:283). None asserts a timeline count or inbox state after
the sign-up (public-pages reads the first outbound - still the welcome - and
the capture fields; tenant-onboarding scopes its checks to the Details
section). e2e/performance only classifies the endpoint
(mutationCatalog.ts:178). No correction needed; S6 can cite this instead of
re-deriving it.
