# R4 plan-research findings - dashboard contact surfaces (branch B)

Scope: KindPicker, ContactCreateForm, ContactEditForm, UnknownFile, ContactDetail,
PartnerFile, the caseworker conversion dialog, Contacts navigation and the
Caseworkers tab, the page-profiler registry, the mutation catalog, the message
catalog and GLOSSARY. Spec: docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
(revision 13). Worktree W:\tmp\caseworkers at 97ac55ee. Code cited by file:line;
the reference material (current behavior, quotes, test pins, accessible names)
is a separate artifact under .superpowers/sdd/plan-research/R4-reference.md.

Severity: HIGH = the plan cannot be written without a ruling or the build
will guess a contract; MEDIUM = a builder-guessing gap with a clear default;
LOW = precision or housekeeping.

## HIGH

F-R4-01. The `make` response body is unspecified. Spec section 6 and D19 say
only that `make` "answers 200" (and that `make` on a caseworker re-runs steps
2-4). Every dashboard entry point must re-render from the result: ContactDetail
swaps its file pane by `contact.type` (ContactDetail.tsx:563-573) and applies
returned contacts in place (`setContact`, the pattern at ContactDetail.tsx:656-665
and endpoints.ts:1460-1466 `updateContact` returning `{ contact }`). The
Possible caseworkers list must drop the row and the Caseworkers list must gain
it. Recommend: `make` and `dismiss` both answer `{ contact }` (the converted or
dismissed contact), mirroring PATCH. The server researcher and this plan must
agree on one shape.

F-R4-02. The preview wire is described by content, not by fields. D19 lists
what `GET .../caseworker-review/preview` carries (refusals, removed housing
authority and agency, pending-suggestion count, threads to re-type and left
alone, the organization and its source) but no field names, no enum for the
source (stored / list match / carried / none) and no shape for refusals. The
dialog, its unit tests and the e2e spec cannot be written without it. The plan
must pin one TypeScript shape shared by the route and the dashboard mirror in
dashboard/src/api/types.ts.

F-R4-03. Who owns the refusal sentence is undefined. D19: "each 409 with its
own code and a staff sentence naming what to resolve first". The dashboard
convention A established is the opposite of a server sentence:
"`ApiError.message` is the RAW machine code and is never rendered. Every
failure goes through orgErrorCopy()" (orgCopy.ts:7-10). Decide: (a) the
dashboard maps the four codes (`caseworker_open_placement`,
`caseworker_open_tour`, `caseworker_landlord_of_record`,
`caseworker_on_roster`) plus `contact_changed` and `caseworker_use_conversion`
to its own copy, and (b) whether a refusal carries the blocking record's id so
the sentence can LINK to the placement, tour or property (the preview names
them before Confirm, so a link is what makes "what to resolve first"
actionable). Same question for the preview's refusal list.

F-R4-04. The possible-caseworkers row shape is half specified. Section 6: "one
row per contact with its name, type, current role and the signal that put it
there". D19 has four signals and one contact can meet several (a tenant whose
role mentions caseworker AND who is linked as another contact's caseworker).
The plan must fix: the signal enum values, single vs list, and the staff label
for each (the page shows why a row is there).

F-R4-05. Shared lean world leakage makes naive e2e assertions on the Possible
list unstable, and two actions are irreversible on shared data. The list holds
EVERY role-less live partner and every tenant or landlord whose role mentions
caseworker: the lean partner Renee Carter (app/src/lib/seed/lean.ts:159-176),
every partner other specs create (e.g. conversation-fact-extraction.spec.ts:315-357
leaves a role-less partner each run), and a tenant with role
`Case worker ${stamp}` created by contact-create.spec.ts:24-28 on EVERY run and
never removed. Specs are not reseeded between files. So: (a) B's e2e must
assert only its own run-unique rows, never a count or an empty state; (b) no
spec may convert or dismiss Renee - dismissal is permanent with no UI undo, and
conversion REMOVEs her housing authority and re-types threads that
group-text-conversion.spec.ts:77-140 and group-text-detection.spec.ts:26-61
read. D19's "e2e expectations include her" must mean presence only.

## MEDIUM

F-R4-06. Misdescription: the Unknown card's button order. D16 lists the four
actions as "Mark as Tenant, Landlord, Property Manager, Partner" and puts Mark
as Caseworker "after Partner". The code order is Tenant, Landlord, Partner,
Property Manager (UnknownFile.tsx:98-131), pinned as "KindPicker order" by
UnknownFile.test.tsx:91-104. Read literally, "after Partner" is the 4th slot,
not last. Recommend the KindPicker segment order Tenant / Landlord / Partner /
Caseworker / Property Manager / Other, and Mark as Caseworker 4th on the card,
keeping the two in step as the test intends.

F-R4-07. "A's picker already takes a list of kinds" (D6, D17) is true for
matching only; every other part of A's org UI assumes one kind. The plan must
list each one:
- OrgPicker.tsx:242 `addNoun = KIND_NOUN[kinds[0] ...]` -> the add option on a
  both-kinds picker reads "Add X as a new housing authority" (:214).
