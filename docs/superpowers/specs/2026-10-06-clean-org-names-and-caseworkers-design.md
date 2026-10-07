# Clean housing authority and agency names, and caseworkers - design

Date: 2026-10-06 (revision 8: revision 5 was APPROVED by Cameron; revision 6
folded in precision corrections from the plan research
(`docs/superpowers/reviews/2026-10-06-clean-org-names/plan-research/planner-rulings.md`);
revision 7 folds in the plan review round 1
(`docs/superpowers/reviews/2026-10-06-clean-org-names/plan-review/adjudications.md`):
the name-variant rule in D10, D11's read paths, fixed `fields` and
lock-loss stop, and section 6's endpoint shapes; revision 8 records Sam's
answers from the 2026-10-06 meeting (section 13, Appendix A: the old county
values become spellings of the authority that runs those vouchers) and plan
review round 2 (D13's no-empty rule covers spellings; D8's place-name rule;
`Clayton` on Jonesboro - Cameron's 2026-10-07 ruling after verification,
reversing the launch-gate default of DCA); the final independent
review (2026-10-07) added two precision lines - D4 folds typographic
punctuation and strips invisible characters; section 8's apply refuses an
environment with no stored list. Revision 9 (2026-10-07, after branch A
merged): the branch B half (D16-D21, sections 5.2, 6, 9, 10, 12) re-checked
against A's merged code by two readers
(`docs/superpowers/reviews/2026-10-07-caseworkers/spec-rereview/`) - 55
statements, 47 valid or already done, 20 sharpened: the one-kind-per-field
shape of A's Settings and rewrite code, exact-match role presets, the
possible-caseworkers endpoint, the recipients wire row, the thread re-type
rule; planner defaults marked "(planner default; Cameron confirms)" are open
until Cameron rules. Design review: rounds 1-4,
closed - adjudications in
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
  /api/broadcasts`; a draft can be resumed, and its preview re-resolves the
  stored filter. The dashboard's send posts the curated recipient list
  (`recipientContactIds`) and does not re-resolve the filter; only a send
  without that list (an API caller) re-resolves it.
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
the item before branch A deploys there, and Appendix A is fixed in the code
before branch A merges (section 13), so dev and prod start from the same
list. Seeds (lean and full) write the item with an UNCONDITIONAL put, so a
reader that created the item during the dev reseed's clear-then-seed window
is overwritten and test worlds stay deterministic.

D3. **Records store the full name, not an ID; "uses" means exact text in a
field of the right kind.** `contact.housingAuthority`, `contact.agency`,
`unit.accepted_authorities[]` and (B) `contact.organization` hold the entry's
name text. A stored value is ON THE LIST for its field exactly when it is
character-for-character the name of an entry of a kind that field accepts
(housing authority fields: housing authority entries; `agency`: agency
entries; (B) `organization`: either). An entry is USED by a record exactly
when such a field of the record holds the entry's name. An agency's exact
name in a housing authority field (or the reverse) is therefore NOT on the
list and not a use. Every existing reader (the
GSI, blasts, facets, the Properties summary, the flyer, similar units, the AI
context) keeps working unchanged. Consequence: renaming or merging an entry
rewrites the records that hold it (D11).

D4. **Matching rules (one server-side module).**
- Normalize for comparison only: first strip invisible format characters
  (soft hyphen, zero-width and bidi marks, U+FEFF) and fold typographic
  punctuation to ASCII (curly single quotes and primes to `'`, curly double
  quotes to `"`, hyphens, dashes and the minus sign to `-` - an iPhone's
  smart punctuation must match a desktop's); then lowercase; `&` to `and`;
  the characters `. , ( ) - / ' " _` to spaces; collapse whitespace; trim.
  (Final review 2026-10-07.) A NEW name or spelling may carry typographic
  punctuation but never an invisible format character (D13).
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
  (de-duplicated on write) and may be shared between entries of the SAME
  kind (AHA, MHA); a spelling may never be shared across kinds.
- Exact equality is decided first: a text equal to a name or spelling
  (normalized) is a match or an ambiguity as above, and is NEVER compound.
- Otherwise a value is COMPOUND when its normalized text holds two or more
  NON-overlapping whole-word spans that each equal a name or spelling (spans
  found left to right, taking at each position the LONGEST phrase that is a
  name or spelling, so a span inside a longer matching span does not count)
  and no single entry is matched by every span. Examples: "dca hud
  vash" (Georgia Department of Community Affairs + HUD-VASH) is compound;
  "aha" and "atlanta aha" are exact spellings, never compound; "atlanta
  housing authority aha" is not compound (Atlanta Housing Authority matches
  both spans) and, not being exact, is simply not on the list. One shared
  spelling is ambiguity, never compound.
