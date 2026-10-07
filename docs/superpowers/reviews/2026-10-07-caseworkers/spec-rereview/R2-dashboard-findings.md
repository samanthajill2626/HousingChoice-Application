# R2 - branch B re-checked against merged branch A: dashboard and e2e findings

- Date: 2026-10-07. Researcher R2 (dashboard + e2e side), read-only.
- Tree: `W:/tmp/caseworkers`, branch `feat/caseworkers` at `a8b66cd6` (the merged
  main, branch A included).
- Scope: the branch B half of
  `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  (D16-D21, section 10, and the "(B)" sentences of D3, D4, D6, D10, section 5.2 and
  section 9) as it lands in `dashboard/src` and `e2e/`. Server code is cited only
  where a dashboard statement depends on it; the `app/` side is another
  researcher's.
- Method: code reading only - no npm, no tests, no servers. Byte-exact quotations
  behind every citation: `.superpowers/sdd/spec-rereview/R2-dashboard-reference.md`
  (gitignored run state).
- Verdicts: **STILL VALID** = the statement matches the merged code (still to build
  as written, or a no-op that is already true); **AMEND** = the merged code makes the
  statement incomplete or differently shaped (amendment text given); **DONE BY A** =
  merged branch A already provides it.

## Summary

34 rows: **20 STILL VALID, 13 AMEND, 1 DONE BY A.**

AMEND rows, one line each:

1. D16-3 - say whether the Unknown triage card gains "Mark as Caseworker"; it is the
   only one-click type-suggestion accept surface and has four fixed actions.
2. D16-4 - define ONE caseworker-role normalizer shared by the KindPicker preset,
   the D18 tab, the D16 canonicalizer and the D19 criteria (all differ today).
3. D16-5 - the KindPicker "Other" placeholder still suggests "Case worker" on a
   tenant/landlord base, minting the records D19 has to clean up.
4. D17-3 - the add step is single-kind end to end (picker noun, NewOrgDialog, POST
   /check close names); D6's "the dialog asks which" needs an organization mode and
   a both-lists check.
5. D17-5 - `OrgUsageCounts` has no key for organization uses; "(B) caseworkers" is
   the wrong label if every partner can hold an organization.
6. D17-6 - Settings "Not on the list" is one-kind-per-field (`kindForField`); the
   resolve body has no `kind` for Add as new on an organization row.
7. D18-1 - decide the left-nav child; the new route must be registered in (or
   excluded from) the page-profiler pins.
8. D19-2 - no API is named for the list or its two actions; choose client-side
   (full records already come back) vs a server read; mutation catalog pin bumps.
9. D19-3 - the lean seed's Renee Carter is a role-less, consent-less partner and
   sits in every lane's Possible list by construction.
10. D19-4 - say who may run Make caseworker / Not a caseworker, and how 409 reasons
    read.
11. D19-5 - a converted tenant's tours, placements and staff notes stop showing on
    their page (PartnerFile omits them).
12. D20-6 - recipient rows carry no type or role, so "partner rows labelled by
    their role" needs a wire change.
13. D20-7 - tenant wording also sits on the Matching list row and the property
    Activity entry; choose neutral vs type-aware wording (type-aware needs a type
    on preview and results rows).

---

## Section 1.2 - the intake claims B rests on (dashboard side)

| # | Statement | Verdict | Code (file:line) | Note |
|---|---|---|---|---|
| I1 | "picking Partner clears the role" | STILL VALID | `dashboard/src/routes/contact/KindPicker.tsx:105-109` (every non-Other segment goes through `patchForSuggestedContactKind`); `dashboard/src/routes/contact/contactProfile.ts:32` (`partner: { type: 'partner', role: '' }`) | - |
| I2 | "the Other choice offers only Tenant or Landlord as a base" | STILL VALID | `KindPicker.tsx:32-43` (`BASE_OPTIONS` = tenant, landlord) | So no UI path saves partner + role. An existing partner + role (API, import) rehydrates into Other with NO base radio checked (`KindPicker.tsx:56-58`). |
| I3 | "caseworkers accepted from an AI type suggestion are partners with NO role" | STILL VALID | `dashboard/src/routes/contact/UnknownFile.tsx:115-122` ("Mark as Partner"); `dashboard/src/routes/contact/ContactDetail.tsx:656-665` (`onTriage` PATCHes the kind map); `e2e/tests/flows/conversation-fact-extraction.spec.ts:346` pins `role` undefined after triage | - |
| I4 | "Partners have no organization field and no tab" | STILL VALID | `dashboard/src/api/types.ts:2213-2220` (Contact declares `housingAuthority`, `agency`; no `organization`); `dashboard/src/routes/contacts/ContactsList.tsx:47-53` (All / Tenants / Landlords / Unknown / Deleted) | Partners already list under All and Deleted (`dashboard/src/routes/contacts/useContacts.ts:31,40`). |
| I5 | "property sharing is tenant-only" | STILL VALID | Dashboard: the composer takes any `?contactId=` (`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:71-75`); a dropped partner seed shows as "1 added tenant can't receive texts (unknown, opted out, or unreachable) ..." (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:390-396`; `types.ts:3296-3297` lists non-tenant among unresolved seeds). Server: `app/src/routes/broadcasts.ts:434,827`; `app/src/jobs/broadcastFanOut.ts:871,1386` mint `tenant_1to1` | The drop is server-side; on the dashboard only the partner card and its wiring are missing (D20-1). |

