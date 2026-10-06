# Spec review r2 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
at `28243656` (revision 2). Inputs: the r1 reports of both reviewers and
`adjudications.md`. Read and grep only; no suite run. Every claim about current
behavior cites a file:line that was read; anything unproven is marked
UNVERIFIED. Spec citations are `spec:<line>` at `28243656`.

Ordered by severity (consequence if shipped unfixed). New problems first; the
adjudication contest and the fix checks are at the end.

---

## 1. [MEDIUM] "Uses" (D3) and "Not on the list" (D10) ignore the field's kind, so exact wrong-kind names are counted as valid uses and never surface

**What is wrong.** D3 defines a use as a stored value that is "character-for-
character the entry's name" (spec:230-232), with no reference to the field
holding it. D10 lists every stored value "that is not exactly a listed name"
(spec:354-355) - again any kind - although its resolution column includes "the
other kind" (spec:356-357). Rev 2 itself LEAVES exact wrong-kind names in place:

- cleanup: a housing authority value resolving to one agency is moved only
  when `agency` is absent or `''`, "otherwise count a conflict and leave both"
  (spec:629-631);
- Move to Agency: "records whose `agency` holds something else are counted as
  conflicts and left" (spec:367-368).

The old canonical `'Step Up'` (`app/src/lib/housingAuthority.ts:57`) is
character-for-character the Appendix A agency name "Step Up" (spec:782); the
same holds for any free-text "Mercy Care" or "CaringWorks".

