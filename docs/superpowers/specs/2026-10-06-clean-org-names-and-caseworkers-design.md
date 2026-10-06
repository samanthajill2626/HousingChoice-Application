# Clean housing authority and agency names, and caseworkers - design

Date: 2026-10-06 (revision 2, after adversarial design review round 1 -
adjudications in
`docs/superpowers/reviews/2026-10-06-clean-org-names/design-review/adjudications.md`).
Tracker items #2 ("One clean name per housing authority") and #19
("Caseworkers"), built together under one approved estimate (10-15 hours of
Cameron's time, approved by Sam on Sep 30).

Two branches, built in order:

- **Branch A - `feat/clean-org-names`** (worktree `W:\tmp\clean-org-names`):
  the stored lists, the one name check, the pickers, the blast composer
  picker, the AI and importer changes, the Settings page (including the "Not
  on the list" view), seeds and tests on real names, and the one-time cleanup
  script. No send-path change.
- **Branch B - `feat/caseworkers`** (cut from `main` after A merges): the
  Caseworker choice, the caseworker's organization, the Caseworkers tab, the
  possible-caseworkers review, and direct property shares to partners (the
  send-path change).

This document is the design for both. Branch B gets its own implementation
plan, written after A merges, against A's real code.

---

## 1. Problem

### 1.1 What Sam asked for

- **#2:** one clean name per housing authority instead of every spelling a
  text message produced; the housing authority field holds only the
  organization that runs the voucher, never a helper agency. Sam sent a list
  of housing authorities and a list of agencies (Sep 30). Both lists grow:
  staff add a name when one comes up, the platform asks whether it is really
  new so "AHA" never becomes a second Atlanta Housing Authority, and the AI
  makes the same check. Properties list the housing authorities they accept
  (several allowed), never agencies. Existing values are cleaned up once, and
  agency names move out of the housing authority field into Agency.
- **#19:** caseworkers easy to tell apart and find; each caseworker belongs
  to an organization; a list of all caseworkers with a filter by
  organization; property shares to caseworkers from the right-hand panel, the
  same as tenants, with the normal share message; caseworkers who were saved
  as tenants are listed for Sam to confirm, then converted. Decided Sep 29/30:
  caseworkers stay `partner` contacts with a Caseworker role (no new contact
  type).

### 1.2 What the platform does today

- Housing authority and agency names are free text. Three hand-kept copies of
  a name list exist and disagree: the alias map in
  `app/src/lib/housingAuthority.ts` (23 lowercase spellings to 13 names, 4 of
  them agencies), the AI's hint list `HOUSING_AUTHORITY_VOCAB` in
  `app/src/services/extraction/schema.ts` (adds "College Park", which the
  alias map does not know), and the form suggestions in
  `dashboard/src/routes/contact/orgVocabulary.ts` (8 authorities, 4
  agencies). Only the importer and the AI use the alias map; the tenant edit
  form, the property forms and the blast composer store any text.
- The fields are not tenant-only in data: the contacts PATCH accepts
  `housingAuthority` and `agency` on any contact type
  (`app/src/routes/contacts.ts`), the importer writes the housing authority
  for every imported person whatever its type (caseworker rows are typed
  `partner`), and the lean seed's partner holds one. The `byHousingAuthority`
  GSI holds every type; "tenants only" is a convention.
- Blasts filter tenants with an exact match on the `byHousingAuthority` GSI
  (`app/src/services/audienceResolution.ts`), so two spellings of one
  authority are two audiences that cannot see each other. The Tenants page
  and the Properties page group spellings case-insensitively (folding `_`) in
  the browser, so the pages show one group where blasts see two.
- The AI and the importer treat the four agency names (Hope Atlanta, HUD
  VASH, Claratel, Step Up) as KNOWN housing authorities and write them into
  `housingAuthority`. The importer SETs a contact's housing authority on every
  run (replacing staff edits) and SETs `type` on every run. On units it SETs
  every fact, `accepted_authorities` included, on a unit no person has edited
  (no `updated_at`), and fills only ABSENT attributes on a unit a person has
  edited (`app/src/lib/import/apply.ts`, the ownership rule documented
  there).
- The AI prompt tells the model the list "is NOT exhaustive and is not a
  permitted-values list"; an unknown name is demoted to a staff suggestion.
  Accepting a suggestion writes its stored text as-is
  (`app/src/services/suggestionResolution.ts`; the accept request carries only
  the suggestion's identity).
- Saved blast drafts store their filter in `audience_filter.housing_authority`
  (`app/src/repos/broadcastsRepo.ts`), written only by `POST
  /api/broadcasts`; a draft can be resumed, and its preview and send
  re-resolve the stored filter.
- Seeds use slugs (`atlanta_housing`, `ga_dca`, `dekalb_housing`,
  `fulton_housing`, `gwinnett_housing`, `cobb_housing`), including the
  broadcast filters in `app/src/lib/seed/matrix.ts`; about 20 e2e specs and
  many unit tests pin them or mint run-unique free-text names.
- Caseworkers are `partner` contacts with an optional free-text role
  ("Case worker"). The contact type picker cannot save one: picking Partner
  clears the role, and the "Other" choice offers only Tenant or Landlord as a
  base (`dashboard/src/routes/contact/KindPicker.tsx`), so existing "Case
  worker" roles sit on tenant- or landlord-based contacts. Imported caseworkers
  and caseworkers accepted from an AI type suggestion are partners with NO
  role. Partners have no organization field and no tab, and property sharing
  is tenant-only (`app/src/routes/broadcasts.ts` drops non-tenants in seed
  resolution and in the explicit send list; both fan-out sites in
  `app/src/jobs/broadcastFanOut.ts` mint `tenant_1to1` threads).

### 1.3 What the research found (Sam's list, vetted 2026-10-06)

The housing authority field answers one question: **which organization runs
this tenant's voucher** - where the RTA (or the program's unit request) goes,
who approves and inspects the unit, who pays the landlord, and whom staff
call about a voucher problem. Findings that shape the starting list (sources
in Appendix B):

- The **Georgia Housing Voucher Program** is a real, statewide, state-funded
  supportive housing voucher run by the Department of Behavioral Health and
  Developmental Disabilities (DBHDD). DBHDD's contractor pays landlords; the
  tenant's provider agency requests the unit inspection. It is on the list as
  "Georgia Housing Voucher Program (DBHDD)" (Cameron, 2026-10-06).
- The **Georgia Department of Community Affairs (DCA)** runs vouchers in 149
  of Georgia's 159 counties (not Fulton, DeKalb, Clayton, Cobb, Bibb,
  Chatham, Glynn, Muscogee, Richmond or Sumter).
- **HUD-VASH** is a national program, not a voucher issuer: the voucher comes
  from a housing authority and the VA provides the case manager. It is an
  agency entry, named without any city.
- **McDonough Housing Authority** runs public housing only (no vouchers);
  Henry County vouchers are DCA's. **Clayton County** vouchers are all run by
  Jonesboro Housing Authority; **Cobb County** vouchers by Marietta Housing
  Authority.
- Two abbreviations are shared: AHA (Atlanta, Augusta) and MHA (Marietta,
  Macon).

An **agency** is a government or nonprofit organization that helps a tenant
but does not hold the voucher or process the RTA (Cameron, 2026-10-06) - for
example a caseworker's employer, a community service board, or the VA for
HUD-VASH.

---

## 2. Goals and non-goals

### Goals

- G1. One stored list of housing authorities and one of agencies, used by
  every writer and every name entry: tenant edits, property forms, the blast
  composer, the AI, the importer, the cleanup, and (in B) caseworkers.
- G2. Every stored housing authority, agency and (B) organization value
  WRITTEN after the deploy is a name on the list of the right kind - enforced
  on the server for every writer.
- G3. Staff can see and manage the lists on a Settings page, including every
  stored value that is not on the list.
- G4. A dry-run-first cleanup maps existing values to list names
  automatically; the rest is settled on the Settings page.
- G5. (B) Caseworkers as partner + Caseworker role, with an organization, a
  tab with an organization filter, direct property shares, and a confirm list
  for caseworkers saved as tenants or as role-less partners.

### Non-goals (explicitly out of scope)

- Suggesting a property's housing authorities from its address (county and
  city limits). Filed as a follow-up issue (section 12).