## D16 - Caseworkers stay partners

| # | Statement | Verdict | Code (file:line) | Amendment / note |
|---|---|---|---|---|
| D16-1 | The type picker gains "Caseworker", saving `type: partner, role: Caseworker`, "the way Property Manager saves" | STILL VALID | Segments `KindPicker.tsx:125`; PM preset detection `isPmPresetValue` `KindPicker.tsx:47-49`, used by `activePrimarySegment` (`52-63`) and `inOtherMode` (`93`). One component serves create (`ContactCreateForm.tsx:258`) and edit (`ContactEditForm.tsx:531`) | Plan precision: add a Caseworker twin of `isPmPresetValue` and use it in BOTH places, or a saved caseworker reopens "Change type" in Other with no base checked (I2). Keep the preset OUT of `SuggestedContactKind` (`contactProfile.ts:13-17` mirrors the server's AI kinds, which have no caseworker); add a role constant beside `PM_ROLE` (`contactProfile.ts:11`). |
| D16-2 | No new `ContactType` | STILL VALID | `contactProfile.ts:50-56` (`CONTACT_TYPE_LABEL`), `63-68` (`displayKind` = role, else type label); header pill `ContactDetail.tsx:575`; list badge `ContactsList.tsx:111` | No code: the pill and the list badge already read "Caseworker" for partner + role Caseworker. |
| D16-3 | The canonicalizer treats partner + Caseworker as partner "so accepting an AI 'partner' suggestion through the Caseworker choice records accepted" | AMEND | Server canonicalizer still returns undefined for every non-empty role except Property Manager (`app/src/services/extraction/contactKinds.ts:11-15`; called at `app/src/routes/contacts.ts:1719`). The dashboard's one-click accept surface for a type suggestion is the Unknown triage card, with four fixed actions and no Caseworker (`UnknownFile.tsx:98-131`) | Amend D16: state whether the triage card gains "Mark as Caseworker" (PATCH `{type: partner, role: Caseworker}`). Without it the AI chip keeps minting role-less partners (I3) that D19 then has to sweep, and "through the Caseworker choice" is reachable only via Edit > Change type. Pins if added: `UnknownFile.test.tsx:91-102` (exactly four actions, in KindPicker order), `ContactDetail.test.tsx:515-520` (`it.each`), e2e `conversation-fact-extraction.spec.ts:333-337` (visibility only), `e2e/support/selectors.md:57`. |
| D16-4 | (D16 + D18 + D19 together) what counts as a caseworker role | AMEND | D16 saves the exact role "Caseworker"; D18 takes roles that "normalize to caseworker or case worker"; D19 takes roles that "mention caseworker or case manager". The dashboard has only exact-match presets (`KindPicker.tsx:47-49`, `value.role === PM_ROLE`); the server canonicalizer is exact too (`contactKinds.ts:12`) | Amend: define ONE normalizer (case, spaces, hyphens) used by the KindPicker preset detection, the D18 tab predicate, the D16 canonicalizer and the D19 criteria, and say whether a partner whose role is "Case worker" is the preset (it should be: D18 lists it). |
| D16-5 | (gap) the Other path still mints tenant-based caseworkers | AMEND | The Other role input's placeholder suggests "Case worker" (`KindPicker.tsx:170`, "e.g. Case worker, Social worker" plus an ellipsis) on a tenant/landlord base; `KindPicker.test.tsx:95` pins typing a role then base Tenant | Amend D16: replace the example (it now steers staff to exactly the records D19 cleans up) and decide whether Other + a caseworker role (D16-4 rule) redirects to the Caseworker preset. |

## D17 - Organization field on partners (with D6's "(B)" sentence)

| # | Statement | Verdict | Code (file:line) | Amendment / note |
|---|---|---|---|---|
| D17-1 | `contact.organization`, checked by D5 against either list | STILL VALID | Not built by A anywhere. Server `OrgField` / `KINDS_FOR_FIELD` are four "(branch A)" fields (`app/src/lib/orgNames.ts:23-31`); dashboard `OrgField` / `OrgRecordField` likewise (`types.ts:3435-3439`); Contact and ContactPatch declare only `housingAuthority`, `agency` (`types.ts:2213-2220`, `2276-2282`) | `KINDS_FOR_FIELD` is a Record, so `organization: [housing_authority, agency]` is one line, and `resolveOrgText` already takes a kinds array (`app/src/lib/orgNames.ts:89-106`). |
| D17-2 | An OrgPicker can serve `organization` over BOTH lists (matching) | DONE BY A | `kinds: readonly OrgKind[]` (`dashboard/src/routes/orgs/OrgPicker.tsx:63-64`); matching filters by it (`140`); "Not on the list" chip test (`361`); typed-text settle and its hook take kinds arrays (`dashboard/src/routes/orgs/orgCopy.ts:201-212`, `useTypedOrgText.ts:66-75`); `isOnList` (`orgCopy.ts:95-101`) | Matching, on-list marks and Save-commits-typed-text already work for `[housing_authority, agency]`. The add step (D17-3) and the copy (OrgPicker notes below) do not. |
| D17-3 | D6 (B): "A caseworker's organization can add either kind; the dialog asks which" | AMEND | Single-kind end to end: the add option's noun is `KIND_NOUN[kinds[0]]` (`OrgPicker.tsx:242,463`); `onRequestAdd` carries only the text (`71`, `311`); `NewOrgDialog` takes ONE kind (`NewOrgDialog.tsx:43`) for its check (`107`), its copy (`205`) and its add (`147`), and treats a hit in the other list as a refusal ("X is an agency, not a housing authority", `260-291`). POST `/check` resolves one kind and scores close names only inside it (`app/src/services/orgNames.ts:262`, `resolveOrgText(entries, text, [kind])`; `app/src/lib/orgNames.ts:106`) | Amend D6 and section 6: `/check` accepts the organization field (or a kinds list) so match, candidates AND close names span both lists - otherwise adding an organization as a housing authority never shows a near-duplicate agency, and vice versa. `NewOrgDialog` gains an organization mode that asks the kind before "Yes, add it" and offers a hit in either list as "Use <name>"; the picker's add option reads "Add <text> as a new organization". |
| D17-4 | "Shown on the partner page" (section 10: "partner page shows Role and Organization") | STILL VALID | PartnerFile Details shows only Phone numbers and Status (`dashboard/src/routes/contact/PartnerFile.tsx:67-83`) | Role already shows in the header pill (`ContactDetail.tsx:575`); Details rows still to add. |
| D17-5 | "Counted ... by D10" (D10: counts include "(B) caseworkers") | AMEND | `OrgUsageCounts` = `{tenants, otherContacts, properties, deleted}` (`types.ts:3479-3485`); `usageText` / `usageBreakdown` / `usageTotal` (`orgCopy.ts:577-592`); `inUseText` (`dashboard/src/routes/settings/OrgEntryDialogs.tsx:110-113`); e2e `OrgUsageWire` (`e2e/fixtures/orgFixture.ts:53-57`); Change kind and Delete block on `usageTotal > 0` (`OrgEntryDialogs.tsx:447`, `503`) | Amend D10/D17: name the new count key and what it counts. D17 lets EVERY partner hold an organization ("edited on partner contacts"), so a count labelled "caseworkers" is wrong for a non-caseworker partner (Renee, D19-3): count the field ("organizations") or restrict the field to caseworkers. Also say whether an organization use blocks Change kind (the field accepts both kinds, so the change cannot make the value off-list). |
| D17-6 | "rewritten by D11"; section 10: "Settings counts, Not on the list and the rewrite job include organization" | AMEND | One-kind-per-field throughout: `kindForField` returns housing_authority for anything but `agency` (`orgCopy.ts:64-67`); `settleChoices` keeps compound halves of that kind only (`dashboard/src/routes/settings/NotOnListSection.tsx:83`) and its Split/Move rules name `housingAuthority` / `agency` (`86-101`); "Use another name" offers one kind (`377-386`); Remember-this-spelling looks the target up inside that kind (`246-249`, check at `255`); Add as new adds to `KIND_PLURAL_TITLE[kind]` and sends NO kind (`317-329`; `NotOnListResolveBody`, `types.ts:3598-3607`, = the spec section 6 resolve body); `notOnListMessage` derives the kind from the field (`orgCopy.ts:337-351`); `FIELD_LABEL` and `COUNT_LABEL` list three fields (`orgCopy.ts:48-53`, `534-541`) | Amend section 6: the resolve body needs a `kind` for action `add` on an organization row. Plan precision: a dashboard `KINDS_FOR_FIELD` mirror replaces `kindForField`; organization rows offer Use (either list), Add as new with a kind choice, and Clear - no Move, no Split; `FIELD_LABEL`, `COUNT_LABEL`, `notOnListMessage`, `orgListLoadError` (`orgCopy.ts:104-106` would say "Couldn't load housing authorities") gain organization; so do the dev seam's contact-field allowlist (`app/src/routes/dev.ts:1226-1231`) and e2e `OrgRecordField` (`orgFixture.ts:24`). |

## D18 - Caseworkers tab

| # | Statement | Verdict | Code (file:line) | Amendment / note |
|---|---|---|---|---|
| D18-1 | "Contacts gains a Caseworkers tab" | AMEND (precision) | Tabs and headings are closed records (`ContactsList.tsx:35-41`, `47-53`; `ContactsFilter` / `TYPES_FOR` at `useContacts.ts:16`, `30-41`); routes `dashboard/src/App.tsx:152-156`; left-nav children Tenants / Landlords / Unknown with a closed dot union (`dashboard/src/app/nav.ts:59-70`, `32`; `dashboard/src/app/NavContents.tsx:18-22`); the nav model is "LOCKED by the design spec" (`nav.ts:1`) | Amend D18: say whether the LEFT NAV gets a Caseworkers child (a nav target must also join `IMPLEMENTED`, `App.tsx:61-83`, or `e2e/performance/routes.test.ts:360` fails). Either way the new route must be registered in the page profiler (`e2e/performance/routes.ts:607-611` rows, `EXPECTED_KEYS` `routes.test.ts:29-38`, the 31 pins at `287-291` and `660`) or excluded with a filed issue (`routes.test.ts:378-393`; precedent `perf-pages-settings-organizations-surface`). |
| D18-2 | Members: partners whose role normalizes to caseworker / case worker | STILL VALID | GET `/api/contacts` requires `type` and has no role filter (`app/src/routes/contacts.ts:986-990`, `1050-1056`); the hook walks every page per type (`useContacts.ts:59-64`) | A `caseworker` filter maps to `['partner']` plus a client predicate (the D16-4 normalizer). |
| D18-3 | Organization chips "built the way the Tenants page builds its housing authority chips" | STILL VALID | The facet engine is tenant-bound: `TenantSelection {voucher, ha, porting}` (`dashboard/src/routes/contacts/tenantFacets.ts:57-62`), `authorityOf` reads `housingAuthority` (`121-130`), params `voucher` / `ha` / `porting` (`138-172`); `ChipGroup` is file-private (`TenantFilters.tsx:36`); facets render and apply on the Tenants view only (`ContactsList.tsx:153-155`, `263-265`); only the Tenants tab carries params (`250-254`); the filter-miss line is tenant copy (`318`) | Plan precision: generalize the engine (value accessor + param name) or add a sibling with its own param; export `ChipGroup`; copy the tab-carries-its-own-params rule; keep the Not recorded chip (it finds the caseworkers Make caseworker left without an organization, D19). |

## D19 - Possible caseworkers

| # | Statement | Verdict | Code (file:line) | Amendment / note |
|---|---|---|---|---|
| D19-1 | The list lives on the Caseworkers tab | STILL VALID | The Unknown tab lists type `unknown` only (`useContacts.ts:34`), and D19's candidates are tenants, landlords and partners; nothing in A's Settings page argues for a Settings home | - |
| D19-2 | (unstated) where the list is computed; the API for its two actions | AMEND | Section 6 names `/api/organizations` only: no Make caseworker, Not a caseworker or list endpoint. GET `/api/contacts` returns FULL records (`byTypeStatus` projects all attributes, `app/src/repos/contactsRepo.ts:1154`; route `contacts.ts:1050-1056`), so all three criteria and `caseworker_review` are client-computable from the 'all' fan-out (`useContacts.ts:31`) - the relationship criterion needs every contact's relationships, unknowns included | Amend: name the endpoints (Make caseworker with its 409 reasons; Not a caseworker as a PATCH of `caseworker_review` - not in `ContactPatch`, `types.ts:2262` on - or its own route) and choose client-side (the Caseworkers tab then loads every contact of four types) vs a server read. Each new dashboard write needs a `e2e/performance/mutationCatalog.ts` entry and bumps the pin (`mutationCatalog.test.ts:378`, 118 today, with the running comment at `367-377`). |
| D19-3 | "partners with NO role" are candidates | AMEND | The lean seed's Renee Carter is a partner with no `role` (her title rides `role_title`, which nothing reads) and no consent (`app/src/lib/seed/lean.ts:160-177`, `153-154`); she is also a seeded group/relay member (`lean.ts:319-323`) | Amend (e2e world): she is in every lane's Possible list by construction. The spec or plan should say so: specs assert on their own run-unique contacts and never act on her - or the seed gives her a role or a dismissal (a seed change, pinned by `seedData.test.ts`). |
| D19-4 | "Each row offers Make caseworker and Not a caseworker" | AMEND | A's Settings actions are admin-only and absent for a VA (`dashboard/src/routes/settings/OrgListSection.tsx:1-8`), while a type change in the edit form is open to every user | Amend: state who may act. Map each 409 reason to staff words (never the raw code - the rule at `orgCopy.ts:7-10`) and keep the confirm open on a 409 (`dashboard/src/routes/settings/ConfirmRemoveDialog.tsx:1-5`, `26-37`). |
| D19-5 | "Past tours, closed placements and listing sends stay as history" | AMEND | A converted contact renders PartnerFile, which omits Tours and Placements by design (`PartnerFile.tsx:4-7`) and has no Staff notes card (`StaffNotesCard` is tenant-only, `TenantFile.tsx:254-271`; open issue `staff-notes-on-landlord-partner-files`) | Amend: the data stays, but the converted contact's own page stops showing their tours, placements and hand-written staff notes (listing sends come back through D20's card). Show them on PartnerFile for converted contacts, or state the loss; the staff-notes issue says to ask Sam first. |

