# Code review - Reviewer A (SPEC CONFORMANCE) - feat/last-heard-from

Date: 2026-10-13. Reviewer: Reviewer A (spec conformance), read-only.
Tree: `feat/last-heard-from` HEAD 1f298e64 (merge-base 16ca96cc = main, 0 behind).
Contract: spec rev 6 (section 14 wins), plan v3 sections 1, 2, 3 (3.4 wins over
slice text) and 11, build-research adjudications, slice reports D1-D12.

Method: read every live source file the diff touches (not only the hunks),
every new/changed test title, the six e2e specs, the docs diff, and the gate
logs under `.superpowers/sdd/gates/`. Per the GATE RULE no test was run while
`p3-e2e.exit` was absent; see section 7 for what ran after it appeared.

## 0. Verdict

The branch conforms to the spec and plan essentially end to end. Every work-map
task S1-S9 is present; every goal, decision, invariant, edge case, section-14
amendment, copy string and wire shape checked out against the live code, with
one MINOR and two NIT findings below. No BLOCKER, no MAJOR.

Counts: BLOCKER 0, MAJOR 0, MINOR 1, NIT 2.

## 1. Findings (most severe first)

### A-1 MINOR (PLAUSIBLE) - the contact header's "Last heard from" is clipped first on a narrow pane

- Where: `dashboard/src/routes/contact/ContactDetail.tsx:997-1008` (the facts
  line now always renders `<span>{facts}</span> - <LastHeardFrom/>`, :1637),
  `dashboard/src/routes/contact/ContactDetail.module.css:89-104` (`.facts` is
  `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`, and
  `.heardFrom` only adds `nowrap`).
- What is wrong: spec 5.7 puts the value on the header "so the value Sam sorts
  by is visible on the page she lands on"; 14.5 F6 places it as its own span on
  the facts line. Because the span is the LAST inline child of a single
  nowrap/ellipsis line, any overflow is cut from the end - i.e. "Last heard
  from" is the first thing to disappear. The D6 implementer recorded exactly
  this (D6 decision 6) and deferred it to self-QA; nothing changed since.
- Failing scenario: a tenant with `voucherSize` and a housing authority on a
  phone (360px): the line reads "Voucher 2BR - Atlanta Housing Authority -
  Last heard from Today 2:14 PM" (about 70 chars at `--fs-xs` = 12px, roughly
  420px of text) inside an identity column that also holds the 36px avatar and
  the header actions, so the label is ellipsized away ("... - Last he...") or
  cut entirely. Desktop widths fit.
- Proof: walked layout from the CSS tokens (`ui/tokens.css:52`, 12px) and the
  `buildFacts()` strings (`ContactDetail.tsx:1453-1475`). Not rendered in a
  browser (no lane may be started by this review; jsdom does no layout), hence
  PLAUSIBLE.
- Smallest fix: make `.facts` a nowrap flex row whose facts span is the one
  shrinkable child (`min-width: 0; overflow: hidden; text-overflow: ellipsis`)
  and the heard span `flex: 0 0 auto` - the same sacrifice order the Tenants
  row already uses (spec 14.5 F13, `ContactsList.module.css` `.heardFrom`).

### A-2 NIT (CONFIRMED) - one property, two address spellings across the new surfaces

- Where: `app/src/services/followUps.ts:42` (comment) and :162 (`unitLabel` =
  app `formatAddress`), `app/src/routes/units.ts:1260` (timeline labels, app
  `formatAddress`) vs `dashboard/src/routes/listing/listingFormat.ts:137-142`
  (`shortAddress`) and `dashboard/src/routes/contact/format.ts:102-112`
  (dashboard `formatAddress`) used by the "Sent to" / "Properties sent" aria
  names and the Properties list.
- What is wrong: the app formatter joins `City, ST ZIP`
  (`app/src/lib/address.ts:121-125`); the dashboard one joins `City, ST, ZIP`.
  The follow-ups comment says `unitLabel` is "the dashboard's shortAddress
  rule"; it is not. Spec 5.6 / 14.3 do mandate the SERVER formatter for
  `unitLabel` and the timeline label, so this conforms to the letter; the
  impact is cosmetic plus a mismatched accessible name for the same action on
  two surfaces.