- NewOrgDialog.tsx:42-43 takes one `kind`; :107 checks with `{ kind }`; :147
  adds with that kind; :205 and :249 word it by that kind; :260-291 render an
  other-kind section that cannot apply. D6's organization mode ("asks the kind
  before Yes, add it", close names over both lists, `/check` with `kinds`)
  needs a new mode or prop, and `checkOrgText` (endpoints.ts:2906-2915) a
  `kinds` field.
- orgCopy.ts:65-67 `kindForField` maps anything but `agency` to
  housing_authority; :338-352 `notOnListMessage` does the same, so a 422 on
  `organization` would read "is a spelling of more than one housing
  authority"; :104-106 `orgListLoadError` says "Couldn't load housing
  authorities" for a both-kinds picker; :49-53 `FIELD_LABEL` and the
  `OrgField` / `OrgRecordField` mirrors (types.ts:3434-3437) lack
  `organization`.
- ContactEditForm.tsx:210-214 `applyOrg` routes a pick BY KIND into
  housingAuthority or agency; reusing it for the Organization picker would
  write an agency pick into `agency`. The organization add/Use path needs its
  own setter.

F-R4-08. Typed-but-not-picked text in the dialog's Organization picker. D19's
wire says the dialog "sends `organization` only when staff changed the
picker"; A's rule is that text typed in a picker is never dropped silently
(OrgPicker.tsx:19-28, useTypedOrgText.ts). The plan should state that the
dialog settles typed text with `useTypedOrgText` exactly as the forms do (a
text naming one entry counts as a pick, anything else refuses Confirm under
the picker), otherwise Confirm silently ignores what staff typed and the
server derives a different organization.

F-R4-09. Confirm with refusals present. The preview shows refusals "so staff
see them before pressing", but the spec does not say whether Confirm is
disabled while the preview carries one. Recommend disabled with the refusal
sentences as its description (the server still re-checks at `make`).
Likewise unspecified: dialog title, Confirm label, the "what stays" copy, the
Possible list heading and empty state, and "Not a caseworker" confirm/undo
(dismissal is permanent and no UI reverses it). The plan should fix the words
and the accessible names the e2e spec will use.

F-R4-10. Where "Make caseworker" lives on a contact page is unspecified (D16,
D19: "a 'Make caseworker' action on the contact page", keyed on
`contact.type`). Two shapes: the header kebab (ContactActionsMenu, rendered
once by ContactDetail.tsx:933-951 for every pane - the natural place for a
type-keyed action) or a card action on TenantFile, LandlordFile and
PartnerFile (three props, and TenantFile also serves team_member, so it would
need the type key passed in). Recommend the kebab; the plan should rule.

F-R4-11. The edit form's 409 `caseworker_use_conversion` has no copy. Today
every non-422 failure is "Couldn't save - please try again."
(ContactEditForm.tsx:460-469), which is wrong for a refusal that will repeat.
With D16's offering rule the UI cannot reach it except from a stale form, so a
short sentence pointing to "Make caseworker" is enough - but the plan should
name it rather than leave the generic retry line.

F-R4-12. The Caseworkers page structure is left to the builder. Unspecified:
(a) a new component vs ContactsList with a new filter (ContactsFilter at
useContacts.ts:16 is also consumed by EmailTriage.tsx:238 via
`useContacts('all')`); (b) whether the on-page "Filter contacts" tabs
(ContactsList.tsx:43-53, whose comment says they mirror the nav routes) gain
Caseworkers - D18 names only the nav sub-link; (c) the nav position among
Tenants/Landlords/Unknown and its dot (nav.ts:31-32 dot union; NavContents.tsx:18-22
`Record` makes a new dot a typecheck error until mapped; token
`--c-dot-partner` exists at ui/tokens.css:43); (d) the organization chips'
URL param name (Tenants use `ha`) and whether rows show the organization
(ContactsList.tsx:307 shows facts for tenants only); (e) ChipGroup and Chip
are private to TenantFilters.tsx (:35, :98) and `buildFacts` is
tenant-specific, so "built the way the Tenants page builds" means exporting
or factoring them; (f) the hard-coded "No tenants match the selected
filters." (ContactsList.tsx:318) if ContactsList is reused.

F-R4-13. Profiler: the decision D18 leaves to the plan has mechanical
consequences either way. Always: '/contacts/caseworkers' must join
`IMPLEMENTED` in App.tsx:61-67 (routes.test.ts:364-375 requires every nav
target there). Exclude: add it to the `excluded` set (routes.test.ts:378-392)
with a TODO and a filed issue, A's precedent being
perf-pages-settings-organizations-surface. Register: EXPECTED_KEYS and the 31
count (routes.test.ts:29-37, :287-292), a ROUTES row (routes.ts:606-611), its
GETs (partner walk + `/api/contacts/possible-caseworkers`), a terminal over
two regions, and ledger citations (routes.ts:730-736, :785-790). Separately:
the '/contacts/:contactId' warm contract (routes.test.ts:115-124) is bound to a
TENANT (routes.ts:1101-1114), so the preview read must fire only when the
dialog opens and no new GET may be added at ContactDetail or TenantFile mount
(for example a page-level `useOrgList`).

