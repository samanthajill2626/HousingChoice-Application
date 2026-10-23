# R1 code review - spec conformance (feat/unknown-inactive, tracker #30)

- Reviewer: spec-conformance reviewer, round 1.
- Tree reviewed: HEAD 8738fcfd (merge base and main both 916258ae, so the
  final main sync is a no-op). Authority: the live tree; slice reports were
  read as claims and checked against code and tests.
- Contract: spec rev 3 (APPROVED), plan sections 0-4 (AR1-AR24), WORKLIST
  OR-1..OR-22.
- Gate battery-1 (run by the orchestrator at 8738fcfd, finished 17:24:28):
  typecheck 0, npm test 0 (app 527 files / 11155 passed + 1 skipped,
  dashboard 266 / 5481, e2e workspace 22 / 508, plus 34 / 275 and 13 / 111),
  smoke 0, e2e 0 (372 passed, 15.8m, no `[dynamoAdmin]` line).
- Reviewer's own runs (after ALL.done): gate 5 eslint on the 81 branch files
  - exit 1 with ONE error, ContactsList.tsx:219 react-hooks/set-state-in-effect,
  identical to the merge-base content (:208), so no new lint error; mutant M1
  and a throwaway probe for finding 1 (method in finding 1). The probe file
  was deleted; no tracked file was modified.

Verdict counts: 99 rows - 97 CONFORMS, 1 PARTIAL, 0 MISSING, 1 N/A (W7).
Findings: 0 HIGH, 1 MEDIUM, 4 LOW, 9 INFO.

## 1. Spec decisions D1-D10