- Failing scenario: `{ line1: '12 Oak St', city: 'Atlanta', state: 'GA',
  zip: '30314' }` - Follow up heading and its row buttons read
  "Mark Tia Moss not interested in 12 Oak St, Atlanta, GA 30314"; the
  property card's button reads "... in 12 Oak St, Atlanta, GA, 30314"; the
  timeline pin reads "Not interested in 12 Oak St, Atlanta, GA 30314".
- Proof: throwaway tests (deleted) - app `formatAddress({ line1: "12 Oak St", city: "Atlanta", state: "GA", zip: "30314" })` === "12 Oak St, Atlanta, GA 30314"; dashboard `formatAddress` and `shortAddress` on the same input === "12 Oak St, Atlanta, GA, 30314". `npx vitest run` on each: 1 file, all passed (logs `.superpowers/review/reviewerA-app-tmp.log`, `reviewerA-dash-tmp.log`).
- Smallest fix: correct the comment at `followUps.ts:42` (and optionally file
  the formatter split as a tier-1 TODO); aligning the two formatters is out
  of this branch's scope.

### A-3 NIT (CONFIRMED) - 503 `saved: true` when the Interested click wrote nothing

- Where: `app/src/routes/units.ts:1359-1373` (the re-projection catch and the
  `after === undefined` branch always answer `saved: true`).
- What is wrong: spec 5.4 - "A failure in step 5 ... AFTER A SUCCESSFUL WRITE
  returns 503 with `saved: true`". On `interested` where a qualifying tour
  already exists and no effective decline is on the row, steps 3 and 4 write
  nothing, yet a failed re-read still answers `saved: true`, and the row then
  says "Saved - reload to see the change." (`lib/listingOutcomeErrors.ts`).
- Failing scenario: a stale "Sent to" card (a tour was created from the Tours
  page after it loaded) - Interested is clicked, the route finds the tour,
  writes nothing, and the tours re-read throws -> 503 `{ saved: true }`.
  Impact is small: a reload does show Interested, so the copy is not wrong in
  effect.
- Proof: throwaway route test (deleted; harness world, no DynamoDB): a scheduled tour t-1 on the pair, `toursRepo.listByUnit` real on call 1 and throwing on call 2, POST `{ outcome: "interested" }` -> 503 `{ error: "outcome_unavailable", saved: true }` while `toursMap.size` stayed 1, the listing_sends row was byte-identical and no `listing_*` event was written. `cd app; npx vitest run test/conformanceA.review-tmp.test.ts` -> 2 passed.
- Smallest fix: track `let wrote = false` (set on setDeclined / clearDeclined /
  create) and send `saved: true` only when it is true; otherwise the plain
  `{ error: 'outcome_unavailable' }`.

## 2. Work map (plan section 2) - every slice and task

