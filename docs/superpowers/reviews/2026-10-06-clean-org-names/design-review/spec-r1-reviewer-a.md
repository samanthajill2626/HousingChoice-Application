# Spec review r1 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(commit e78345f6). Read-only review of the spec against the repository at the
same commit. Every claim about current behavior below cites code read for this
review; anything not verified is marked UNVERIFIED.

Verified as accurate (no finding): the 23-spelling / 13-name alias map with 4
agencies (`app/src/lib/housingAuthority.ts:34-58`); `HOUSING_AUTHORITY_VOCAB`
adding College Park (`app/src/services/extraction/schema.ts:59-81`); the 8 + 4
dashboard suggestions (`dashboard/src/routes/contact/orgVocabulary.ts:17-30`);
exact-match audience resolution on `byHousingAuthority`
(`app/src/services/audienceResolution.ts:117-142`); case/underscore-folded facet
grouping (`dashboard/src/routes/contacts/tenantFacets.ts:117-119`); the prompt's
"NOT exhaustive" rule (`app/src/services/extraction/prompt.ts:55-62`); accept
writing the suggestion text as-is (`app/src/services/suggestionResolution.ts:133-148,262-284`);
KindPicker clearing the role on Partner and offering only Tenant/Landlord bases
(`dashboard/src/routes/contact/KindPicker.tsx:32-43,96-111`); tenant-only seed
and explicit-list fences (`app/src/routes/broadcasts.ts:413-423,743`); both
`tenant_1to1` fan-out mint sites (`app/src/jobs/broadcastFanOut.ts:871,1386`);
contacts POST ignoring `housingAuthority`/`agency` (`app/src/routes/contacts.ts:775-950`);
public intake not writing these fields (`app/src/routes/public.ts`, no match).

---

## 1. [HIGH] Non-tenant contacts hold `housingAuthority`/`agency`, but rename, merge, usage counts, delete and kind-change are scoped to tenants, and the cleanup sheet cannot tell a partner from a tenant

**What is wrong.** The spec treats `contact.housingAuthority` and
`contact.agency` as tenant fields. D10 rewrites "every tenant
(`housingAuthority`, `agency`)"; section 6 usage counts are "tenants by housing
authority, tenants by agency"; delete and kind change are gated on those counts.
But non-tenant contacts carry these fields today, by three writers:

- The lean seed's partner Renee Carter has `housingAuthority: 'atlanta_housing'`
  (`app/src/lib/seed/lean.ts:158-177`).
- The importer writes `housingAuthority` for EVERY imported person from the
  Airtable tenant row's voucher program, regardless of the resolved type
  (`app/src/lib/import/apply.ts:914`, written unconditionally at `:1019-1022`),
  and the importer types caseworker rows as `partner`
  (`app/src/lib/import/merge.ts:409-413`). Whether prod partners actually hold
  values is UNVERIFIED, but the code path writes them.
- The contacts PATCH accepts both fields for any type (no type gate,
  `app/src/routes/contacts.ts:631-646`); a tenant re-typed to partner/landlord/
  unknown keeps them.

The byHousingAuthority GSI is hash-only and includes every type
(`app/src/repos/contactsRepo.ts:1166-1179`; the "Tenants only" comment at
`app/src/lib/tables.ts:95-100` is a convention, not enforced).

**Consequences inside the spec's own mechanisms.**

- Rename/merge leaves every non-tenant holder on the old name (now a spelling),
  silently breaking I1. Usage counts omit them, so "Delete is allowed only when
  nothing uses the entry" and the kind-change gate both pass while records still
  hold the name - the stated integrity guarantees do not hold.
- Staff cannot see or fix these values: the edit form renders Housing authority
  and Agency only for tenants (`dashboard/src/routes/contact/ContactEditForm.tsx:517-550`),
  PartnerFile omits them (`dashboard/src/routes/contact/PartnerFile.tsx:1-9`);
  only the header shows the authority for non-landlords
  (`dashboard/src/routes/contact/ContactDetail.tsx:1225-1238`), and branch B's D19
  hides that too.