| Item | Verdict | Evidence (live tree) |
|---|---|---|
| D1 lists per type | CONFORMS | app/src/lib/statusModel.ts:196 (PARTNER_STATUSES), :211 (UNKNOWN_STATUSES), :228-234 (statusAllowlistFor: tenant, landlord, unknown explicit, else partner list); NON_TENANT_STATUSES has no hit in app/, dashboard/ or e2e/. Pinned app/test/statusModel.test.ts:264-315 |
| D1 labels in the model, no call-site humanize | CONFORMS | statusModel.ts:200, :215 (label maps), :241-251 statusLabelFor; no status humanize in app/src (grep) |
| D2 dropdown for every live type, type's own list (team_member: partner list) | CONFORMS | dashboard/src/routes/contact/ContactDetail.tsx:1031-1040 (StatusMenu, `options={statusOptionsFor(contact.type)}`, label "Contact status"). Pinned ContactDetail.test.tsx:535 (partner, team_member, unknown) |
| D2 soft-deleted keeps the display-only badge | CONFORMS | ContactDetail.tsx:1041-1043. Pinned ContactDetail.test.tsx:560 |
| D2 same route and source, no reason prompt | CONFORMS | ContactDetail.tsx:945-950 setTenantStatus(id, {toStatus, source:'manual'}) |
| D2 conditional write, 409 on a re-type, nothing written | CONFORMS (code) | app/src/routes/statusTransition.ts:274 (consistent check read), :292 (expectedType), :346-350 (409); app/src/services/statusTransition.ts:647-664 (update with `expect` on type; CCFE re-read). Pin gap: finding 1 |
| D2 notify open Today and Inbox | CONFORMS | services/statusTransition.ts:678; routes/contacts.ts:2207-2213 (PATCH); routes/api.ts SSE on/off; dashboard/src/api/EventStreamProvider.tsx:221-226; routes/today/useToday.ts:156; routes/inbox/useInbox.ts:591. Edge deviation: finding 3 |
| D3 Status options = header's, no private list, one mirrored module + mirror test | CONFORMS | ContactEditForm.tsx:598 statusOptionsFor(statusType); dashboard/src/api/types.ts:812-869; routes/contact/contactStatusMirror.test.ts. Pinned ContactEditForm.test.tsx:1662 |
| D3 DISPLAYS an Inactive caseworker as Inactive | CONFORMS | ContactEditForm.tsx:181, :195-197. Pinned ContactEditForm.test.tsx:1680, :1686 |
| D3 type change measured vs STORED type; role-only and change-and-back are not | CONFORMS | ContactEditForm.tsx:154 (`base`), :178, :273-279. Pinned :1781, :1794, :1813, :1831 |
| D3 type change moves the field to the new type's first step | CONFORMS | ContactEditForm.tsx:47-53 FIRST_STATUS_FOR_TYPE, :276-279. Pinned :1720, :1756, :1768 |
| D3 save paths (non-tenant target PATCH carries status; tenant target setTenantStatus only off Onboarding; partner/team/unknown via transition; landlord unchanged) | CONFORMS (deviation, finding 2) | ContactEditForm.tsx:339-343, :522-527, :547-556. Pinned :448, :1697-1718, :1735, :1874, :1887 |
| D4.1 Inactive never chased, any type; Placed tenant-only | CONFORMS | app/src/lib/listingSendOutcome.ts:119-120. Pinned listingSendOutcome.test.ts:198-211, followUps.test.ts:185, listingSendsApi.test.ts:549 |
| D4.2 blasts unchanged | CONFORMS | services/audienceResolution.ts diff is the :84-85 comment only |
| D4.3 shown as any other contact | CONFORMS | no status filter added; inbox rows for every contact via buildContactRow (inbox.ts:1257, :1513, :2285) |
| D4.4 one muted tone | CONFORMS | dashboard/src/ui/StatusBadge.tsx:119-125. Pinned StatusBadge.test.tsx:62-68 |
| D4.5 "Status -> label" by the type AFTER the write | CONFORMS | routes/contacts.ts:2180-2190; services/statusTransition.ts:181, :301; services/caseworkerConversion.ts:413-420. Pinned contactTriage.test.ts:1333-1354 (copyReads), statusTransition.test.ts labels-by-type describe |
| D4 automatic texts unchanged | CONFORMS | no diff in those services; isEligibleRecipient's only consumers are services/followUps.ts:182 and routes/units.ts:301 |
| D5 collect-loop skip of an Inactive owner's unknown_1to1 thread, before the cap | CONFORMS | app/src/routes/today.ts:763-769 (right after the deleted skip :743-747, same memoized getContact :358). Fallback unchanged. Pinned todayApi.test.ts:1001-1110 |
| D6 (unknown, active) refused on every path, each with its response | CONFORMS | contacts.ts:631 (type+status parse), :1708-1712 (status-only), :914-917 (create), :1141-1145 (list read); routes/statusTransition.ts:279; suggestion accept unchanged; lib/import/apply.ts:972. Pinned contactTriage.test.ts:1111, :1121; contactsCrud.test.ts:602, :631; transitionRoutes.test.ts:390; suggestionReclassification.test.ts:698; importApply.integration.test.ts:518 |
| D6 defaults (create -> needs_review; unmatched email) | CONFORMS | contacts.ts:1014-1023; routes/unmatchedEmail.ts:455-461 comment only (AR23). Pinned contactsCrud.test.ts:661; unmatchedEmailRoutes.test.ts:583-590 |
| D7 first step from Inactive; both branches guarded on newType !== stored.type | CONFORMS | contacts.ts:1766 (auto-advance), :1797-1810 (normalize + inactive rule). Pinned contactTriage.test.ts:1249-1331; caseworkerConversion.test.ts:1009 |
| D8 card title | CONFORMS | dashboard/src/routes/contact/UnknownFile.tsx:104. Pinned UnknownFile.test.tsx:238-261, ContactDetail.test.tsx:591 |
| D9 inbound text/call never resets Inactive | CONFORMS | pinned twilioSmsWebhook.test.ts:530, founderTriage.test.ts:309 |
| D9 needsTriage false for Inactive; contactless rows unchanged | CONFORMS | app/src/routes/inbox.ts:1127; :1187 and :1578 untouched. Pinned app/test/inboxInactive.test.ts:109-190 |
| D9 Inactive tag, any type, any tab | CONFORMS | inbox.ts:1129; dashboard types.ts:3880; InboxRow.tsx:137; InboxRow.module.css:181-189. Pinned InboxRow.test.tsx:349-407 |
| D9 Unknown tab: server blocks needs_review then inactive; dashboard sorts loaded rows on Unknown only | CONFORMS | app/src/lib/unknownQueue.ts:188-191; dashboard inboxListMerge.ts:69-74; useInbox.ts:175-177, :746. Pinned unknownQueue.test.ts:46, :286; inboxListMerge.test.ts:299; useInbox.test.tsx:1451 |
| D9 superseded 2026-08-26 ruling comments updated | CONFORMS | inbox.ts:2307-2327 (SUPERSEDED paragraph, cites sortForFilter and compareUnknownTabRows); useInbox.ts:150-174 |
| D9 flip watch item; pre-deploy cursor 400 once | CONFORMS | docs/issues/unknown-queue-status-flip-duplicates-across-pages.md:31-46; pinned inboxUnknownTab.test.ts:351-366 |
| D10 no new free text | CONFORMS | no new input anywhere in the diff |

