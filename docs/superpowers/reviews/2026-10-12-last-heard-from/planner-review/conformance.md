# Planner spec-conformance review - feat/last-heard-from @ 8bec5de1

Reviewer: planner's spec-conformance reviewer (read-only; no test, server, npm or
npx command run - a gate battery was live in the worktree). Base 8a56128c.
Contract: spec `docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`
(sections 4, 5.1-5.8, 6, 7, 8, 14.1-14.7; 14.7 treated as a builder PROPOSAL),
plan sections 1-3 (incl. 3.4), handback (claims only).

## Verdict

CONFORMS, MERGE-READY ON A HUMAN RATIFICATION: every approved decision, section,
copy row and markup row traces to code that implements it. No BLOCKING or HIGH
finding. The one material item is that spec 14.7 (durable tour supersession and
the Interested write order) was authored on the branch by the builder and changes
approved D11 / 5.4 text; the code matches 14.7 exactly, its substance is
consistent with D11's stated intent, and it needs Cameron's explicit yes before
merge.

## Findings

1. [MEDIUM] Spec 14.7 durable supersession is an unapproved amendment of D11's
   formula and 5.4's "a canceled, no-show or not-a-fit tour contributes no
   activity". D11 (approved) reads "max(createdAt, lastMarkedAt) over every
   QUALIFYING tour"; `deriveTourActivityAt` (`app/src/lib/listingSendTour.ts:116-129`)
   now also counts a NON-qualifying tour's `createdAt`. The change is consistent
   with D11's second sentence ("a tour created ... by a PERSON after a decline
   means the tenant changed their mind, from any tour-creating path") and closes
   a real path inconsistency the approved spec itself contained (5.4 step 3
   REMOVES the record on Interested, so only the Tours-page path could revive a
   decline). Only person paths create tours (`app/src/routes/tours.ts:367`,
   `app/src/routes/units.ts:1339` are the only `tours.create` callers), so no
   automated create can supersede. Product consequence Sam will see: decline ->
   later tour -> tour canceled puts the tenant back on Waiting / Follow up, and
   staff must re-record Not interested (one click; a newer decline re-wins). Needs
   Cameron's ratification; reverting is one function plus its tests.
2. [LOW] Spec 14.7's Interested write order (create BEFORE clear,
   compare-and-clear of the decline READ "whatever its effectiveness", 503
   `saved:true` after any write) reverses approved 5.4 steps (3)/(4)
   (`app/src/routes/units.ts:1333-1376`). Strictly safer than the approved order:
   a failed create leaves nothing changed, and a failed clear after a create still
   reads Interested because the new tour's `createdAt` supersedes the decline.
   Ratify together with finding 1.
3. [LOW] E2E (2) proves the INACTIVE tenant comes back (chip click and "Show all
   statuses") but never proves the PLACED tenant comes back: after "Show all" it
   asserts only `?status=placed` in the URL and the inactive row
   (`e2e/tests/dashboard-next/contacts-list-facets.spec.ts:214-223`); the Placed
   chip is never clicked with the placed row asserted visible. Spec 8 (2) "the
   status chips bring them back" is half-proved for placed (unit tests cover the
   rule; the e2e is weaker than the spec wording).