- The cleanup sheet is "ONE ROW PER DISTINCT VALUE AND FIELD" (section 8) while it
  reads "every contact's" values. A caseworker partner whose `housingAuthority`
  holds "Hope Atlanta" gets the tenant-shaped action `move to agency`, so the
  apply writes the partner's organization into `agency` - a field no partner
  surface renders - and D9 makes the importer do the same on every run. Branch B
  then never migrates it: D15/D17 set `organization` only for tenants converted
  by Make caseworker.

**Implies.** The spec must decide what a non-tenant's `housingAuthority`/`agency`
means (migrate to B's `organization`, clear, or keep), and the rewrite, usage,
delete/kind-change gates and cleanup actions must cover every contact type (or
the cleanup must emit per-type rows). Branch B's `organization` has the same
hole: D10 rewrites only "(B) caseworker (`organization`)", but D15 lets any
partner hold an organization.

---

## 2. [MEDIUM] The spec misdescribes the importer's unit-side write as "fill-only"; `updated_at` is the importer's human-ownership signal and the spec's machine writers never say whether they stamp it

**What is wrong.** Section 1.2 says the importer's "unit-side write only fills an
empty list" and D9 says it is "already fill-only". It is not. For an
import-owned unit (no `updated_at`) every property fact, `accepted_authorities`
included, is SET unconditionally on every run
(`app/src/lib/import/apply.ts:1349-1359,1397-1403`); only a human-owned unit
(has `updated_at`) gets `if_not_exists` (`:1404-1414`), and `if_not_exists`
fills an ABSENT attribute, never an empty stored list. The ownership rule is
documented at `:1251-1270`: "`updated_at` is the line ... an exact 'a person has
touched this row' signal". `unitsRepo.update` stamps `updated_at` on every write
(`app/src/repos/unitsRepo.ts:566-594`).

**Implies.** The cleanup script and the D10 rewrite job are machine writers to
units. If they go through `unitsRepo.update` (the obvious path), every unit they
touch flips permanently to human-owned and later re-imports stop correcting its
beds, baths, address, notes and landlordId. If they bypass it, the plan must say
so. The spec names neither the signal nor the choice. Related importer gaps the
"fill-only" rule leaves open: `housingAuthority` is cleared by REMOVE (GSI key,
`app/src/routes/contacts.ts:631-636`), so `if_not_exists` cannot tell "never set"
from "staff cleared it" and a re-import re-fills a deliberate clear; a cleared
`agency` persists as `''` (`dashboard/src/routes/contact/TenantFile.tsx:192-197`),
which `if_not_exists` treats as present, so D9's "written to Agency when Agency
is empty" never fills it.

---

## 3. [MEDIUM] Draft blasts: the spec names a field and an endpoint that do not exist, and the cleanup never touches drafts although send re-resolves the stored filter

**What is wrong.**

- The field is `audience_filter.housing_authority`
  (`app/src/repos/broadcastsRepo.ts:84-86`, parsed at
  `app/src/routes/broadcasts.ts:107-138`), not "`filter.housingAuthority`"
  (sections 5.2, D10, I1, 9).
- Section 9 lists "broadcasts create/PATCH". The PATCH replaces only
  `seedContactIds` (`app/src/routes/broadcasts.ts:955-990`); there is no
  draft-update endpoint at all - the composer recreates a draft on every
  material change (`dashboard/src/routes/broadcasts/useComposerDraft.ts:1-6`).
  The filter is written only by POST.
- Saved drafts persist and can be resumed (`useComposerDraft.ts:13-16`), and the
  filter-mode send re-resolves the STORED filter at send time
  (`app/src/routes/broadcasts.ts:786-796`).
- The cleanup (section 8) reads only contacts and units. The Settings counts
  count tenants, properties and caseworkers. So I1's carve-out ("values written
  before the cleanup applies, which the cleanup and the Settings page counts
  surface") is false for drafts: nothing surfaces or rewrites them.
- Seeds carry slug filters on a sent and a draft broadcast
  (`app/src/lib/seed/matrix.ts:1204-1254`); section 7's seed bullet does not
  mention broadcasts.

**Implies.** After the cleanup, a resumed pre-cleanup draft sends to an empty
audience (400 `empty_audience`) or, where some tenants were left on the legacy
value, silently to a partial one - the "under-reach with no report" the drift
issue calls the worst consequence. The cleanup needs a draft pass (draft status
only), and the spec needs the real field name and the real write surface (POST
only).

---

## 4. [MEDIUM] Soft-deleted records and the two restore routes are unenumerated; the natural readers for rename, merge and usage skip them

**What is wrong.** Contacts and units soft-delete and restore.
`listByType` excludes deleted contacts by default
(`app/src/repos/contactsRepo.ts:602-606,1136-1140`), `listByHousingAuthority`
always excludes them (`:1166-1179`), unit lists filter `deleted_at`
(`app/src/repos/unitsRepo.ts:449-452`). Restore is `POST /api/contacts/:id/restore`
(`app/src/routes/contacts.ts:2267`) and `POST /api/units/:id/restore`
(`app/src/routes/units.ts:1422-1436`). Neither D10, section 6 nor section 9
mentions deleted records or restore.

**Implies.** A rename/merge job or usage count built on the existing list/GSI
readers skips soft-deleted holders; delete passes the "nothing uses it" gate;
a later restore brings back a record holding a non-name, which an exact-match
blast on the new name never finds. Restore is exactly the "reopen" mutation
surface the invariant must enumerate.

---

## 5. [MEDIUM] The 60-second in-process cache has no cross-process or reseed invalidation

**What is wrong.** Section 5.1: "App and worker each cache the item in process
for 60 seconds ... dropping the cache on their own writes." App and worker are
separate processes in prod (`docker-compose.yml:39-56`,
`infra/modules/ec2/main.tf:1`) and in every e2e lane ("hermetic e2e lanes spawn a
REAL worker process", `app/src/repos/settingsRepo.ts:70-73`). A write by one
never reaches the other's cache. `POST /__dev/reseed` wipes every table,
`settings` included (`app/src/lib/devReset.ts:101-108`), and clears only the
session-epoch cache (`app/src/routes/dev.ts:325-333`); the worker's cache is not
reachable from that route at all. The cited pool-number cache is a pure TTL
closure with no invalidation (`app/src/routes/webhooks/twilio.ts:1425,1447,1500`).

**Implies.**

- e2e: after a reseed the worker resolves AI output against the PREVIOUS world's
  list for up to 60 s - including renames/deletes made by the new Settings e2e
  specs - and the app does too unless reseed is extended. This is the
  pass-alone / fail-in-suite cross-spec process-state class this repo has
  already paid for.
- The rename job runs in the worker and writes `lastRewrite`; the app can serve
  "running" for up to 60 s after completion, contradicting "the page shows the
  result counts when it finishes".

The spec must name the invalidation: reseed clears the app cache, and either the
worker's cache is invalidated (the existing worker-to-app event bridge only runs
one way) or worker-side readers that must be fresh (the rewrite job) bypass it.

---

## 6. [MEDIUM] A list-driven extraction prompt breaks the memoized prompt fingerprint, the run log's prompt identity, and the closed drop-reason vocabulary

**What is wrong.** D8 makes the system prompt include stored names and spellings.
Today `buildExtractionSystemPrompt()` is synchronous and parameterless, and
`extractionPromptFingerprint()` memoizes once per process because "both inputs
are module constants" (`app/src/services/extraction/prompt.ts:11-13,125-141`).
That fingerprint is stamped on every run (`app/src/adapters/extraction.ts:245-258`,
`app/src/adapters/extractionFake.ts:73`, `app/src/jobs/extraction.ts:550,623`)
and shown on System Status (`app/src/services/systemStatus.ts:235`). The prompt
file's own contract is "keep it verbatim and ASCII-only" (`prompt.ts:3`), but D10
lets any signed-in user add names and spellings. D8 also adds a new discard
branch ("an agency name is dropped ... logged (debug)") while the run log's
`DROP_REASONS` is a closed list of "Every discard branch a run can record"
(`app/src/services/extraction/runTypes.ts:24-38`).

**Implies.** After any list edit the recorded fingerprint no longer identifies
the prompt a run used, so the AI run log cannot attribute behavior changes to
list changes. The agency drop would be recorded under an existing reason (most
likely `invalid_value`), misstating the decision on an admin audit surface. The
spec must define the per-run fingerprint, how the list reaches the adapter (the
vendor SDK lives in `app/src/adapters`), how non-ASCII names are handled, and a
new drop reason with its dashboard label.

---

## 7. [MEDIUM] The rename/merge job has no concurrency rule, no recovery path, and a write condition that does not protect sent blasts

**What is wrong.**

- `lastRewrite` is one slot (section 5.1) and nothing forbids starting a second
  rename or merge while one runs. Interleaved jobs (rename A to B while merging B
  into C) can leave records on B after B stopped being a name.
- `failed` and the `skipped` count have no remediation: the item already says
  the new name, the old name is a spelling, and re-issuing the same rename is a
  no-op. Skipped records stay on the old name.
- "Every record write conditional on the record still holding the old name"
  does not include `status = draft` for broadcasts. A draft sent mid-job
  (`markSending`, `app/src/routes/broadcasts.ts:824-838`) can still have its
  filter rewritten, breaking "Sent blasts keep their historical filter".
- Merge does not say what happens to the merged-away entry's own spellings.
  Records holding them (pre-cleanup or `leave` values) become unresolvable if
  they are dropped.
- If the job finds tenants through the eventually consistent byHousingAuthority
  GSI, it misses just-written holders. Between the item update and job
  completion, blasts on the new name under-reach (the spec states this window
  for the cleanup, not for rename).

**Implies.** It needs a running-job lock (refuse while `lastRewrite.status` is
running), a resumable re-run, a draft-status condition, defined spelling
transfer on merge, and a base-table read (or a documented consistency choice).

---

## 8. [MEDIUM] Spelling governance contradicts itself: any signed-in user can set spellings at creation, and new spellings are never validated

**What is wrong.** D10 says editing spellings is admin-only, and D11 lists
spelling sources (starting list, cleanup decisions, admins). Section 6's add
endpoint `POST /api/organizations { kind, name, spellings?, notes? }` is open to
every signed-in user. Its only check is the 409 when the NAME equals a name or
spelling. D4's invariant that a spelling may not equal any entry's name is not
enforced on add, and nothing warns when a new spelling makes an existing unique
spelling ambiguous. D11 also omits D10's own source (renamed/merged names become
spellings), and PATCH `name` (rename) has no stated validation.