## 2. Spec section 5 tests 1-8

| Test | Verdict | Evidence |
|---|---|---|
| 1 allowlists, D6 refusals, both create defaults | CONFORMS | rows D1, D6 above (unmatched email cannot create unknown: AR23) |
| 2 transition route: Inactive for 3 types, manual source, audit, typed label, 409 on concurrent re-type, notify | PARTIAL | transitionRoutes.test.ts:299, :327, :351; statusTransition.test.ts:413-499. The 409 is pinned only for a re-type that lands BEFORE the service's own read; the conditional write itself is unpinned (finding 1, proven by mutant M1) |
| 3 type change from Inactive, non-Inactive unchanged, same-type PATCH, new-type label | CONFORMS | contactTriage.test.ts:1249-1354; caseworkerConversion.test.ts:1009 |
| 4 Today | CONFORMS | todayApi.test.ts:1020 (Inactive unknown), :1049 (Inactive team member, OR-6), Needs review / Active team member PINs, :1057 (Inactive tenant in Unreplied), :1076 (101 ahead of the cap) |
| 5 inbox | CONFORMS | inboxInactive.test.ts:110-190 (All/Unread/Unknown, tenant, caseworker, team member, contactless); block order unknownQueue.test.ts; inbound tests above |
| 6 Follow up / listing-send | CONFORMS | listingSendOutcome.test.ts:193-211 (old pin flipped), followUps.test.ts:185, listingSendsApi.test.ts:549 |
| 7 dashboard | CONFORMS | ContactDetail.test.tsx:535-605; ContactEditForm.test.tsx:448, :1597-1900; contactStatusMirror.test.ts; useInbox.test.tsx:1451; InboxRow.test.tsx:349; UnknownFile.test.tsx:238. Beyond the list: finding 2 |
| 8 e2e | CONFORMS | e2e/tests/dashboard-next/unknown-inactive.spec.ts (steps 1-10; live Today drop with a no-reload flag; red1/red2/red3 recorded in S6); passed in battery-1 |

## 3. Work map S1-S6

| Slice | Verdict | Evidence |
|---|---|---|
| S1 status model + writers | CONFORMS | e7724e4e..66a850cf; rows D1, D4.5, D6, D7; seeds performance.ts:551-557, history.ts:215-232, :469-471; partition fake comment; contactsRepo.ts:118-131 |
| S2 transition + live notify | CONFORMS | e93c49ab..940c1313; rows D2; OR-3/4/5 below |
| S3 backend readers | CONFORMS | c6ec169b..c3044ed1; rows D4.1, D5, D9 |
| S4 dashboard contact page | CONFORMS | 4138acf0..f6c1c495; rows D2, D3, D4.4, D8; OR-1 |
| S5 dashboard inbox | CONFORMS | f06257d6..aedbc481; row D9 |
| S6 e2e + docs + W3 | CONFORMS | 5809b2ad, 8152f3bf, 6e0b23d9; documentation/STATUS-MODEL.md section 5b, GLOSSARY.md Inactive entry |

(S7 - final sync, gates, gate report - is outside this review; battery-1
above is its gate run. main has not moved, so no sync is owed.)

## 4. Watch items with a build-side record

