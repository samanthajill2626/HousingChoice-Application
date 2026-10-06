# Clean housing authority and agency names, and caseworkers - design

Date: 2026-10-06. Tracker items #2 ("One clean name per housing authority") and
#19 ("Caseworkers"), built together under one approved estimate (10-15 hours of
Cameron's time, approved by Sam on Sep 30).

Two branches, built in order:

- **Branch A - `feat/clean-org-names`** (worktree `W:\tmp\clean-org-names`):
  the stored lists, the one name check, the pickers, the blast composer
  picker, the AI and importer changes, the Settings page, seeds and tests on
  real names, and the one-time cleanup script. No send-path change.
- **Branch B - `feat/caseworkers`** (cut from `main` after A merges): the
  Caseworker choice, the caseworker's organization, the Caseworkers tab,
  the possible-caseworkers review, and direct property shares to partners
  (the send-path change).

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
  (several allowed), never agencies. Existing tenant and property values are
  cleaned up once, and agency names move out of the housing authority field
  into Agency.
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
- Blasts filter tenants with an exact match on the `byHousingAuthority` GSI
  (`app/src/services/audienceResolution.ts`), so two spellings of one
  authority are two audiences that cannot see each other. The Tenants page
  and the Properties page group spellings case-insensitively in the browser,
  so the pages show one group where blasts see two.
- The AI and the importer treat the four agency names (Hope Atlanta, HUD
  VASH, Claratel, Step Up) as KNOWN housing authorities and write them into
  `housingAuthority` (`isKnownAuthority` in `housingAuthority.ts`; the
  importer's write in `app/src/lib/import/apply.ts`). The importer also
  overwrites a contact's housing authority on every run, replacing staff
  edits; its unit-side write only fills an empty list.
- The AI prompt tells the model the list "is NOT exhaustive and is not a
  permitted-values list"; an unknown name is demoted to a staff suggestion.
  Accepting a suggestion writes its text as-is
  (`app/src/services/suggestionResolution.ts`).
- Seeds use slugs (`atlanta_housing`, `ga_dca`, `dekalb_housing`,
  `fulton_housing`, `gwinnett_housing`, `cobb_housing`); about 20 e2e specs
  and many unit tests pin them or mint run-unique free-text names.
- Caseworkers are `partner` contacts with an optional free-text role
  ("Case worker"). The contact type picker cannot save one: picking Partner
  clears the role, and the "Other" choice offers only Tenant or Landlord as a
  base (`dashboard/src/routes/contact/KindPicker.tsx`). Partners have no
  organization field, no tab, and property sharing is tenant-only
  (`app/src/routes/broadcasts.ts` drops non-tenants in seed resolution and in
  the explicit send list).

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
- G2. Every stored housing authority, agency and (B) organization value is a
  name on the list of the right kind - enforced on the server for every
  writer, not just in the forms.
- G3. Staff can see and manage the lists on a Settings page.
- G4. A dry-run-first cleanup maps existing values to list names.
- G5. (B) Caseworkers as partner + Caseworker role, with an organization, a
  tab with an organization filter, direct property shares, and a confirm
  list for caseworkers saved as tenants.

### Non-goals (explicitly out of scope)

- Suggesting a property's housing authorities from its address (county and
  city limits). Filed as a follow-up issue (section 12).
- The AI filling the tenant's Agency field, or adding names to the list on
  its own (Work Package 2 may revisit; until then the AI only suggests).
- Blasts (filter-resolved audiences) to partners or caseworkers. Audience
  rules belong to tracker #6.
- The /join housing authority dropdown (tracker #14, next in the order of
  work; it will read this list).
- A new contact type for caseworkers.
- Storing organization IDs on records instead of names.
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
  name; such a spelling is never applied automatically.
- **caseworker** (NEW, branch B) - a `partner` contact whose role is
  "Caseworker", with an organization from either list.
- **organization (of a caseworker)** (NEW, branch B) - the housing authority
  or agency a caseworker works for: `contact.organization`.

---

## 4. Decisions

D1. **Storage: one item in the existing `settings` table.** Item id
`org-list`. No new table, no Terraform. Shape in section 5.1. Writes are
optimistic and conditional on a `version` number (read, change, write with
`version = :expected`, retry on conflict), following the conditional idioms
in `app/src/repos/settingsRepo.ts`; a new sibling repo owns it (settingsRepo's
own helpers are not a generic record API).