- The AI filling the tenant's Agency field, or adding names to the list on
  its own (Work Package 2 may revisit; until then the AI only suggests).
- Blasts (filter-resolved audiences) to partners or caseworkers, and adding
  partners through the blast composer's recipient search. Audience rules
  belong to tracker #6.
- The /join housing authority dropdown (tracker #14; it will read this list),
  and the public intake routes' `tenant_1to1` thread for a phone that belongs
  to a partner (tracker #13 owns sign-ups from existing contacts).
- A new contact type for caseworkers.
- Storing organization IDs on records instead of names.
- The tenant's free-text `caseworker` attribute shown on tour and placement
  pages (written only by the lean seed); B does not touch it.
- The A2P campaign documents.

---

## 3. Vocabulary (GLOSSARY.md changes, both branches)

- **housing authority** - REWRITTEN: the organization that runs a tenant's
  voucher (receives the RTA or the program's unit request, approves and
  inspects the unit, pays the landlord). Usually a public housing authority;
  the Georgia Housing Voucher Program (DBHDD) is the one listed entry that is
  a state program rather than a housing authority. Staff label stays
  "Housing authority"; its help text reads "The organization that runs the
  voucher". For a tenant who ports, it is the authority that administers the
  voucher where they lease. Values are names from the housing authority list.
- **agency** - REWRITTEN: a government or nonprofit organization that helps a
  tenant but does not hold the voucher or process the RTA. Values are names
  from the agency list.
- **organization list** (NEW) - the two stored lists (housing authorities,
  agencies) with their alternate spellings and notes; managed on Settings >
  Housing authorities & agencies.
- **alternate spelling** (NEW) - an abbreviation or other spelling that finds
  a listed name (AHA, HADC, DBHDD). A spelling may belong to more than one
  name of the same kind; such a shared spelling is never applied
  automatically.
- **not on the list** (NEW) - a stored value that is not exactly a listed
  name (old spellings, unknown text, values left by the cleanup). Shown on
  the Settings page until staff settle it.
- **caseworker** (NEW, branch B) - a `partner` contact whose role is
  "Caseworker", with an organization from either list.
- **organization (of a caseworker)** (NEW, branch B) - the housing authority
  or agency a caseworker works for: `contact.organization`.

---

## 4. Decisions

### Storage and matching

D1. **Storage: one item in the existing `settings` table.** Item id
`org-list`. No new table, no Terraform. Shape in section 5.1. A new sibling
repo owns it (settingsRepo's helpers are not a generic record API). Writes
are read-and-bump: read the item, change it, write it conditionally on
`version = :expected` (and `version + 1`), retry on a lost condition - the
read-and-bump pattern of `app/src/repos/conversationsRepo.ts` and
`app/src/repos/unitsRepo.ts`. **No in-process cache:** every reader does one
consistent GetItem of the item (it is small; readers are human-paced writes,
one read per AI run, and page loads).

D2. **The starting list seeds an empty store once.** The first read in an
environment that finds no `org-list` item writes the starting list
(Appendix A) with a create-only condition and returns it. From then on the
stored item is the only source; later edits to the starting list in code do
NOT reach an environment that already has the item. No environment holds
the item before branch A deploys there, and Appendix A is final before the
branch A plan is written (section 13), so dev and prod start from the same
list. Seeds (lean and full) write the item explicitly so test worlds are
deterministic, and the dev reseed's wipe of `settings` is followed by that
seed write.

D3. **Records store the full name, not an ID; "uses" means exact text.**
`contact.housingAuthority`, `contact.agency`, `unit.accepted_authorities[]`
and (B) `contact.organization` hold the entry's name text. An entry is USED
by a record exactly when the record's stored value (or a member of the unit's
list) is character-for-character the entry's name. Every existing reader (the
GSI, blasts, facets, the Properties summary, the flyer, similar units, the AI
context) keeps working unchanged. Consequence: renaming or merging an entry
rewrites the records that hold it (D11).

D4. **Matching rules (one server-side module).**
- Normalize for comparison only: lowercase; `&` to `and`; the characters
  `. , ( ) - / ' " _` to spaces; collapse whitespace; trim.
- A text whose normalized form equals an entry's normalized NAME matches that
  entry.
- A text whose normalized form equals an entry's normalized SPELLING matches
  every entry that carries it, counted WITHIN the kind(s) the field accepts
  (housing authority fields: housing authority entries; agency fields:
  agency entries; (B) organization: both). One entry = a match; two or more =
  ambiguous.
- Anything else is not on the list. "Close" names (shared words, initials,
  small edit distance) are computed only to offer choices in a prompt; they
  are never applied automatically.
- Names are unique across BOTH kinds (normalized). A spelling may not equal
  any entry's name (normalized). Spellings are unique within one entry
  (de-duplicated on write) and may be shared between entries of the same
  kind (AHA, MHA). Compound values ("DCA HUD-VASH") are never stored as
  spellings.

D5. **One server-side check for every writer.** When a writer SETS a value
that differs from what the record holds now, it resolves the text with D4
against the field's kind: an exact name is stored; a unique spelling (or a
name differing only in case or punctuation) is stored as its entry's exact
name; anything else is refused with HTTP 422 `org_not_on_list` `{ field,
text, candidates, close, otherKind? }` (`otherKind` names an entry of the
other kind that the text matches). Rules for partial and empty writes:
- A scalar field is checked only when its value changes. Clearing is always
  allowed: `housingAuthority: ''` REMOVEs the attribute (it is a GSI key and
  is never SET to `''`), `agency: ''` keeps today's stored `''`.