F-R4-14. After a conversion on the contact page, the page must refresh what
the conversion changed off the contact record: pending suggestions (all
superseded, D19 step 2) and the threads (re-typed, step 3). The server emits
`suggestion.updated` and `conversation.updated` (step 4), but existing page
actions also refetch explicitly (ContactDetail.tsx:634
`timeline.refetch()` after opt-out). The plan should say which hooks the
dialog's success path refetches.

F-R4-15. Preset recognition vs the offering gate. D16 makes the AI
canonicalizer byte-exact on `Caseworker` but the tab uses `isCaseworkerRole`.
KindPicker must pick one for "already a caseworker": a partner with role
"Case worker" (reachable through the API) is a caseworker by
`isCaseworkerRole` but would not light a byte-exact preset and would
rehydrate as Other with no base checked (KindPicker.tsx:52-63, :93; partner is
not in BASE_OPTIONS at :32-43). Recommend: light the preset on exact
`CASEWORKER_ROLE` (as PM does, :45-49) and gate the OFFER on
`contact.type === 'partner' && isCaseworkerRole(contact.role)` from the STORED
contact.

## LOW

F-R4-16. "One constant, `CASEWORKER_ROLE`, beside `PROPERTY_MANAGER_ROLE`"
(D16) spans two workspaces. The server constant lives at
app/src/services/extraction/contactKinds.ts:4; the dashboard keeps its own
copy (`PM_ROLE`, contactProfile.ts:11) and cannot import app code at runtime.
B needs a dashboard `CASEWORKER_ROLE` and `isCaseworkerRole` (on the D4
normalizer mirror, orgCopy.ts:81-93) plus a mirror test in the
relayWindowCloseMirror.test.ts style. Placing the helper in contactProfile.ts
and importing orgCopy creates an import cycle (orgCopy.ts:24 imports
contactProfile); a separate small module avoids it.

F-R4-17. Typing a caseworker role on a tenant or landlord base stays possible.
D16 removes only the placeholder and the datalist entries; KindPicker's Other
role input still accepts "Case worker" and POST/PATCH still save it, so new
D19 targets keep being created (and KindPicker.test.tsx:95-115,
ContactCreateForm.test.tsx:109-163, ContactEditForm.test.tsx:214-231 and
contact-create.spec.ts:24-80 use exactly that as their custom-kind example).
If accepted, the plan should say so; if not, a hint under the Role input
pointing to the Caseworker choice is the small fix.

F-R4-18. Header facts after D21. Partner and team_member headers lose the
voucher/authority line (ContactDetail.tsx:1323-1335 else-branch covers them
today); Renee Carter's header currently shows her authority and will not. The
spec does not say whether a partner header shows anything instead (its
organization is the natural fact). No unit or e2e pin covers a partner's
facts line today, so nothing breaks; the plan should state the intended line.

F-R4-19. Issue housekeeping. docs/issues/staff-notes-on-landlord-partner-files.md
(open) asks for the card on landlord AND partner files; B builds the partner
half (Cameron confirmed). The plan should update the issue body/status (landlord
half stays open) in the same change. Wiring note: PartnerFile is rendered
without `onContactUpdated` (ContactDetail.tsx:1097-1108), which StaffNotesCard
needs to be editable (StaffNotesCard.tsx:31-32).

F-R4-20. Another type picker exists. Email triage's create-contact offers
Tenant / Landlord / Partner with no role (EmailTriage.tsx:213,
endpoints.ts:748-761). D16's Caseworker choice does not reach it; such
partners land in the Possible list. Acceptable, but the plan should list it as
a known entry point that does not offer Caseworker.

F-R4-21. KindPicker grows from five to six segments. Check the segment bar at
phone width (KindPicker.module.css) during self-QA. The placeholder line it
edits (KindPicker.tsx:170) carries a non-ASCII ellipsis today; the touched line
must become ASCII (AGENTS.md editing rule).

F-R4-22. The brief's "message catalog for new copy" does not apply to R4. The
catalog holds automated outbound messages only (app/src/messages/catalog.ts:1-4;
ContactDetail.tsx:1338-1340 states the dashboard-copy exclusion). Every new
string in this area is staff-facing dashboard copy; GLOSSARY.md is the place
that changes (`caseworker`, `organization (of a caseworker)`, per spec section
3, beside the `partner` entry at GLOSSARY.md:220-228).

F-R4-23. Mutation catalog count. mutationCatalog.test.ts:378 pins 118 with a
running comment (:365-377). The count goes up by one per new POST FUNCTION,
not per route: one `caseworkerReview(contactId, body)` function is +1, a
`makeCaseworker` / `dismissPossibleCaseworker` pair on the same path is +2.
The plan should fix the function names so the catalog entries
(mutationCatalog.ts, beside :90) are written once.