D2. **The starting list seeds an empty store once.** The first read in an
environment that finds no `org-list` item writes the starting list
(Appendix A) with a create-only condition. From then on the stored item is
the only source; later edits to the starting list in code do NOT reach an
environment that already has the item. Seeds (lean and full) write the item
explicitly so test worlds are deterministic.

D3. **Records store the full name, not an ID.** `contact.housingAuthority`,
`contact.agency`, `unit.accepted_authorities[]` and (B)
`contact.organization` hold the entry's name text. Every existing reader
(the GSI, blasts, facets, the Properties summary, the flyer, similar units,
the AI context) keeps working unchanged. Consequence: renaming or merging an
entry rewrites the records that hold it (D10).

D4. **Matching rules (one server-side module).**
- Normalize for comparison only: lowercase, `&` to `and`, punctuation
  (`. , ( ) - / ' "`) to spaces, collapse whitespace, trim.
- A text equal to an entry's NAME (normalized) matches that entry.
- A text equal to an entry's SPELLING matches every entry that carries it;
  one entry = a match; two or more = ambiguous.
- Anything else is not on the list. "Close" names (shared words, initials,
  small edit distance) are computed only to offer choices in a prompt; they
  are never applied automatically.
- Names are unique across BOTH lists (an authority and an agency cannot
  share a name). A spelling may not equal any entry's name. Spellings may be
  shared between entries (AHA, MHA).
- The kind matters: a housing authority field accepts only housing authority
  entries, an agency field only agency entries, (B) an organization field
  either kind.

D5. **One server-side check for every writer (the invariant).** A write of a
name to any of the fields in D3 resolves the text with D4 against the right
kind: an exact name is stored; a unique spelling is stored as its entry's
name; anything else is refused (HTTP 422 `org_not_on_list`, with the
candidates and, when the text names an entry of the OTHER kind,
`otherKind`). The full list of writers is in section 9; the plan must cover
each one.

D6. **Forms use a picker, with an add step.** Tenant Housing authority and
Agency, property Housing authorities (several), and (B) caseworker
Organization become a type-to-search picker over the list. Typing matches
names and spellings, so typing AHA shows both Atlanta Housing Authority and
Augusta Housing Authority, and staff pick. When nothing matches, the last
option is "Add <text> as a new housing authority" (or agency). Choosing it
opens "Is this really new?": the closest names are offered first ("Use
Atlanta Housing Authority"), and "Yes, add it" creates the entry. When the
text is an entry of the other kind ("HUD-VASH is an agency"), the dialog
says so and, on the tenant form, offers to put it in Agency instead. Property
forms add only housing authorities. (B) A caseworker's organization can add
either kind; the dialog asks which.

D7. **Blast composer: the picker without the add step.** No tenant can hold a
name that is not on the list, so adding one there is meaningless. Prefilling
from the property and multi-authority rules stay with tracker #6.

D8. **AI: list-aware, suggestion-only for anything new.**
- The extraction system prompt lists the housing authority names WITH their
  spellings, read from the stored list (cached), and says: return the full
  name from the list; when an abbreviation belongs to more than one name,
  pick the one the conversation supports or return the text as said; agency
  names (listed) are never housing authorities.
- The apply layer resolves the returned text with D4: a match is handled
  exactly as a known authority is today (write an empty field, suggest a
  change); ambiguous or unknown text becomes a staff suggestion (as unknown
  names do today); an agency name is dropped from `housingAuthority` and
  logged (debug), never written.
- Accepting a suggestion whose text is not a list name runs the same "Is
  this really new?" step before anything is written; the accepted value is
  always a list name (D5 applies to the accept path).
- The AI never adds to the list and never fills Agency (non-goals).

D9. **Importer: same check, fill-only.** The importer resolves each value
with D4. A match is written ONLY when the contact's field is empty (today it
overwrites on every run); an agency name found in the housing authority
column is written to Agency when Agency is empty; ambiguous or unknown values
are not written and are listed in the import report with counts. The
unit-side write (already fill-only) uses the same check.