**Implies.** A VA adding, say, a new authority with spelling "DCA" silently
changes D4 resolution for every writer. "DCA" becomes ambiguous, so the AI
demotes it to suggestions, the importer stops writing it, D5 422s it, and the
cleanup's `map -> Georgia Department of Community Affairs` rows turn into
`needs decision`. Either add-time spellings are admin-only, or the API rejects
spellings that collide with names or create ambiguity.

---

## 9. [MEDIUM] The pickers have no defined behavior for a stored value that is not on the list; on properties a legacy member blocks every authority edit

**What is wrong.** The spec keeps non-list values around on purpose: `leave` and
undecided rows "are left exactly as they are", plus skipped rewrite records,
restored records and orphans from deleted entries. D6 never says how a picker
displays or removes such a value. The property edit form sends the WHOLE
`accepted_authorities` array whenever it changes
(`dashboard/src/routes/listing/ListingEditForm.tsx:154-167`), prefilled from
`authoritiesOf`, which synthesizes legacy `jurisdiction`
(`ListingEditForm.tsx:35-39`, `app/src/lib/unitFields.ts:283-291`). D5 does not
say whether an array is validated whole or only its new members.

**Implies.** Take a property the cleanup refused to empty (for example its only
member is an agency). Adding a real authority sends
`[legacy, new]`, D5 422s it, and the form shows only "Couldn't save - please try
again." (`ListingEditForm.tsx:198-200`). The properties staff most need to fix
become uneditable. The spec must define the legacy-value chip (shown, removable,
never re-sent) and the array validation rule.