- Compound values are never stored as spellings and never resolve to one
  entry; the Settings page offers Split for them (D10). The plan's tests
  cover every Appendix A row and these examples.

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
  holds (compared after trimming both sides) pass unchanged, and so does the
  unit's legacy `jurisdiction` ONLY while the unit has no stored
  `accepted_authorities` (the list a form shows was synthesized from it);
  every other member must resolve. Members are trimmed and de-duplicated.
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
housing authorities. (B) A caseworker's Organization picker searches BOTH
lists at once (A's picker already takes a list of kinds); its add option
opens "Is this really new?" in an organization mode that asks the kind
before "Yes, add it", and the close-name check covers both lists
(`POST /api/organizations/check` with `kinds`). A stored value that is not on the list shows as a
removable chip marked "Not on the list"; saving never fails because of an
unchanged value (D5).

D7. **Blast composer: the picker without the add step.** Composer filters
can only name list entries. A tenant whose stored value is not on the list is
not reachable by a housing authority filter until that value is settled on
the Settings page (D10), which lists every such value with its count. A
stored filter is re-checked at preview of a DRAFT and inside the send branch
that re-resolves the filter (not a seeds-only send): a value that is not on
the list for the housing authority field (D3) is refused with 422
`org_not_on_list` (field `audience_filter`; a stored value that resolves to
one entry but is not its exact name lists that entry as the candidate), and
the composer asks for a new pick. The dashboard's composer does not resume
saved drafts; the 422s it can meet come from creating its draft and from
Preview. The curated send (`recipientContactIds`) does not re-resolve the
filter and is not re-checked. Sent blasts keep their historical filter; nothing rewrites
broadcasts. Prefilling from the property and multi-authority rules stay with
tracker #6.

D8. **AI: list-aware, suggestion-only for anything new.**
- The extraction SYSTEM prompt stays a static template, so its memoized
  fingerprint keeps identifying it (its text changes once, to describe the
  list block). The list rides in the USER content as a block - the housing
  authority names with their spellings, then the agency names under "not
  housing authorities" - passed to the adapter through the extraction input;
  the extraction job reads the store once per run. Each run records a hash
  of the rendered list block (`orgListFingerprint`) in the AI run log beside
  the prompt fingerprint, so runs that saw the same list group together. The
  block has a budget of 16,000 characters: housing authority names first,
  then agency names, then spellings. Over budget, spellings are dropped
  first, then agency names, then the housing authority names that do not fit
  (each drop logged at WARN with counts).
- The model is told: return the full name from the list; when an
  abbreviation belongs to more than one name, pick the one the conversation
  supports or return the text as said; agency names are never housing
  authorities; where the client lives or wants to live is not a housing
  authority - a county or city name counts only when the client says it
  runs the voucher (some spellings are place names, section 13).
- The apply layer resolves the returned text with D4: a match is handled
  exactly as a known authority is today (the model's op still decides write
  or suggest; the value written or suggested is the entry's exact name);
  ambiguous or unknown text becomes a staff suggestion (as unknown names do
  today); an agency name is dropped from `housingAuthority`,
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
  The SERVER enforces the same rule: a `value` is accepted only when it is
  the D4 resolution of the suggestion's text or one of the text's ambiguity
  candidates, computed against the current list (a name staff just added
  from the text resolves); anything else is refused with 422
  `value_not_from_suggestion`. A second accept of an already-resolved
  suggestion with a different `value` answers 409
  `suggestion_already_resolved`, as an action mismatch does today: the
  completed journal row keeps `valueKey` (a sha256 of the accepted value,
  absent when none was sent) and a re-accept compares it.
- The per-run `orgListFingerprint` shows in the AI run detail header beside
  the prompt fingerprint; System Status is unchanged.
- The AI never adds to the list and never fills Agency (non-goals).

D9. **Importer: same check, no overwrites.** The importer resolves each
value with D4. Contact side: `housingAuthority` is written only when the
attribute is absent (`if_not_exists`; a staff clear REMOVEs it, so a later
re-import can re-fill it - accepted); an agency name found in the housing
authority column is written to `agency` when `agency` is absent; ambiguous or
unknown values are not written and are listed in the import report with
counts. Unit side: the existing ownership rule is unchanged (import-owned
units are rewritten each run, human-owned units fill absent attributes); the
values it writes are resolved names, agency names are never written to a
unit, and unknown or ambiguous unit values are not written and are counted
in the report. The list reaches the importer as an input: the CLI reads the
environment's stored item WITHOUT creating it (the starting list when
absent), and the not-written counts are computed in dry runs too. (B adds a
`type` rule to the importer, D21.)

### Settings page

D10. **Settings > "Housing authorities & agencies".** A new Settings tab,
visible to every signed-in user, with three sections:
- **Housing authorities** and **Agencies**: each row shows the name, its
  spellings, its notes, and how many records use it (D3) - tenants and other
  contacts, properties, (B) partners holding it as their organization -
  counting active records, with the
  count of deleted records that still hold it shown beside them ("+2
  deleted"); the delete and kind-change checks count both, and their 409
  says how many deleted records hold the name.
- **Not on the list**: every distinct stored value, across all contact types
  and properties (deleted included), that is not on the list for its field
  (D3) - one row per value and field, with its record count, the field, and
  its D4 resolution (one name, several candidates, the other kind, compound,
  or nothing). An agency's exact name in a housing authority field appears
  here with resolution "the other kind". "Show records" expands the row into
  the records holding the value: each contact's name, type and a "deleted"
  marker, or each property's address, linked to its page. Tenants and
  properties can be fixed one at a time on their own pages; for records whose
  page does not show the field (non-tenant contacts in branch A, deleted
  records), the value-level actions below are the way to settle them. A
  NAME-VARIANT row (a value that normalizes equal to an entry NAME of the
  field's kind, e.g. "atlanta housing authority") offers ONLY "Use <that
  entry>": a rewrite matches normalized text, so any other action would also
  rewrite every record holding the exact name (refused 409
  `org_value_is_name_variant`).
- Everyone: view all three sections (including "Not on the list" and its
  records); add an entry (name and notes, through "Is this really new?");
  edit an entry's notes.
- Admins only (`requireRole('admin')` on the server): edit spellings, rename,
  merge into another entry of the same kind, delete, change kind, and the
  "Not on the list" actions, each a rewrite (D11):
  - **Use <name>** - rewrite every record holding the value (in that field) to
    that name. The dialog shows the value and a "Remember this spelling"
    checkbox (on by default; D12's automatic rules can turn it off and say
    why).
  - **Move to Agency as <name>** - for housing authority values that match an
    agency entry: move to `agency` where `agency` is absent or `''`, REMOVE
    the housing authority; records whose `agency` holds something else are
    counted as conflicts and left.
  - **Move to Housing authority as <name>** - for agency values that match a
    housing authority entry: move to `housingAuthority` where it is absent,
    set `agency` to `''`; records whose housing authority holds something else
    are counted as conflicts and left.
  - **Split into <housing authority> + <agency>** - for compound housing
    authority values (D4); both names prefilled from the value's spans and
    editable: set `housingAuthority` to the housing authority name, and set
    `agency` to the agency name where `agency` is absent or `''` (records
    whose `agency` holds something else keep it and are counted as
    conflicts; their housing authority is still set).
  - **Add as new** - create the entry (from the value or a corrected name),
    then Use it.
  Split applies only to housing authority values on contacts. A compound
  member of a property's list, or a compound agency value, is settled with
  Use (keeping one half) or Clear, or record by record on its page.
  - **Clear** - remove the value from those records.
- Delete is allowed only when no record (deleted records included) uses the
  entry; kind change likewise.
- Editing spellings or notes touches no records.

D11. **The rewrite job (rename, merge, and the "Not on the list" actions).**
- One rewrite at a time: a new one is refused (409 `org_rewrite_running`)
  while `lastRewrite.status` is `running` and its heartbeat is under 15
  minutes old. The cleanup script's apply takes the same lock (section 8).
- Order: the service mints the rewrite id (a random UUID); ONE conditional
  write of the list item changes the list (rename, merge, new spelling) and
  sets `lastRewrite` to `running` with that id and the rewrite's definition
  (from-texts, to-name, fields, action); then the job is enqueued
  (`jobs.enqueue`) with the id in its payload (never the jobs envelope id).
  An enqueue failure sets `lastRewrite` to `failed`. A
  `failed` rewrite, or a `running` one whose heartbeat is older than 15
  minutes, shows "Run again" (admin), which re-enqueues the same definition -
  EXCEPT action `cleanup`, which no job can run: for it the page says to
  re-run the cleanup script, and a stale `cleanup` lock simply stops blocking
  new rewrites after 15 minutes.
- The job reads every contact of every type, active and deleted - through the
  `byTypeStatus` index, as every contact list in the app does (the contacts
  table also holds pointer rows; the repo refuses to remove that index's keys,
  so a contact missing them is invisible app-wide) - and every unit, active and
  deleted (a base-table scan). Index lag is sub-second: a record written in
  the moment before a rewrite or a delete check can be missed, and then shows
  in "Not on the list" once the index catches up, where Use settles it. The
  rewrite's `fields` are fixed when it starts (rename/merge: the fields of the
  target's kind then). It rewrites each value or
  list member whose normalized text is in the from-texts, conditional on the
  record still holding the text it read; unit lists are de-duplicated after
  the rewrite; the housing authority is REMOVEd on Clear. Machine writes never
  stamp `updated_at` on units (the importer's human-ownership signal). Each
  record write appends an audit event `org_name_rewrite` {field, from, to,
  action, actor} (`actor` is the codebase's audit key). The job never touches
  broadcasts.
- From-texts: rename = the old name; merge = the merged entry's name and its
  spellings that no other entry shares; Use <name>, Move to Agency, Move to
  Housing authority, Split and Clear = the value (in the one field the row
  names).
- Merge moves the merged entry's name and ALL its spellings onto the target
  as spellings, then removes the merged entry. A spelling the merged entry
  shared with a third entry stays shared (the target replaces the merged
  carrier, so no share is created or lost); D12's skip rules for automatic
  additions do not apply to this transfer. A merge whose transfer would break
  a D13 cap is refused (409 `org_spellings_full`) so no spelling is silently
  dropped. A renamed entry keeps its old name as a spelling.
- The job heartbeats `lastRewrite` and finishes with `done` and counts
  (records rewritten per field, skipped because a record changed meanwhile).
  It acts only while `lastRewrite` still carries its id and `running`; every
  heartbeat and finish re-checks the id first, so a duplicate or stale run
  never overwrites a newer rewrite's state, and a run whose heartbeat finds
  the lock gone stops writing records at once. "Run again" first re-checks
  that the rewrite's target names still exist with the expected kind (else
  409 `org_rewrite_target_gone`). It catches its own errors,
  records `failed` with the counts so far, and never rethrows (a rethrow would
  make the queue redeliver it). Re-running a definition is safe: records
  already rewritten no longer hold the from-text. While a rewrite runs, a
  blast filtered on the new name misses records not yet rewritten (seconds to
  minutes).

D12. **Spellings are curated, never learned from form clicks.** Sources: the
starting list; admin edits on the Settings page; renamed and merged names
(D11); values settled with "Use <name>" when "Remember this spelling" is on
(D10).
- An admin spelling edit is refused when the spelling equals any entry's
  name, would be shared with an entry of the OTHER kind, is compound (D4), or
  breaks a D13 cap; adding a spelling another entry of the same kind already
  carries is allowed only with an explicit confirm ("now shared with <name> -
  it will no longer be applied automatically").
- AUTOMATIC additions (rename keeping the old name, Use with "Remember this
  spelling") apply the same rules but SKIP - never fail on - a spelling that
  breaks one; the action still runs, and the result names each skipped
  spelling and why. They never create a same-kind share silently: a spelling
  another entry already carries is skipped too. (Merge's transfer follows
  D11 instead.)
- A rename's new name must not equal another entry's name or spelling (it may
  equal one of the entry's own spellings, which is then dropped from its
  spellings).

D13. **Notes, names and size limits.** Names are at most 120 characters.
Names and spellings may not contain a newline, another control character or
an invisible format character such as a soft hyphen or zero-width space
(they are rendered one per line into the AI list block, and an invisible
character would make two visually identical names), and neither a name
nor a spelling may normalize to the empty string (for example "-" or "()" -
such a spelling would match nothing).
Notes are free text up to 500 characters, editable by everyone. An entry
carries at most 20 spellings of at most 120 characters each (the name limit,
so a merged or renamed name always fits as a spelling). A COMPOUND text (D4)
is refused as a new name too - in "Is this really new?", Add as new and
rename - with a message naming the entries it contains and pointing to
Split. A write that
would make the item larger than 300 KB is refused with 409 `org_list_full`
(about 300 entries with full notes fit; the starting list has about 20). The
AI list block has its own budget (D8).

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
re-arm the intake text. The operator hint that mirrors this rule (Settings >
Templates, `dashboard/src/routes/settings/TemplatesSection.tsx`, and its
test) changes with it, and so does the rule's description in
`docs/issues/missed-call-autotext-partial-intake.md`. A contact whose only
fact was a junk value that staff
Clear is genuinely blank and may receive it (stated, accepted).

### Branch B

D16. **Caseworkers stay partners.** The contact type picker gains a
"Caseworker" choice that saves `type: partner, role: Caseworker` (one
constant, `CASEWORKER_ROLE`, beside `PROPERTY_MANAGER_ROLE`), the way
"Property Manager" saves `type: landlord, role: Property Manager`. No new
`ContactType`. Three tiers of role matching, each named and owned by one
shared helper (revision 9):
- the extraction kind canonicalizer (`canonicalSuggestedContactKind`) treats
  `type: partner` with role EXACTLY `Caseworker` as `partner` - byte-exact,
  as the Property Manager preset is - so accepting an AI "partner" suggestion
  through the Caseworker choice records `accepted`; any other partner role
  stays unsupported;
- the Caseworkers tab (D18) uses `isCaseworkerRole(role)`: the role
  normalizes (D4) to "caseworker" or "case worker";
- the Possible caseworkers list (D19) uses the looser "mentions" match.
The Unknown triage card gains "Mark as Caseworker" beside Mark as Tenant /
Landlord / Partner - the one-click way to accept the AI's `partner`
suggestion as a caseworker (planner default; Cameron confirms). The
KindPicker's "Other" placeholder no longer suggests "Case worker" on a tenant
or landlord base: those are exactly the records D19 exists to clean up. The
Caseworker choice on a contact that is a tenant today applies D19's
refusals (open placement, open tour, landlord of record, roster seat): the
choice is a conversion, not a relabel (planner default; Cameron confirms).
The generic edit-form type change keeps today's unguarded behavior
(pre-existing; filed, section 12).

D17. **Organization field on partners.** `contact.organization`, checked by
D5 against EITHER list (`KINDS_FOR_FIELD.organization` = both kinds; A's
check already takes a list of kinds, so an "other kind" result can never
occur for it), edited on partner contacts (the server accepts it on any
contact, as it does housingAuthority; the UI offers it on partners).
Clearing REMOVEs the attribute (`''` -> absent, the `role` convention; Make
caseworker's "left empty" and the rewrite's Clear mean the same absent
attribute). Shown on the partner page and as the Caseworkers tab's filter.
In Settings (D10, D11), where A's code assumes one kind per field: usage
gains a "partners" column counting organization holders (a record holding
one name in two fields counts once per entry); a rename or merge of EITHER
kind also rewrites `organization` (a housing authority rewrite covers
housingAuthority, accepted_authorities and organization; an agency rewrite
covers agency and organization); Delete's refusal counts organization
holders; a kind change is NOT blocked by organization holders (the field
accepts either kind, so they stay valid); an organization "Not on the list"
row offers Use (a name of either kind), Add as new (staff pick the kind -
the resolve body gains `kind`) and Clear - never Move or Split (the field
has no "other kind"); Run again and the job's claim re-validate an
organization Use target against both kinds. The Organization picker is D6's
both-lists picker with the organization-mode add dialog. The dev-only
`POST /__dev/org-fixture` accepts `organization` (stated exception).

D18. **Caseworkers tab.** Contacts gains a Caseworkers tab at
`/contacts/caseworkers` - a sub-link under Contacts beside Tenants,
Landlords and Unknown, the one addition this design makes to the otherwise
locked navigation (planner default; Cameron confirms): partner contacts
whose role satisfies `isCaseworkerRole`, with organization filter chips
built the way the Tenants page builds its housing authority chips. The route
joins the page-profiler registry (or is excluded with a filed issue - the
plan decides). The tab starts empty until the Caseworker choice or Make
caseworker writes a role: no path has ever given a partner one.

D19. **Possible caseworkers.** The Caseworkers tab shows a "Possible
caseworkers" list, computed on the server (`GET
/api/contacts/possible-caseworkers`: one read of the tenant, landlord and
partner partitions - no index exists for any signal; the tours-tabs cost
precedent) of contacts that are not yet caseworkers:
- tenants whose role mentions caseworker or case manager, whose notes carry
  the AI's "Identified as a caseworker" line or those words (match the
  words - the line is model-written and dated), or who are linked as another
  contact's caseworker relationship (a relationship row that carries a
  `contactId`);
- partners with NO role - today EVERY partner, since no path has given a
  partner a role (the importer's caseworkers, the AI chip's, and other
  outside contacts alike; the lean world's Renee Carter is one, and e2e
  expectations include her); "Not a caseworker" dismisses the rest;
- tenant- or landlord-based contacts whose custom-kind role says caseworker.
Each row offers "Make caseworker" and "Not a caseworker", open to every
signed-in user as the edit form's type change is (planner default; Cameron
confirms), through `POST /api/contacts/:contactId/caseworker-review`.
Dismissal is stored on the contact (`caseworker_review: 'dismissed'`) and
hides the row for good. Make caseworker: refused 409 while the contact has
an open placement (a non-terminal stage) or an open tour as the tenant
(requested, scheduled, toured or no_show; canceled and closed are resolved),
is any unit's landlord of record (`landlordId`), or sits on any unit's
contact roster (a unit scan - no index) - each refusal has its own code
(`caseworker_open_placement`, `caseworker_open_tour`,
`caseworker_landlord_of_record`, `caseworker_on_roster`) and a staff
sentence naming what to resolve first. Otherwise, in one write through the
classification fence (`contactsRepo.update`, so `classification_revision`
bumps): type `partner`, role `Caseworker`, status `active` (the partner
default), `type_source: manual`; `organization` from the contact's agency
when it is exactly a list name, else from its housing authority when that is
(agency wins when both are - the employer is the helper organization;
planner default; Cameron confirms), else left absent for staff to pick;
REMOVEs `housingAuthority` together with its `housingAuthority_source` stamp
and supersedes any pending housing-authority suggestion (a partner is never
extracted again, so it would never resolve); clears `agency`; re-types the
contact's open one-to-one threads (D21). Past tours, closed placements and
listing sends stay as history in the data; the partner page does not show
tenant history. The partner page gains the Staff notes card, so a converted
caseworker's notes stay visible (planner default - the open issue
`staff-notes-on-landlord-partner-files` asked to check with Sam; Cameron
confirms).

D20. **Direct property shares to partners; no blasts.** A partner's page gets
the "Properties sent" card and its Send action, as tenants have (the rows
already load for every contact type; only the card is missing); the
composer opens with the partner as its starting recipient and sends the
normal share (address and flyer link) into the partner's own conversation.
Starting (seed) and explicitly listed recipients may be tenants or partners;
filter-resolved audiences stay tenant-only, and the composer's recipient
search stays tenant-only. Every existing gate (opt-out per phone number,
unreachable, deleted, the kill switch, the just-in-time consent check)
applies unchanged. A share to a partner with no conversation creates a
`partner_1to1` conversation: both fan-out sites (the send pass and the
send.reconcile adoption in `broadcastFanOut.ts`) use the exported
`conversationTypeFor(contact)` from `lib/voiceMasking.ts`. The property's
"Sent to tenants" list becomes "Sent to", with partner rows labelled by
their role: the recipients rows gain `type` and `role` (display projection
and wire row). Recipient wording goes NEUTRAL everywhere it is tenant-only
today - the composer preview and results ("Send to N recipients"; a
recipient row's fallback name), the compose reach line, the Matching list
label and the property Activity's share row ("Sent to N recipients") - one
rule, no type on preview or results rows; the plan lists every unit and e2e
pin that changes.

D21. **Type changes keep threads and imports consistent.** When staff change
a contact's type between tenant, landlord and partner (edit form, Caseworker
choice, Make caseworker), the contact's open one-to-one threads - for EVERY
phone in its `phones` list and every email address
(`conversationsForContact`), not only the primary phone - whose type matches
the OLD type, OR is still `unknown_1to1` (today's triage flip, kept: every
imported one-to-one thread is `unknown_1to1` and only this path ever
re-types a thread), are re-typed to the new type; a thread typed for some
other identity is left alone (today's triage-conflict rule); the re-type is
conditional on the type the read returned. A NEW field `type_source:
'manual'` is stamped when staff OVERRIDE a type - change a contact typed
tenant, landlord or partner to a different type (edit form, Caseworker
choice) - and by Make caseworker; triage of an `unknown` contact does not
stamp it. The field is server-owned: a client-sent `type_source` is refused
as `consent_captured_by` is. The importer, for a contact whose `type_source`
is `'manual'`, writes none of `type`, `status`, `housingAuthority` or
`agency` (its own type and status were computed for a type staff overrode,
and Make caseworker removed the authority on purpose - since A the authority
and agency are fill-only, so the guard is load-bearing for type, status and
the removed authority); contacts without the field are imported as today.
Triage of an `unknown` contact is NOT protected: a later re-import still
applies the importer's type, status and fill-only fields to it, as it does
today (pre-existing; filed by A as `reimport-reverts-unknown-triage`). The
contact header shows voucher size and housing authority only when
`contact.type` is `tenant` (keyed on the type, not the display kind, because
team_member maps to the tenant kind).

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
      spellings: string[],         // <= 20, each <= 120 chars
      notes?: string,              // <= 500 chars
      createdAt: string, createdBy: string,
      updatedAt: string, updatedBy: string,
    }
  ],
  lastRewrite?: {                  // the latest rewrite (D11)
    jobId: string,
    action: 'rename' | 'merge' | 'use' | 'move_to_agency'
          | 'move_to_housing_authority' | 'split' | 'clear' | 'cleanup',
    fromTexts: string[], toName?: string,
    agencyName?: string,           // split: the agency half
    field?: string,                // the one field a value action targets
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
| `contact.organization` (B, partners) | either | new; checked by D5 against both kinds; `''` REMOVEs (the `role` convention) |
| `contact.caseworker_review` (B) | - | new: `'dismissed'`; server-owned (written by the caseworker-review route, a client value refused) |
| `contact.type_source` (B) | - | new: `'manual'` on staff type overrides and Make caseworker; server-owned (a client value refused, as `consent_captured_by` is) |
| broadcast `audience_filter.housing_authority` | housing authority | POST checked by D5; preview and a filter-resolved send re-check (D7) |

The legacy `unit.jurisdiction` / `accepted_programs` tombstones stay accepted
and ignored on the unit PATCH (`docs/issues/retire-humanize-authority.md`);
the cleanup backfills `accepted_authorities` for units that have only
`jurisdiction`.

---

## 6. API

All under `/api/organizations`, signed-in staff unless marked admin.

- `GET /api/organizations` - both lists (5.1 entries) plus `lastRewrite`.
- `GET /api/organizations/usage` - per-entry use counts (D3, D10).
- `GET /api/organizations/not-on-list` - the D10 section: distinct values,
  field, count, resolution; `GET /api/organizations/not-on-list/records?field=&value=`
  - the holding records of one row. Computed on demand (D11's read paths).
  Visible to everyone.
- `POST /api/organizations/check` `{ kind, text, spellingFor? }` - the D4
  resolution: `{ match?, candidates[], close[], otherKind?, compound?,
  nameProblem?, spellingProblem? }`. No write. Text over 200 characters is
  refused with 400; close names are scored only for texts up to 120
  characters.
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
  action: 'use' | 'move_to_agency' | 'move_to_housing_authority' | 'split' |
  'add' | 'clear', name?, agencyName? (split), rememberSpelling? }` - starts
  the rewrite (D10, D11); the response names any spelling D12 skipped.
- `POST /api/organizations/rewrite/run-again` (admin) - D11.
- Suggestions: `POST` accept gains optional `value` (D8); 422
  `value_not_from_suggestion`, 409 `suggestion_already_resolved`.

Existing endpoints that write the fields in 5.2 apply D5 and answer 422
`org_not_on_list`. Rewrite-starting endpoints answer 409
`org_rewrite_running` while one runs (D11).

Branch B (revision 9):

- `GET /api/contacts/possible-caseworkers` - D19's list, computed on the
  server from the tenant, landlord and partner partitions: one row per
  contact with its name, type, current role and the signal that put it
  there. Visible to everyone.
- `POST /api/contacts/:contactId/caseworker-review` `{ action: 'make' |
  'dismiss' }` (everyone - planner default, D19) - `make` is Make caseworker
  (refused 409 `caseworker_open_placement`, `caseworker_open_tour`,
  `caseworker_landlord_of_record` or `caseworker_on_roster`, each with a
  staff sentence); `dismiss` writes `caseworker_review: 'dismissed'`.
- `POST /api/organizations/check` gains optional `kinds` (both lists) for
  the organization picker; `kind` alone keeps today's single-list behavior.
- `POST /api/organizations/not-on-list/resolve` gains `kind` for
  `action: 'add'` on an `organization` row; `move_to_agency`,
  `move_to_housing_authority` and `split` are refused 400 for that field.
- `GET /api/organizations/usage` gains a `partners` count per entry
  (organization holders; a record holding one name in two fields counts
  once).
- `GET /api/units/:unitId/recipients` rows gain `type` and `role` (D20).
- contacts PATCH accepts `organization` (D5, either kind) and applies D21 to
  a `type` change; `caseworker_review` and `type_source` are refused when a
  client sends them.

---

## 7. Behavior by surface (branch A)

- **Tenant edit form:** Housing authority and Agency pickers (D6); help text
  under Housing authority: "The organization that runs the voucher".
  `orgVocabulary.ts` is replaced by the stored list.
- **Property New/Edit forms:** Housing authorities multi-picker (D6), housing
  authorities only; legacy members shown as "Not on the list" chips.
- **Blast composer:** housing authority filter picker without add (D7); it
  changes the filter only on a pick or a clear (never per keystroke, since
  every filter change re-creates the draft); a 422 at draft create or at
  Preview asks for a new pick.
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
  `cobb_housing` -> Marietta Housing Authority, `fulton_housing` -> Fulton
  County Housing Authority). Seeds write the `org-list` item. The lean world changes; e2e
  expectations follow.
- **e2e specs** that type free-text names or mint run-unique names pick list
  names or add their run-unique names through `POST /api/organizations` first.
  The "Not on the list" section and its actions are tested through a NEW
  dev-only seam, `POST /__dev/org-fixture` (mounted only where the other
  `/__dev` fixtures are), which writes a run-unique off-list value onto
  records the spec itself created, bypassing D5; nothing off-list is seeded
  into the shared lean world, so one spec's settle action cannot leak into
  another.

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
  before the deploy). A dry run never writes. An apply REFUSES to run while
  the environment has no stored item (exit 1, nothing read or written): the
  deployed app creates the item on its first read, so its absence means the
  environment is not yet on the new code, and an apply there would rewrite
  data under an app that still speaks the old spellings (final review
  2026-10-07; the RUNBOOK's step 4 opens the Settings tab once first).
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
- **Lock:** the apply takes the D11 rewrite lock (`lastRewrite` set to
  `running` with action `cleanup`, heartbeated, finished `done` or `failed`)
  and refuses to start while another rewrite runs, so no rename or merge can
  interleave with it. Its abort and failure paths release the lock (set
  `failed`) before exiting; after a hard kill the stale lock stops blocking
  rewrites 15 minutes after its last heartbeat (RUNBOOK names the wait). The
  Settings page never offers "Run again" for it (D11). A dry run takes no
  lock.
- **Order (RUNBOOK):** dry run against prod from a `main` checkout BEFORE the
  deploy; review the leftover values with Sam; deploy; apply immediately after
  the deploy (until the apply runs, a blast filtered on a new list name misses
  tenants still holding old spellings); then Sam settles the leftovers on the
  Settings page. Dev first. No agent runs it against dev or prod; an agent
  rehearses on a lane (`--env local --lane L`).

---

## 9. Invariants, writers and readers (the plan must enumerate each)

**Invariant I1:** every housing authority, agency, accepted-authority member,
(B) organization and broadcast filter value WRITTEN after the deploy is on
the list for its field (D3: an entry name of a kind the field accepts).
Values written before the deploy are either mapped by the cleanup or listed
in the Settings page's "Not on the list" section until staff settle them; a
broadcast's stored filter is re-checked at preview and on a filter-resolved
send (D7).

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
  and the dev reseed; the dev-only `POST /__dev/org-fixture` seam (a stated
  exception: it writes off-list values on purpose, local stacks only; (B) it
  accepts `organization` too);
- the rewrite job (D11) and the cleanup script (section 8);
- (B) the caseworker-review route (Make caseworker, D19) and the Caseworker
  choice (D16), both through the contacts PATCH's classification fence.

Readers (must keep working with full names and with not-on-the-list values):
`audienceResolution.ts` and broadcast preview/send; Tenants page facets;
Properties page summary and facets; the flyer projection; `similarUnits.ts`;
the AI job's current-profile context and the new list block; the AI run log
(the run detail header shows `orgListFingerprint`; the new drop reason and
its label; System Status is unchanged); the missed-call auto-text check and
its Settings > Templates hint (D15); the property Activity tab (labels for
`org_name_rewrite` / `org_name_cleanup`); the contact header and tenant
file; tour and placement pages that show tenant facts; (B) the Caseworkers
tab and the Possible caseworkers list, the partner page, the Unknown triage
card, the "Sent to" list, the Settings usage column and organization rows,
and the extraction kind canonicalizer.

**Invariant I2 (B):** a partner's share never mints a `tenant_1to1` thread
(both fan-out sites use the contact's type), and a staff type change re-types
the contact's own open one-to-one threads (D21). Exception: the public intake
routes still mint `tenant_1to1` for any phone (tracker #13).

---

## 10. Branch B summary of changes

- KindPicker "Caseworker" choice (with D19's refusals), the Unknown card's
  "Mark as Caseworker", the byte-exact kind canonicalizer and the shared
  `isCaseworkerRole` helper; the "Other" placeholder drops "Case worker"
  (D16). Partner edit form Organization picker over both lists with the
  organization-mode add dialog and a both-lists `/check` (D17, D6). Partner
  page shows Role, Organization and the Staff notes card; the contact header
  hides tenant facts for non-tenants (D21).
- Contacts > Caseworkers sub-link and tab with organization chips (D18); the
  Possible caseworkers list from its server endpoint with its two actions
  through the caseworker-review route (D19).
- Direct shares (D20): `broadcasts.ts` seed resolution and the explicit send
  list accept `partner`; both fan-out sites mint the contact's conversation
  type; PartnerFile gets the Properties sent card and Send; recipient wording
  goes neutral on the composer preview and results, the compose reach line,
  the Matching list label and the property Activity row; the property's
  "Sent to" list labels partner rows (recipient rows carry type and role).
- Type-change thread consistency (old-type or `unknown_1to1`), the
  server-owned `type_source` and the importer's rule (D21).
- Settings: a partners usage column, Delete counting organization holders,
  rename/merge of either kind rewriting `organization`, organization rows in
  "Not on the list" with Use / Add as new (with kind) / Clear, Run again
  across both kinds (D17).
- Page-profiler and mutation-catalog pins updated for the new route and
  endpoints; `/__dev/org-fixture` accepts `organization` (plan).

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
- A re-import reverts in-app triage of imported `unknown` contacts (the
  importer SETs type and status on every run for contacts without
  `type_source`; pre-existing).
- Close or update `housing-authority-free-text-drift` (resolved by this work)
  and `retire-humanize-authority` (seed slugs retired here; PATCH tombstones
  remain).
- (B) The generic edit-form type change has none of Make caseworker's
  refusals: a tenant with an open placement or tour can be re-typed today
  (pre-existing; B guards only the Caseworker choice). File for a decision.
- (B) The possible-caseworkers read scans three contact partitions with no
  index (the `tours-tabs-load-every-contact-for-names` cost class); revisit
  if the contact count grows.

---

## 13. Questions for Sam - answered 2026-10-06

Sam answered in the 2026-10-06 founder meeting
(`W:\AI Projects\Housing Choice\Founder Meeting 2026-10-06\Meeting Transcript.md`):

1. **Fulton County:** add Fulton County Housing Authority (she left it off
   her list by mistake; she works with no one there today). The old value
   `Fulton County` meant the Fulton County voucher, not Atlanta's.
2. **McDonough:** McDonough Housing Authority runs public housing only;
   McDonough and Henry County vouchers are DCA's.
3. **Clayton County and Cobb County:** Clayton County vouchers (including
   "Housing Authority of Clayton County") are Jonesboro Housing Authority's;
   Cobb County vouchers are Marietta Housing Authority's.
4. **Hands of Hope:** left off - real, but she has no record of working with
   it (she works with HOPE Atlanta). Settings adds it if that changes.
5. **Any other entry now:** none beyond Fulton County.
6. **HUD-VASH:** confirmed as an agency; VA caseworkers are her strongest
   relationships, and she works with them directly.

So the old values are spellings of the entry that runs those vouchers
(Appendix A) and the cleanup maps them automatically: `Fulton County` and
`Fulton, Fulton County` -> Fulton County Housing Authority; `McDonough` and
`Henry County` -> Georgia Department of Community Affairs; `Clayton County`
and `Housing Authority of Clayton County` -> Jonesboro Housing Authority;
`Cobb County` -> Marietta Housing Authority. The retired importer alias
`Clayton` (bare) -> Jonesboro Housing Authority too (Cameron, 2026-10-07,
reversing his 2026-10-06 launch-gate ruling after verification: DCA does not
administer vouchers in Clayton County - it is one of the ten counties with
their own authority - and Jonesboro Housing Authority is Clayton County's only
voucher administrator; the city of Clayton in Rabun County, which DCA serves,
is not in this caseload). "McDonough Housing Authority" is
deliberately NOT a spelling (a public-housing authority with no vouchers). The
seeds map `fulton_housing` to Fulton County Housing Authority.

---

## Appendix A - Starting list (final: Sam's answers, section 13)

Housing authorities:

| Name | Spellings |
|---|---|
| Atlanta Housing Authority | AHA; Atlanta Housing; Housing Authority of the City of Atlanta; Atlanta (AHA); Atlanta, aha, Atlanta housing |
| Georgia Department of Community Affairs | DCA; Georgia DCA; GA DCA; Department of Community Affairs; DCA, Department of Community Affairs; McDonough; Henry County |
| Georgia Housing Voucher Program (DBHDD) | GHV; GHVP; DBHDD; Georgia Housing Voucher; Georgia Housing Voucher (GHV) |
| DeKalb County Housing Authority | HADC; Housing Authority of DeKalb County; Dekalb County Housing; Dekalb Housing |
| Decatur Housing Authority | Housing Authority of the City of Decatur |
| Marietta Housing Authority | MHA; Cobb County |
| Jonesboro Housing Authority | JHA; Jonesboro (JHA); Jonesboro housing; Jonesboro, JHA, Jonesboro housing; Clayton County; Housing Authority of Clayton County; Clayton |
| East Point Housing Authority | EPHA; East Point; Eastpoint Housing Authority |
| College Park Housing Authority | Housing Authority of the City of College Park; College Park |
| Macon-Bibb County Housing Authority | Macon Housing Authority; MHA |
| Augusta Housing Authority | AHA |
| Fulton County Housing Authority | Housing Authority of Fulton County; Fulton County; Fulton, Fulton County |

Notes carried on the starting entries (research, 2026-10-06): Georgia
Department of Community Affairs (the 149 counties it covers and the ten it
does not; North Regional Office in Atlanta), Georgia Housing Voucher Program
(DBHDD's statewide program; its contractor pays landlords; the provider
agency requests inspections), HUD-VASH (national program; voucher from a
housing authority, case manager from the local VA medical center), Fulton
County Housing Authority (Fulton County outside the City of Atlanta).

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
Point", "HUD VASH", "Claratel", "Hope Atlanta", "Step Up") and the old county
values Sam settled ("Fulton County", "McDonough", "Henry County", "Clayton
County", "Cobb County") resolve to one entry each, so the cleanup maps them
automatically; a bare "AHA" or "MHA" is ambiguous by design and lands in "Not
on the list".

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