D10. **Settings page: "Housing authorities & agencies".** A new Settings tab,
visible to every signed-in user. It lists both kinds; each row shows the
name, its spellings, its notes, and how many tenants, properties and (B)
caseworkers use it.
- Everyone: view; add an entry (same "Is this really new?" step); edit an
  entry's notes.
- Admins only (`requireRole('admin')` on the server): edit spellings, rename,
  merge into another entry, delete, change kind.
- Rename and merge rewrite records: every tenant (`housingAuthority`,
  `agency`), property (`accepted_authorities`), (B) caseworker
  (`organization`) and saved DRAFT blast filter that holds the old name. The
  confirm step shows those counts first. The rewrite runs as a background job
  (`jobs.enqueue`), every record write conditional on the record still
  holding the old name, and the page shows the result counts when it
  finishes. A renamed or merged-away name becomes a spelling of the entry
  that remains, so old text still finds it. Sent blasts keep their historical
  filter.
- Delete is allowed only when nothing uses the entry. Kind change is allowed
  only when nothing uses the entry.
- Editing spellings or notes touches no records.

D11. **Spellings are curated, never learned from clicks.** Spellings come
from the starting list, cleanup decisions (D12), and admins on the Settings
page. Picking a name in a form never adds the typed text as a spelling.

D12. **Cleanup script, dry run first** (section 8). It maps existing values
to list names, moves agency names out of the housing authority field, and
writes a review sheet for the values it cannot decide. It has no merge mode
(merging is D10).

D13. **Notes per entry.** Free text (for example where RTAs go and a phone
number), editable by everyone, shown on the Settings page.

D14. (Branch B) **Caseworkers stay partners.** The contact type picker gains
a "Caseworker" choice that saves `type: partner, role: Caseworker`, the way
"Property Manager" saves `type: landlord, role: Property Manager`. No new
`ContactType`.

D15. (Branch B) **Organization field on partners.** `contact.organization`,
validated by D5 against either list, edited on partner contacts. Shown on the
partner page and as the Caseworkers tab's filter.

D16. (Branch B) **Caseworkers tab.** Contacts gains a Caseworkers tab: partner
contacts whose role matches "caseworker" (case-insensitive, spaces ignored,
so existing "Case worker" roles match), with organization filter chips built
the way the Tenants page builds its housing authority chips.

D17. (Branch B) **Possible caseworkers saved as tenants.** The Caseworkers tab
shows a "Possible caseworkers" list: tenant contacts whose role mentions
caseworker or case manager, whose notes carry the AI's "Identified as a
caseworker" line or those words, or who are linked as another contact's
caseworker relationship. Each row offers "Make caseworker" and "Not a
caseworker" (dismissal is stored on the contact and hides the row for good).
Make caseworker: type `partner`, role "Caseworker", `organization` set from
the contact's agency or housing authority when that is a list name (else
left empty for staff to pick), `housingAuthority` cleared, and the contact's
open one-to-one thread re-typed from `tenant_1to1` to `partner_1to1`.

D18. (Branch B) **Direct property shares to partners; no blasts.** A partner's
page gets the "Properties sent" card and its Send action, as tenants have;
the message is the normal share (address and flyer link) into the partner's
own conversation. Hand-picked recipients of any property send may be tenants
or partners; filter-resolved audiences stay tenant-only. Every existing gate
(opt-out per phone number, unreachable, deleted, the kill switch, the
just-in-time consent check) applies unchanged. A share to a partner with no
conversation creates a `partner_1to1` conversation, not a `tenant_1to1` one.
The property's "Sent to tenants" list becomes "Sent to", with partner rows
labelled by their role.