| item | status | evidence (live tree) |
|---|---|---|
| 1.1 repo method + typed fakes + harness touches | CONFORMS | `app/src/repos/contactsRepo.ts:229` (attr), :939 iface, :1949-1984 impl (pointer skip :1952, normalize, `attribute_exists` condition :1971, CCF -> skipped, else failed); harness `heardFromTouches` (D1) |
| 1.2 `attributeInbound` + `repoLookup` | CONFORMS | `app/src/lib/heardFrom.ts:54-105`, :111-119; thread-type discrimination :43, :65 |
| 1.3 path 1 (1:1) | CONFORMS | `app/src/routes/webhooks/twilio.ts:2670-2702` (persisted row/thread, both branches) |
| 1.4 path 2 (relay open) | CONFORMS | `twilio.ts:943-968` |
| 1.5 path 3 (closed late text) | CONFORMS | `twilio.ts:1371-1395` |
| 1.6 path 4 (native group) | CONFORMS | `twilio.ts:2170-2199`, persisted row hoisted :2106/:2126 |
| 1.7 path 5 (founder bridge) | CONFORMS | `app/src/routes/webhooks/voice.ts:749-751` (captured caller kept), :816-841 |
| 1.8 path 6 (refused masked) | CONFORMS | `voice.ts:1095-1135` (every reason; 14.6 left the router alone) |
| 1.9 path 7 (bridged masked) | CONFORMS | `voice.ts:1204-1232` |
| 1.10 path 8 (email) + IB1 | CONFORMS | `app/src/services/inboundEmail.ts:815-843`; `routes/unmatchedEmail.ts:83` |
| 1.11 dev seams | CONFORMS | `app/src/routes/dev.ts:824-843` helper; :914 transcript, :1138 append, :1175 direct Put |
| 1.12 importer stamp + IB3 | CONFORMS | `app/src/lib/import/apply.ts:369-386`, :497-505, :527-528, :533-549; `ApplyReport.lastHeardFromStamps` :213 |
| 1.13 seed derivation | CONFORMS | `app/src/lib/seed/heardFrom.ts:59-85` (copies, pointer skips); `seed/index.ts:151` after the matrix/history merge, before the Put loop |
| 1.13B refusal + I1 audit | CONFORMS | `app/src/routes/contacts.ts:299-304`; record `docs/.../2026-10-12-last-heard-from/I1-last-heard-from-writers.md` |
| 1.14 dashboard `Contact` | CONFORMS | `dashboard/src/api/types.ts:2280` |
| 2.1 backfill planner + CLI | CONFORMS | `app/scripts/backfill-last-heard-from.ts:89-121` planner, :160-261 runner (abort on failed :255-258), --lane via stageClient :272-287 |
| 2.2 RUNBOOK | CONFORMS | `RUNBOOK.md:500-522` |
| 3.1 `listingSendOutcome.ts` | CONFORMS | `app/src/lib/listingSendOutcome.ts:20-141` (+ `wireDecline`, additive) |
| 3.2 `deriveTourActivityAt` | CONFORMS | `app/src/lib/listingSendTour.ts:106-118` |
| 3.3 `declined` + writers | CONFORMS | `app/src/repos/listingSendsRepo.ts:109`, :351-406 (counted condition), header :14-25 |
| 3.4 projection + requireComplete | CONFORMS | `contactsRepo.ts:367-378`, :1043-1055 (`#status` aliased :1050), :1314-1318 |
| 3.5 event writer + types | CONFORMS | `app/src/lib/listingOutcomeEvents.ts:21-50`; `activityEventsRepo.ts:64-66`; mirror `dashboard/src/api/types.ts:2744-2746` |
| 3.6 two GET projections | CONFORMS | `units.ts:234-280` (`projectRecipientRow`), :1180-1203 (503 on either join); `contacts.ts:1232-1277` |
| 3.7 outcome route + wiring | CONFORMS (A-3 NIT) | `units.ts:1223-1378`; `api.ts:968-970`, :1108-1112 |
| 3.8 dashboard wire types + endpoint | CONFORMS | `dashboard/src/api/types.ts:2962-2999`; `endpoints.ts:1150-1159`; `dashboard/src/lib/listingOutcomeErrors.ts`; perf catalog `e2e/performance/mutationCatalog.ts:84` |
| 4.1 dashboard heardFrom helpers | CONFORMS | `dashboard/src/lib/heardFrom.ts:48-96` |
| 4.2 facet model + URL | CONFORMS | `dashboard/src/routes/contacts/tenantFacets.ts:60-75`, :179-190, :224-247, :270-284, :385-390 |
| 4.3 ChipGroup baseline + Status group + hint | CONFORMS | `FilterChips.tsx:50`, :72; `TenantFilters.tsx:61-68`; `ContactsList.tsx:285-288`, :385-397 |
| 4.4 rows + sort + `visible` memo | CONFORMS | `ContactsList.tsx:183-189`, :264-274; `TenantFilters.tsx:107-121` |
| 4.5 contact header span | CONFORMS (A-1 MINOR) | `ContactDetail.tsx:997-1008`, :1637-1645 |
| 4.6 perf `resolveContactDetail` | CONFORMS | `e2e/performance/routes.ts:1130-1139`, :402 (tenants-F2) |
| 5.1 `SendRosterRow` + CSS | CONFORMS | `dashboard/src/routes/contact/Card.tsx:215-404`; `Card.module.css:221-330` |
| 5.2 per-row setters | CONFORMS | `useListing.ts` `setRecipientRow`; `useContactFile.ts:126-135` (forId guard) |
| 5.3 property card wiring | CONFORMS | `ListingDetail.tsx:388-423` (URL form), :1192-1229 (four groups), :1213 (deleted -> no actions), :1479-1493 |
| 5.4 contact cards | CONFORMS | `TenantFile.tsx:326-360`; `PartnerFile.tsx:184-219`; `ContactDetail.tsx:665-668`, :1200-1260, :1383-1395 |
| 5.5 Timeline / Activity labels | CONFORMS | route writes timeline labels `units.ts:1304`, :1317, :1333, :1349; `listingFormat.ts:172-209` |
| 6.1 resolver + seeds projection | CONFORMS | `audienceResolution.ts:49-58`, :181-182; `broadcasts.ts:528-529`, :796-797 |
| 6.2 preview response + deps | CONFORMS | `broadcasts.ts:462-489` (`effectiveDeclines`), :770-782 (degraded), :817, :838-839; deps :124-131 |
| 6.3 C6 patch verbatim | CONFORMS | commit 3509ad35; `git diff` hunks equal the patch hunks (proved, section 7) |
| 6.4 `annotate` prop | CONFORMS | `ContactSearchField.tsx:68`, :292, :319 (after C6 commit) |
| 6.5 RecipientPreview | CONFORMS | `RecipientPreview.tsx:99-130`, :194-217, :437-439, :491-494, :508-517, :582; CSS container queries |
| 7.1 builder + endpoint | CONFORMS | `app/src/services/followUps.ts:97-187`; `broadcasts.ts:1072-1085` |
| 7.2 dev seam | CONFORMS | `dev.ts:1339-1390` (201 / 409 send_exists / 400 / 404) |
| 7.3 `useFollowUps` + `FollowUpView` + tab URL | CONFORMS | `useFollowUps.ts`; `FollowUpView.tsx`; `BroadcastsList.tsx:34`, :58, :160-182 |
| 7.4 counts hook + pill | CONFORMS | `listings/useFollowUpCounts.ts`; `ListingsList.tsx:128`, :210, :425-430 |
| 7.5 (adjudication F2) perf template | CONFORMS | `e2e/performance/templates.ts:133`; `routes.ts:309` |
| 8.1-8.4, 8.6 e2e specs + rewrites | CONFORMS | section 5 below |
| 8.5 C6 full-suite re-proof | CONFORMS | `matching-entry-points.spec.ts:192` ok 129 in `p3-e2e.log`; see section 7 |
| 9.1 GLOSSARY | CONFORMS | `documentation/GLOSSARY.md:478-510` |
| 9.2 issues | CONFORMS | `contact-search-popover-below-viewport.md:6,9` resolved; `denormalize-...md:110`; `tour-create-no-dedupe.md:6` open |