- `accepted_authorities` is checked per member: members the unit already
  holds (exact text), or equal to the unit's legacy `jurisdiction`, pass
  unchanged; only new members must resolve. Members are trimmed and
  de-duplicated.
- Scripts and jobs follow the same rules and REMOVE (never SET `''`) the
  housing authority.
The full list of writers is in section 9; the plan must cover each one.

### Forms, composer, AI, importer

D6. **Forms use a picker, with an add step.** Tenant Housing authority and
Agency, property Housing authorities (several), and (B) caseworker
Organization become a type-to-search picker over the list. Typing matches
names and spellings, so typing AHA shows both Atlanta Housing Authority and
Augusta Housing Authority, and staff pick. When nothing matches, the last
option is "Add <text> as a new housing authority" (or agency). Choosing it
opens "Is this really new?": the closest names are offered first ("Use
Atlanta Housing Authority"), and "Yes, add it" creates the entry (name and
notes only; spellings are admin-only, D12). When the text matches an entry
of the other kind ("HUD-VASH is an agency"), the dialog says so and, on the
tenant form, offers to put it in Agency instead. Property forms add only
housing authorities. (B) A caseworker's organization can add either kind;
the dialog asks which. A stored value that is not on the list shows as a
removable chip marked "Not on the list"; saving never fails because of an
unchanged value (D5).

D7. **Blast composer: the picker without the add step.** Composer filters
can only name list entries. A tenant whose stored value is not on the list is
not reachable by a housing authority filter until that value is settled on
the Settings page (D10), which lists every such value with its count. A
stored draft filter is re-checked at preview and at send: a value that is not
exactly a current list name is refused with 422 `org_not_on_list` and the
composer asks for a new pick (sent blasts keep their historical filter;
nothing rewrites broadcasts). Prefilling from the property and multi-authority
rules stay with tracker #6.