4. [LOW] Review recipients column header row is `aria-hidden="true"`
   (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:508`). Plan P1 (visible
   text, outside the `<ul>`) is met, and the spec does not require semantic
   headers, but at >= 768px the bare authority cell and the bare last-heard cell
   ("Today 2:14 PM" / "Never", `:565-567`) carry no accessible column context; the
   "Last heard from " prefix exists only below 768px as CSS `::before`
   (`RecipientPreview.module.css:264-265`). An accessibility nicety, not a spec
   deviation.
5. [LOW] The Interested route reads the pair's tours as `tours.listByUnit(unitId)`
   filtered to the tenant (`app/src/routes/units.ts:1313-1316`) instead of spec
   5.4's `tours.listByTenant(contactId)` filtered to the unit. Same pair set (both
   GSIs, both eventually consistent); recorded only as build adjudication F6, not
   in spec 14 or the handback's deviation list.
6. [LOW] Out-of-scope copy edit rides along: Matching's "Load more" busy label
   changed from "Loading" + U+2026 to "Loading..." (`BroadcastsList.tsx`, the
   loadMore button). ASCII cleanup, harmless, not in the spec.

## Handback deviations

- D1 (masked voice paths log the touch error NAME only, `voice.ts:1126-1134`,
  `:1224-1231`): AGREE. Spec 5.1 / 14.2 fix the log LINE (still emitted verbatim)
  and give the caller the log; field content is unspecified, and an existing
  masked-path privacy test forbids lookup error text. The 1:1, relay, group,
  founder and email paths log `err` as before.
- D2 (deleted contacts keep card actions): AGREE. This is SOFT-deleted contacts.
  Spec 5.5 puts them in NOT ELIGIBLE "with the same actions as its outcome", and
  14.3 B10 makes only a deleted PROPERTY read-only and says a soft-deleted tenant
  passes `requireTenantContact` by design. A HARD-deleted recipient
  (`recipientMissing`) correctly gets no actions (`Card.tsx:339`), as 5.4 requires.
- D3 (existing `contactDisplayName` instead of a new `lib/contactDisplay.ts`):
  AGREE. The spec never names the module (it is plan 3.4-era text, plan :7904);
  `app/src/lib/contactName.ts:74-82` is byte-for-byte the same rule as
  `units.ts:181-192` (`displayNameOfContact`), so one rule is reused, not forked.
- D4 (spec 14.7 durable supersession + Interested write order): AGREE ON
  SUBSTANCE, NOT YET APPROVED - see findings 1 and 2. It does not contradict D11's
  intent, but it does change D11's literal formula and 5.4's no-activity sentence,
  so it is a human decision, not a builder one.

## 1. Spec decisions D1-D14

| item | implemented where | conforms | note |
|---|---|---|---|
| D1 waiting list = A (Follow up tab) + C count; 24h quiet; 14d back; replied-then-quiet included; inactive/placed out | `app/src/services/followUps.ts:102-196`; `app/src/lib/listingSendOutcome.ts:143-145,214-250`; `dashboard/src/routes/broadcasts/FollowUpView.tsx`; `BroadcastsList.tsx:162`; `ListingsList.tsx:128,210` | YES | option B not built |
| D2 Replied = last_heard_from_at > sentAt (any thread) | `listingSendOutcome.ts:198-200` | YES | strictly after; equal = no_reply |
| D3 blasts and direct shares identical | `listingSendOutcome.ts` (row-shape only); fixture writes `individual` | YES | no `via` branch anywhere |
| D4 declined shown unchecked, tagged, never hidden; hand-check sends | `RecipientPreview.tsx:99-111,582`; send path unchanged | YES | e2e 8(3) proves send |
| D5 C6 applied verbatim, issue closed | commit 3509ad35 (hunks identical to the patch - checked); `docs/issues/contact-search-popover-below-viewport.md` status resolved 2026-10-13 | YES | |
| D6 Interested derived; only Not interested stored | `listingSendsRepo.ts` `declined` only; `deriveListingSendOutcome` `:186-202` | YES | as amended by D14 |
| D7 partner rows: Replied / Not interested + "Request a tour" | `units.ts:252-279` (`interestedSupported: isTenant`, no tour); `Card.tsx:375-384`; `ListingDetail.tsx:1217-1221`; `PartnerFile.tsx:211-214`; `FollowUpView.tsx:144-155` | YES | link only for `type === 'partner'` (B8) |
| D8 actions on contact page "Properties sent" too | `TenantFile.tsx:333-357`; `PartnerFile.tsx:191-217`; `ContactDetail.tsx:663-668` | YES | |
| D9 Tenants status filter defaulting to active | `tenantFacets.ts:60-73,179-190`; `TenantFilters.tsx:59-68` | YES | |
| D10 dup-tour bug filed; fixed on Interested only | `docs/issues/tour-create-no-dedupe.md`; `units.ts:1320-1340` (existing-tour check) | YES | |
| D11 decline superseded by later share or tour activity; never updatedAt | `listingSendOutcome.ts:166-178`; `listingSendTour.ts:116-129` | YES as amended by 14.7 | see finding 1 |
| D12 required joins with requireComplete; 503; per-endpoint error surface | `units.ts:1191-1203,1272-1281,1311-1319,1430-1438`; `contacts.ts:1241-1254`; `followUps.ts:145`; `broadcasts.ts:1072-1085`; dashboard surfaces below | YES | |
| D13 lean/full seeds derived; perf world excluded | `app/src/lib/seed/heardFrom.ts`; `seed/index.ts` (after merge, before Put loop) | YES | perf exclusion filed `perf-world-lacks-last-heard-from` |
| D14 one click only with structured `unit.tour_type`, else the form | `listingSendOutcome.ts:230-232`; `units.ts:1324-1329` (409 guard); `Card.tsx:361-368`; `FollowUpView.tsx:137-140`; `ListingDetail.tsx:1223` | YES | 409 also falls through to the form (`Card.tsx:323-328`) |

## 2. Section 5 walk

### 5.1 last_heard_from_at

| item | where | conforms | note |
|---|---|---|---|
| attribute on ContactItem, not an index key | `contactsRepo.ts:225-229` | YES | |
| one writer `touchLastHeardFrom` -> written/skipped/failed, never throws | `contactsRepo.ts:1949-1985` | YES | 14.2 tri-state |
| condition `attribute_exists(contactId) AND (attribute_not_exists OR < :at)` | `contactsRepo.ts:1968` | YES | |
| normalization inside the writer; unparseable -> logged skip | `contactsRepo.ts:1956-1960`; `heardFrom.ts:14-18` | YES | logs at warn |
| pointer rows never targets | `contactsRepo.ts:1952-1954` | YES | plan 3.4 #8 |
| CCF swallowed (debug) | `contactsRepo.ts:1978-1981` | YES | |
| failure log line exact, caller-owned | all 8 paths + seams (see table below) | YES | |
| instant = persisted row's tsMsgId prefix | every path uses `splitTsMsgId(appended/persisted tsMsgId)` | YES | |
| fresh AND deduped on SMS/voice; email with the winner only | twilio `:943,:1371,:2170,:2670`; voice `:816,:1095,:1204`; email `:815` after the dedupe return `:737-743` | YES | |
| echo check only where the persisted row is read back (1:1, native group) | `twilio.ts:2679-2683` (`persistedRow`), `:2177-2179` (`groupPersisted`) | YES | 14.2 |
| attribution on the PERSISTED thread | `twilio.ts:2678-2681` (1:1 adopts `persistedConversationId`); relay/late/voice use `conversations.getById(appended.conversationId)` on mismatch; native group returns early on a foreign row `:2115-2125` | YES | plan 3.4 #8 |
| `attributeInbound` rule (thread-type discriminated, retry, team, phone# via roster non-empty contactId else byPhone, keyless external caller fields, no roster fallback, email_new_address, participants non-empty, phone then email fall-through) | `app/src/lib/heardFrom.ts:54-105` | YES | always async (14.2) |
| `repoLookup` with cache | `heardFrom.ts:111-119` | YES | |

Eight live paths:

| # | path | touch site | conforms | note |
|---|---|---|---|---|
| 1 | 1:1 SMS/MMS | `twilio.ts:2670-2702`, cache `effectiveContact` | YES | echo -> persisted outbound row -> undefined |
| 2 | relay open, member / non-member | `twilio.ts:943-968` | YES | non-member `phone#From` -> byPhone; before keyword classify so STOP counts |
| 3 | closed relay late text into 1:1 | `twilio.ts:1371-1395` | YES | no captureContact; unknown phone -> no touch |
| 4 | native group | `twilio.ts:2170-2199` | YES | unreadable persisted row -> nobody |
| 5 | founder bridge call | `voice.ts:749-751` (captured id kept), `:816-841` | YES | inside the try after the append |
| 6 | masked refused | `voice.ts:1095-1135` | YES | member key / external caller id / phone; 14.6 path unchanged |
| 7 | masked bridged | `voice.ts:1204-1232` | YES | |
| 8 | inbound email | `inboundEmail.ts:815-843` | YES | keyed on `email_new_address` (`flagNewAddress`), never `author` |

| rule | where | conforms |
|---|---|---|
| call touches whatever its outcome (row-producing outcomes) | voice paths above | YES |
| STOP/keyword counts | relay touch precedes classify `twilio.ts:943` vs keyword block; 1:1 touch precedes `(4)` keyword handling | YES |
| staff-from-org-number, no special case | no branch added | YES |
| dev seams touch (append + direct Put + transcript) | `dev.ts:914,1138-1145,1175`; deps `dev.ts:150-165` | YES |
| importer stamp after flush, dry-run skip, in-memory phone map, ApplyReport field | `lib/import/apply.ts:369-386,459-505,527-549`; `scripts/import-apply.ts:430-434` | YES |
| seed derivation over merged rows, copies, pointer skips | `lib/seed/heardFrom.ts:60-85`; `seed/index.ts` | YES |
| readers: contacts list raw items; preview projection; RECIPIENT_PROJECTION +status etc.; listings-sent; waiting list; header | `audienceResolution.ts:180-182`; `broadcasts.ts:528-529`; `contactsRepo.ts:1043-1055`; `contacts.ts:1259-1272`; `followUps.ts:157`; `ContactDetail.tsx:1010` | YES |
| dashboard `Contact.last_heard_from_at` | `dashboard/src/api/types.ts:2278-2280` | YES |
| `formatHeardFrom` Today/Yesterday/date/Never with title | `dashboard/src/lib/heardFrom.ts:48-57` | YES (14.5 F7 `{label,title}`) |

### 5.2 Backfill

| item | where | conforms |
|---|---|---|
| `--env local|dev|prod`, `--lane`, dry run default, `--apply` | `backfill-last-heard-from.ts:271-307` | YES |
| scan conversations, skip pointer rows | `:79-81,226-244` | YES |
| Query inbound non-retry newest-first | `:206-224` | YES |
| 1:1 stops at first ATTRIBUTED; group to exhaustion (14.2) | `:89-121` | YES |
| instant = normalized tsMsgId prefix; max per contact; one touch per contact | `:111-117,251-260` | YES |
| tri-state counted; abort on failed with PARTIAL report | `:175-185,252-259` | YES |
| report incl. unattributed count + sample (ids only) | `:55-65,247` | YES |
| RUNBOOK section | `RUNBOOK.md:500-` | YES |

### 5.3 Matching review

| item | where | conforms | note |
|---|---|---|---|
| `ResolvedContact` + `resolveSeeds` gain status (tenant only) and lastHeardFromAt; filters untouched | `audienceResolution.ts:49-58,180-182`; `broadcasts.ts:525-529` | YES | |
| new fields not persisted on the broadcast | `buildRecipientsFrom` stores `{status:'queued'}` only (`broadcasts.ts:372-381`) | YES | pinned by `broadcastApi.test.ts` |
| preview per-candidate status?, lastHeardFromAt?, declinedThisProperty; top-level declinedContactIds, declineLabelsUnavailable | `broadcasts.ts:770-783,794-817,838-839` | YES | |
| D11 effective set; tours+contacts read only when a decline exists; requireComplete | `broadcasts.ts:462-489` | YES | |
| degraded: candidates served, no labels, one line | `broadcasts.ts:773-782`; `RecipientPreview.tsx:491-495` | YES | |
| row order: checkbox, name, phone, status badge, authority, last heard, tags; columns >= 768px, stacked below | `RecipientPreview.tsx:520-588`; CSS `:7,232,264` | YES | header aria-hidden - finding 4 |
| combined list sorted by `sortByHeardFrom` | `RecipientPreview.tsx:194-206` | YES | |
| added row scrolls into view | `:212-217,289` | YES | `block:'nearest'` (B10) |
| declined: unchecked unless seeded; Select all skips; checkbox enabled | `:99-101,243-245` | YES | |
| accessible names (both tags / one tag), ASCII | `:105-111` | YES | |
| `annotate` prop, after C6, separate commit, geometry untouched | commit 740ea936; `RecipientPreview.tsx:437-438,612` | YES | one suffix, Not interested outranks |
| send endpoint unchanged | no diff on send path | YES | |

### 5.4 The send outcome

| item | where | conforms | note |
|---|---|---|---|
| `declined { at, by, staffId? }` on listing_sends | `listingSendsRepo.ts` (ListingSendItem) | YES | name `declined`, not `response` |
| `setDeclined` / `clearDeclined`, SET/REMOVE only `declined`+`updated_at`, counted condition | `listingSendsRepo.ts:368-425` | YES | clear gains `expectedAt` (14.7) |
| NO-RESET invariant extended | repo header | YES | dev re-seed caveat documented |
| `effectiveDecline` (>= keeps effective) | `listingSendOutcome.ts:166-178` | YES | |
| `deriveTourActivityAt` sibling, never updatedAt | `listingSendTour.ts:116-129` | YES (14.7) | finding 1 |
| `deriveListingSendOutcome` precedence; non-tenant reads no tour | `listingSendOutcome.ts:186-202` | YES | |
| partner rows: `interestedSupported:false`, Request a tour -> `?tour=new` | `units.ts:252-279`; `ListingDetail.tsx:1217-1221` | YES | |
| audit: 3 types on contact timeline + unit audit; own writer; no landlord copy; refType unit; payload `{contactId, actor, tourId?}`; best-effort | `lib/listingOutcomeEvents.ts:21-50`; `activityEventsRepo.ts:61-66`; `types.ts:2743-2746` | YES | |
| labels: timeline written by route; Activity via `describeUnitActivity` | `units.ts` (labels at each record call); `listingFormat.ts:172-209` | YES | |
| route body / answers | `units.ts:1249-1457` | YES | order: unit -> deleted -> counted row -> body (pinned by test); plan lists no order |
| not_interested idempotent | `units.ts:1377-1394` | YES | |
| clear: 200, no event when nothing declined (14.6); compare-and-clear (14.7) | `units.ts:1395-1420` | YES | |
| interested: existing-tour check, 409 `tour_type_required`, create `requested` with `unit.tour_type`, event only on create, requireTenantContact | `units.ts:1301-1376` | YES (14.7 order) | finding 2, finding 5 |
| 503 with `saved` only after a write | `units.ts:1427-1456` | YES | throw before any write = generic 500 |
| `by:'engine'` reserved | route always `staff` `:1378` | YES | |
| button rule D14 + hosts (contact host per-click unit; property host per-click tenant via URL; waiting list navigates) | `ContactDetail.tsx:1259-1262,1386-1398`; `ListingDetail.tsx:386-421,1479-1493`; `FollowUpView.tsx:72,139` | YES | |
| `interestedMode` server where unit known, client on contact page | `units.ts:235`; `followUps.ts:180`; `Card.tsx:221-223` + `TenantFile.tsx:346` | YES | 14.3 B2 |
| D12 joins required on both GETs, outcome route, waiting list | see D12 row | YES | |
| missing contact: id as name, recipientMissing, not_interested if unsuperseded-by-share decline else no_reply, no actions, NOT ELIGIBLE | `units.ts:236-253`; `Card.tsx:339`; `listingFormat.ts:290` | YES | |
| error surfaces: property card existing row; contact cards new error row; waiting list error line | `useListing.ts:117-118` (503 -> error); `TenantFile.tsx:326-327`; `PartnerFile.tsx:184-185`; `FollowUpView.tsx:211-219` | YES | |
| wire additions on both GETs; dashboard mirror | `listingSendsRepo.ts` ListingSendRow; `types.ts:2962-2999` | YES | |

### 5.5 Roster cards

| item | where | conforms |
|---|---|---|
| two-line `SendRosterRow` (identity+kind, Sent / Last heard from; chip + actions) | `Card.tsx:303-413` | YES |
| chips incl. TourChip for interested, muted Not interested with date title, "(auto)" | `Card.tsx:259-284` | YES |
| actions per outcome; disabled in flight; row replaced; inline error | `Card.tsx:316-332,357-406`; hosts `ListingDetail.tsx:419-422`, `ContactDetail.tsx:663-668` | YES |
| property card four groups covering every row; WAITING newest first; eligibility half only | `listingFormat.ts:282-297`; `ListingDetail.tsx:1192-1229` | YES |
| projection carries deleted_at / opt-out / unreachable / status; wire `eligible` | `contactsRepo.ts:1043-1055`; `units.ts:278` | YES |
| contact card newest-first with outcome | `TenantFile.tsx:333-357` (server order) | YES |
| partner page rows show outcome + actions; never a tour chip | `PartnerFile.tsx:191-217`; `contacts.ts:1267` (tour only `isTenant`) | YES |
| deleted property: outcomes, no actions | `ListingDetail.tsx:1213`; `TenantFile.tsx:349`; `PartnerFile.tsx:207` | YES |

### 5.6 Waiting list

| item | where | conforms |
|---|---|---|
| available units walked until 100 KEPT or exhaustion; WARN + `truncated` | `followUps.ts:105-125` | YES |
| per-unit listByUnit + tours.listByUnit; one requireComplete batch | `followUps.ts:129-145` | YES |
| keep rules: outcome, eligibility (incl. has-a-phone), not inactive/placed tenant, LOOKBACK, QUIET from max(sentAt, heard) | `followUps.ts:159-167`; `listingSendOutcome.ts:214-250` | YES |
| order longest-waiting first; groups by first appearance | `followUps.ts:187-192`; `FollowUpView.tsx:39-50` | YES |
| endpoint path, response shape, 503 | `broadcasts.ts:1072-1085` | YES |
| FollowUpItem fields; unitLabel = server formatAddress | `followUps.ts:42-63,171` | YES |
| Text via `ensureContactConversation` | `FollowUpView.tsx:96-107` | YES |
| N days floor on browser clock | `heardFrom.ts:92-96`; `FollowUpView.tsx:34-37` | YES |
| constants in the outcome module | `listingSendOutcome.ts:143-145` | YES |
| Properties count from `byUnit`, own hook, silent failure | `useFollowUpCounts.ts`; `ListingsList.tsx:128,210,425-430` | YES |

### 5.7 Tenants tab

| item | where | conforms |
|---|---|---|
| row "Last heard from" after Porting, Tenants view only | `ContactsList.tsx:183-189,376` | YES |
| Sort by select, `?sort=heard|name`, default heard | `TenantFilters.tsx:105-121`; `tenantFacets.ts:239-248`; `ContactsList.tsx:263-274` | YES |
| status chips, seven, TENANT_STATUSES order, StatusBadge labels | `tenantFacets.ts:385-389` | YES |
| no param = default set; `_empty`; values beat sentinel; invalid-only -> default | `tenantFacets.ts:179-190` | YES |
| only a non-default selection written | `tenantFacets.ts:224-236` | YES |
| Clear returns to default, shown only when different (`baseline`) | `FilterChips.tsx:72`; `TenantFilters.tsx:65-67` | YES |
| status in buildFacets counts both ways | `tenantFacets.ts:341-353,385-389` | YES |
| no-status / off-list never hidden, under no chip (14.5 F1) | `tenantFacets.ts:270-273,385-389` | YES |
| hidden-match hint + "Show all statuses" | `ContactsList.tsx:285-288,384-396`; `tenantFacets.ts:277-284` | YES |
| client-side over fully loaded list; sort in `visible` memo, never the hook | `ContactsList.tsx:265-274` | YES |
| contact header "Last heard from" for every type, own span on facts line (14.5 F6) | `ContactDetail.tsx:997-1011,1640-1648` | YES |

### 5.8 C6

| item | where | conforms |
|---|---|---|
| verbatim patch, own commit, only the field + its test | 3509ad35 (hunks diffed identical to the patch file) | YES |
| annotate later and separate | 740ea936 | YES |
| populated Matching case re-proven in a full run | handback / `c6-full-run-reproof.md` | UNVERIFIED (gate evidence, not re-run here) |
| issue resolved with date and commit | issue file | YES |

## 3. Invariants and edge cases

| item | where | conforms | note |
|---|---|---|---|
| I1 forward-only; no other writer; PATCH/POST refuse it | `contactsRepo.ts:1949-1985`; `contacts.ts:299-304` (server-owned refusal); creates are `attribute_not_exists` Puts | YES | full grep audit is the builder's `i1-audit-final.md` - spot-checked here (only seed + writer write it), rest UNVERIFIED |
| I2 outcome derived; only `declined` stored, only by the route | `listingSendsRepo.ts`; dev seam writes no decline (`dev.ts:1320-1390`) | YES | |
| I3 one open tour from Interested; button disabled in flight | `units.ts:1320-1340`; `Card.tsx:316-332` | YES | race filed |
| I4 seeds self-consistent; exact lean values | `seedHeardFrom.test.ts:36-45`; `seedProfile.integration.test.ts:141-143` | YES | tenant-0001 14:02:10.000Z, landlord-0001 13:45:00.000Z, others none |
| 7 delete/restore keeps value | no writer clears it | YES | |
| 7 phone-only recipient: no outcome row | listing_sends keyed by contactId | YES | |
| 7 unlisted send: 404 | `units.ts:1261-1264` (`ledgerRowCounted`) | YES | |
| 7 converted caseworker: no tour signal, interestedSupported false | `listingSendOutcome.ts:193-195`; `units.ts:263-279` | YES | |
| 7 STOP after send: Replied, not waiting | `isEligibleRecipient` `:223` | YES | |
| 7 instants via Date.parse; ms thresholds | `listingSendOutcome.ts:155-159,246-249` | YES | |

## 4. Section 14

| item | where | conforms |
|---|---|---|
| 14.1 module `listingSendOutcome.ts`, type `ListingSendOutcome`, constants | `app/src/lib/listingSendOutcome.ts:139-145` | YES |
| 14.2 email_new_address; async attributeInbound; persisted thread; echo check only on read-back paths; phone-only members; tri-state; backfill exhaustion + abort; `--lane`; seed after merge / copies / pointer skips / exact values; dev seams both branches + deps; importer specifics; I1 grep scope | see 5.1 / 5.2 tables | YES (I1 grep scope UNVERIFIED beyond spot checks) |
| 14.3 `tenant_required` dropped -> requireTenantContact; deriveTourActivityAt sibling; own event writer and payload rules; ledgerRowCounted + counted condition; contact card status prop; deps; interestedMode server/client split; requireComplete option; per-row setters; URL-driven form with locked tenant; deleted property 409 + no actions; no `tour` on partner rows; CSS classes; knowing test rewrites | `units.ts:1257-1309`; `listingOutcomeEvents.ts`; `useContactFile.ts` setter; `useListing.ts:183-191`; `ListingDetail.tsx:386-421`; `contacts.ts:1267` | YES |
| 14.4 hand-picked declined stays checked; FollowUpView/useFollowUps not a filter value; `?tab=follow-up`; count on mount; aria-controls/tabpanel; dev seam (create-only); router deps; hand-added facts; ASCII names; container query + header outside list + gutter; Select-all formula; 100-unit walk; Properties hook/pill; degraded flag tested via rejection | `RecipientPreview.tsx`; `BroadcastsList.tsx:34,58,140-183`; `dev.ts:1339-1390`; `api.ts:968-970,1108-1112`; `followUps.ts:105-125`; `useFollowUpCounts.ts`; `broadcastApi.test.ts` | YES |
| 14.5 F1 off-list never hidden; F2 perf rebind; F4 listing-activity rewrite; F5/F6 header; F7/F8/F10 helpers; F9 facet model; F11 hint; F12 baseline; F13/F14 row and sort placement; F17/F18 e2e scope | as in 5.7; `e2e/performance/routes.ts`; `listing-activity.spec.ts` | YES (F2 UNVERIFIED - read the diff only) |
| 14.6 path 6 unchanged + path 5 test; clear-nothing writes no event; email_new_address known limit; non-superseding tour writes accepted | `founderTriage.test.ts` (closed-groups non-member); `units.ts:1395-1420` | YES |
| 14.7 durable supersession; create-before-clear; compare-and-clear on Interested and Undo; `saved` only after a write; known limits documented and filed | `listingSendTour.ts:116-129`; `units.ts:1333-1456`; `listingSendsRepo.ts:398-425`; `docs/issues/outcome-actions-act-on-server-read-decline.md` | YES to 14.7 as written; 14.7 itself NEEDS RATIFICATION (findings 1-2) |

## 5. Plan copy table (exact strings)

| row | where | conforms |
|---|---|---|
| chips No reply yet / Replied / Not interested / Not interested (auto); interested = TourChip | `Card.tsx:263-281` | YES |
| row dates `Sent <label>` / `Last heard from <label>`, Never | `Card.tsx:350-353` | YES |
| row actions Interested / Not interested / Undo / Request a tour | `Card.tsx:369,383,392,403` | YES |
| row aria (4 forms) | `Card.tsx:366,378,387,398`; `FollowUpView.tsx:136,151,160,179` | YES |
| row error / saved copy | `listingOutcomeErrors.ts:9-10` | YES |
| card errors | `ListingDetail.tsx` existing; `TenantFile.tsx:327`; `PartnerFile.tsx:185` | YES |
| preview headers | `RecipientPreview.tsx:510-514` | YES |
| preview tags | `RecipientPreview.tsx:581-585` | YES |
| preview checkbox aria (5 forms, ASCII) | `RecipientPreview.tsx:105-111` | YES |
| preview degraded line | `RecipientPreview.tsx:493` | YES (exact) |
| search annotation | `RecipientPreview.tsx:437-438` | YES |
| Tenants sort label/options | `TenantFilters.tsx:110-119` | YES |
| Tenants status group label, chips, `Clear status filter` | `TenantFilters.tsx:60`; `FilterChips.tsx:76` | YES |
| hidden-match line + button | `ContactsList.tsx:386-395` | YES (entity quotes around q) |
| Tenants row line | `ContactsList.tsx:187` | YES |
| contact header line | `ContactDetail.tsx:1645` | YES |
| Follow up tab, heading, sub, chips, actions, empty, error | `BroadcastsList.tsx:171-177`; `FollowUpView.tsx:28-37,214,224,244-246` | YES |
| Properties pill | `ListingsList.tsx:128` | YES |
| timeline labels | `units.ts` record calls (`Interested in ... - tour requested`, `Not interested cleared for ...`, `Not interested in ...`) | YES |
| property Activity labels | `listingFormat.ts:172-209` | YES (fallback `A recipient` when no who) |
| 3.4 #5 additions (Text aria, Text failure, truncated note, `1 day`, bare Interested chip, one suffix) | `FollowUpView.tsx:28-32,190,232`; `Card.tsx:268`; `RecipientPreview.tsx:437` | YES |

## 6. Markup contract (plan 3.4 #10)

| row | where | conforms |
|---|---|---|
| R1 every roster row an `<li>` in a `<ul>`, nothing else a listitem | `Card.tsx:287-293,341`; group lists `ListingDetail.tsx:1197`; `TenantFile.tsx:334`; `PartnerFile.tsx:192` | YES |
| R2 chip visible text exact; interested = TourChip link | `Card.tsx:259-284` | YES |
| R3 aria names on property card, contact card, Follow up rows | see copy row | YES |
| R4 form mode navigates `?tour=new&tenantId=`, dialog with LOCKED tenant, creates nothing, Cancel clears both | `ListingDetail.tsx:389-421,1479-1493`; e2e `send-outcome-cards.spec.ts:293-319` | YES |
| P1 header cells visible text before the `<ul>`, never inside | `RecipientPreview.tsx:508-517` | YES (aria-hidden - finding 4) |
| P2 tags and annotate suffix as text | `RecipientPreview.tsx:581-585`; `ContactSearchField.tsx` option note | YES |
| F1 `role="tab"` "Follow up" + count, aria-selected, URL open + click writes | `BroadcastsList.tsx:160-177,76-85` | YES |
| F2 `<section aria-labelledby>`, heading starts with unitLabel and contains `<n> waiting`, rows `<li>`, name -> `/contacts/:id` | `FollowUpView.tsx:239-262,110-114` | YES |
| F3 chips / `1 day` / empty state | `FollowUpView.tsx:30-37,224` | YES |
| F4 pill inside the row link, available rows only | `ListingsList.tsx:122-129,429` | YES |

## 7. Section 8 - do the e2e specs assert what the spec requires?

| spec 8 item | spec file | verdict |
|---|---|---|
| (1) inbound text, relay text, call, email each move it on the contact page; outbound does not | `e2e/tests/dashboard-next/last-heard-from.spec.ts:96-197` - Never -> Today on the header plus API instant per channel; staff reply and relay opening legs as outbound controls | MEETS |
| (2) default excludes inactive + placed; chips bring them back; hint; last-heard sort puts a just-replied tenant first; reload keeps URL | `contacts-list-facets.spec.ts:146-244` | MEETS except placed-comes-back (finding 3) |
| (3) columns; order; declined unchecked with "Not interested" in audience and hand-added; check and send works | `review-recipients-heard-from.spec.ts:119-236` | MEETS (stronger: proves Select all skip and supersession by the send) |
| (4) Interested -> one tour, Needs booking, Tour requested; Not interested then Undo; Tours-page tour after decline -> Tour scheduled; contact card mirrors | `send-outcome-cards.spec.ts:151-319` | MEETS (plus form-mode test) |
| (5) populated Matching hand-pick (C6) | existing `matching-entry-points.spec.ts:228`, full-run re-proof per handback | UNVERIFIED here (no run) |
| (6) >24h send appears under its property with tab count; a reply removes it; Not interested removes it; Properties count | `follow-up-tab.spec.ts:126-262` | MEETS (removal proven on the next load, which is the designed behavior) |

Unit coverage named in spec 8 was spot-checked by test name: touch on each path
incl. deduped and echo, attributeInbound branches, deriveListingSendOutcome
precedence incl. partner, effectiveDecline by share / newer tour behind an older
toured tour / reschedule, outcome route branches incl. `saved`, preview labels
and degraded flag, backfill planner and runner, seed derivation, follow-ups
thresholds and eligibility - all present (`app/test/*` as listed in the diff).
Results UNVERIFIED (no test run by this reviewer; the handback reports gates
green on b8dc2181).

## 8. Undeclared deviations searched for and not found

- `touchLastHeardFrom` condition, normalization, pointer guard: exact.
- `deriveTourActivityAt` never reads `updatedAt` (`listingSendTour.ts:119-126`).
- Email: no touch on the deduped loser; `email_new_address` is the only exclusion; a verified unknown-typed sender counts.
- D12: every outcome-serving read uses `requireComplete`; a failed join is 503, never a guessed row; preview correctly degrades instead of 503.
- D14: no keyword guess anywhere in the app (`units.ts:1326` reads `unit.tour_type` only; values validated in `lib/unitFields.ts:194-207`).
- Partner rows: never a tour on the wire, never Interested, link only for partners (not landlords/team).
- Follow-ups: 24h / 14d constants, has-a-phone in eligibility, tenant-only status clause.
- Lean seed values: exact and pinned.
- Backfill: `--env local --lane`, dry run default, tri-state, abort on failed.