## 3. Spec requirements

### 3.1 Goals

| id | status | evidence |
|---|---|---|
| G1 | CONFORMS | eight touch sites (section 2, 1.3-1.10); forward-only `contactsRepo.ts:1971`; backfill same rule `backfill-last-heard-from.ts:100` |
| G2 | CONFORMS | `ContactsList.tsx:183-189`, :270-274; default set `tenantFacets.ts:70`; Name sort `heardFrom.ts:65` |
| G3 | CONFORMS (14.4 amended) | columns/order `RecipientPreview.tsx:194`, :508-575; declined default `:99-101`; tag :582; annotate :437 |
| G4 | CONFORMS | route `units.ts:1223-1378`; cards `Card.tsx:301-404` |
| G5 | CONFORMS (D1 decided) | `followUps.ts:97-187`; `FollowUpView.tsx`; pill `ListingsList.tsx:128` |
| G6 | CONFORMS | commit 3509ad35; issue resolved |
| G7 | CONFORMS | `DeclineRecord.by` `listingSendOutcome.ts:29-33`; route writes `staff` `units.ts:1324`; derivations pure in one module |

### 3.2 Decisions

| id | status | evidence |
|---|---|---|
| D1 | CONFORMS | option A tab + C count; QUIET 24h / LOOKBACK 14d `listingSendOutcome.ts:24-26`; replied-then-quiet `isWaiting` :116-131 |
| D2 | CONFORMS | `deriveListingSendOutcome` replied = heard > sent `listingSendOutcome.ts:79-81` |
| D3 | CONFORMS | outcome independent of `via` everywhere |
| D4 | CONFORMS | declined rows shown, unchecked, enabled `RecipientPreview.tsx:99-101`, :563-565 |
| D5 | CONFORMS | 3509ad35 + issue |
| D6 / D14 | CONFORMS | stored only `declined`; `tourType = unit.tour_type` `units.ts:1289`; 409 `tour_type_required` :1291; form mode `Card.tsx:358`, `ListingDetail.tsx:393-405` |
| D7 | CONFORMS | partner: no tour `units.ts:256`, `contacts.ts:1269`; Request a tour link `Card.tsx:363-371`, `PartnerFile.tsx:212-214`, `FollowUpView.tsx:136-147` |
| D8 | CONFORMS | contact-card actions `TenantFile.tsx:336-357`, `PartnerFile.tsx:194-216` |
| D9 | CONFORMS | Status group `TenantFilters.tsx:61-68` |
| D10 | CONFORMS | `docs/issues/tour-create-no-dedupe.md` open; Interested path checks `units.ts:1286` |
| D11 | CONFORMS | `effectiveDecline` `listingSendOutcome.ts:47-59`; `deriveTourActivityAt` `listingSendTour.ts:106-118` (never updatedAt) |
| D12 | CONFORMS | requireComplete joins, 503s `units.ts:1185-1200`, `contacts.ts:1243-1254`, `followUps.ts:139`; error surfaces `ListingDetail.tsx:1232`, `TenantFile.tsx:327`, `PartnerFile.tsx:185`, `FollowUpView.tsx:206` |
| D13 | CONFORMS | `seed/index.ts:151`; perf world untouched (`performanceSeed.ts` not in diff) |