D8. **AI: list-aware, suggestion-only for anything new.**
- The extraction SYSTEM prompt stays a static template, so its memoized
  fingerprint keeps identifying it (its text changes once, to describe the
  list block). The list rides in the USER content as a block - the housing
  authority names with their spellings, then the agency names under "not
  housing authorities" - passed to the adapter through the extraction input;
  the extraction job reads the store once per run. Each run records the
  list's `version` in the AI run log beside the prompt fingerprint.
- The model is told: return the full name from the list; when an
  abbreviation belongs to more than one name, pick the one the conversation
  supports or return the text as said; agency names are never housing
  authorities.
- The apply layer resolves the returned text with D4: a match is handled
  exactly as a known authority is today (write an empty field, suggest a
  change); ambiguous or unknown text becomes a staff suggestion (as unknown
  names do today); an agency name is dropped from `housingAuthority`,
  recorded with the new drop reason `agency_not_authority` (dashboard label
  "Agency, not a housing authority"), never written.
- Accepting a housing authority suggestion: the accept request gains an
  optional `value`, checked with D5 while the plan is built - BEFORE the
  suggestion is claimed, so a refusal does not consume it - and stored in the
  replayable plan. The dashboard opens "Is this really new?" when the
  suggestion's text is not exactly a list name:
  - the text resolves to one name, or staff pick one of its ambiguity
    candidates, or staff add the text as a new name: accept with that value;
    the verdict is `accepted`;
  - staff choose a DIFFERENT name ("Use <close name>"): the contact field is
    edited the normal way and the suggestion is superseded
    (`superseded_by_human_edit`, as today);
  - the text is an agency name (a suggestion created before the deploy):
    the dialog says so and offers Dismiss.
- The AI never adds to the list and never fills Agency (non-goals).

D9. **Importer: same check, no overwrites.** The importer resolves each
value with D4. Contact side: `housingAuthority` is written only when the
attribute is absent (`if_not_exists`; a staff clear REMOVEs it, so a later
re-import can re-fill it - accepted); an agency name found in the housing
authority column is written to `agency` when `agency` is absent; ambiguous or
unknown values are not written and are listed in the import report with
counts. Unit side: the existing ownership rule is unchanged (import-owned
units are rewritten each run, human-owned units fill absent attributes); the
values it writes are resolved names, and agency names are never written to a
unit. (B adds a `type` rule to the importer, D20.)

### Settings page

D10. **Settings > "Housing authorities & agencies".** A new Settings tab,
visible to every signed-in user, with three sections:
- **Housing authorities** and **Agencies**: each row shows the name, its
  spellings, its notes, and how many records use it (D3) - tenants and other
  contacts, properties, (B) caseworkers - counting active records (deleted
  records are counted only for the delete and kind-change checks).
- **Not on the list**: every distinct stored value, across all contact types
  and properties (deleted included), that is not exactly a listed name - one
  row per value and field, with its record count, the field, and its D4
  resolution (one name, several candidates, the other kind, or nothing). No
  names of people. "Show records" opens the Tenants or Properties page
  filtered to that value.
