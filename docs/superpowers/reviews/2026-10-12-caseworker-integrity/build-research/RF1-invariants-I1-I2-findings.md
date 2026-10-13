# RF1 - invariant sweep findings: I1 (tenant-only accepts) and I2 (tenant records)

Reader: RF1 (read-only), caseworker-integrity build mission, 2026-10-12.
Tree: W:\tmp\caseworker-integrity @670fb701 (main @19607658 + spec + plan).
Method: every writer and reader of the protected state derived from the live
code first, then compared with spec sections 1/2/4/5/6/10 and the plan's
"Surfaces covered" lists. Full inventory (writers A1-A20, B1-B12, C1-C19,
readers D1-D18, result/code consumers E1-E13):
`.superpowers/sdd/research/RF1-invariants-I1-I2-reference.md` (gitignored
reference, one file one kind).

Headline: NO BLOCKER. No plan-unlisted accept path exists for I1, and no
plan-unlisted create / revive / reopen / terminal-exit / tenantId-change path
exists for I2 (the six spec section 4 surfaces are the only ones in code; the
contacts PATCH and the conversion are the only runtime type writers besides the
out-of-scope importer). No READER-DISAGREES case found. Four items below.

---

## F1 - CORRECTION: the housing-authority "Is this really new?" dialog writes a tenant-only field onto a team member, bypassing D1's refusal

**Where.** `dashboard/src/routes/contact/ContactDetail.tsx:816-823`
(`onAcceptSuggestion`) -> `:766-791` (`reviewHousingAuthority`: org check; a
text that is not exactly a list name opens the dialog) -> `NewOrgDialog`
(`:1240-1255`; `dashboard/src/routes/orgs/NewOrgDialog.tsx:66`, `:172-185`,
`:266-272`) -> "Use" on a CLOSE name (`via === 'close'`) ->
`editHousingAuthorityTo` (`ContactDetail.tsx:801-813`) -> `updateContact`
PATCH `{ housingAuthority }` -> `app/src/routes/contacts.ts:653-658` (no type
gate; only the D5 list check `:1663-1685`) writes the authority, and the
pending chip is superseded as a human edit (`:1801-1817`).

**Reachable path.** A tenant with a pending housingAuthority chip (common: an
authority not exactly on the list is always SUGGESTED as said,
`app/src/services/extraction/apply.ts:289-297`) is re-typed to `team_member`
in the edit form (D2 allows it when the contact holds no open tour or
placement; the PATCH supersedes only the CHANGED fields' chips, so the chip
stays - spec section 2 "Today" says the same). A team member's page renders
`TenantFile` (`ContactDetail.tsx:574-584`), which renders the tenant-only
chips (`TenantFile.tsx:146-189`). Accept -> dialog -> pick a close name ->
the authority lands on the team member. `team_member` is the ONLY non-tenant
type whose page shows tenant-only chips (landlord / partner / unknown files do
not render them), so this is exactly where staff meet D1 in the UI. The
dialog's "Add it as new" (`onAdded`, `:1253`) has a side effect too: it adds
an organization-list entry and THEN accepts, which the server now refuses with
409 `suggestion_contact_not_tenant` - a list entry created for a refused
accept.

