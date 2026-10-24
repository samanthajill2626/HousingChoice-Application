# Planner spec-conformance review - feat/unknown-inactive

Reviewer: independent spec-conformance reviewer dispatched by the planner (not the builder).
Contract: `docs/superpowers/specs/2026-10-23-unknown-inactive-design.md` rev 3.
Code reviewed: `git diff 916258ae..798de475 -- app dashboard e2e documentation docs/issues`
(798de475 = the gated code commit). Read-only pass: no test suite, e2e, dev server or npm
command was run. Every row below is verified in CODE (render sites included), not in comments,
records or test names; test rows cite the test that exists, not its result.
The handback's DEVIATIONS list was read only after this pass (section 4).

Line numbers are at 798de475.

## 1. Conformance table

### Goals

| # | Item | Verdict | Evidence |
|---|---|---|---|
| G1 | Unknown contact can be marked Inactive without a type; stays on Contacts, inbox, threads; not deleted | CONFORMS | `app/src/lib/statusModel.ts:214` (UNKNOWN_STATUSES has inactive); header pill renders for unknown `dashboard/src/routes/contact/ContactDetail.tsx:1048-1057`; Contacts list reads every page `dashboard/src/routes/contacts/useContacts.ts:6-10`; Unknown tab block `app/src/lib/unknownQueue.ts:190-193` |
| G2 | Every type has an inactive-type status | CONFORMS | tenant (unchanged), landlord Parked (unchanged), partner/team_member `statusModel.ts:196`, unknown `statusModel.ts:214` |
| G3 | One header dropdown; edit form offers the same choices | CONFORMS | both call `statusOptionsFor` (`dashboard/src/api/types.ts:857`): header `ContactDetail.tsx:1051`, form `ContactEditForm.tsx:651` |
| G4 | Inactive means the same for every type | CONFORMS (one stated narrowing, see F1) | eligibility `app/src/lib/listingSendOutcome.ts:119`; tone `dashboard/src/ui/StatusBadge.tsx:123`; tag any type `app/src/routes/inbox.ts:1142`; chip `inbox.ts:1140` |

### D1 - status lists

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D1.1 | tenant list unchanged | CONFORMS | statusModel.ts diff does not touch TENANT_STATUSES |
| D1.2 | landlord list unchanged | CONFORMS | LANDLORD_STATUSES untouched |
| D1.3 | partner + team_member = needs_review, active, inactive | CONFORMS | `statusModel.ts:196`; `statusAllowlistFor` returns it for any other type `statusModel.ts:234-239` |
| D1.4 | unknown = needs_review, inactive (Active removed) | CONFORMS | `statusModel.ts:214`, `:238` |
| D1.5 | NON_TENANT_STATUSES split; statusAllowlistFor single source for writers and readers | CONFORMS | no NON_TENANT_STATUSES left in app/src or dashboard/src (grep); callers: create `contacts.ts:914`, triage parse `:631`, list read `:1141`, status-only PATCH `:1711`, normalize `:1803`, route `statusTransition.ts:316`, AI accept `suggestionResolution.ts:298`, import `lib/import/apply.ts:972` |
| D1.6 | Parked untouched; rules key on literal `inactive` | CONFORMS | `listingSendOutcome.ts:119`, `inbox.ts:1140,1142`, `today.ts:776`, `StatusBadge.tsx:123`, `ContactsList.tsx:111` all compare `=== 'inactive'` |
| D1.7 | Labels "Needs review/Active/Inactive" held in the status model | CONFORMS | `statusModel.ts:200-204`, `:218-221`; `statusLabelFor` `:247`; dashboard mirror `types.ts:819-835` |

### D2 - header dropdown

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D2.1 | Dropdown for EVERY live type with that type's D1 statuses | CONFORMS | `ContactDetail.tsx:1048-1057` (no type gate; `statusOptionsFor(contact.type)`) |
| D2.2 | Soft-deleted keeps display-only badge | CONFORMS | `ContactDetail.tsx:1058-1059` |
| D2.3 | Same route `/tenant-status`, validated against stored type; no reason prompt | CONFORMS | `ContactDetail.tsx:963-973` calls `setTenantStatus` with source manual, no reason; route allowlist `statusTransition.ts:316-319` |
| D2.4 | team_member (TenantFile) dropdown lists team_member statuses | CONFORMS | header is type-generic, `statusOptionsFor('team_member')` -> PARTNER list (`types.ts:846-850`) |
| D2.5 | Route write conditioned on stored type; mismatch 409, nothing written | CONFORMS | route passes `expectedType: stored.type` (`routes/statusTransition.ts:326-329`); service conditional write `services/statusTransition.ts:647-664`; 409 mapping `routes/statusTransition.ts:383-387` |
| D2.6 | Every status change notifies open Today and Inbox, named or not, threads or not | CONFORMS | emit on every successful setTenantStatus `services/statusTransition.ts:678`; SSE wiring `routes/api.ts` (contact.updated listener); dashboard dispatch `EventStreamProvider.tsx` contact.updated listener; Today `useToday.ts:156`; Inbox `useInbox.ts:591`; also PATCH `contacts.ts:2219-2228` and conversion `caseworkerConversion.ts:575` |