## D20 - Direct property shares to partners

| # | Statement | Verdict | Code (file:line) | Amendment / note |
|---|---|---|---|---|
| D20-1 | PartnerFile gets "Properties sent" and its Send | STILL VALID | The rows already load for every type (`dashboard/src/routes/contact/useContactFile.ts:144`) from a route that is not type-gated (`app/src/routes/contacts.ts:1168-1176`); missing: the card (`TenantFile.tsx:292-316` is the model) and the wiring (`ContactDetail.tsx:1097-1108` passes no rows or `onSendProperty`; the tenant wiring is `1162-1164`) | No new GET (`CONTACT_DETAIL_BASE_GETS` already holds listings-sent, `e2e/performance/routes.ts:335`). Give "+ Send" a distinct label (the tenant's is "Send a property to this tenant", `TenantFile.tsx:296`; `selectors.md:45` records the bare 'Send' strict-mode collision). |
| D20-2 | The composer opens with the partner as starting recipient and sends the normal share | STILL VALID | `?contactId=` seeds one recipient of any type (`BroadcastComposer.tsx:71-75`, `175-183`); one seed with filters off is resolved one-to-one mode (`115`), auto-filled with address + flyer link (`225-236`) | No entry change. "Add more tenants by filters" (`528`) stays true: filters add tenants. |
| D20-3 | Filter-resolved audiences stay tenant-only | STILL VALID | `AudienceFilter.contact_type` is the literal `'tenant'` (`types.ts:3076-3077`; `BroadcastComposer.tsx:78`) | No code. |
| D20-4 | The composer's recipient search stays tenant-only | STILL VALID | `getAllContacts({ type: 'tenant' })` (`BroadcastComposer.tsx:273`); `addTenant` validates against that list (`RecipientPreview.tsx:181-190`) | No code. |
| D20-5 | Every existing gate applies unchanged | STILL VALID | The dashboard mirrors the fences only for hand-added tenants (`RecipientPreview.tsx:181-211`); seeded rows are fenced by the server | No dashboard code. |
| D20-6 | Property "Sent to tenants" becomes "Sent to", partner rows labelled by role | AMEND | Rows carry no type or role: `ListingSendRow {contactId, tenantName?, ...}` (`types.ts:2871-2883`); the card renders `row.tenantName ?? row.contactId` (`dashboard/src/routes/listing/ListingDetail.tsx:1043`); the server join reads the display projection - names, phone, deleted_at only (`app/src/routes/units.ts:1007`; `app/src/repos/contactsRepo.ts:913-923`) | Amend D20: name the wire change (type + role, or a display label, on the recipients row) - the dashboard cannot label a partner row from what it receives. Pins: e2e headings `listing-activity.spec.ts:215`, `matching-entry-points.spec.ts:263`; `ListingDetail.test.tsx:498-532`, `993`. |
| D20-7 | Section 10: "recipient wording in the composer preview and results is not tenant-only" | AMEND | Tenant wording sits on more surfaces than those two: `RecipientPreview.tsx:294,393-394,400,530`; `BroadcastResults.tsx:58` ('Tenant' fallback), `206-208`; the Matching list row (`BroadcastsList.tsx:37-40`) and its empty copy (`132`); `sendReachLabel` "To N tenants" (`broadcastFormat.ts:70-71`); the property Activity entry "Sent to N tenants" / "No tenants reached" (`dashboard/src/routes/listing/listingFormat.ts:179-181`). Preview candidates and results rows carry no type (`types.ts:3268-3289`, `3236-3260`) | Amend section 10: list every surface, and choose neutral wording ("recipient") or type-aware wording (which needs a type on preview candidates and results rows). Pins to update: `RecipientPreview.test.tsx` (many "Send to N tenants"), `BroadcastComposer.test.tsx:482,845`, `broadcastFormat.test.ts:38-40`, `listingFormat.test.ts:229-253`; e2e `matching-entry-points.spec.ts:152,235`, `share-skip-fix.spec.ts:190`, `broadcasts.spec.ts:247` (exact `^Send to \d+ tenants?$`), `landlord-activity.spec.ts:122`, `listing-activity.spec.ts:143`, `share-sent-outcome.spec.ts:671`. |

## D21 - Type changes keep threads and imports consistent

| # | Statement | Verdict | Code (file:line) | Amendment / note |
|---|---|---|---|---|
| D21-1 | Re-type threads on staff type changes; stamp `type_source: manual`; importer rule | STILL VALID | Dashboard: triage and the edit form send the same PATCH shape `{type, role}` (`ContactDetail.tsx:656-665`; `ContactEditForm.tsx:276-278`), so the server tells triage apart by the stored type `unknown` | No dashboard change; the server half is `app/`. |
| D21-2 | "The contact header shows voucher size and housing authority only for tenants" | STILL VALID | `buildFacts` shows them for every non-landlord (`ContactDetail.tsx:1322-1335`): partner, unknown and team_member today | Precision: key on `contact.type === 'tenant'`, not the page's `kind` (team_member maps to the tenant kind, `ContactDetail.tsx:563-573`). Consequence to accept: an unknown contact's imported housing authority stops showing anywhere (UnknownFile omits the tenant cards, `UnknownFile.tsx:7-9`). Consider Organization in the partner facts line. |

## Section 10 - items not covered above

| # | Statement | Verdict | Code (file:line) | Amendment / note |
|---|---|---|---|---|
| S10-1 | Partner edit form Organization picker (D17) | STILL VALID | The org pickers mount for tenants only (`ContactEditForm.tsx:592`); the refused-save state and the 422 handler know two fields (`143-146`, `461-466`); `applyOrg` routes a dialog answer by entry KIND (`208-214`); `settleTypedText` returns early for non-tenants (`396-398`); the add state is `{kind, text}` (`141`); the load alert keys on any failed read (`615`, `639`) | Plan precision: the organization picker needs its own apply (an agency answer goes into `organization`, never `agency`), field-keyed add state, a third 422 field and a third settle, and keeps the never-send-an-untouched-field rule (`347-366`). The contacts POST still ignores org fields (spec section 9), so the create dialog cannot set an organization; a new caseworker gets one through Edit. |

---

## OrgPicker reuse notes (organization = either list)

What A built and B reuses as is:

- `OrgPicker` (`dashboard/src/routes/orgs/OrgPicker.tsx`): handle `{ focus, clearText }`
  (`51-56`); props `label`, `kinds`, `entries`, `loading`, `onRequestAdd`, `hint`,
  `error`, `errorAttempt`, `disabled`, `placeholder`, `className`, `labelClassName`,
  `onPendingTextChange`, `pendingNote`, `ref` (`58-98`); single or multi value
  (`100-113`). Commit rule: `onChange` only on a pick or a chip removal; typed text
  is reported, never dropped (`16-28`). The host renders "Is this really new?"
  outside its form (`36-39`).
- `useOrgList()` reads GET `/api/organizations` once per mount, no cache
  (`useOrgList.ts:65-109`); `noteAdded` counts a just-added entry at once
  (`125-131`).
- `useTypedOrgText(list, kinds, ref)` (`useTypedOrgText.ts:66-75`) - kinds array.
- `NewOrgDialog` props `{kind, text, mode 'field'|'suggestion'|'settings',
  initialCheck?, onUse?, onUseOtherField?, onDismissSuggestion?, onAdded, onClose}`
  (`NewOrgDialog.tsx:40-67`).

What B must add for the organization field (beyond D17-3 / D17-6 above):

- Kinds: `HOUSING_AUTHORITY_KINDS` / `AGENCY_KINDS` are "(plan 3.2 KINDS_FOR_FIELD,
  branch A)" (`orgCopy.ts:26-28`); add an organization pair or a field map.