**What it implies.** A tenant whose housing authority field holds "Step Up" and
whose Agency holds another agency keeps an agency in the authority field
forever: it is not in "Not on the list" (it IS exactly a listed name), it is
counted as a use of the agency on the Agencies row, and it blocks deleting or
re-kinding that agency (spec:371-372). The same applies to an exact authority
name in an agency field. I1's promise that pre-deploy values are mapped or
listed (spec:658-660) fails for exactly the conflict records. D7's preview and
send re-check uses the same kind-blind wording ("not exactly a current list
name", spec:296-297), so a draft can keep the name of an entry whose kind
changed - drafts are not uses, so the kind-change gate does not see them. Define
"uses", "not on the list" and the re-check per field kind: a value counts only
in a field of the entry's kind, and anything else is listed or refused.

---

## 2. [MEDIUM] "Show records" can only reach active tenants' housing-authority values; the rest of "Not on the list" is settled blind

**What is wrong.** D10 lists values across every contact type, deleted records
included, and for the agency field (spec:354-356), with "No names of people",
and promises "Show records opens the Tenants or Properties page filtered to
that value" (spec:357-359). Section 7 says the Tenants page is "unchanged code"
(spec:592-593).

**Evidence.**
- The facet filter (`?ha=`) exists only on the tenant view:
  `dashboard/src/routes/contacts/ContactsList.tsx:155,199,263`; the selection
  is voucher, housing authority and porting only - there is no agency facet
  (`dashboard/src/routes/contacts/tenantFacets.ts:58-62`); the tenant view
  fetches type `tenant` only (`dashboard/src/routes/contacts/useContacts.ts:30-41`).
- Non-tenant contacts never render these fields: the edit form shows Housing
  authority and Agency for tenants only
  (`dashboard/src/routes/contact/ContactEditForm.tsx:517-550`), and the
  partner page omits them (reviewer A r1, `PartnerFile.tsx:1-9`).

**What it implies.** For agency-field rows, non-tenant holders and deleted
holders, "Show records" has no target and the section names no people, so an
admin can only act on the whole value at once. Move to Agency on a partner
writes an `agency` no partner surface shows (only branch B's Make caseworker
migrates it, and only for caseworkers). Either specify the record list (a
records view inside the section, or Tenants-page support for agency, other
types and deleted) or state that these rows are value-level only.

---

## 3. [MEDIUM] The accept `value` is only checked against the list, not against the suggestion

**What is wrong.** D8 (spec:320-332) adds an optional `value`, "checked with D5
while the plan is built", and records `accepted` when the value is the
suggestion's own resolution, one of its ambiguity candidates, or a name just
added from its text. Only the DASHBOARD is told to send a different name
through the contact edit. Nothing requires the SERVER to check that `value`
belongs to that set, and D5 only resolves `value` against the list.

**Evidence.** The plan writes whatever the request resolves to
(`app/src/services/suggestionResolution.ts:262-283`). The codebase records a
hand-picked value as `superseded_by_human_edit` on purpose, because counting
coincident edits as acceptances "would ... corrupt the accuracy record this
feature exists to produce" (`app/src/routes/contacts.ts:1643-1652`). Also: a
completed journal for the same identity returns success after comparing only
the ACTION (`suggestionResolution.ts:658-673`; identity = createdAt, revision,
runId, `app/src/routes/suggestions.ts:59-70`). A second accept of the same
suggestion with a different `value` - two staff members picking Atlanta and
Augusta for "AHA" - answers 200 without applying its value.

**What it implies.** Any client, script or future dashboard bug can stamp
`accepted` on an arbitrary list name. The server must refuse a `value` outside
{resolution of the suggested text} plus {its ambiguity candidates} (409/422),
and a completed identity whose stored value differs must answer 409
`suggestion_already_resolved`, as an action mismatch does today.

---

## 4. [MEDIUM] (B) The importer keeps a manual type but still writes a status computed for its own type; it also re-fills the authority Make caseworker removed

**What is wrong.** D21 makes the importer skip the TYPE when `type_source` is
`manual` (spec:489-492). The importer's STATUS write is separate.

**Evidence.**
- The importer validates the status against ITS resolved type
  (`app/src/lib/import/apply.ts:878-911`) and writes it whenever the stored
  `status_source` is `import` (`:961-964`, `:1023-1024`).
- A staff retype does not change `status_source`: the PATCH auto-advance sets
  `status` but deliberately does not stamp `status_source`
  (`app/src/routes/contacts.ts:1489-1498`).
- D19's Make caseworker REMOVEs the housing authority (spec:467-468); D9 now
  writes the contact's authority whenever the attribute is absent
  (spec:336-338) for any type.

**What it implies.** An imported tenant converted by Make caseworker keeps
`status_source: import`. On the next import it stays `partner` (D21) but gets
a tenant lifecycle status such as `searching` - a (type, status) pair the PATCH
route exists to prevent (`contacts.ts:1501-1532`) - and gets its housing
authority back. D21 must also make the importer skip the status when it keeps
a manual type (or validate against the kept type), and say whether a converted
caseworker's authority may be re-filled. Note also that "mirroring its status
rule" is the opposite polarity: the status rule preserves anything the import
did not write (`apply.ts:961-964`), and a literal mirror would freeze the type of
every existing contact, which has no `type_source`. Whether another import
will run against prod is UNVERIFIED (RUNBOOK documents re-runs).

---

## 5. [MEDIUM] Automatic spelling additions (Use, rename, merge) have no rule for the caps, a name collision, "compound" values, or people's names

**What is wrong.** "Use <name>" makes the settled value a spelling "unless it is
shared or compound" (spec:364-366). Renames keep the old name as a spelling, and
merges move every spelling onto the target (spec:394-396). These additions are
part of the ONE conditional list write that also takes the rewrite lock
(spec:379-381). Gaps:

- No test for "compound" is defined anywhere (D4 says only that compound values
  "are never stored as spellings", spec:253-254). A builder without one stores
  "DCA HUD-VASH" as a DCA spelling, and every later writer silently drops the
  agency half.
- D13 caps spellings at 20 per entry and 100 characters each (spec:414-415). A
  stored housing authority from the PATCH has no length cap
  (`app/src/routes/contacts.ts:631-636`), and a merge can push the target past
  20. The spec does not say whether the action fails or skips the spelling.
- A value equal to a name under normalization violates D4 (spec:250-251) and
  D12's refusal (spec:405-406).
- Spellings are shown to every user and included in EVERY extraction's list
  block (spec:305-307). Free-text values can carry a person's name ("AHA - per
  Ms. Johnson"), and the section's "No names of people" (spec:357-358) does not
  stop that text becoming a permanent spelling.
- D12's confirm covers shared spellings of the same kind only (spec:406-409).
  Sharing across kinds is not addressed, and branch B's organization field
  accepts both kinds, where such a spelling becomes ambiguous.

**What it implies.** Specify: Use/rename/merge skip (never fail on) a spelling
that breaks a cap, collides with a name, or is compound (with a defined test);
the admin confirms the spelling text before it is kept; and either refuse or
confirm cross-kind sharing.

---

## 6. [LOW] "Not on the list" is admin-only, though the tab's three sections are visible to everyone

D10 says the tab is "visible to every signed-in user, with three sections"
(spec:348-349), and G3 and D7 send staff there to see unreachable values
(spec:145-146,292-295). Section 6 makes `GET /api/organizations/not-on-list`
admin-only (spec:554-555). VAs, who run shares day to day
(`app/src/routes/broadcasts.ts:2-4`), cannot see which values make tenants
unreachable. Pick one.

## 7. [LOW] D15 changes the intake rule without the operator hint that must change with it

The intake gate is "Mirrored in the settings UI hint ... - change both
together" (`app/src/jobs/missedCallAutoText.ts:109-110`). The hint lists "name,
voucher size, or housing authority"
(`dashboard/src/routes/settings/TemplatesSection.tsx:202-219`) and is pinned by
`TemplatesSection.test.tsx`. D15 (spec:430-434) and the readers list in section
9 omit it.

## 8. [LOW] The send-time filter re-check (D7) protects a filter the dashboard's send never uses

The dashboard always sends the curated `recipientContactIds`
(`dashboard/src/routes/broadcasts/RecipientPreview.tsx:284`,
`dashboard/src/api/endpoints.ts:1855-1861`). That path never re-resolves the
filter (`app/src/routes/broadcasts.ts:720-771`); only a body-less API send does
(`:785-796`). So section 1.2's "its preview and send re-resolve the stored
filter" (spec:85-86) is half-true. A send re-check can only refuse a curated
send after a rename lands mid-compose, discarding the curation. Re-check at
preview and on the filter-resolve send only.

## 9. [LOW] The per-run list `version` identifies nothing that can be recovered

D8 records the list `version` beside the fingerprint (spec:308-309). The item
stores only its current state (spec 5.1), and `version` moves on every write -
notes edits and every rewrite heartbeat (spec:397) included. A run log can show
that the list changed, but not what the model saw. If attribution matters,
record a hash of the rendered block, or keep the block's history.

## 10. [LOW] The AI list block has no size budget, and names have no length cap

The transcript is budgeted at `WINDOW_CHAR_BUDGET = 60_000`
(`app/src/jobs/extraction.ts:80`). The list block (spec:305-307) is not. D13
permits about 300 entries with 20 spellings of 100 characters each
(spec:414-417) - an order of magnitude past that budget. Entry NAMES have no
length cap at all (5.1), and any signed-in user can add one (spec:558-560).

## 11. [LOW] D2's create-on-first-read races the reseed's clear-then-seed window

`resetLocalData` clears every table and then seeds
(`app/src/lib/devReset.ts:102-107`). A reader in that window (the e2e worker's
extraction poll, a lingering page) creates the item from Appendix A, with
random ids and timestamps. The seed write must be an unconditional put (not the
repo's create-only path), or the lean world loses determinism intermittently.

## 12. [LOW] The cleanup script ignores the rewrite lock

D11's lock binds only "rewrite-starting endpoints" (spec:574-575). The cleanup
apply (section 8) reads the list once and rewrites from that snapshot, so a
rename or merge during the apply recreates the chained race (names written
after they stopped being names). "Not on the list" catches the residue. RUNBOOK
should forbid the overlap, or the script should take the lock.

## 13. [LOW] There is no Move to Housing authority for agency-field values that are authority names

The cleanup and the section's actions move housing authority values to Agency
only (spec:629-631,366-368). An agency field holding an authority name resolves
to "the other kind", but its only actions are Use (an agency name), Add as new
(refused: names are unique across kinds, spec:250) and Clear, which loses it.

## 14. [LOW] The rewrite job writes no per-record audit

The cleanup audits every record write (`org_name_cleanup`, spec:624-626). The
D11 job - an admin action that rewrites many tenants' fields - specifies no
audit (spec:385-401), so the contact's audit trail cannot explain the change.

## 15. [LOW] (B) Make caseworker on a landlord-based kind (new in rev 2) checks only tenant-side ownership

D19 now offers Make caseworker to "tenant- or landlord-based contacts" with a
caseworker role (spec:461). The precondition checks open placements and tours
"as the tenant" only (spec:464-465). A landlord-based contact can own units
(`landlordId`, byLandlord GSI, `app/src/lib/tables.ts:107`;
`app/src/repos/unitsRepo.ts:350`) or sit on unit rosters
(`unitsRepo.ts:505-510`); converting it leaves partners as property owners.

## 16. [LOW] (B) D21's thread re-typing reaches only the primary phone's and the email threads

The PATCH gathers linked threads from the scalar primary `phone` and the email
addresses only (`app/src/routes/contacts.ts:1806-1823`). A contact's threads on
secondary numbers (one active 1:1 per phone) keep the old type, which breaks
I2's "re-types the contact's own open one-to-one threads" (spec:692-693) if the
builder reuses that gathering.

---

## Adjudication contest

- **T20 (my r1 #21, `tenant.caseworker`) - conceded.** Only the lean seed writes
  it (`app/src/lib/seed/lean.ts:120`), the PATCH allowlist does not accept it,
  and it is display-only (`TourDetail.tsx:650-652`, `PlacementDetail.tsx:238-240`);
  the non-goal is sufficient.
- Every other theme was accepted; I do not reopen any as rejected.

## Fix checks (r1 findings, both reviewers)

Holding as written: T6 (no cache - every read consistent), T9 (deleted records
in the rewrites, the cleanup and the gates), T11 (change-only D5 with per-member
lists and the legacy `jurisdiction` pass), T12's corrected section 1.2 (matches
`apply.ts:1396-1413`), T13, T14, T15 (Appendix A re-checked under D4
normalization: no duplicate spellings within an entry, and no spelling equals a
name), T16, T17 (the precedents exist: `unitsRepo.ts:471-528`,
`conversationsRepo.ts:1171-1243`), T18 (except finding 7), T8 (except
finding 8).

Plausible but incomplete: T1/T2 (findings 1, 2), T4 (finding 3), T5 (findings
12, 14; the lock, heartbeat and base-table read are sound), T7 (findings 9,
10), T10 (finding 5), T19 (findings 4, 15, 16).