### D3 - edit form

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D3.1 | Form Status lists exactly the D1 list for the type; no form-local list | CONFORMS | local lists removed; `validStatusesForType` and options both via `statusOptionsFor` (`ContactEditForm.tsx:31-33`, `:651`) |
| D3.2 | Inactive caseworker DISPLAYED as Inactive | CONFORMS | `defaultStatusForType` keeps a legal stored value (`ContactEditForm.tsx:39-41`); PARTNER list contains inactive |
| D3.3 | Shared dashboard module mirrored from backend + mirror test | CONFORMS | `dashboard/src/api/types.ts:813-866`; `dashboard/src/routes/contact/contactStatusMirror.test.ts` imports `app/src/lib/statusModel.ts` and compares lists, labels and `statusOptionsFor` against `statusAllowlistFor` |
| D3.4 | Type change measured against STORED type; role-only switch and change-and-back are not type changes; no status written | CONFORMS | `typeChanged` vs `base.type` (`ContactEditForm.tsx:207`); change-and-back resets to `initialStatus` (`:306`); PATCH status only when `typeChanged` or landlord status changed (`:374-378`); no transition write when unchanged (`:560-564`) |
| D3.5 | On type change field moves to new type's first step (tenant Onboarding, landlord Interested, partner Active, team_member Active, unknown Needs review) | CONFORMS | `FIRST_STATUS_FOR_TYPE` `ContactEditForm.tsx:46-52`, applied `:305-308` |
| D3.6 | Non-tenant target: PATCH carries shown status explicitly; server honors it | CONFORMS | `ContactEditForm.tsx:374-375`; server skips auto-advance and normalize when `'status' in patch` (`contacts.ts:1769`, `:1791`) and validates against the body type (`contacts.ts:629-633`) |
| D3.7 | Tenant target: PATCH never carries status; server auto-advances; follow-up setTenantStatus ONLY if shown status is not Onboarding | DEVIATES (accepted, deviation 4) | `ContactEditForm.tsx:560-561` also calls it when porting changed; see section 4 |
| D3.8 | Tenant + landlord with no type change: unchanged; landlord status rides the PATCH with park reason | CONFORMS | tenant `:562-563` (status or porting -> setTenantStatus, as before); landlord `:376-377` in PATCH, `park_reason` in same PATCH `:400` |
| D3.9 | partner/team_member/unknown with no type change: status via the transition route | CONFORMS | `ContactEditForm.tsx:564` (`!isLandlord && status !== initialStatus`) -> `setTenantStatus` `:584-597` |
| D3.10 | Any save that changes the type: the PATCH path | CONFORMS | `:374-375` + tenant arm above |

### D4 - meaning of Inactive

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D4.1 | `isEligibleRecipient` drops any `inactive`; placed tenant-only; old pin flips | CONFORMS | `listingSendOutcome.ts:119-120`; `app/test/listingSendOutcome.test.ts` old case flipped; consumers followUps/units unchanged and covered by `app/test/followUps.test.ts`, `app/test/listingSendsApi.test.ts` |
| D4.2 | Blasts unchanged | CONFORMS | no blast/audience code changed (`audienceResolution.ts` comment only) |
| D4.3 | Shown as any other contact | CONFORMS | no list/search/thread filter added |
| D4.4 | Same muted tone | CONFORMS | `StatusBadge.tsx:123`; tenant inactive already muted `StatusBadge.tsx:30` |
| D4.5 | Timeline label from the type AFTER the write | CONFORMS | PATCH `contacts.ts:2198-2203` (new type when present); transition `services/statusTransition.ts:181`, `:301`; conversion `caseworkerConversion.ts:418` |
| D4.6 | Automatic texts NOT changed | CONFORMS | no tour-reminder, group roster, missed-call, nudge or share-recipient file in the diff |