- Add option: neutral noun when more than one kind is offered (`OrgPicker.tsx:242`,
  `463`); widen e2e `ORG_PICKER.addOption` (`e2e/scenarios/steps.ts:130`).
- Option labels show the name and the matched spelling, never the list
  (`OrgPicker.tsx:462-473`). With both lists in one picker, decide whether to tag
  options with their list. The selector contract only requires the accessible name
  to START with the entry name (`steps.ts:125-127`; `selectors.md:121`), so a suffix
  is safe.
- Copy map (`orgCopy.ts`): `KIND_NOUN` (`31-34`) has no both-kinds noun;
  `FIELD_LABEL` (`48-53`); `kindForField` (`64-67`); `orgListLoadError`
  (`104-106`); `notOnListMessage` (`337-351`, would call an organization value "a
  spelling of more than one housing authority"); `COUNT_LABEL` (`534-541`); usage
  helpers (`577-592`); `resolutionText` (`594-603`, `other_kind` never occurs for
  organization); `holderKindLabel` (`617-621`, shows "Partner", not the role).
- Wire mirrors (`dashboard/src/api/types.ts`): `OrgField` / `OrgRecordField`
  (`3435-3439`), rewrite `counts` keys comment (`3464`), `OrgUsageCounts`
  (`3479-3485`), `NotOnListResolveBody` (`3598-3607`), Contact / ContactPatch
  (`organization`, `caseworker_review`, `type_source`; today they would fall
  through Contact's index signature as `unknown`).
- `ContactEditForm`: see S10-1.

Pins a new route or endpoint must update:

- Page profiler: `e2e/performance/routes.test.ts` - `EXPECTED_KEYS` (`29-38`), 31
  surfaces (`287-291`, `660`), App route and nav-target mechanical match with its
  `excluded` set (`348-393`); `e2e/performance/routes.ts` rows and
  `CONTRACT_SOURCE_LEDGER` (citation format is checked, not line accuracy).
- Mutation catalog: `e2e/performance/mutationCatalog.ts` (contacts entries
  `90-107`, org entries `133-139`) and `mutationCatalog.test.ts:378` (118, with the
  enumerated comment at `367-377`). Reusing `updateContact` or the broadcast
  functions adds nothing; a new endpoint function adds one each.

## Navigation and list notes (Caseworkers tab, Possible caseworkers)

- Wiring for `/contacts/caseworkers`: `App.tsx:152-156` route; `ContactsList`
  `HEADING` and `FILTERS` (`35-41`, `47-53`); `ContactsFilter` + `TYPES_FOR`
  (`useContacts.ts:16`, `30-41`); optional nav child (`nav.ts:65-69`, dot union
  `32`, `DOT_CLASS` `NavContents.tsx:18-22`, `IMPLEMENTED` `App.tsx:61-83`); profiler
  pins (D18-1).
- The list's API call: `getAllContacts({ type, deleted }, signal)` per type, every
  page (`useContacts.ts:59-64`); the server requires `type`, takes `status`,
  `limit`, `cursor`, `deleted`, and has no role or organization filter
  (`contacts.ts:986-990`, `1050-1056`). The Caseworkers view = the partner fetch +
  a client role predicate + client organization chips.
- `ContactsList` stays MOUNTED across the filter routes (`ContactsList.tsx:141-143`):
  a Possible-list read must be keyed to the caseworker view, or every Contacts tab
  pays for it.
- A's patterns to copy for the Possible list: the "Not on the list" table (row
  header = the value, per-row actions, a "Show records" expansion,
  `NotOnListSection.tsx:474-497`); the confirm that repeats the action and cannot
  close while busy (`NotOnListSection.tsx:350-353`); the 409-stays-open dialog
  (`ConfirmRemoveDialog.tsx:26-37`); the details read with in-flight de-dupe and
  reload-after-action (`useOrgAdmin.ts:57-89`, `107-111`) - but WITH an age cap (open
  issue `org-settings-details-read-no-age-cap`). No polling is needed (no job runs).
- `TenantFilters` deliberately renders no `ul`/`li` so the rows list stays the only
  source of listitems (`TenantFilters.tsx:1-8`); keep that for the organization
  chips and the Possible section, or specs that scope `listitem` must change.
- Make caseworker's organization (D19: from agency or housing authority "when
  either is exactly a list name") can be previewed on the row with `isOnList`
  (`orgCopy.ts:95-101`) against `useOrgList`.

## E2E notes

Partner coverage today:

- No partner or caseworker step in `e2e/scenarios/steps.ts`. `teamCreatesTenant`
  (`791-812` on) drives the KindPicker group "Contact kind" (`808`);
  `partnerEmailsIn` (`704-714`) is a role-agnostic inbound email.
- The only partner flow: `e2e/tests/flows/conversation-fact-extraction.spec.ts:315-348`
  (AI suggests Partner, "Mark as Partner", `role` undefined, thread `partner_1to1`).
- The lean world's one partner is Renee Carter (D19-3).

Reusable as is:

- `e2e/fixtures/orgFixture.ts`: `addOrg`, `requireOrg`, `getOrgUsage`,
  `getNotOnList`, `setOffListValue` (`103-115`), `waitForRewrite`.
- `pickOrgName` + `ORG_PICKER` (`steps.ts:118-164`).
- `e2e/fixtures/extraction.ts`: `sendExtractSms` (`50-54`) with `typeSuggestion` and
  `noteLines` (an AI "Identified as a caseworker" note - a D19 criterion) +
  `extractionTick`.
- `matching-entry-points.spec.ts`: `createTenant` with consent (`36-55`) - the
  template for a consenting caseworker (`type: 'partner', role: 'Caseworker'`) - and
  the tenant-page share flow (`103-160`) - the template for the partner-page share.

To extend:

- `pickOrgName` label union (`steps.ts:152`) gains `'Organization'`;
  `ORG_PICKER.addOption` (`130`) gains the organization text.
- A `teamCreatesCaseworker` step; a triage step if D16-3 adds the button.
- `orgFixture.ts` `OrgRecordField` (`24`) and `OrgUsageWire` (`53-57`); the server
  seam's contact fields (`app/src/routes/dev.ts:1226-1231`).
- `e2e/support/selectors.md` rows: `45` ("+ Send" strict-mode note - add the partner
  label), `57` (Unknown triage, if Mark as Caseworker), `111` (seam fields),
  `112-114` (Caseworkers list name, the organization chip group and its Clear, the
  tab's own params), `121-122` (picker label `Organization`, the add-option text),
  `123-124` (organization rows' actions, the usage label).
- Copy pins: D20-6 and D20-7 lists; D16-3 list.

Lean-world hazards:

- Renee Carter (D19-3). She also has no consent, so a share to her is fenced: use a
  run-unique consenting partner.
- Every run of `contact-create.spec.ts:181-190` adds a 'Caseworker' relationship
  pointing at the seeded LANDLORD Marcus Bell. Harmless under D19's tenant-only
  relationship criterion; any widening to landlords would put a seeded landlord in
  every lane's list (and Make caseworker on him must refuse: `landlordId`).
- Do not add to A's e2e debt: create units with `'Atlanta Housing Authority'`, never
  the `atlanta_housing` slug (org-picker-settings-review-lows item 12); values
  run-unique and not substrings of each other (`selectors.md:124`); sync on
  `waitForRewrite`, never the status line (`selectors.md:123`).

## Filed issues B touches

`docs/issues/org-picker-settings-review-lows.md` (open, low, dashboard):

- Fix with B (B is in these lines anyway): **item 1** (re-read the list on a 422 -
  B adds a third field to `ContactEditForm`'s 422 handler, `461-466`); **item 2**
  (false "Couldn't load" after a failed re-read - B adds a third picker with the
  same `orgList.error ?` line, `615`, `639`); **item 3** (stale `failedFor`, keyed by
  name only, `NewOrgDialog.tsx:92`, `123-124` - B's kind choice makes the key kind +
  name); **item 4** (the add option empties the typed text before the dialog opens,
  `OrgPicker.tsx:306-313` - B reworks that add step).
- Optional with B: item 5 (no timeout on `/check` - `NewOrgDialog`), item 9 (bare
  "Clear" / "Show records" names, `NotOnListSection.tsx:474-497` - B adds
  organization rows and their e2e), item 11 (360 px wrap of the same table).
- Do not copy: item 10 (stale rows after a failed re-read) into the Possible list.
- E2E items 12-13: do not add to the debt (above).

Other open issues:

- `org-settings-details-read-no-age-cap` (dashboard/settings): the read pattern the
  Possible list would copy - copy it with the age cap.
- `org-picker-note-wrap-reflow` (dashboard/orgs): B puts a third picker in the same
  Modal; the CSS fix covers all three. Optional.
- `org-provisional-entry-concurrent-rename` (dashboard/orgs): B's organization add
  uses `noteAdded` (`useOrgList.ts:125-131`); same risk, not required.
- `perf-pages-settings-organizations-surface` (e2e/performance): the precedent for
  the new Caseworkers route (D18-1).
- `staff-notes-on-landlord-partner-files` (dashboard/contact, open, "ask before
  building"): D19's conversion makes it bite (D19-5).
- `composer-org-422-offer-renamed-entry`: not touched by B.
- Server-side, for the app researcher: `org-names-backend-review-lows` item 1 (Move /
  Split parity in the contact rewrite planner) sits in the planner B extends for
  `organization`.

Background (resolved, no action): `caseworker-contact-type` (why the AI suggests
Partner and the triage card has four actions); `lean-seed-ha-staffer-should-be-partner`
(why Renee is a partner); `partner-widening-consumer-test-gap` (partners on the 'all'
surfaces).

## Server notes the dashboard depends on (for the app researcher)

- Canonicalizer exact match: `app/src/services/extraction/contactKinds.ts:11-15`.
- `/check` single kind: `app/src/services/orgNames.ts:262`.
- Recipients join has no type or role: `app/src/repos/contactsRepo.ts:913-923`,
  `app/src/routes/units.ts:1007`.
- Dev seam contact fields: `app/src/routes/dev.ts:1226-1231`.
- Status after Make caseworker: the PATCH re-type auto-advance sets a partner to
  `active` (`app/src/routes/contacts.ts:1510-1513`); D19 should say Make caseworker
  does the same, or the contact keeps a tenant status that is invalid for a partner.