---

## 10. [MEDIUM] The accept path has no way to carry the name staff pick in "Is this really new?"

**What is wrong.** D8: "Accepting a suggestion whose text is not a list name runs
the same 'Is this really new?' step ... the accepted value is always a list
name." That step offers "Use <closest name>". The accept endpoint carries only
the suggestion identity (`app/src/routes/suggestions.ts:109-146,203-209`;
`dashboard/src/api/endpoints.ts:1468-1480`). The plan is built from the stored
`suggestedValue` (`app/src/services/suggestionResolution.ts:262-284`), persisted
in a leased journal at `claim()`, and replayed by other requests
(`:640-656,675-700`). The ambiguous case ("AHA", which D8 tells the model to
return as said) is exactly the case where the written name differs from the
suggestion text.

**Implies.** A builder must pick one of two options, and the spec chooses
neither:

- Add a value override to the journaled replay protocol. A hand-picked value
  would then be recorded as `accepted`, which the codebase explicitly says
  corrupts the AI accuracy record (`app/src/routes/contacts.ts:1643-1649`).
- PATCH the contact instead, which supersedes the suggestion as
  `superseded_by_human_edit` (`:1630-1662`).

The spec must pick one. Placing the D5 check in `buildPlan` (before `claim()`) is
required so a refusal does not consume the suggestion.