### D5 - Today

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D5.1 | Triage pass unchanged (reads only unknown, needs_review) | CONFORMS | today.ts triage pass untouched |
| D5.2 | Skip an unread `unknown_1to1` thread whose contact is `inactive` | DEVIATES (narrowed, deviation 3) | `today.ts:773-781` skips only when the owner's type is `unknown` or `team_member`; see F1 and section 4 |
| D5.3 | Skip in the COLLECT loop beside the deleted skip, ahead of the cap, memoized read | CONFORMS | `today.ts:748-781`, before `unreadOneToOne.push` and the `TODAY_UNREAD_CAP` break (`:782-787`); `getContact` memoized |
| D5.4 | "Skip Inactive", not "keep needs_review"; Active team member unchanged; unresolved contact unchanged | CONFORMS | predicate is `status === 'inactive'`; `owner` undefined is not skipped (`today.ts:775-777`) |
| D5.5 | Unreplied unchanged for Inactive tenant/caseworker | CONFORMS | skip limited to `unknown_1to1`; typed threads go to the Unreplied arm `today.ts:~836-845` |
| D5.6 | Dashboard Today fallback unchanged | CONFORMS | `dashboard/src/routes/today/buildToday.ts` not in diff |
| D5.7 | Only Today change | CONFORMS | today.ts diff is this one block |
| D5.8 | Open Today page drops the row live | CONFORMS | `useToday.ts:156`; e2e `e2e/tests/dashboard-next/unknown-inactive.spec.ts:252-253` (second page, no reload) |

### D6 - (unknown, active) refused

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D6.1 | status-only PATCH 400 | CONFORMS | `contacts.ts:1706-1715` |
| D6.2 | transition route 400 | CONFORMS | `routes/statusTransition.ts:316-319` |
| D6.3 | create with explicit status 400 | CONFORMS | `contacts.ts:912-918` |
| D6.4 | AI status accept refused (409 non-tenant, unchanged) | CONFORMS | `suggestionResolution.ts` unchanged; pinned in `app/test/suggestionReclassification.test.ts` |
| D6.5 | import falls back to Needs review with a warning | PARTIAL | row path `lib/import/apply.ts:972-999` conforms; a re-import that re-types a contact whose status staff set keeps it unchecked (`apply.ts:1142-1146`, `:1218`) - see F4 (out of scope per spec section 3, but not in the issue file) |
| D6.6 | list read `type=unknown&status=active` 400 | CONFORMS | `contacts.ts:1138-1145` |
| D6.7 | POST create with no status: unknown defaults to needs_review | CONFORMS | `contacts.ts:1014-1023` |
| D6.8 | unmatchedEmail duplicate default "does the same" | CONFORMS (vacuous) | `routes/unmatchedEmail.ts:73` CREATE_CONTACT_TYPES excludes unknown, so the path cannot mint one; comment corrected `:455-461` |
| D6.9 | normalize fallback maps illegal status to unknown -> Needs review | CONFORMS | `contacts.ts:1805-1813` |

### D7 - type change from Inactive

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D7.1 | tenant -> Onboarding, landlord -> Interested, partner -> Active (auto-advance), conversion -> Active | CONFORMS | `contacts.ts:1769-1772`; `caseworkerConversion.ts` unchanged write |
| D7.2 | FROM Inactive: team_member -> Active, unknown -> Needs review; other stored statuses keep today's behavior | CONFORMS | `contacts.ts:1801-1813` (`stored.status === 'inactive' \|\| !legal`) |
| D7.3 | Same-type PATCH: BOTH auto-advance and normalize run only on a real type change | CONFORMS | `contacts.ts:1769` (`newType !== stored?.type`), `:1802`, `:1814` |

### D8 - unknown contact page

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D8.1 | "Needs triage" only while Needs review; "Type unknown" for Inactive; Mark as buttons and body copy kept | CONFORMS | `dashboard/src/routes/contact/UnknownFile.tsx:104` (body and buttons unchanged); e2e `unknown-inactive.spec.ts:246-248` |