D19. (Branch B) **Type changes keep threads consistent.** When staff change a
contact's type between tenant, landlord and partner (edit form or D17), the
contact's open one-to-one threads whose type matches the OLD type are
re-typed to the new type; a thread typed for some other identity is left
alone (today's triage-conflict rule). The contact header shows voucher size
and housing authority only for tenants.

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
      spellings: string[],         // alternate spellings (may be shared)
      notes?: string,              // free text, <= 2000 chars
      createdAt: string, createdBy: string,
      updatedAt: string, updatedBy: string,
    }
  ],
  lastRewrite?: {                  // the latest rename/merge job (D10)
    jobId: string, kind: 'rename' | 'merge',
    fromName: string, toName: string,
    status: 'running' | 'done' | 'failed',
    counts?: { tenants: number, agencies: number, properties: number,
               caseworkers: number, drafts: number, skipped: number },
    startedAt: string, finishedAt?: string,
  }
}
```

Size: the starting list is ~20 entries; even 500 entries stay far below
DynamoDB's 400 KB item limit. App and worker each cache the item in process
for 60 seconds (the pool-number cache in `app/src/routes/webhooks/twilio.ts`
is the pattern), dropping the cache on their own writes.

### 5.2 Records

| Field | Kind accepted | Change |
|---|---|---|
| `contact.housingAuthority` | housing authority | now list-checked (D5) |
| `contact.agency` | agency | now list-checked (D5); `''` still clears |
| `unit.accepted_authorities[]` | housing authority | now list-checked; entries trimmed and de-duplicated |
| `contact.organization` (B) | either | new, partners |
| `contact.caseworker_review` (B) | - | new: `'dismissed'` hides a possible caseworker |
| draft blast `filter.housingAuthority` | housing authority | now list-checked |

The legacy `unit.jurisdiction` / `accepted_programs` tombstones stay accepted
and ignored on the unit PATCH (`docs/issues/retire-humanize-authority.md`);
the cleanup backfills `accepted_authorities` for units that have only
`jurisdiction` (section 8).

---

## 6. API (branch A)

All under `/api/organizations`, signed-in staff unless marked admin.

- `GET /api/organizations` - both lists (entries as in 5.1) plus
  `lastRewrite`. `?usage=1` adds per-entry counts (tenants by housing
  authority, tenants by agency, properties, (B) caseworkers), computed by
  reading tenants, units and partners; results may be cached 60 seconds.
- `POST /api/organizations/check` `{ kind, text }` - the D4 resolution:
  `{ match?, candidates[], close[], otherKind? }`. Used by the forms' add
  step and the suggestion accept step. No write.
- `POST /api/organizations` `{ kind, name, spellings?, notes? }` - add.
  Refused 409 `org_name_taken` when the name equals any entry's name or
  spelling (either kind), with that entry. The UI's "Is this really new?"
  step happens before this call.
- `PATCH /api/organizations/:orgId` `{ notes }` (everyone) or
  `{ spellings, name, kind }` (admin). A `name` change starts the rename job
  (D10). `kind` refused 409 `org_in_use` when anything uses the entry.
- `POST /api/organizations/:orgId/merge` `{ intoOrgId }` (admin) - same kind
  only; starts the merge job.
- `DELETE /api/organizations/:orgId` (admin) - refused 409 `org_in_use` when
  anything uses the entry.

Existing endpoints that write the fields in 5.2 apply D5 and answer 422
`org_not_on_list` `{ field, text, candidates, close, otherKind? }`.

---

## 7. Behavior by surface (branch A)

- **Tenant edit form:** Housing authority and Agency pickers (D6); the help
  text under Housing authority reads "The organization that runs the
  voucher". `orgVocabulary.ts` suggestions are replaced by the stored list.
- **Property New/Edit forms:** Housing authorities multi-picker (D6),
  housing authorities only.
- **Blast composer:** housing authority filter picker without add (D7).
- **Tenants page, Properties page summary, flyer, similar units:** unchanged
  code; they show whatever names records hold. After the cleanup the flyer's
  "Accepts:" line shows full names (for example "Accepts: Atlanta Housing
  Authority").
- **Contact suggestions (AI):** D8.
- **Importer:** D9.
- **Settings:** D10, D13.
- **Seeds:** every seed (lean, full cast, matrix, live, performance) uses
  list names; slugs are retired (`gwinnett_housing` and `cobb_housing` map to
  Georgia Department of Community Affairs and Marietta Housing Authority).
  Seeds write the `org-list` item. The lean world changes; e2e expectations
  follow.
- **e2e specs** that type free-text names or mint run-unique names pick list
  names or add their run-unique names through `POST /api/organizations`
  first.

---

## 8. The cleanup script (branch A)

`app/scripts/clean-org-names.ts`, modeled on
`app/scripts/enable-conversation-automation.ts` and its RUNBOOK section:

- `--env local|dev|prod`, `--lane <L>` (local only), `--apply`,
  `--decisions <path>`, `--out <path>`. Target resolution and guards through
  `app/scripts/lib/stageClient.ts` (account guard, pinned endpoint, refusal
  while any `AWS_ENDPOINT_URL*` is set). Unknown or repeated arguments exit 2.
- **The list it uses:** the environment's stored `org-list` item, or the
  starting list (Appendix A) when the item does not exist yet (a dry run
  before the deploy). A dry run never writes the item; an apply creates it
  (create-only) when absent.
- **Dry run (default):** reads every contact's `housingAuthority` and
  `agency` and every unit's `accepted_authorities` (and legacy
  `jurisdiction`), and writes a review sheet (CSV) with ONE ROW PER DISTINCT
  VALUE AND FIELD: value, field, record count, proposed action, decision. No
  names of people. Proposed actions:
  - `map -> <name>` (exact name or unique spelling);
  - `move to agency -> <name>` (an agency name in a tenant's housing
    authority field);
  - `remove (agency on a property)` (an agency name in a property's list);
  - `needs decision` (unknown, ambiguous such as a bare "AHA", or compound
    such as "DCA HUD-VASH").
- **Decisions:** Cameron and Sam fill the decision column for `needs
  decision` rows with one of: an existing name; `new housing authority:
  <name>`; `new agency: <name>`; `split: <authority> + <agency>`; `clear`
  (junk such as "N/A"); `leave`. A decided value that is not already a
  spelling of any entry becomes a spelling of the chosen entry (D11), unless
  the decision is `clear` or `leave`.
- **Apply:** applies every `map`/`move`/`remove` row and every decided row;
  `needs decision` rows without a decision and `leave` rows are left exactly
  as they are and reported again. Every record write is conditional on the
  record still holding the value the run read (a staff edit made meanwhile
  wins) and carries an audit event (`org_name_cleanup` with from/to). A
  tenant whose Agency already holds a different agency is reported as a
  conflict and not written. A property whose list would become empty is
  reported and not written. A unit with only `jurisdiction` gets
  `accepted_authorities` written from the mapped value. Re-running is safe.
  Abort and failure reporting follow the D2 script: a PARTIAL report on an
  abort, `COMPLETED WITH FAILURES` and exit 1 on per-record failures.
- **Order (RUNBOOK):** dry run against prod from a `main` checkout BEFORE the
  deploy; settle the sheet with Sam; deploy; apply immediately after the
  deploy (until the apply runs, a blast filtered on a new list name finds
  tenants still holding old spellings missing). Dev first. No agent runs it
  against dev or prod; an agent rehearses on a lane (`--env local --lane L`).

---

## 9. Invariants, writers and readers (the plan must enumerate each)

**Invariant I1:** every stored `housingAuthority`, `agency`,
`accepted_authorities[]` entry, (B) `organization`, and draft blast
`filter.housingAuthority` is a name on the list, of the right kind - except
values written before the cleanup applies, which the cleanup and the Settings
page counts surface.

Writers (each must apply D5 or be listed as an accepted exception):

- contacts PATCH (`housingAuthority`, `agency`, (B) `organization`, type
  changes in D19); contacts POST (today ignores `housingAuthority`; must not
  start accepting it unchecked);
- units POST and PATCH (`accepted_authorities`);
- broadcasts create/PATCH (`filter.housingAuthority`);
- the AI apply layer and the suggestion accept path;
- the importer (contact and unit sides);
- the public intake routes (do not write these fields today; #14 will);
- seeds (lean, cast, matrix, live, performance) and the dev reseed;
- the rename/merge job and the cleanup script;
- (B) the Make caseworker action.

Readers to check (must keep working with full names and with pre-cleanup
legacy values): `audienceResolution.ts` and the broadcast preview/send;
Tenants page facets; Properties page summary and facets; the flyer
projection; `similarUnits.ts`; the AI job's current-profile context; the
missed-call auto-text presence check; the contact header and tenant file;
tour and placement pages that show tenant facts; (B) the Caseworkers tab and
partner page.

**Invariant I2 (B):** a partner contact's open one-to-one thread is typed
`partner_1to1` once any path in D17-D19 touched it; new threads for partners
are never minted as `tenant_1to1` (both fan-out sites in
`app/src/jobs/broadcastFanOut.ts` use the contact's type).

---

## 10. Branch B summary of changes

- KindPicker "Caseworker" choice (D14); partner edit form Organization picker
  (D15); partner page shows Role and Organization; contact header hides
  tenant facts for non-tenants (D19).
- Contacts > Caseworkers tab with organization chips (D16) and the Possible
  caseworkers list with its two actions (D17).
- Direct shares: `broadcasts.ts` seed resolution and explicit send list
  accept `partner`; both fan-out sites mint the right conversation type;
  PartnerFile gets the Properties sent card and Send; recipient wording in
  the composer preview and results is not tenant-only; the property's
  "Sent to" list labels partner rows (D18).
- Type-change thread consistency (D19).
- Settings usage counts include caseworkers; rename/merge rewrites include
  `organization`.

---

## 11. Rollout and operations

- Branch A: no Terraform, no secrets, no schema or index change. Deploy, then
  the cleanup apply (section 8). The `org-list` item creates itself on first
  read. RUNBOOK gets a section for the cleanup.
- Branch B: deploy only. No script.
- Cameron runs everything against dev and prod; agents only on lanes.

---

## 12. Follow-ups to file (docs/issues)

- Suggest a property's housing authorities from its address (geocode to
  county and city limits; a table of which authority serves where; landlord
  acceptance stays a choice).
- AI fills a tenant's Agency from the conversation.
- AI adds confirmed-new names itself (Work Package 2).
- Close or update `housing-authority-free-text-drift` (this work resolves it)
  and `retire-humanize-authority` (seed slugs retired here; PATCH tombstones
  remain).

---

## 13. Open items pending Sam (Cameron's meeting, 2026-10-06)

The answers change only Appendix A and cleanup decisions, not the design:

1. Fulton County Housing Authority: are there tenants with one?
2. "McDonough" on tenants: a DCA voucher in Henry County, or something else?
3. "Clayton County" = Jonesboro Housing Authority, "Cobb County" = Marietta
   Housing Authority?
4. Who is "Hands of Hope"?
5. Any other entry now (for example McIntosh Trail Community Service Board)?
6. HUD-VASH as the agency on a veteran's record: confirmed?

---

## Appendix A - Starting list (pending section 13)

Housing authorities:

| Name | Spellings |
|---|---|
| Atlanta Housing Authority | AHA; Atlanta Housing; Housing Authority of the City of Atlanta; Atlanta (AHA); Atlanta housing; Atlanta, aha, Atlanta housing |
| Georgia Department of Community Affairs | DCA; Georgia DCA; Department of Community Affairs; DCA, Department of Community Affairs |
| Georgia Housing Voucher Program (DBHDD) | GHV; GHVP; DBHDD; Georgia Housing Voucher; Georgia Housing Voucher (GHV); Georgia Housing Voucher, GHV |
| DeKalb County Housing Authority | HADC; Housing Authority of DeKalb County; Dekalb County Housing; Dekalb Housing |
| Decatur Housing Authority | Housing Authority of the City of Decatur |
| Marietta Housing Authority | MHA |
| Jonesboro Housing Authority | JHA; Jonesboro (JHA); Jonesboro housing; Jonesboro, JHA, Jonesboro housing |
| East Point Housing Authority | EPHA; East Point; Eastpoint Housing Authority |
| College Park Housing Authority | Housing Authority of the City of College Park; College Park |
| Macon-Bibb County Housing Authority | Macon Housing Authority; MHA |
| Augusta Housing Authority | AHA |
| Fulton County Housing Authority (pending Sam) | Housing Authority of Fulton County |

Agencies:

| Name | Spellings |
|---|---|
| HUD-Veterans Affairs Supportive Housing (HUD-VASH) | HUD-VASH; HUD VASH; VASH |
| Step Up | |
| Claratel Behavioral Health | Claratel; DeKalb Community Service Board |
| View Point Health | Viewpoint Health |
| HOPE Atlanta | Travelers Aid |
| Mercy Care | |
| CaringWorks | Caring Works |

The old canonical spellings ("Atlanta (AHA)", "Jonesboro (JHA)", "Dekalb
County Housing", "Georgia Housing Voucher (GHV)", "DCA", "East Point", "HUD
VASH", "Claratel", "Hope Atlanta", "Step Up") are covered as names or
spellings above, so the cleanup maps them without a decision; "Fulton
County", "Clayton County" and "McDonough" wait on section 13.

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