---

## 11. [MEDIUM] "Uses" is undefined, and per-entry counts cannot surface values that resolve to no entry

**What is wrong.** I1's carve-out says pre-cleanup values are surfaced by "the
cleanup and the Settings page counts". The counts are per entry (D10: how many
tenants, properties and caseworkers "use it"). A value that resolves to no entry
(unknown, ambiguous, orphaned by a delete) has no row to be counted under, so
the Settings page cannot surface it. Nor does the spec define "uses":

- If it means exact name, deleting an entry whose SPELLINGS are still held by
  legacy or `leave` records passes the gate and orphans them.
- If it means D4 resolution, the rename rewrite (exact old name only) leaves
  spelling-holders on their legacy text forever while counting them as users.

**Implies.** Define "uses" once, use it for counts, the delete/kind gates and the
rewrite, and add an "unrecognized values" view (or drop the claim from I1).

---

## 12. [MEDIUM] Branch B: several writers and readers the caseworker design does not account for

- **Role-less partners are invisible to both lists.** D16 shows partners whose
  ROLE matches caseworker, and D17 scans TENANT contacts only. The importer
  creates caseworker partners with no role
  (`app/src/lib/import/merge.ts:409-413`; `upsertContact` writes no role,
  `app/src/lib/import/apply.ts:966-1022`). The AI path (unknown, then AI
  suggests partner with an "Identified as a caseworker" note, then "Mark as
  Partner") also yields role-less partners. Neither population appears anywhere
  in B.
- **The "Caseworker" preset vs AI verdicts.** `canonicalSuggestedContactKind`
  returns undefined for any partner with a role
  (`app/src/services/extraction/contactKinds.ts:8-24`). So picking "Caseworker"
  after an AI `partner` suggestion stamps `superseded_by_human_edit`, not
  `accepted` (`app/src/routes/contacts.ts:1669-1746`). D14 does not say whether
  Caseworker joins the canonical kind set the way Property Manager did.
- **The importer re-types on every run.** `#type = :type` is unconditional
  (`app/src/lib/import/apply.ts:967`). A re-import reverts Make caseworker and
  leaves a `partner_1to1` thread on a tenant, which breaks D19 and I2. The
  importer is not in B's writer list.
- **Hand-picked partners cannot be picked.** The composer's add-recipient
  candidates are tenants only (`dashboard/src/routes/broadcasts/BroadcastComposer.tsx:236`,
  `RecipientPreview.tsx:59`), yet D18 says hand-picked recipients may be
  partners. Section 10 lists only wording changes.
- **I2 has other mint sites.** Public intake mints `tenant_1to1` for any phone
  (`app/src/routes/public.ts:285`).
- **Make caseworker ignores tenant-owned records.** D17 converts a contact that
  may own placements, tours and listing sends as a tenant (placements `byTenant`,
  `tours.listByTenant`), and the spec does not say what happens to them.

---

## 13. [LOW] D7's premise is false by the spec's own mechanism

D7: "No tenant can hold a name that is not on the list, so adding one there is
meaningless." But section 8 leaves `leave` and undecided rows "exactly as they
are", and findings 4, 7 and 11 add more non-conforming holders. Today's free-text
composer input (`dashboard/src/routes/broadcasts/AudienceFilters.tsx:104-118`) is
the only way to target them. A picker without add makes those tenants
unreachable by every authority filter, with no report. The spec should say this
is accepted and where staff see those tenants.

## 14. [LOW] The item-size guarantee does not hold under the spec's own notes cap

Section 5.1: "even 500 entries stay far below DynamoDB's 400 KB item limit".
With `notes <= 2000 chars`, 500 entries is about 1,000,000 bytes of notes alone.
About 190 full-note entries already exceed 400 KB. Past the limit every org-list
write fails: adds, spelling edits, the rewrite job's `lastRewrite`, and cleanup
spellings. Lower the notes cap or state an entry ceiling.

## 15. [LOW] Clearing `housingAuthority` is not specified under D5

The 5.2 table says "`''` still clears" for `agency` only. D5 says anything that
is not an exact name or unique spelling "is refused". The edit form sends `''`
to clear (`dashboard/src/routes/contact/ContactEditForm.tsx:323-326`), and the
route maps it to null/REMOVE (`app/src/routes/contacts.ts:631-636`). Placing D5
before that mapping 422s every clear. The script writers (cleanup `clear` and
`move to agency`, D17 "cleared") must REMOVE, never SET `''`, on this GSI hash
key. The repo guard (`app/src/repos/contactsRepo.ts:513-534`) only protects
callers that use the repo, and the importer-style scripts use raw
`UpdateCommand`s.

## 16. [LOW] The cleanup can re-arm the missed-call intake auto-text

The auto-text fires only when all four intake facts are blank, and
`housingAuthority` is one of them
(`app/src/jobs/missedCallAutoText.ts:80,112-116`). `agency` is not. A
name-less tenant whose only fact was an agency or junk value in
`housingAuthority` (`move to agency` / `clear`) starts receiving the intake text
on the next missed call. Section 9 lists this reader but not this effect.

## 17. [LOW] The spec does not stand alone in four places

- Section 8 says "follow the D2 script". This spec's D2 is the starting-list
  decision; the reference is to share-skip-fix's D2
  (`app/scripts/enable-conversation-automation.ts:2`).
- Appendix A's Name column literally contains
  "Fulton County Housing Authority (pending Sam)". Seeds use `fulton_housing`
  (`app/src/lib/seed/cast.ts:328`, `app/src/lib/seed/matrix.ts:76,681`,
  `e2e/tests/scenarios/tenant-onboarding.spec.ts:129-136`), but section 7 gives
  mappings only for gwinnett and cobb, and Fulton may be removed (section 13).
- D1 cites `settingsRepo.ts` for a version-conditional idiom it does not have:
  it has create-only, monotonic and period-claim writes
  (`app/src/repos/settingsRepo.ts:413-484`). The read-and-bump precedent is
  `app/src/repos/conversationsRepo.ts:2067` /
  `app/src/repos/unitsRepo.ts:472-528`.
- D2 freezes an environment's list at first read. If Sam's section 13 answers land
  after the dev deploy, "Dev first" rehearses the cleanup against a different
  list than prod will get.