- Everyone: view; add an entry (name and notes, through "Is this really
  new?"); edit an entry's notes.
- Admins only (`requireRole('admin')` on the server): edit spellings, rename,
  merge into another entry of the same kind, delete, change kind, and the
  "Not on the list" actions: **Use <name>** (rewrite every record holding the
  value to that name; the value becomes a spelling of it unless it is shared
  or compound), **Move to Agency as <name>** (housing authority values that
  match an agency: move to `agency` where `agency` is absent or `''`; records
  whose `agency` holds something else are counted as conflicts and left),
  **Add as new** (create the entry, from the value or a corrected name, then
  Use it), and **Clear** (remove the value from those records).
- Delete is allowed only when no record (deleted records included) uses the
  entry; kind change likewise.
- Editing spellings or notes touches no records.

D11. **The rewrite job (rename, merge, and the "Not on the list" actions).**
- One rewrite at a time: a new one is refused (409 `org_rewrite_running`)
  while `lastRewrite.status` is `running` and its heartbeat is under 15
  minutes old.
- Order: ONE conditional write of the list item changes the list (rename,
  merge, new spelling) and sets `lastRewrite` to `running` with the rewrite's
  definition (from-texts, to-name, fields, action); then the job is enqueued
  (`jobs.enqueue`). An enqueue failure sets `lastRewrite` to `failed`. A
  `failed` rewrite, or a `running` one whose heartbeat is older than 15
  minutes, shows "Run again" (admin), which re-enqueues the same definition.
- The job reads base tables, not the GSI: every contact of every type, active
  and deleted, and every unit, active and deleted. It rewrites each value or
  list member whose normalized text is in the from-texts, conditional on the
  record still holding the text it read; unit lists are de-duplicated after
  the rewrite; the housing authority is REMOVEd on Clear. Machine writes never
  stamp `updated_at` on units (the importer's human-ownership signal). The job
  never touches broadcasts.
- From-texts: rename = the old name; merge = the merged entry's name and its
  spellings that no other entry shares; Use <name> = the value.
- Merge moves the merged entry's name and spellings onto the target as
  spellings (spellings shared with other entries stay shared), then removes
  the merged entry. A renamed entry keeps its old name as a spelling.
- The job heartbeats `lastRewrite` and finishes with `done` and counts
  (records rewritten per field, skipped because a record changed meanwhile).
  Re-running a definition is safe: records already rewritten no longer hold
  the from-text. While a rewrite runs, a blast filtered on the new name
  misses records not yet rewritten (seconds to minutes).

D12. **Spellings are curated, never learned from form clicks.** Sources: the
starting list; admin edits on the Settings page; renamed and merged names
(D11); values settled with "Use <name>" (D10). An admin spelling edit is
refused when the spelling equals any entry's name; adding a spelling another
entry of the same kind already carries is allowed only with an explicit
confirm ("now shared with <name> - it will no longer be applied
automatically"). A rename's new name must not equal another entry's name or
spelling (it may equal one of the entry's own spellings, which is then
dropped from its spellings).

D13. **Notes per entry and size limits.** Notes are free text up to 500
characters, editable by everyone. An entry carries at most 20 spellings of at
most 100 characters each. A write that would make the item larger than 300 KB
is refused with 409 `org_list_full` (about 300 entries with full notes fit;
the starting list has about 20).

### Cleanup and side effects

D14. **The cleanup script applies automatic mappings only** (section 8). It
maps values that resolve to one name (D4), moves agency names out of housing
authority fields, drops agency names from property lists (unless that would
empty the list), and backfills `accepted_authorities` from legacy
`jurisdiction`. Everything else stays as it is and appears in the Settings
page's "Not on the list" section; the dry run lists those values with counts
so they can be reviewed before the deploy. The script has no merge mode and
no decisions file.

D15. **Agency counts as an intake fact.** The missed-call intake auto-text
(`app/src/jobs/missedCallAutoText.ts`) treats a contact with an `agency` as
known, so moving an agency out of the housing authority field does not
re-arm the intake text. A contact whose only fact was a junk value that staff
Clear is genuinely blank and may receive it (stated, accepted).

### Branch B

D16. **Caseworkers stay partners.** The contact type picker gains a
"Caseworker" choice that saves `type: partner, role: Caseworker`, the way
"Property Manager" saves `type: landlord, role: Property Manager`. No new
`ContactType`. The extraction kind canonicalizer
(`canonicalSuggestedContactKind`) treats partner + Caseworker as `partner`, so
accepting an AI "partner" suggestion through the Caseworker choice records
`accepted`.

D17. **Organization field on partners.** `contact.organization`, checked by
D5 against either list, edited on partner contacts. Shown on the partner page
and as the Caseworkers tab's filter. Counted and rewritten by D10 and D11.

D18. **Caseworkers tab.** Contacts gains a Caseworkers tab: partner contacts
whose role normalizes to "caseworker" or "case worker", with organization
filter chips built the way the Tenants page builds its housing authority
chips.

D19. **Possible caseworkers.** The Caseworkers tab shows a "Possible
caseworkers" list of contacts that are not yet caseworkers:
- tenants whose role mentions caseworker or case manager, whose notes carry
  the AI's "Identified as a caseworker" line or those words, or who are
  linked as another contact's caseworker relationship;
- partners with NO role (the importer's and the AI chip's caseworkers);
- tenant- or landlord-based contacts whose custom-kind role says caseworker.
Each row offers "Make caseworker" and "Not a caseworker" (dismissal is stored
on the contact, `caseworker_review: 'dismissed'`, and hides the row for good).
Make caseworker: refused (409) while the contact has an open placement or an
upcoming or unresolved tour as the tenant; otherwise sets type `partner`,
role "Caseworker", `type_source: manual`, `organization` from the contact's
agency or housing authority when either is exactly a list name (else left
empty for staff to pick), REMOVEs `housingAuthority`, clears `agency`, and
re-types the contact's open one-to-one thread to `partner_1to1` (D21). Past
tours, closed placements and listing sends stay as history.

D20. **Direct property shares to partners; no blasts.** A partner's page gets
the "Properties sent" card and its Send action, as tenants have; the
composer opens with the partner as its starting recipient and sends the
normal share (address and flyer link) into the partner's own conversation.
Starting (seed) and explicitly listed recipients may be tenants or partners;
filter-resolved audiences stay tenant-only, and the composer's recipient
search stays tenant-only. Every existing gate (opt-out per phone number,
unreachable, deleted, the kill switch, the just-in-time consent check)
applies unchanged. A share to a partner with no conversation creates a
`partner_1to1` conversation (both fan-out sites use the contact's type). The
property's "Sent to tenants" list becomes "Sent to", with partner rows
labelled by their role.

D21. **Type changes keep threads and imports consistent.** When staff change
a contact's type between tenant, landlord and partner (edit form, Caseworker
choice, Make caseworker), the contact's open one-to-one threads whose type
matches the OLD type are re-typed to the new type; a thread typed for some
other identity is left alone (today's triage-conflict rule). Staff type
changes stamp `type_source: manual`, and the importer no longer changes the
type of a contact whose `type_source` is `manual` (mirroring its status
rule). The contact header shows voucher size and housing authority only for
tenants.

---

## 5. Data model

### 5.1 The `org-list` settings item

```
{
  settingId: 'org-list',
  version: number,                 // incremented on every write
  entries: [
    {
      orgId: string,               // stable id (uuid), never shown
      kind: 'housing_authority' | 'agency',
      name: string,                // the stored full name (unique across kinds)
      spellings: string[],         // <= 20, each <= 100 chars
      notes?: string,              // <= 500 chars
      createdAt: string, createdBy: string,
      updatedAt: string, updatedBy: string,
    }
  ],
  lastRewrite?: {                  // the latest rewrite (D11)
    jobId: string,
    action: 'rename' | 'merge' | 'use' | 'move_to_agency' | 'clear',
    fromTexts: string[], toName?: string,
    fields: string[],              // which record fields it rewrites
    status: 'running' | 'done' | 'failed',
    heartbeatAt: string,
    counts?: Record<string, number>,  // rewritten per field, skipped, conflicts
    startedAt: string, finishedAt?: string, startedBy: string,
  }
}
```

### 5.2 Records

| Field | Kind accepted | Change |
|---|---|---|
| `contact.housingAuthority` (any type) | housing authority | checked by D5 when set; `''` REMOVEs |
| `contact.agency` (any type) | agency | checked by D5 when set; `''` stored as today |
| `unit.accepted_authorities[]` | housing authority | new members checked by D5; trimmed, de-duplicated |
| `contact.organization` (B, partners) | either | new |
| `contact.caseworker_review` (B) | - | new: `'dismissed'` |
| `contact.type_source` (B) | - | new: `'manual'` on staff type changes |
| broadcast `audience_filter.housing_authority` | housing authority | POST checked by D5; preview and send re-check (D7) |

The legacy `unit.jurisdiction` / `accepted_programs` tombstones stay accepted
and ignored on the unit PATCH (`docs/issues/retire-humanize-authority.md`);
the cleanup backfills `accepted_authorities` for units that have only
`jurisdiction`.

---

## 6. API

All under `/api/organizations`, signed-in staff unless marked admin.

- `GET /api/organizations` - both lists (5.1 entries) plus `lastRewrite`.
  `?usage=1` adds per-entry use counts (D3, D10).
- `GET /api/organizations/not-on-list` (admin) - the D10 section: distinct
  values, field, count, resolution. Computed on demand from base-table reads.
- `POST /api/organizations/check` `{ kind, text }` - the D4 resolution:
  `{ match?, candidates[], close[], otherKind? }`. No write.
- `POST /api/organizations` `{ kind, name, notes? }` - add. Refused 409
  `org_name_taken` when the name equals any entry's name or spelling (either
  kind), returning that entry.
- `PATCH /api/organizations/:orgId` `{ notes }` (everyone) or `{ spellings }`,
  `{ name }`, `{ kind }` (admin). `name` starts a rename rewrite; `kind` is
  refused 409 `org_in_use` while anything uses the entry.
- `POST /api/organizations/:orgId/merge` `{ intoOrgId }` (admin).
- `DELETE /api/organizations/:orgId` (admin) - refused 409 `org_in_use` while
  anything uses the entry.
- `POST /api/organizations/not-on-list/resolve` (admin) `{ field, value,
  action: 'use' | 'move_to_agency' | 'add' | 'clear', name? }` - starts the
  rewrite (D10, D11).
- `POST /api/organizations/rewrite/run-again` (admin) - D11.
- Suggestions: `POST` accept gains optional `value` (D8).

Existing endpoints that write the fields in 5.2 apply D5 and answer 422
`org_not_on_list`. Rewrite-starting endpoints answer 409
`org_rewrite_running` while one runs (D11).

---

## 7. Behavior by surface (branch A)

- **Tenant edit form:** Housing authority and Agency pickers (D6); help text
  under Housing authority: "The organization that runs the voucher".
  `orgVocabulary.ts` is replaced by the stored list.
- **Property New/Edit forms:** Housing authorities multi-picker (D6), housing
  authorities only; legacy members shown as "Not on the list" chips.
- **Blast composer:** housing authority filter picker without add (D7); a
  resumed draft with an off-list filter asks for a new pick.
- **Contact suggestions (AI):** D8.
- **Importer:** D9.
- **Settings:** D10-D13.
- **Missed-call intake text:** D15.
- **Tenants page, Properties page summary, flyer, similar units:** unchanged
  code; they show whatever names records hold. After the cleanup the flyer's
  "Accepts:" line shows full names (for example "Accepts: Atlanta Housing
  Authority").
- **Seeds:** every seed (lean, full cast, matrix, live, performance) uses list
  names, including broadcast filters; slugs are retired (`atlanta_housing` ->
  Atlanta Housing Authority, `ga_dca` -> Georgia Department of Community
  Affairs, `dekalb_housing` -> DeKalb County Housing Authority,
  `gwinnett_housing` -> Georgia Department of Community Affairs,
  `cobb_housing` -> Marietta Housing Authority, `fulton_housing` -> section 13
  item 1). Seeds write the `org-list` item. The lean world changes; e2e
  expectations follow.
- **e2e specs** that type free-text names or mint run-unique names pick list
  names or add their run-unique names through `POST /api/organizations` first.

---

## 8. The cleanup script (branch A)

`app/scripts/clean-org-names.ts`, modeled on
`app/scripts/enable-conversation-automation.ts` and its RUNBOOK section:

- `--env local|dev|prod`, `--lane <L>` (local only), `--apply`. Target
  resolution and guards through `app/scripts/lib/stageClient.ts` (account
  guard, pinned endpoint, refusal while any `AWS_ENDPOINT_URL*` is set).
  Unknown or repeated arguments exit 2.
- **The list it uses:** the environment's stored `org-list` item, or the
  starting list (Appendix A) when the item does not exist yet (a dry run
  before the deploy). A dry run never writes; an apply creates the item
  (create-only) when absent.
- **What it reads:** every contact of every type and every unit, active and
  deleted (base tables).
- **What it does (apply), each write conditional on the record still holding
  the text it read, each with an audit event `org_name_cleanup` {field, from,
  to}:**
  - a housing authority or agency value that resolves to exactly one entry of
    the field's kind: rewrite to the entry's exact name;
  - a housing authority value that resolves to exactly one AGENCY entry: move
    it to `agency` when `agency` is absent or `''` (and REMOVE the housing
    authority); otherwise count a conflict and leave both;
  - a property list member that resolves to one housing authority: rewrite;
    to an agency: drop it unless that would empty the list (then leave it and
    count it); de-duplicate the list; never stamp `updated_at`;
  - a unit with only legacy `jurisdiction`: write `accepted_authorities` from
    its resolved value (or the raw value when it does not resolve, which then
    shows on the Settings page).
- **Everything else** (ambiguous, unknown, compound) is left exactly as it
  is. The dry run prints, per field, each such distinct value with its count
  (no names of people) - the preview of the Settings page's "Not on the list"
  section - and the counts of every automatic change.
- **Reporting** follows `enable-conversation-automation.ts`: a done line with
  counters; a PARTIAL report and exit 1 on an abort; `COMPLETED WITH
  FAILURES` and exit 1 on per-record failures; re-running is safe.
- **Order (RUNBOOK):** dry run against prod from a `main` checkout BEFORE the
  deploy; review the leftover values with Sam; deploy; apply immediately after
  the deploy (until the apply runs, a blast filtered on a new list name misses
  tenants still holding old spellings); then Sam settles the leftovers on the
  Settings page. Dev first. No agent runs it against dev or prod; an agent
  rehearses on a lane (`--env local --lane L`).

---

## 9. Invariants, writers and readers (the plan must enumerate each)

**Invariant I1:** every housing authority, agency, accepted-authority member,
(B) organization and broadcast filter value WRITTEN after the deploy is a
name on the list of the right kind. Values written before the deploy are
either mapped by the cleanup or listed in the Settings page's "Not on the
list" section until staff settle them; a broadcast's stored filter is
re-checked at preview and send.

Writers (each applies D5, or is a stated exception):

- contacts PATCH (`housingAuthority`, `agency`, (B) `organization`, (B)
  `type` and `role` with D21); contacts POST (ignores these fields today and
  must not start accepting them unchecked);
- contacts restore and units restore (no check needed: deleted records are
  rewritten and cleaned like active ones);
- units POST and PATCH (`accepted_authorities`);
- broadcasts POST (`audience_filter.housing_authority`), and preview and send
  (re-check);
- the AI apply layer and the suggestion accept path (D8);
- the importer, contact and unit sides (D9; B adds D21's type rule);
- the public intake routes (do not write these fields today; tracker #14
  will);
- seeds (lean, cast, matrix, live, performance) including seeded broadcasts,
  and the dev reseed;
- the rewrite job (D11) and the cleanup script (section 8);
- (B) Make caseworker (D19) and the Caseworker choice (D16).

Readers (must keep working with full names and with not-on-the-list values):
`audienceResolution.ts` and broadcast preview/send; Tenants page facets;
Properties page summary and facets; the flyer projection; `similarUnits.ts`;
the AI job's current-profile context and the new list block; the AI run log
and System Status (prompt fingerprint plus list version, the new drop
reason); the missed-call auto-text check (D15); the contact header and tenant
file; tour and placement pages that show tenant facts; (B) the Caseworkers
tab, partner page, "Sent to" list, and the extraction kind canonicalizer.

**Invariant I2 (B):** a partner's share never mints a `tenant_1to1` thread
(both fan-out sites use the contact's type), and a staff type change re-types
the contact's own open one-to-one threads (D21). Exception: the public intake
routes still mint `tenant_1to1` for any phone (tracker #13).

---

## 10. Branch B summary of changes

- KindPicker "Caseworker" choice and the kind canonicalizer (D16); partner
  edit form Organization picker (D17); partner page shows Role and
  Organization; contact header hides tenant facts for non-tenants (D21).
- Contacts > Caseworkers tab with organization chips (D18) and the Possible
  caseworkers list with its two actions (D19).
- Direct shares (D20): `broadcasts.ts` seed resolution and explicit send list
  accept `partner`; both fan-out sites mint the right conversation type;
  PartnerFile gets the Properties sent card and Send; recipient wording in
  the composer preview and results is not tenant-only; the property's "Sent
  to" list labels partner rows.
- Type-change thread consistency and the importer's `type_source` rule (D21).
- Settings counts, "Not on the list" and the rewrite job include
  `organization`.

---

## 11. Rollout and operations

- Branch A: no Terraform, no secrets, no schema or index change. Cleanup dry
  run before the deploy, apply right after it (section 8). The `org-list` item
  creates itself on first read. RUNBOOK gets a section for the cleanup and
  for the Settings page's rewrite actions ("Run again").
- Branch B: deploy only. No script.
- Cameron runs everything against dev and prod; agents only on lanes.

---

## 12. Follow-ups to file (docs/issues)

- Suggest a property's housing authorities from its address (geocode to
  county and city limits; a table of which authority serves where; landlord
  acceptance stays a choice).
- AI fills a tenant's Agency from the conversation.
- AI adds confirmed-new names itself (Work Package 2).
- Close or update `housing-authority-free-text-drift` (resolved by this work)
  and `retire-humanize-authority` (seed slugs retired here; PATCH tombstones
  remain).

---

## 13. Open items pending Sam (Cameron's meeting, 2026-10-06)

The answers change only Appendix A and the seed mapping of `fulton_housing`,
not the design. Appendix A must be final before the branch A plan is written.

1. Fulton County Housing Authority: are there tenants with one? (Decides
   whether it is in Appendix A, and what `fulton_housing` maps to.)
2. "McDonough" on tenants: a DCA voucher in Henry County, or something else?
3. "Clayton County" = Jonesboro Housing Authority, "Cobb County" = Marietta
   Housing Authority? (If yes, each becomes a spelling of that entry.)
4. Who is "Hands of Hope"?
5. Any other entry now (for example McIntosh Trail Community Service Board)?
6. HUD-VASH as the agency on a veteran's record: confirmed?

---

## Appendix A - Starting list (final once section 13 is answered)

Housing authorities:

| Name | Spellings |
|---|---|
| Atlanta Housing Authority | AHA; Atlanta Housing; Housing Authority of the City of Atlanta; Atlanta (AHA); Atlanta, aha, Atlanta housing |
| Georgia Department of Community Affairs | DCA; Georgia DCA; GA DCA; Department of Community Affairs; DCA, Department of Community Affairs |
| Georgia Housing Voucher Program (DBHDD) | GHV; GHVP; DBHDD; Georgia Housing Voucher; Georgia Housing Voucher (GHV) |
| DeKalb County Housing Authority | HADC; Housing Authority of DeKalb County; Dekalb County Housing; Dekalb Housing |
| Decatur Housing Authority | Housing Authority of the City of Decatur |
| Marietta Housing Authority | MHA |
| Jonesboro Housing Authority | JHA; Jonesboro (JHA); Jonesboro housing; Jonesboro, JHA, Jonesboro housing |
| East Point Housing Authority | EPHA; East Point; Eastpoint Housing Authority |
| College Park Housing Authority | Housing Authority of the City of College Park; College Park |
| Macon-Bibb County Housing Authority | Macon Housing Authority; MHA |
| Augusta Housing Authority | AHA |

Pending section 13: Fulton County Housing Authority (spellings: Housing
Authority of Fulton County; Fulton County; Fulton, Fulton County).

Agencies:

| Name | Spellings |
|---|---|
| HUD-Veterans Affairs Supportive Housing (HUD-VASH) | HUD-VASH; VASH |
| Step Up | |
| Claratel Behavioral Health | Claratel; DeKalb Community Service Board |
| View Point Health | Viewpoint Health |
| HOPE Atlanta | Travelers Aid |
| Mercy Care | |
| CaringWorks | Caring Works |

Under D4's normalization these spellings are distinct within each entry
("HUD-VASH" also covers "HUD VASH"; "Caring Works" is distinct from the name
"CaringWorks" because normalization does not join words). The old canonical
spellings ("Atlanta (AHA)", "Jonesboro (JHA)",
"Dekalb County Housing", "Georgia Housing Voucher (GHV)", "DCA", "East
Point", "HUD VASH", "Claratel", "Hope Atlanta", "Step Up") resolve to one
entry each, so the cleanup maps them automatically; a bare "AHA" or "MHA" is
ambiguous by design and lands in "Not on the list".

## Appendix B - Research sources (2026-10-06)

- DBHDD Georgia Housing Voucher Program: dbhdd.georgia.gov/node/16631;
  healthyfuturega.org GHVP fact sheet; ghvp.zendesk.com inspection articles.
- DCA Housing Choice Voucher program and offices: dca.ga.gov HCV program page;
  dca.ga.gov/node/2162; WABE 2023 waiting list article.
- HUD-VASH: hud.gov HUD-VASH program page; dekalbhousing.org VASH page.
- Local authorities: dekalbhousing.org; decaturhousing.org; atlantahousing.org;
  maconhousing.com; HUD-listing pages for East Point (GA078), College Park
  (GA232), Jonesboro (GA228), McDonough (GA182), Fulton County (GA264),
  Marietta (GA010), Augusta (GA001).