| Item | Verdict | Evidence |
|---|---|---|
| W1 #31 overlap | CONFORMS | S3-report W1 line; re-checked now: no #31 branch or worktree (branches flyer-leads, property-requirements, unknown-inactive, main). S7 re-check still to be written |
| W2 flip issue reopen trigger | CONFORMS | issue body :31-46 (OR-14 text); not met on recorded counts |
| W3 Today fallback | CONFORMS | S6-report W3; buildToday.ts unchanged |
| W4 inbound writers | CONFORMS | S3-report W4 writer list; two tests |
| W5 audience + extraction | CONFORMS | S3-report W5; audienceResolution.ts diff is comment only |
| W6 lean byte-stability | CONFORMS | S1-report W6; seedContactTypeInvariants.test.ts (new describe); full e2e green |
| W7 rollout re-count | N/A | planner/human, not the builder |
| W8 live drop over eventual reads | CONFORMS | S2-report W8 paragraph (today.ts:870, :362, unknownQueue.ts:350) |

## 5. Planner rulings AR1-AR24

| Ruling | Verdict | Evidence |
|---|---|---|
| AR1 constants, statusLabelFor, import-free | CONFORMS | statusModel.ts:196-251; the file has no import statement |
| AR2 dashboard mirror + drift guard | CONFORMS | types.ts:812-869; contactStatusMirror.test.ts (finding INFO-c on the label helper's return type) |
| AR3 contact.updated end to end, two emitters, subscribers | CONFORMS | events.ts (AppEventMap + ALL_APP_EVENTS); api.ts SSE; services/statusTransition.ts:678; contacts.ts:2207-2213; useToday.ts:156, useInbox.ts:591, useContact.ts:90; bridge unchanged (eventBridge.test.ts, internalRoute.test.ts) |
| AR4 conditional transition write, ContactTypeChangedError, 409 | CONFORMS (code) | services/statusTransition.ts:223-228, :647-664; routes/statusTransition.ts:292, :346-350. Pin gap: finding 1 |
| AR5 wire field + needsTriage rule | CONFORMS | inbox.ts:133-138, :1127-1129 |
| AR6 compareUnknownTabRows, Unknown only | CONFORMS | inboxListMerge.ts:69-74; useInbox.ts:175-177 |
| AR7 copy and muted style | CONFORMS | InboxRow.tsx:137; UnknownFile.tsx:104 |
| AR8 Today skip placement | CONFORMS | today.ts:763-769 |
| AR9 header for every non-deleted contact; 409 shows the error and refetches | CONFORMS | ContactDetail.tsx:960-975 (consistent re-read) |
| AR10 D7 code shape | CONFORMS | contacts.ts:1766, :1797-1810 |
| AR11 same-type regression is a real RED | CONFORMS | contactTriage.test.ts:1290 |
| AR12 e2e builds its own state | CONFORMS | spec builds two contacts from inbound texts; no lean-seed edit |
| AR13 docs | CONFORMS | STATUS-MODEL.md section 5b; GLOSSARY.md waiting-on-a-reply and Inactive entries |
| AR14 docs/issues edits only to described behavior | CONFORMS | only contacts-status-filter-tenants-only.md (OR-1) and the W2 issue body |
| AR15 names | CONFORMS | sortForFilter, compareByActivity, compareUnknownTabRows; no sortByActivity in code |
| AR16 priorType | CONFORMS | contacts.ts:1655 (one declaration) |
| AR17 fixture flips in S1.1 | CONFORMS | unknownQueue.test.ts, inboxUnknownTab.test.ts, inboxUnknownParity.test.ts, inbox.integration.test.ts |
| AR18 other (unknown, active) fixtures unchanged | CONFORMS | followUps/listingSendsApi/unitsApiActivity fixtures untouched except new cases |
| AR19 ai-run-log record + pin | CONFORMS | S1-report AR19; S6 green2 9/9; battery-1 green |
| AR20 accessible names | CONFORMS | "Contact status", "Type unknown", "Inactive" |
| AR21 list rows plain text | CONFORMS | ContactsList.tsx:100-103, :178-182; default stands (intent.md:17-18) |
| AR22 ASCII arrow constant | CONFORMS | contacts.ts:431, :2188; statusTransition.ts keeps its two six-character u2192 escape sequences in source, backslash-u-2192 (:181, :301; `grep -c u2192` prints 2) |
| AR23 unmatched email comment only | CONFORMS | unmatchedEmail.ts:455-461 |
| AR24 'contact triaged' log untouched, emit after it | CONFORMS | contacts.ts:2194-2197 then :2207-2213 |

## 6. Orchestrator worklist OR-1..OR-22

| Item | Verdict | Evidence |
|---|---|---|
| OR-1 Contacts > Unknown lists Inactive last | CONFORMS | ContactsList.tsx:105-113, :280, :288 deps; ContactsList.test.tsx:217 (RED) + PIN; e2e step 6; issue body :21-25. Scope note: finding 5 |
| OR-2 copy reads for the label tests | CONFORMS | contactTriage.test.ts:1242-1246, :1333-1347 |
| OR-3 status-only PATCH consistent read + type fence | CONFORMS | contacts.ts:1637-1643, :1686-1692, :1974; tests contactTriage.test.ts:1154, :1164, :1197 |
| OR-4 timeline refetch on own contact.updated | CONFORMS | useContactTimeline.ts:548-550; useContactTimeline.test.tsx:240 (RED) and the other-contact PIN |
| OR-5 latest-wins re-read | CONFORMS | useContact.ts:74-91; useContact.test.tsx:147 |
| OR-6 Inactive team member Today case | CONFORMS | todayApi.test.ts:1049 |
| OR-7 deleted + inactive row shows both | CONFORMS | InboxRow.test.tsx:383; server side inbox.ts:1128-1129 |
| OR-8 unknownQueue.test.ts comment | CONFORMS | unknownQueue.test.ts:199-200 |
| OR-9 history.ts:215 ASCII line | CONFORMS | history.ts:215 |
| OR-10 contacts.ts create comment | CONFORMS | contacts.ts:994-995 |
| OR-11 partition-fake test comment | CONFORMS | contactsPartitionFake.test.ts:96-103 |
| OR-12 audienceResolution comment | CONFORMS | audienceResolution.ts:84-85 |
| OR-13 inbox.ts cites sortForFilter | CONFORMS | inbox.ts:2309 |
| OR-14 W2 wording | CONFORMS | issue :31-46 (cites unknownQueue.ts:67-68, the moved lines) |
| OR-15 American spelling | CONFORMS | case-insensitive grep of all added lines for colour/labelled/behaviour/favour/organis/cancelled: 0 |
| OR-16 team member leaves Needs you now; tenant/partner in Unreplied | CONFORMS | STATUS-MODEL.md section 5b second difference; GLOSSARY.md:708-729 (:718-722) |
| OR-17 Unknown-feed unread poll | CONFORMS | unknown-inactive.spec.ts step 8 |
| OR-18 stack-free check before each run | CONFORMS (record) | S6-report OR-18 (process; not re-verifiable from the tree) |
| OR-19 Inbox.tsx header | CONFORMS | Inbox.tsx:1-11 |
| OR-20 ASCII added lines vs 916258ae | CONFORMS | reviewer re-ran: 0 non-ASCII bytes over every added line in app/, dashboard/, e2e/, documentation/, docs/issues/; the three new files 0 |
| OR-21 lint expectations | CONFORMS | reviewer re-ran gate 5: only the pre-existing ContactsList.tsx:219 error (base :208) |
| OR-22 staged-index check | CONFORMS (record) | each slice report; tree clean at HEAD |
| Section D record-only lines | CONFORMS | S1 item 3, S2 record lines, S3 W4/W5 lines, S4 record lines all present |

## 7. Findings

### 1. MEDIUM - the transition service's conditional write is unpinned in its own read-to-write window

- Where: app/src/services/statusTransition.ts:647-652 (the `expect` clause on
  `type`); tests app/test/statusTransition.test.ts:413-499 and
  app/test/transitionRoutes.test.ts:351.
- Rule: spec D2 "The route's write is conditioned on the stored type being
  unchanged since the check"; AR4 names the conditional write; spec test 2.
- What the tests actually pin: every re-type they stage is already visible
  when setTenantStatus does its OWN read (the route test mutates the stored
  record during the route's read; the service test seeds the landlord type up
  front). No test lands a re-type between the service's read and its update,
  and none asserts the `expect` option on that update. The "(PIN) without
  expectedType the write is guarded on the type the setter read" case
  (statusTransition.test.ts:479) asserts only that the write succeeds.
- Proof: mutant M1 (a scratch copy of the service, swapped in for every
  `../services/` and `../src/services/` importer by a throwaway
  resolve.alias config; a canary copy that throws in setTenantStatus failed
  31 of 103 tests under the same config, so the alias took effect) replaces
  the conditional update with a read-time compare
  (`if (contact.type !== expectedType) throw ...`) plus an UNCONDITIONED
  update. statusTransition.test.ts + transitionRoutes.test.ts: 103/103 pass
  under M1. A throwaway probe that re-types the stored record inside the
  update call (after the service's read) passes on the real code and fails
  under M1 ("promise resolved instead of rejecting"; (landlord, inactive)
  stored). Probe deleted afterwards.
- Why it matters: a refactor that "simplifies" the guard to a comparison on
  the read it already holds would pass the whole suite and reopen the race
  for the service-read-to-write window - storing exactly the illegal pair D2
  exists to prevent.
- Fix: add to statusTransition.test.ts's AR4 describe a case that spies
  `contactsRepo.update` to set the stored contact's type to `landlord` before
  delegating to the real update, and expects ContactTypeChangedError, the
  stored record still (landlord, needs_review), no audit, no milestone and no
  contact.updated. Optionally also assert `expectClausesOf(opts)` on that
  update contains `{ attr: 'type', value: 'unknown' }`. Rename the
  statusTransition.test.ts:479 PIN or make it assert the guard.

### 2. LOW - tenant-target save also calls setTenantStatus when porting changed (spec says ONLY off Onboarding), and that branch is unpinned

- Where: dashboard/src/routes/contact/ContactEditForm.tsx:522-527
  (`typeChanged ? isTenant && (status !== 'onboarding' || portingChanged)`).
- Spec D3: "The form calls `setTenantStatus` afterwards ONLY if the shown
  status is not Onboarding". The build adds the porting case (plan S4.4
  clarification 3; porting is writable only through setTenantStatus). With
  Onboarding kept it writes no second milestone (S4-report records why), but
  it does write a second tenant_status_changed audit row (onboarding ->
  onboarding), stamps status_source 'manual', and emits a second
  contact.updated. The deviation is reported by S4 but never put to the spec.
- Unpinned: no ContactEditForm test toggles porting during a type change (the
  only type-change test that names porting passes `porting: false` with a
  non-Onboarding status, ContactEditForm.test.tsx:1748). Dropping
  `|| portingChanged` would silently discard a porting tick made in a
  retype-to-tenant save.
- Fix: add a test - retype to Tenant, tick Porting, keep Onboarding, save -> one
  PATCH `{ type: 'tenant' }` then exactly one setTenantStatus
  `{ toStatus: 'onboarding', source: 'manual', porting: true }`. Record the
  spec deviation for the planner (or amend D3's wording).

### 3. LOW - a status change that commits but whose audit append fails notifies nobody

- Where: services/statusTransition.ts:666-670 then :678 (the emit sits after
  the required audit; StatusTransitionCommittedError skips it); same class in
  the PATCH, contacts.ts:2207-2213 follows non-best-effort awaits.
- Spec D2: "The notify fires for EVERY status change". On this path the
  status IS changed (the write committed; the route answers 500), but open
  Today/Inbox pages are not told, so the Today row stays until an unrelated
  event. The build pins the opposite on purpose (statusTransition.test.ts:492)
  under AR3's "every successful call" reading; S2-report records it.
- Fix (planner call): either emit right after the committed write (before the
  audit), or record the exception in spec D2 / STATUS-MODEL so the pin
  matches the contract.

### 4. LOW - STATUS-MODEL says every writer refuses (unknown, active); the importer's preserved-status re-type does not, and the cited issue does not describe it

- Where: documentation/STATUS-MODEL.md:248-249; app/src/lib/import/apply.ts:1142-1146
  (preserveStatus), :1165-1166 (writes `#type`), :1218-1223 (skips the status SET).
- A re-import that re-types a contact whose status staff set keeps that
  status, so it can still store (unknown, active) or (landlord, inactive).
  Spec section 3 scopes the importer gap out, but
  docs/issues/import-bypasses-contact-type-rules.md names no (type, status)
  pair shape, so the doc's pointer does not cover the claim. The WORKLIST
  section D planner call (append it to that issue) is still open.
- Fix: planner appends the pair shape to the issue (with apply.ts lines), or
  the STATUS-MODEL sentence says "every status writer except the importer's
  status-preserving re-type (filed ...)".

### 5. LOW - OR-1 (Contacts > Unknown lists Inactive last) is a scope addition beyond the approved spec

- Where: dashboard/src/routes/contacts/ContactsList.tsx:105-113, :280; now also
  stated as product behavior in STATUS-MODEL.md:271-272, GLOSSARY.md:720-721,
  docs/issues/contacts-status-filter-tenants-only.md:21-25, and asserted by
  e2e step 6.
- The spec orders only the inbox Unknown tab; OR-1 is an orchestrator ruling
  marked "reversible; surfaced for Cameron in the handback". The rationale is
  sound (byTypeStatus answers ascending, so 'inactive' would list first), but
  it is not yet Cameron's decision.
- Fix: put it to Cameron in the handback. If reversed, revert the helper and
  the three doc sentences and drop e2e step 6's order assertion together.

### 6. INFO - findings recorded for completeness (no action required unless noted)

- a. Vendor SDK import in a service: services/statusTransition.ts:14 imports
  ConditionalCheckFailedException from @aws-sdk/client-dynamodb against
  AGENTS.md "Vendor SDK imports belong in app/src/adapters"; precedent
  services/caseworkerConversion.ts:12; S2-report records it.
- b. The edit form's own partner/team member/unknown status write maps a
  409 contact_type_changed to the generic "Couldn't save - please try again."
  (ContactEditForm.tsx:576); S4-report offers the planner a sentence.
- c. AR2 detail: dashboard contactStatusLabelFor returns `string | undefined`
  (types.ts:864) where the app's statusLabelFor returns the raw status; the
  mirror test compares on-list values only, which is correct for both.
- d. The resolved issue docs/issues/unknown-queue-cap-starves-needs-review.md
  keeps a reopen trigger on the `(unknown, active)` count (:131-141), now
  structurally 0; the reviewed-but-untyped class is (unknown, inactive). S1
  left it as a planner call.
- e. The inbox half of D2's observable rule (an OPEN inbox shows the tag
  without a reload) is pinned piecewise (server emit, SSE frame test,
  provider dispatch, useInbox.test.tsx:314) but not end to end; the e2e opens
  the inbox after the change. Today's half is e2e-pinned live.
- f. Fixture spacing nits from the mechanical flip: app/test/inboxUnknownTab.test.ts:212-214,
  :694-695 (`'inactive',14`).
- g. Stale refs: contacts-status-filter-tenants-only.md frontmatter and body
  cite ContactsList.tsx:217 (now :228); ContactEditForm.tsx:194 "see the
  effect below" (no effect); test names ContactEditForm.test.tsx:333, :403
  (S4-report records all three).
- h. W1's S7 re-check and the S7 gate report are not written yet (battery-1
  is the gate run; main has not moved).
- i. During this review the worktree briefly held five untracked zz-review
  probes this reviewer did NOT create (presumably parallel reviewers':
  zz-review-asymmetric-fence, -conversion-no-event, -stale-client-status
  under app/test/, -editform-stale-type and -useContact-initial under
  dashboard/src/routes/contact/). They were left untouched and were gone by
  the final `git status`. This reviewer's own probe
  (app/test/zz-review-transition-window.test.ts) is deleted; the only
  untracked path left by this review is this report.
