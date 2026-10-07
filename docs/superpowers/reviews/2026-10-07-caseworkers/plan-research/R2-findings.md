# R2 findings - `contact.organization` across A's org-list machinery

Plan research, branch feat/caseworkers @ 97ac55ee, spec rev 13 (D5, D6 (B),
D10 (B), D17, sections 6, 9, 10). Findings only; the surface map, the
invariant enumeration and the test inventory are reference material kept
outside the records path.

Severity: HIGH = unbuildable or self-contradictory as written; MEDIUM = a
builder must guess and a wrong guess ships a defect; LOW = wording or a
precision the plan should pin.

---

## F1 (HIGH) - the usage counts cannot express D10/D17's two different "in use" rules

The spec asks for two different counts and names one wire change:

- D10 (spec :504-506) and D17 (spec :684-689): Delete is refused while ANY
  record uses the entry, counting DISTINCT records ("one record can appear in
  two columns, and Delete's refusal counts distinct records"); a kind change is
  refused only by holders in a field of the entry's KIND - organization
  holders do not block it, deleted records included ("the delete and
  kind-change checks count both", spec :456-457).
- Section 6 (spec :1055-1058): usage "gains an `organization` count per entry".

A's code cannot carry either rule with one more column:

- `OrgUsage` holds ONE `deleted` number for all fields
  (`app/src/services/orgRecords.ts:97-100`, filled at `:415`). A deleted
  contact holding the name ONLY as its organization lands in `deleted`, so a
  kind change would be refused by it - contradicting D17.
- Columns are per field, so a record holding the name in `housingAuthority`
  AND `organization` counts twice; `refuseWhileUsed` sums the columns
  (`app/src/routes/organizations.ts:116-123`) and serves BOTH the kind change
  (`:288`) and Delete (`:301`), so the 409 `uses` body (D10: "says how many
  deleted records hold the name") overstates.
- The dashboard decides Delete and Change kind client-side from the column
  SUM (`dashboard/src/routes/orgs/orgCopy.ts:590-592` `usageTotal`, used at
  `dashboard/src/routes/settings/OrgEntryDialogs.tsx:447` and `:503`, and in
  the sentence at `:110-113`). A distinct-record count cannot be rebuilt from
  per-field columns.

The plan must define the wire: for example per entry the per-field columns
for display PLUS two server-computed distinct totals - `inUse { active,
deleted }` (any field, organization included: Delete) and `kindLocked {
active, deleted }` (fields of the entry's kind only: Change kind) - with
`refuseWhileUsed` taking the mode and both dialogs reading the totals. It
should also say whether the "Organization column" (D17, spec :682) is a new
table column or a part of today's single "Used by" cell
(`dashboard/src/routes/settings/OrgListSection.tsx:93-95`, `:112`).

## F2 (MEDIUM) - Run again / the job's claim derive the target kind from `fields[0]`

`rewriteTargetKind` (`app/src/services/orgRewrite.ts:188-201`) returns, for
rename/merge/use, `(def.field ?? def.fields[0]) === 'agency' ? 'agency' :
'housing_authority'` (`:199`). D17 covers the organization `use` case ("Run
again and the job's claim re-validate an organization Use target against
both kinds"), but not rename/merge: once `recordFieldsForKind`
(`app/src/services/orgRecords.ts:172-175`) adds `organization`, an agency
rename stored as `['organization', 'agency']` reads as a housing-authority
target, so every Run again answers 409 `org_rewrite_target_gone` and every
lapsed claim records it failed (`orgRewrite.ts:276-287`, `:561-563`). The
plan must either pin organization as the LAST member (and test the order) or
stop deriving the kind from field order (store or derive it from the
non-organization field).

Related behavior change to state and pin: `revalidationProblem` unions the
accepted kinds of every stored field (`orgRewrite.ts:228`). With
organization in a housing-authority rename's `fields`, the union becomes BOTH
kinds, so such a rename is now also refused when its old name has since
become an AGENCY name. That is the correct guard (the organization pass would
rewrite those holders) but it is new behavior for an A rewrite shape.

## F3 (MEDIUM) - the kind choice in the two organization-mode "add" flows is unspecified

D6 (spec :358-360): the organization-mode "Is this really new?" "asks the
kind before 'Yes, add it'"; D17 (spec :690-691) and section 6 (spec
:1052-1054): an organization row's Add as new has "staff pick the kind". The
spec does not say whether the kind is preselected (and which), or a required
choice with the add disabled until made. A default silently files a new
employer under the wrong list (D19's "agency first" ruling is about deriving
a conversion's organization, not this). Recommend: no default; "Yes, add it"
/ "Add as new" disabled until a kind is chosen. Affected: `NewOrgDialog`
takes one `kind` prop (`dashboard/src/routes/orgs/NewOrgDialog.tsx:42-67`,
check `:107`, add `:147`); the Settle dialog's add sends no kind
(`dashboard/src/routes/settings/NotOnListSection.tsx:317-329`) and words its
sentence with one kind (`:319`).

## F4 (LOW) - both-lists wording the spec leaves to the builder

Each of these reads one kind today and has no stated organization wording:

- the picker's add option: `KIND_NOUN[kinds[0]]` -> "Add X as a new housing
  authority" (`dashboard/src/routes/orgs/OrgPicker.tsx:242`, `:463`); D6 gives
  only the single-kind forms (spec :350);
- `orgListLoadError` -> "Couldn't load housing authorities" for both kinds
  (`dashboard/src/routes/orgs/orgCopy.ts:103-106`);
- `notOnListMessage` derives its noun from the field (`orgCopy.ts:338-351`,
  `:339`) - an organization ambiguity of two agencies would say "housing
  authority";
- `NewOrgDialog` intro "Check that this housing authority ..." (`:205`) and
  its compound copy pointing to Split (`:292-298`), which an organization
  value is never offered (D17);
- `FIELD_LABEL` / `COUNT_LABEL` need an organization label
  (`orgCopy.ts:49-53`, `:535-541`).

## F5 (LOW) - `POST /api/organizations/check` with `kinds`: the request contract is open

Section 6 (spec :1050-1051) adds an optional `kinds`; "`kind` alone keeps
today's single-list behavior". Unstated: both `kind` and `kinds` sent;
neither (today 400, `app/src/routes/organizations.ts:179-182`); an empty,
duplicated or single-member `kinds`; `spellingFor` together with `kinds`
(the spelling problem is target-based, `app/src/services/orgNames.ts:265-269`,
so it is kind-independent). Recommend: exactly one of `kind` / `kinds`, `kinds`
a non-empty subset of the two kinds, 400 otherwise.

## F6 (LOW) - the resolve body's `kind`: presence rules are open

Section 6 (spec :1052-1054) adds `kind` "for `action: 'add'` on an
`organization` row". Unstated: a missing `kind` on that request (400 is the
only safe answer - `resolveNotOnList` would otherwise fall back to the
field-derived kind, `app/src/services/orgRewrite.ts:446`, i.e. housing
authority), and a `kind` sent on any other field or action (refuse 400, or
ignore). A `use` on an organization row needs no kind: names are unique across
kinds (D4), but `named()` must search both kinds (`orgRewrite.ts:467-475`,
`:525`).

## F7 (LOW) - the conversion's carry test has no existing helper, and the obvious one is wrong

D19 (spec :845-849): carried text must pass D13's limits - at most 120
characters, no control or invisible characters, not empty after
normalization. The nearest helper, `checkNewOrgName`
(`app/src/services/orgNames.ts:92-99` over `app/src/lib/orgNames.ts:342-359`),
also refuses a TAKEN name and a COMPOUND text, which D19 does not list. A
compound agency text ("DCA HUD-VASH") is therefore carried and later settled
with Use or Clear (no Split for organization, D17); the plan should say the
carry test is composed from `hasOrgControlChar` (`services/orgNames.ts:68-77`),
`ORG_NAME_MAX` and `normalizeOrgText(text) !== ''`, and pin the compound case.

## F8 (LOW) - dashboard one-kind assumptions the spec's D17 list does not name

D17 (spec :681-693) names the server-side one-kind spots; these client spots
would ship silent defects if missed:

- `ContactEditForm` routes the dialog's answer by the ENTRY kind
  (`dashboard/src/routes/contact/ContactEditForm.tsx:141`, `:208-213`): an
  agency picked in the partner Organization dialog would land in the tenant
  Agency state, not Organization. Route by field.
- Its 422 handler shows the refusal under a picker only for `housingAuthority`
  / `agency` (`:143-146`, `:462-468`); an organization 422 becomes "Couldn't
  save - please try again."
- The Settle dialog looks up the Remember-this-spelling target within ONE
  kind (`NotOnListSection.tsx:246-249`): Use of an agency name on an
  organization row finds no target, so Remember disappears with no reason
  shown. Its "Name to use" picker (`:377-386`) and the compound-half Use
  buttons (`:83`) also offer one kind.

## F9 (INFO) - the cleanup script needs no change; one doc line

`app/scripts/clean-org-names.ts` reads and writes only `housingAuthority`,
`agency` and `accepted_authorities` (`:82`, `:186-246`, `:527`; its lock lists
those three, `app/src/services/orgRewrite.ts:585`) and already ran on dev and
prod. Run after B deploys it is safe: it never reads or writes
`organization`; a converted caseworker holds no authority and an empty
agency, so it has nothing to do there; the conversion's commit and the
cleanup's conditional writes guard each other. Its dry run is no longer a
complete preview of "Not on the list" (organization rows are absent). Section
11's "Branch B: deploy only. No script." holds; a docblock line and a RUNBOOK
sentence saying the script ignores `organization` are enough.