### 3.3 Sections 5.1-5.8

| section | status | evidence / note |
|---|---|---|
| 5.1 attribute, writer, guard, normalize, best-effort | CONFORMS | `contactsRepo.ts:1949-1984`; caller log line verbatim at every site (`twilio.ts:963`, :1390, :2194, :2697; `voice.ts:836`, :1124/:1133, :1222/:1230; `inboundEmail.ts:835`; `dev.ts:835`) |
| 5.1 instant = persisted key, dedupe both branches | CONFORMS | `splitTsMsgId(appended/persisted tsMsgId)` at every site |
| 5.1 one attribution rule (as 14.2) | CONFORMS | `heardFrom.ts:54-105` |
| 5.1 readers + Display formatter | CONFORMS | `RECIPIENT_PROJECTION` `contactsRepo.ts:1043`; `formatHeardFrom` `dashboard/src/lib/heardFrom.ts:48-57` |
| 5.2 backfill | CONFORMS | pointer skip :79-81, :236-239; filter :213; 1:1 stop / group exhaust :118; normalized max :111-117; report fields :123-136 |
| 5.3 resolver + preview + review rows + annotate | CONFORMS | section 2 rows 6.1-6.5 |
| 5.4 decline record, effective decline, outcome, partner, audit, route, joins | CONFORMS (A-3 NIT) | section 2 rows 3.1-3.7 |
| 5.5 roster rows, four groups, actions, aria | CONFORMS | `Card.tsx:301-404`; `listingFormat.ts:282-298` |
| 5.6 Follow up tab + Properties count | CONFORMS (A-2 NIT) | `followUps.ts`; `FollowUpView.tsx`; `BroadcastsList.tsx`; `ListingsList.tsx` |
| 5.7 Tenants tab + header | CONFORMS (A-1 MINOR) | section 2 rows 4.1-4.5 |
| 5.8 C6 | CONFORMS | verbatim; full-run proof section 7 |

### 3.4 Invariants

| id | status | evidence |
|---|---|---|
| I1 | CONFORMS | one writer `contactsRepo.ts:1949`; client refusal `contacts.ts:299-304` (both parsers); writer audit record; seed Put exception accepted (adjudication IB8) |
| I2 | CONFORMS | only `setDeclined`/`clearDeclined` write `declined`; putShareMemory pin `listingSendsRepo.integration.test.ts:152` describe; seam writes no `declined` (`devListingSendFixture.test.ts:39`) |
| I3 | CONFORMS | full qualifying-set check `units.ts:1286`; buttons disabled in flight `Card.tsx:356`, `FollowUpView.tsx:127` |
| I4 | CONFORMS | `seed/heardFrom.ts` through `attributeInbound`; `seedHeardFrom.test.ts:37`, :62; `seed/live.ts` writes no messages (so no derived value is missing) |

### 3.5 Edge cases (section 7)

All CONFORM: restore keeps the value (no clearing writer, I1 audit);
phone-only recipient has no row (rows keyed by contactId); unlisted row -> 404
`send_not_found` (`units.ts:1235-1238`, `ledgerRowCounted`); converted caseworker
-> `interestedSupported: false`, tours ignored (`units.ts:255-256`,
`contacts.ts:1241`); two properties / one reply -> both Replied (pure
derivation); STOP -> Replied but ineligible (`isEligibleRecipient`
`listingSendOutcome.ts:104`); instants via `Date.parse` (`instantMs`
`listingSendOutcome.ts:36-40`, `instantOf` `dashboard/src/lib/heardFrom.ts:36-40`).

### 3.6 Section 14 amendments