### D9 - inbox

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D9.1 | Inactive contact's texts/calls show, unread when unread; no inbound writer resets status (test for text and call) | CONFORMS | no inbound writer in the diff; tests `app/test/twilioSmsWebhook.test.ts` (text), `app/test/internalRoute.test.ts` (call); e2e `unknown-inactive.spec.ts:314-333` |
| D9.2 | AI extraction unchanged | CONFORMS | `jobs/extraction.ts` not in diff |
| D9.3 | `needsTriage` false for an `inactive` contact, else today's rule | CONFORMS | `inbox.ts:1140` (single contact-row builder, used at `:1270`, `:1526`, `:2298`); contactless rows keep `true` (`:1200`, `:1591`) |
| D9.4 | Muted "Inactive" tag, any type, any tab; wire field | CONFORMS | wire `inbox.ts:138`, set `:1142`; render `dashboard/src/routes/inbox/InboxRow.tsx:137`; muted CSS `InboxRow.module.css` `.inactiveTag` |
| D9.5 | Server block order Needs review then Inactive; Active block removed | CONFORMS | `unknownQueue.ts:190-193`, blocks derived `:214-220` |
| D9.6 | Unknown tab ONLY: Needs review first, then Inactive, each newest first; other tabs newest-first | CONFORMS | `inboxListMerge.ts:69-74`; applied at render `useInbox.ts:175-177`, `:746` |
| D9.7 | Superseded 2026-08-26 ruling comment updated in inbox.ts and useInbox.ts | CONFORMS | `inbox.ts:2325-2339`; `useInbox.ts:150-174` |
| D9.8 | Watch item flip-duplicates issue re-read | CONFORMS | `docs/issues/unknown-queue-status-flip-duplicates-across-pages.md` updated; inbox.ts comment `:2048-2059` |
| D9.9 | Old cursor may 400 once | CONFORMS (as specified) | documented `unknownQueue.ts:76-82` |

### D10, scope, surfaces, rollout

| # | Item | Verdict | Evidence |
|---|---|---|---|
| D10 | No new free-text input | CONFORMS | none added (409 copy is fixed text) |
| OOS | Nothing out-of-scope built (filters, server ordering, auto-text checks, AI suppression, Today button/reorder, partner/team active removal, Parked) | CONFORMS, with one addition | the Contacts > Unknown ordering (`ContactsList.tsx:111-113`, `:280`) is beyond the spec but is ordering, not a status filter (F2) |
| S-docs | STATUS-MODEL new section; GLOSSARY Inactive + waiting on a reply; contactsRepo comment | CONFORMS | `documentation/STATUS-MODEL.md` section 5b; `documentation/GLOSSARY.md` Inactive + waiting-on-a-reply entries; `app/src/repos/contactsRepo.ts:119-127` |
| S-seeds | performance alternates needs_review/inactive; history branches Inactive off needs_review; unknown trail never passes active | CONFORMS | `lib/seed/performance.ts:556`; `lib/seed/history.ts:215-228`, `:469-472`; invariants pinned `app/test/seedContactTypeInvariants.test.ts` |
| S-fake | test fake updated | CONFORMS | `app/test/helpers/contactsPartitionFake.ts` |
| S-filed | `contacts-status-filter-tenants-only.md` filed | CONFORMS | `docs/issues/contacts-status-filter-tenants-only.md` |
| R1 | No Terraform, no new GSI | CONFORMS | no infra path in `git diff --stat` |

### Section 5 tests

| # | Test item | Verdict | Evidence (test file) |
|---|---|---|---|
| T1 | allowlists exact; (unknown, active) refused per path; unknown create default | CONFORMS | `app/test/statusModel.test.ts`, `contactTriage.test.ts` ("per-type status lists", "unknown create default"), `transitionRoutes.test.ts` ("REJECTS active for an unknown"), `importApply.integration.test.ts`, `suggestionReclassification.test.ts`. The unmatchedEmail create path cannot create unknown (D6.8), so "both create paths" is vacuous there |
| T2 | transition accepts Inactive for partner/tm/unknown, manual source, audit, typed label; concurrent re-type 409; notify | CONFORMS | `transitionRoutes.test.ts` "every contact type: Inactive, the conditional write, contact.updated"; `statusTransition.test.ts` |
| T3 | type change from Inactive (6 targets); non-Inactive unchanged; same-type PATCH; new-type label | CONFORMS | `contactTriage.test.ts` "type change from Inactive and same-type PATCH"; `caseworkerConversion.test.ts` "make from an Inactive contact" |
| T4 | Today: Inactive unknown off; Needs review on; Active team member on; Inactive tenant in Unreplied; 100+ cap | CONFORMS | `app/test/todayApi.test.ts` "unknown-inactive D5" block |
| T5 | Inbox: All/Unread/Unknown; needsTriage false; inactive field (tenant, caseworker too); block order; inbound text + call keep Inactive | CONFORMS | `app/test/inboxInactive.test.ts`, `unknownQueue.test.ts`, `inboxUnknownTab.test.ts`, `twilioSmsWebhook.test.ts`, `internalRoute.test.ts` |
| T6 | Follow up / listing-send: Inactive caseworker ineligible, Active eligible, Parked unchanged | CONFORMS | `followUps.test.ts`, `listingSendOutcome.test.ts`, `listingSendsApi.test.ts` |
| T7 | Dashboard: header for partner/tm/unknown; form options = header; Inactive caseworker shown and kept; type-change first step + tenant one milestone; role-only and change-and-back; park reason; mirror; Unknown sort; tag; card title | CONFORMS | `ContactDetail.test.tsx`, `ContactEditForm.test.tsx`, `contactStatusMirror.test.ts`, `useInbox.test.tsx`, `inboxListMerge.test.ts`, `InboxRow.test.tsx`, `UnknownFile.test.tsx` |
| T8 | e2e: header -> Inactive; off Needs you now; on Contacts Unknown; Unknown tab below Needs review with tag; new inbound unread and not back on Today; still Inactive; own state | CONFORMS | `e2e/tests/dashboard-next/unknown-inactive.spec.ts:206-336`; builds state via inbound webhook after reseed (`:183-186`), no lean-seed contact |