**Why it matters.** Not an I1 violation as written (no accept runs; the run
log records `superseded_by_human_edit`), but it contradicts D1's stated
outcome for this chip ("This contact isn't a tenant, so this can't be applied.
Dismiss it instead.", spec section 2 change 6) on the one surface where staff
can click it. Neither the spec nor the plan names this path (plan grep: no
`reviewHousingAuthority` / `editHousingAuthorityTo` / `NewOrgDialog` task).

**Recommended handling.** In-scope, small (S1 dashboard, beside Tasks
1.9/1.10): in `onAcceptSuggestion`, when `contact.type !== 'tenant'` and the
target is tenant-only, skip `reviewHousingAuthority` and call
`acceptSuggestionValue(target)` directly, so the server answers 409
`suggestion_contact_not_tenant` and the chip shows the D1 sentence; one
ContactDetail test (team member + non-list HA chip -> no dialog, D1 copy).
Alternative: file as an issue if the orchestrator keeps S1 server-only.

---

## F2 - NOTE: spec section 5 inventories tenant-only writers only as accept paths; other writers exist (none is an accept)

I1 is scoped to accepts, so these do not break it; listed so nothing is
assumed. Readers stay safe: broadcast audiences skip every non-tenant
(`app/src/services/audienceResolution.ts:149`), and only `TenantFile`
(tenant + team member) renders tenant facts.

a. **Settings > Not on the list, "Move to housing authority"** -
   `app/src/services/orgRecords.ts:358-375` writes `housingAuthority` onto
   EVERY contact holding the agency text, of every type (`everyContact`
   `:415-425` over `CONTACT_TYPES` `:161-168`; write `:683-687`). A converted
   caseworker is not matched (agency is '' after the conversion; organization
   is never moved, `app/src/services/orgRewrite.ts:466-473`); a landlord,
   partner, team member or unknown holding an agency text (from a re-type or
   the importer) is.
b. **contacts PATCH / POST direct edits are not type-gated server-side** -
   PATCH `app/src/routes/contacts.ts:541-552` (contactName -> voucherSize),
   `:573-580`, `:653-658`, `:721-728`; POST `:820-847`, `:908-914`. The edit
   form shows these only for tenants (`ContactEditForm.tsx:180`, `:621-690`),
   except F1.
c. **`PATCH /api/contacts/:id/tenant-status` writes `porting` on any type** -
   `app/src/routes/statusTransition.ts:257-260`, `:284`;
   `app/src/services/statusTransition.ts:162`. The dashboard sends porting only
   for tenants (`ContactEditForm.tsx:483`).
d. **The importer writes `voucherSize` (and overwrites `notes`) even on a
   `type_source: 'manual'` contact, i.e. every converted caseworker** -
   `app/src/lib/import/apply.ts:1137-1144` (no manual gate; type / status /
   housingAuthority / agency ARE gated at `:1073`, `:1110`, `:1150`, `:1156`).
   The plan's Task 5.9 issue text for `import-bypasses-contact-type-rules`
   (plan `:14252-14255`) says the manual stamp "covers converted caseworkers"
   - true for the four fields it names, not for voucherSize.

**Recommended handling.** No code action. Docs: add one bullet to the 5.9
`import-bypasses-contact-type-rules` body - "it writes voucherSize and notes
on every run, `type_source: 'manual'` contacts (converted caseworkers)
included (`apply.ts:1137-1144`)" - since the M1.6 import has not run yet.

---

## F3 - NOTE: transitionPlacement decides "leaving a terminal stage" from an eventually consistent placement read

**Where.** `app/src/services/statusTransition.ts:395`
(`placementsRepo.getById` - no ConsistentRead option,
`app/src/repos/placementsRepo.ts:254-257`); the stage write
(`:452` -> `placementsRepo.ts:311-355`) is conditioned only on
`attribute_exists`. Plan Task 3.8 (plan `:7319`, implementation `:7492-7516`)
keys the new tenant check on `existing.stage` from that read.

**Reachable path.** Move a placement to `lost` -> re-type its tenant (D2
passes: the placement now reads terminal) -> move it back out of `lost`, all
within read-after-write lag: the stale read reports the pre-`lost` stage, the
check is skipped, and an open placement gets a non-tenant tenant. Three human
writes inside about a second - the same window class as spec L1, though L1's
text names only the GSI reads.

**Recommended handling.** No action (L1 class). Optional: one clause in L1 /
the RUNBOOK L1 paragraph (plan Task 5.7) naming the placement read, or file
under `placement-terminal-stage-exit-unguarded` (plan 5.9).

---

## F4 - NOTE: inventory completeness (all harmless, no action)

- Classification create paths besides `POST /api/contacts` (spec section 5
  names only that one): public housing-fair (`app/src/routes/public.ts:257`,
  tenant), unmatched-email create (`app/src/routes/unmatchedEmail.ts:462`),
  auto-capture and group stubs (`app/src/services/contactCapture.ts:111`,
  `groupConvert.ts:347`, `groupMembers.ts:155`; `unknown` via
  `createIfAbsent`, never overwriting). A new contact holds no tours,
  placements or seats.
- Spec section 5 "No job or dev seam creates or reopens them": the reseed
  seams do create tours and placements (`app/src/routes/dev.ts:329`, `:339`),
  through the seeds the spec lists separately (plan 5.1); the performance seed
  draws tenants only from generated tenants
  (`app/src/lib/seed/performance.ts:1185-1199`).
- Spec section 1 names tour reminders as the reader that still accepts
  `unknown_1to1`; placement nudges (`app/src/jobs/placementNudges.ts:518-519`,
  and they MINT a `tenant_1to1` when none exists, `:650-652`) and the contact
  timeline (`app/src/routes/contactTimeline.ts:959-960`) do the same. All
  consistent with I2.
- `POST /api/placements/from-tour` never checks the tour's status, so a
  canceled tour that is still `convertible` converts
  (`app/src/routes/placements.ts:652-663`); plan Task 3.7's contact check is
  independent of the tour status, so I2 holds.