| item | status | evidence |
|---|---|---|
| 14.1 module/type names | CONFORMS | `listingSendOutcome.ts`; `lib/sendOutcome.ts` untouched (not in diff) |
| 14.2 email_new_address, async rule, persisted thread, no voice read-back, phone-only members, `'written'/'skipped'/'failed'`, backfill exhaust + abort, `--lane`, seed copies/pointers/exact values, seam deps, importer, I1 grep scope | CONFORMS | `heardFrom.ts:93`; sites above; no `getByProviderSid` added on voice paths; `seedHeardFrom.test.ts:37` pins the exact lean values |
| 14.3 tenant_required dropped / requireTenantContact | CONFORMS | `units.ts:1269-1274` |
| 14.3 own event writer, contact timeline only, refType unit, payload | CONFORMS | `listingOutcomeEvents.ts:37-46`; `LANDLORD_FEED_TYPES` not extended |
| 14.3 counted condition + ledgerRowCounted | CONFORMS | `listingSendsRepo.ts:359`, :389; `units.ts:1235` |
| 14.3 error-surface prop change | CONFORMS | `listingsSentStatus` props `TenantFile.tsx:66`, `PartnerFile.tsx:47` |
| 14.3 deps, interestedMode server/client, setters, `?tour=new` URL form, B10 deleted property, B11 no partner tour, B12 CSS + knowing rewrites | CONFORMS | sections above; rewritten (never deleted) tests: `listingSendsApi.test.ts:315`, :334, :446 replace the E3 pins |
| 14.4 hand-pick checked, own view/hook, `?tab=follow-up`, seam, deps, B6-B14 | CONFORMS | sections above |
| 14.5 F1-F18 | CONFORMS (F6 -> A-1) | `matchesStatus` :270-273 (F1), perf (F2), listing-activity rewrite (F4), header (F5/F6), helpers (F7/F8/F10), facet API (F9), hint (F11), ChipGroup (F12), row CSS (F13), select placement (F14), e2e call = business-line miss (F18) |
| 14.6 path 6 unchanged, clear-without-decline no event, accepted limits | CONFORMS | `units.ts:1338-1349`; `founderTriage.test.ts:559` |

## 4. Copy table (plan section 1 + 3.4 #5) vs shipped text and names