### Must-stay-unchanged checks

| Item | Verdict | Evidence |
|---|---|---|
| Tenant and landlord status lists | UNCHANGED | statusModel.ts and types.ts diffs do not touch them |
| Automatic texts (tour reminders, group rosters, missed-call auto-text, placement nudges, share recipients) | UNCHANGED | none of those files in the diff |
| AI extraction | UNCHANGED | `jobs/extraction.ts`, extraction services not in the diff |
| Parked landlord behavior | UNCHANGED | no rule keys on `parked`; pinned in `listingSendOutcome.test.ts`, `inboxInactive.test.ts` |

## 2. Counts

82 rows in total, counting the goals, the D-items, the scope/surfaces/rollout rows, the tests
and the must-stay-unchanged checks.
- CONFORMS: 79 (this includes D6.8, which conforms vacuously, and the OOS row, which conforms
  with one addition).
- DEVIATES: 2. D3.7 (porting) and D5.2 (Today skip narrowed). Both are recorded builder
  deviations, and I accept both.
- PARTIAL: 1. D6.5 (the import's re-type preserve path).
- MISSING: 0.

## 3. Findings

F1 - LOW (Cameron should still see it). Spec D5's literal rule is narrowed.
`app/src/routes/today.ts:773-781` skips an Inactive owner's `unknown_1to1` thread only when the
owner's type is `unknown` or `team_member`. Failure scenario: an imported caseworker has the
one-to-one thread the importer minted as `unknown_1to1`. Staff mark the caseworker Inactive,
and the caseworker texts in. Today's Needs you now then shows a "New unknown contact" row for
an Inactive caseworker. The spec text would hide it. This is not a regression: main shows the
same row, and the root cause is already filed as
`docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md`. The narrowing is the
more faithful reading (section 4, deviation 3).

F2 - LOW, beyond the spec. Contacts > Unknown now sorts Inactive rows after the others
(`dashboard/src/routes/contacts/ContactsList.tsx:111-113`, `:280`). The spec never asks for
this, and it is not a status filter, so section 3 does not forbid it. It does not lose data:
`useContacts` walks every page, so a GSI that sorts ascending by status cannot hide the Needs
review rows behind a page boundary. Cameron's call whether to keep it.

F3 - LOW. A type change to tenant with Porting changed and Onboarding kept still calls
`setTenantStatus` (`dashboard/src/routes/contact/ContactEditForm.tsx:560-561`). That call
appends a second audit row (onboarding -> onboarding). It writes no second timeline milestone,
because the plan adds activity only when the status differs
(`app/src/services/statusTransition.ts:178`). So spec D3's observable rule, "the default case
writes one milestone", holds. The extra audit row is the only cost.

F4 - LOW. One writer can still store (unknown, active), and the only record of it is a code
comment (`app/src/lib/statusModel.ts:207-213`). A re-import that re-types a contact whose
status staff set keeps that status unchecked (`app/src/lib/import/apply.ts:1142-1146`,
`:1218-1222`). Failure scenario: an Active partner whose status staff set is re-imported with
type unknown. It is stored as (unknown, active). That pair has no queue block any more, so the
contact silently drops off the inbox Unknown tab (`app/src/lib/unknownQueue.ts:190-193`). That
consequence is new with this branch: on main, (unknown, active) was its own block. Spec section
3 rules the importer's broader type-rule gap out of scope, but
`docs/issues/import-bypasses-contact-type-rules.md` does not mention this case. Suggested fix:
add one sentence to that issue so the importer code fix that is already owed covers it.

F5 - LOW, not a spec item. `app/src/services/statusTransition.ts:14` imports
`ConditionalCheckFailedException` from `@aws-sdk/client-dynamodb` inside a service. That breaks
the letter of the AGENTS.md rule that vendor SDK imports stay in adapters. Six other services
already do the same (caseworkerConversion, emailEvents, groupIdentityFingerprint, poolNumbers,
relayMembers, rosterProvision), so this adds to an existing pattern and starts nothing new.

F6 - INFO. On a contact-triggered head re-read, the inbox shows the new tag or chip only for
rows in the head. `mergeHeadRead` resets the tail on a complete head
(`dashboard/src/routes/inbox/inboxListMerge.ts:132-142`). A row the user loaded through Load
more therefore goes away until the next Load more, and then comes back with the fresh tag. Any
conversation.updated re-read already behaves this way. At the measured queue sizes the Unknown
tab fits on one page. No action needed.

Nothing rated medium, high or blocking.

## 4. Rulings on the builder's deviations (handback section 1)

1. OR-1, Contacts > Unknown lists Inactive after Needs review. ACCEPTABLE. Spec section 3
   rules out status FILTERS on the Unknown view. A sort is not a filter: every contact still
   shows. It fits the intent of D9 ("needs review first") and Goal 3 (one consistent
   treatment). Without it, the GSI's ascending status order would list every Inactive contact
   above every Needs review one, which is the reverse of the inbox. Because the spec did not
   ask for it, Cameron should confirm it (F2).
2. FW1-1, the optional `expectedType` and 409 `contact_type_changed`. ACCEPTABLE. D2 asks for
   a 409 with no write when the type changes between the check and the write. This extends the
   same protection to the window between the client reading the type and sending the request.
   Without it, a form open on an unknown contact could write Inactive onto a contact a colleague
   had just made a tenant. (tenant, inactive) is a legal pair, so only the client's type can
   catch that wrong-intent write. The field is optional, so API callers keep the stored-type
   check alone (`routes/statusTransition.ts:282-317`).
3. FW2-1, the D5 skip limited to unknown and team_member owners. ACCEPTABLE, and the more
   faithful reading. Read literally, D5 would remove an Inactive tenant's or caseworker's
   imported `unknown_1to1` thread from Today entirely: off Needs you now, and never in
   Unreplied, because Unreplied only takes typed threads. That conflicts with the difference
   D4 states on purpose ("An Inactive tenant's unread text shows in Today's Unreplied"). It
   also goes beyond Cameron's quote, which is about unknown contacts. D5's own rationale names
   team_member as the one other type whose threads are `unknown_1to1`, and the narrowed rule
   covers exactly those two types. The leftover symptom is F1.
4. Plan clarification 3, porting on a type change to tenant. ACCEPTABLE. D3's "ONLY if the
   shown status is not Onboarding" exists to keep the default case at one milestone, and it
   still is (F3). Porting can only be written through `setTenantStatus`, so applying "ONLY"
   literally would silently drop a ticked Porting box. That is data loss the spec cannot have
   meant.
5. Extra emitters and fences: OR-3, FW1-3, FW1-4, OR-4/OR-5, FW2-2 + FW3-1. ACCEPTABLE.
   - OR-3 (`contacts.ts:1689-1695`) and FW1-3 (`:1814-1824`) carry D2's "no illegal
     (type, status) pair" fence over to the PATCH paths. Each answers a lost race with the
     existing 409 `contact_changed`, so no new behavior is visible to the user.
   - FW1-4 (`caseworkerConversion.ts:575`) fulfils D2's observable rule ("an open Today page
     drops the row") for the conversion. That path changes status too, and nothing else
     notifies Today for a contact with no threads.
   - OR-4/OR-5 (`useContactTimeline.ts`, `useContact.ts:74-86`) keep the open contact page
     correct under the new event.
   - FW2-2/FW3-1 (`ContactEditForm.tsx:613-621`, `ContactDetail.tsx:943-949`) are UX guards
     behind the 409.
   None of them changes a decision the spec made.
6. The vendor import in services/statusTransition.ts. ACCEPTABLE for this branch. It is not a
   spec item, and the pattern already exists in six services. It belongs in a repo-wide
   cleanup, not in this branch (F5).