| string | status | where |
|---|---|---|
| chips `No reply yet` / `Replied` / `Not interested` / `Not interested (auto)`; TourChip; `Interested` (no tour) | VERBATIM | `Card.tsx:257-279` |
| `Sent <label>` / `Last heard from <label>` / `Never` | VERBATIM | `Card.tsx:342-344`; `FollowUpView.tsx:110-115`; `heardFrom.ts:50` |
| buttons `Interested`, `Not interested`, `Undo`; link `Request a tour` | VERBATIM | `Card.tsx:351-393`; `FollowUpView.tsx:123-176` |
| aria `Mark <name> interested in <address>` / `Mark <name> not interested in <address>` / `Undo not interested for <name>` / `Request a tour for <name> at <address>` | VERBATIM | `Card.tsx:355`, :376, :387, :367; `FollowUpView.tsx:128`, :152, :171, :143 (address spelling: A-2) |
| `Couldn't save - try again.` / `Saved - reload to see the change.` | VERBATIM | `dashboard/src/lib/listingOutcomeErrors.ts` |
| `We couldn't load properties sent.` | VERBATIM | `TenantFile.tsx:327`, `PartnerFile.tsx:185` |
| headers `Name`, `Status`, `Housing authority`, `Last heard from` | VERBATIM | `RecipientPreview.tsx:510-514` (aria-hidden visual row outside the `ul`) |
| tags `Already sent`, `Not interested`, `Added` | VERBATIM | `RecipientPreview.tsx:581-585` |
| checkbox names (ASCII " - ", five forms) | VERBATIM | `RecipientPreview.tsx:105-111`; visible no-consent tag keeps its em dash via code point :94 |
| degraded line | VERBATIM | `RecipientPreview.tsx:493` |
| search annotation (one suffix, Not interested first) | VERBATIM | `RecipientPreview.tsx:437-439` |
| `Sort by`, `Last heard from`, `Name` | VERBATIM | `TenantFilters.tsx:110-117` |
| `Status` group, seven StatusBadge labels in TENANT_STATUSES order, `Clear status filter` | VERBATIM | `TenantFilters.tsx:61`; `tenantFacets.ts:385-390`; `FilterChips.tsx:76` |
| `No matches for <q> among the statuses shown` + `Show all statuses` | CONFORMS | `ContactsList.tsx:388-394` (quoted query and final period, the existing no-match line's own style) |
| Tenants row / header `Last heard from <label>` | VERBATIM | `ContactsList.tsx:187`; `ContactDetail.tsx:1642` |
| Follow up: tab + count, `<n> waiting`, `No reply yet, N days` / `Replied, quiet N days` / `1 day`, empty, error, `Text`, `Text <name>`, text failure, truncated note | VERBATIM | `BroadcastsList.tsx:168-175`; `FollowUpView.tsx:28-37`, :182, :206, :216, :224, :234 |
| pill `<n> waiting` inside the row link | VERBATIM | `ListingsList.tsx:128` |
| timeline labels | VERBATIM | `units.ts:1304`, :1317, :1333, :1349 (route-written) |
| property Activity labels | VERBATIM | `listingFormat.ts:172-176`, :201-209 |

## 5. Wire shapes (app route vs dashboard mirror)

| shape | status | app | dashboard |
|---|---|---|---|
| `ListingSendRow` (+ outcome fields) | MATCH | `listingSendsRepo.ts:120-152`, serializer :231-255 | `api/types.ts:2966-2999` |
| `FollowUpItem` / response | MATCH (app `type: string`, dashboard `ContactType`) | `followUps.ts:40-66` | `api/types.ts:3440-3463` |
| preview additions | MATCH | `broadcasts.ts:796-797`, :817, :838-839 | `api/types.ts:3402-3408`, :3432-3435 |
| outcome route answers (200 `{ row }`, 400 invalid_outcome / interested_unsupported, 404 unit_not_found / send_not_found / tenant_not_found, 409 unit_deleted / contact_not_tenant / tour_type_required, 503 +saved) | MATCH | `units.ts:1223-1378` | `endpoints.ts:1150-1159` returns `{ row }`; `isOutcomeSaved` |
| dev seam (201 `{ row }`, 409 send_exists, 400, 404s) | MATCH (404s additive) | `dev.ts:1339-1390` | used by e2e only |

## 6. Slice-report divergences judged

All claimed divergences keep the spec's intent:
- D1 1-6: additive asserts, comment citation by text, debug-level test logger - fine.
- D2 #1 (masked paths log the error NAME only): honors 5.1's best-effort
  posture and keeps the pre-existing PII pin; the contract line text is
  unchanged - accepted. #2-#8 fine.
- D3 #2 two commits for 2.1, #6 RUNBOOK exit-code wording widened to match the
  code - fine.
- D4, D5: contract-neutral; knowing rewrites are rewrites, not deletions
  (verified: every removed test title in the diff has its D12 replacement).
- D6 #6 (header clipping deferred to self-QA): NOT resolved - finding A-1.
- D7 #6 interim names were behind `actionsDisabled`, superseded by 5.4 - fine.
- D8 #1 form keyed by tenantId - fine. D8 "deleted CONTACT rows keep actions":
  conforms (14.3 B10 names only a deleted PROPERTY; a soft-deleted tenant is
  "simply NOT ELIGIBLE").
- D9 header row `aria-hidden` beside the list: meets P1 (visible, before and
  outside the `ul`); each cell's text lives in its row - accepted.
- D10 seam rows read `via: 'broadcast'` (putShareMemory's if_not_exists
  default) - seam-only, nothing reads it - fine.
- D11 #5 tab row wraps at phone width - additive CSS, self-QA item, fine.
- D12 #1-#8 test-mechanics adaptations to shipped markup - fine.

## 7. Section 8 verification list -> tests, and what ran

Unit (app), each item -> test:
- touchLastHeardFrom guard/forward-only/normalize/swallow: `contactsRepoHeardFrom.test.ts:34-81`, `contactsRepo.integration.test.ts:294`.
- eight paths, fresh + deduped: `twilioSmsWebhook.test.ts:1401`, :1426 (1); `relayWebhook.test.ts:342`, :354, :370, :385 (2), :400, :414, :425 (3); `groupTextWebhook.test.ts:1545`, :1559 (4); `founderTriage.test.ts:518-559` (5); `voiceWebhook.test.ts:666` describe (6, 7, deduped both); `inboundEmail.test.ts:873`, :926 (8, winner only).
- dev seams: `devMessageTransportFixture.test.ts:104`; `devTranscriptFixture.test.ts:65`.
- retry / echo / new-address do not touch: `heardFrom.test.ts:70`; `twilioSmsWebhook.test.ts:1460`, `groupTextWebhook.test.ts:1572`; `inboundEmail.test.ts:889`; backfill `backfillLastHeardFrom.test.ts:77`. (The live 30003 retry append has no touch call; covered by construction.)
- attributeInbound branch table incl. keyless refused non-member and never-the-roster: `heardFrom.test.ts:65-194` (cases 8-10).
- per-path conformance test: superseded by 14.2 (attribution IS the call).
- deriveSendOutcome precedence incl. partner-ignores-tour: `listingSendOutcome.test.ts:59-95`.
- effectiveDecline by share / new tour behind older toured / reschedule-reopen: `listingSendOutcome.test.ts:39`, `listingSendTour.test.ts:182`, :193.
- outcome route branches + 503 saved + incomplete batch: `listingSendOutcomeApi.test.ts:192`, :248-348; `listingSendsApi.test.ts:446`.
- backfill planner branches: `backfillLastHeardFrom.test.ts:63-260`.
- seed derivation: `seedHeardFrom.test.ts:36-101`; `seedProfile.integration.test.ts:137`.
- follow-ups eligibility/thresholds/order: `followUps.test.ts:88-250`.
- preview declinedContactIds under D11 + degraded flag: `broadcastApi.test.ts:2508` describe.
- `POST /api/tours tenant_required`: dropped by 14.3 A1 (requireTenantContact pins: `listingSendOutcomeApi.test.ts:223`, :238).

Unit (dashboard): `lib/heardFrom.test.ts:11-92`; `contacts/tenantFacets.test.ts:384`, `ContactsList.test.tsx:477`, :553, `TenantFilters.test.tsx` Status/Sort cases, `FilterChips.test.tsx` baseline case; `RecipientPreview.test.tsx:818` describe (+ :965 annotation); `ContactSearchField.test.tsx:114`, :128 (annotate), :334, :356, :373 (C6); `SendRosterRow.test.tsx:42-218`; `listingFormat.test.ts:330` (four-group cover); `ListingDetail.test.tsx:2395` describe; `files.test.tsx:276`, :832, `ContactDetail.test.tsx:1142` (error rendering); `FollowUpView.test.tsx:82-270`; `BroadcastsList.test.tsx:381`; `ListingsList.test.tsx:938`.

E2E (all present and asserting what section 8 asks):
- (1) `last-heard-from.spec.ts:96` (text + staff-reply control), :128 (call), :145 (email), :176 (relay text, opening legs as a second outbound control).
- (2) `contacts-list-facets.spec.ts:147` (default hides inactive + placed, chips/hint/Clear, last-heard sort, reload keeps sort + status).
- (3) `review-recipients-heard-from.spec.ts:119` (columns, order, declined unchecked + Select all skip, hand-added declined CHECKED per 14.4, deliberate send reaches and supersedes).
- (4) `send-outcome-cards.spec.ts:151`, :195, :235, :293 (one tour + Needs booking, NI/Undo mirrored, Tours-page tour supersedes, form mode creates nothing).
- (5) `matching-entry-points.spec.ts:192` (contains the old :228 option click) - `ok 129` in the full run `p3-e2e.log`.
- (6) `follow-up-tab.spec.ts:135`, :228 (tab + count, group, chips, reply removes, NI removes, Properties pill).

Gate logs read (not run by this reviewer): typecheck EXIT=0, test EXIT=0,
smoke EXIT=0; eslint EXIT=1 on the single pre-existing
`ContactsList.tsx:208` react-hooks error (baseline log present, not this
branch's). E2E: `p3-e2e.exit` = EXIT=0, `359 passed (20.9m)`, including all
six section-8 specs and the C6 hand-pick case (`matching-entry-points.spec.ts:192`,
ok 129) - section 8 (5) is proved in the full run, as 14.5 F17 requires.

Throwaway proofs, run only AFTER `p3-e2e.exit` appeared, single files, then
deleted (`git status --short` shows none of this reviewer's files; the
untracked `app/test/adv-outcome.review-tmp.test.ts` belongs to another
reviewer and was left alone):
- `cd app; npx vitest run test/conformanceA.review-tmp.test.ts` -> 2 passed (A-2 app half, A-3).
- `cd dashboard; npx vitest run src/routes/contact/conformanceA.review-tmp.test.ts` -> 1 passed (A-2 dashboard half).
