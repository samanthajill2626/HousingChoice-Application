# Spec review r1 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
at `e78345f6` (branch `feat/clean-org-names`). Read and grep only; no suite run.
Every claim about current behavior cites a file:line that was read. Anything
not proven in code is marked UNVERIFIED.

Severity is consequence-if-shipped-unfixed. Findings are ordered by severity.

---

## 1. [HIGH] D7's "no tenant can hold an off-list name" is false under the spec's own mechanism; off-list holders become unreachable by filtered blasts

**What is wrong.** D7 (spec:233-235) justifies a picker with no add step by
asserting "No tenant can hold a name that is not on the list". The spec's own
mechanism leaves tenants holding off-list text indefinitely:

- `needs decision` rows with no decision and `leave` rows "are left exactly as
  they are and reported again" (spec:475-477). Section 13 says Fulton County,
  Clayton County and McDonough wait on Sam - those are importer canonical
  spellings (`app/src/lib/housingAuthority.ts:46-53`), so real tenants hold them.
- A tenant whose Agency already holds a different agency is "reported as a
  conflict and not written" (spec:480-481): its housingAuthority keeps an
  AGENCY name (wrong kind).
- A value that later becomes a spelling (an admin adds "Fulton County" as a
  spelling on Settings) is never migrated: "Editing spellings or notes touches
  no records" (spec:279). The only record rewriters are the rename/merge job
  (exact OLD NAME only, D10) and the operator-run cleanup script.
- Records missed by the rewrite races in findings 3-5.

**Evidence.** Blasts match the stored text exactly:
`app/src/repos/contactsRepo.ts:1166-1179` (`KeyConditionExpression:
'housingAuthority = :ha'`). Today the composer's filter is a free-text input
(`dashboard/src/routes/broadcasts/AudienceFilters.tsx:55-60,109-117`), so any
stored spelling is reachable by typing it. D3 keeps readers unchanged (exact
match on names), and D7 removes free text.

**What it implies.** After the deploy, every tenant holding a left, undecided,
conflicted or later-spelled value is unreachable by ANY filter-resolved share -
the composer cannot express their value, and no name the composer can express
matches it. That is consequence 1 of `docs/issues/housing-authority-free-text-drift.md`
("Broadcast targeting silently under-reaches"), now for exactly the hardest
cases. The spec must either (a) make the audience resolver query the name AND
its spellings, (b) give the Settings page a way to rewrite records holding a
spelling, or at minimum (c) state in RUNBOOK that every spelling addition needs
a cleanup re-run, and drop D7's false premise.

---

## 2. [HIGH] The suggestion accept API cannot carry the outcomes of D8's "Is this really new?" step

**What is wrong.** D8 (spec:248-250) says accepting a suggestion whose text is
not a list name runs the D6 dialog, and "the accepted value is always a list
name". The D6 dialog has outcomes the accept path cannot express:

- "Use Atlanta Housing Authority" (a close name): the value written differs
  from the suggestion's text.
- "This is an agency - put it in Agency instead" (D6, spec:228-230): a
  different FIELD.
- An ambiguous spelling such as "AHA" (D8 itself returns "the text as said"
  when ambiguous, spec:240-242): D5 refuses it (ambiguous), and "Yes, add it"
  is refused too - `POST /api/organizations` answers 409 `org_name_taken` when
  the name equals any spelling (spec:402-404). The chip is a dead end.
- Pending housingAuthority suggestions created before the deploy hold
  arbitrary free text (today unknown names are suggested,
  `app/src/services/extraction/apply.ts:250-258`).

**Evidence.** The accept body is the suggestion IDENTITY only
(`app/src/routes/suggestions.ts:59-70`, routes at :203-209). The plan writes
`suggestion.suggestedValue` verbatim
(`app/src/services/suggestionResolution.ts:262-283`), inside a journaled,
replayable plan (`ResolutionReplayPlan`, recovered by other requests via
`recoverAbandoned`, suggestions.ts:100-105). The only other way to set the
field is the contacts PATCH, which records the AI verdict as
`superseded_by_human_edit`, never `accepted`
(`app/src/routes/contacts.ts:1643-1652`), corrupting the accuracy record that
comment says the feature exists to produce.

**What it implies.** The builder must invent an API contract: an override
`value` (and field?) on accept, validated by D5, stored in the replay plan so a
recovering request replays the same value, plus the verdict rule for
"accepted with a different list name". Or the spec must say those outcomes go
through PATCH and accept the verdict skew. Neither is specified.

---

## 3. [MEDIUM] Rename/merge rewrite jobs are unserialized and have no failure or retry path

**What is wrong.** D10 (spec:268-276) runs each rename/merge as a background
job, conditional on each record "still holding the old name", with ONE
`lastRewrite` slot (spec 5.1). Nothing serializes jobs, and nothing says what
happens when a job fails or never starts.

**Evidence.**
- The jobs consumer runs up to 10 messages concurrently:
  `app/src/adapters/sqsJobConsumer.ts:111,129` (`MaxNumberOfMessages` default
  10, `Promise.all`); the worker's jobs consumer takes the default
  (`app/src/worker.ts:161-167`).
- Visibility 120 s, then DLQ after 5 receives:
  `infra/modules/jobs/main.tf:36,41`.
- Precedent for enqueue-after-state-write failure handling that this spec omits:
  `app/src/routes/broadcasts.ts:840-854` (markFailed when enqueue fails).

**What it implies.**
- Chained edits (rename A->B, then B->C; or merge A into B, then rename B->C)
  run in parallel: records the first job rewrites to B after the second job
  passed them are left holding B, which is now only a spelling - off-list, and
  unreachable by blasts (finding 1).
- If the enqueue fails after the name write, or the job lands in the DLQ,
  records keep the old name (now a spelling), `lastRewrite.status` stays
  `running` forever, and there is no "retry rewrite" action.
- A merge can turn a unit list [A, B] into [B, B]; de-duplication is stated
  only for the PATCH path (5.2), not the job.
- While a rename runs, a blast on the new name misses not-yet-rewritten
  tenants; the spec acknowledges this window for the cleanup (spec:488-489) but
  not for rename/merge.
The spec needs: refuse a new rename/merge while one is `running`, an explicit
write/enqueue order with a failed state and a re-run action, and de-dup in the
job.

---

## 4. [MEDIUM] Rename/merge rewrite and usage counts are scoped to "tenants", but non-tenant contacts hold housingAuthority and agency

**What is wrong.** D10 rewrites "every tenant (`housingAuthority`, `agency`)"
and section 6 counts "tenants by housing authority, tenants by agency". The
fields are not tenant-only in data.

**Evidence.**
- The lean seed's partner Renee Carter carries `housingAuthority`
  (`app/src/lib/seed/lean.ts:158-176`, type `partner` at :169, value at :174).
- The importer computes the authority independent of the resolved type
  (`app/src/lib/import/apply.ts:914`) and writes it for any type (:1015-1022);
  caseworker rows from the Airtable tenants table are typed `partner`
  (`app/src/lib/import/merge.ts:410-413`).
- The contacts PATCH accepts both fields on any type
  (`app/src/routes/contacts.ts:631-646`); a retype tenant->partner (D19) does
  not clear them.
- The repo comment itself says tenant-only is a "data convention", not a rule
  (`app/src/repos/contactsRepo.ts:1167-1169`).

**What it implies.** A rename/merge leaves non-tenant holders on the old name
(off-list), and "Delete is allowed only when nothing uses the entry"
(spec:277) can delete an entry a partner or imported contact still holds. The
rewrite and the counts must cover every contact type (the cleanup already reads
"every contact", spec:458).

---

## 5. [MEDIUM] Per-process 60 s caches with no cross-process or reseed invalidation break I1 and e2e determinism

**What is wrong.** Section 5.1 (spec:369-371) caches the list for 60 s in the
app AND the worker, "dropping the cache on their own writes". Writes happen in
one process and are read in the other.

**Evidence.**
- App and worker are two processes on one host:
  `infra/modules/ec2/main.tf:1`. In prod the rename/merge job and the AI
  extraction run in the worker; the org-list rename write is an app PATCH.
- Hermetic e2e lanes spawn a REAL worker alongside the app
  (`app/src/repos/settingsRepo.ts:70`, "worklist A16"), and
  the worker runs the extraction poll (`app/src/jobs/pollLoop.ts:4-6`).
- The dev reseed already has to clear an in-process cache explicitly
  (`app/src/routes/dev.ts:325-331`, `sessionEpochCache.clear()`); it cannot
  reach the worker's memory.

**What it implies.**
- After a rename, the worker's stale list still treats the OLD name as a name
  for up to 60 s; the AI apply (D8) can write the old name after the rewrite
  job passed that record. I1 is broken with nothing surfacing it (finding 8).
- After `/__dev/reseed`, both processes can validate against a pre-reseed list
  (including earlier specs' run-unique names) for up to 60 s - the
  pass-alone/fail-in-suite shape.
- The Settings page (served by the app) can show `lastRewrite: running` for
  up to 60 s after the worker finished.
The spec needs an invalidation story: version-checked reads, a short TTL for
the worker's write paths, and a reseed hook (app) plus a bounded-staleness
argument (worker).

---

## 6. [MEDIUM] A list-driven extraction prompt breaks the memoized prompt fingerprint and the driver interface

**What is wrong.** D8 makes the system prompt include names and spellings "read
from the stored list (cached)". The prompt is currently a pure function of
module constants, and its fingerprint is memoized on that assumption.

**Evidence.**
- `buildExtractionSystemPrompt()` is synchronous and takes no arguments
  (`app/src/services/extraction/prompt.ts:11-12`); the driver calls it inline
  (`app/src/adapters/extraction.ts:257`) with no repo dependency.
- `extractionPromptFingerprint()` is memoized: "Memoized: both inputs are module
  constants" (`prompt.ts:130-141`). It is stamped on every run
  (`adapters/extraction.ts:248`, `adapters/extractionFake.ts:73`) and shown on
  System Status (`app/src/services/systemStatus.ts:235`).
- D8's new "agency dropped" outcome has no slot in the closed `DROP_REASONS`
  union the run log records (`app/src/services/extraction/runTypes.ts:25-38`).

**What it implies.** Left memoized, every run after a list edit records a
fingerprint that does not identify the prompt actually sent; un-memoized, the
fingerprint changes on every spelling edit and the run log's prompt-version
grouping fragments. The spec must decide how the run log identifies a
data-dependent prompt (for example template fingerprint plus list version),
how the list reaches the driver, and the new drop reason. None of these
surfaces is enumerated.

---

## 7. [MEDIUM] Draft blasts: the spec names a field and a writer that do not exist, and the cleanup never covers drafts

**What is wrong.** I1 and 5.2 name "draft blast `filter.housingAuthority`" and
section 9 lists "broadcasts create/PATCH (`filter.housingAuthority`)" as
writers. I1 says pre-cleanup values are surfaced by "the cleanup and the
Settings page counts".

**Evidence.**
- The stored field is `audience_filter.housing_authority` (snake case):
  `app/src/repos/broadcastsRepo.ts:84-90`, parsed at
  `app/src/routes/broadcasts.ts:107-138`.
- `PATCH /api/broadcasts/:id` replaces `seedContactIds` ONLY
  (`app/src/routes/broadcasts.ts:955-990`); "There is NO draft-update endpoint
  (editing a draft = recreate)" (`dashboard/src/routes/broadcasts/useComposerDraft.ts:2-3`).
  The only filter writer is the create route (`broadcasts.ts:440-534`).
- The cleanup reads contacts and units only (spec:458-460); usage counts are
  tenants, agencies, properties, caseworkers (spec:396-398). Neither touches
  drafts.

**What it implies.** A saved (non-disposable) draft created before the apply
keeps e.g. "Atlanta (AHA)"; after the apply its send re-resolves that text
(`broadcasts.ts:786-796`) and finds zero or a partial audience, with nothing
having reported the draft. Name the real field, drop the PATCH writer, and add
drafts to the cleanup (or state they are discarded).

---

## 8. [MEDIUM] I1's claim that Settings counts surface off-list values is false; count semantics are unspecified, so delete/kind-change safety is unsound

**What is wrong.** I1 (spec:496-500) excepts pre-cleanup values "which the
cleanup and the Settings page counts surface". Usage counts are per ENTRY
(section 6, D10): a value that is not a name has no row to be counted under.
The spec never says whether counts match records by exact name or by D4
resolution (name + spellings).

**Evidence.** Spec:396-398 (counts per entry), spec:277-278 (delete and kind
change only when nothing uses the entry), D10 row contents (spec:261-263). No
section lists distinct off-list values anywhere in the app.

**What it implies.** If counts are by exact name, off-list values (finding 1)
are invisible in the app, and deleting an entry whose SPELLINGS are still held
by legacy or `leave` records strands them as unresolvable. If counts are by
resolution, the rename/merge "old name" rewrite (exact) and the counts
disagree. Either way the I1 exception is not delivered by the stated
mechanism. Define the count rule, include spelling-holders in "in use", and
either add an "off-list values" view or drop the Settings half of the claim.

---

## 9. [MEDIUM] Pickers have no defined behavior for a current off-list value; the property form sends the whole list, so such a unit 422s on any authority edit

**What is wrong.** D6 replaces the inputs with pickers over the list; D5
refuses anything off-list. The spec never says how a picker shows, keeps or
forces resolution of a value the record already holds that is not on the list
(pre-apply, `leave`, conflict, emptied-list properties, legacy `jurisdiction`).

**Evidence.**
- The property edit form sends the ENTIRE authorities array whenever any
  element changes (`dashboard/src/routes/listing/ListingEditForm.tsx:154-166`),
  prefilled from `authoritiesOf`, which synthesizes a legacy `jurisdiction`
  (`ListingEditForm.tsx:35-38`, `app/src/lib/unitFields.ts:283-291`).
- The cleanup deliberately leaves values (spec:475-477) and leaves a property
  whose list would become empty unwritten (spec:481-482) - e.g. a unit whose
  only entry is an agency keeps it.

**What it implies.** Adding one authority to such a unit is refused (422) until
staff remove a value they may not understand; whether unchanged legacy elements
pass D5 is undefined. Same question for the tenant pickers and for a resumed
draft's filter. Specify the picker's off-list rendering and whether D5 checks
only changed elements.

---

## 10. [MEDIUM] `POST /api/organizations` accepts spellings from every signed-in user, contradicting admin-only spellings

**What is wrong.** D10 makes "edit spellings" admin-only and D11 says spellings
come only from the starting list, cleanup decisions and admins. Section 6's
add route is open to all staff and takes `spellings?` (spec:402-405), and D4
lets spellings be shared (spec:205-207).

**What it implies.** Any VA can add an entry carrying a spelling such as "DCA"
or "HADC". Because a shared spelling is "never applied automatically", that one
add silently makes the core spelling ambiguous: the importer stops writing it
(D9), the AI demotes it to a suggestion (D8), and the cleanup re-marks it
`needs decision`. Strip `spellings` from the non-admin add, or gate it.

---

## 11. [MEDIUM] (B) "Caseworker = partner + role" is invisible to the existing kind machinery

**What is wrong.** D14 defines a caseworker as `partner` + role "Caseworker";
D16 lists partners with that role; D17 lists only TENANT contacts. The existing
producers and readers of partner kinds do not know the role.

**Evidence.**
- The importer types caseworkers `partner` with no role
  (`app/src/lib/import/merge.ts:410-413`; `upsertContact`,
  `app/src/lib/import/apply.ts:937-1054`, writes no role - the word does not
  occur in that file).
- An accepted AI type suggestion "partner" saves `{ type: 'partner', role: '' }`
  (`dashboard/src/routes/contact/contactProfile.ts:26-35`), and the prompt
  classifies caseworkers as Partner (`app/src/services/extraction/prompt.ts:88`).
- The KindPicker "Other" custom kind can only be based on Tenant or Landlord
  (`dashboard/src/routes/contact/KindPicker.tsx:32-43`), so today's "Case
  worker" roles sit on tenant- or landlord-based contacts, not partners -
  D16's "so existing 'Case worker' roles match" matches almost nothing.
- `canonicalSuggestedContactKind` returns undefined for any partner with a
  role (`app/src/services/extraction/contactKinds.ts:8-24`, :15), so a type
  suggestion "partner" resolved through the new Caseworker choice is recorded
  `superseded_by_human_edit`, not `accepted` (`app/src/routes/contacts.ts:1720-1725`).
  The PM precedent the spec cites needed three special cases
  (KindPicker `isPmPresetValue` :47, contactProfile `KIND_PATCH`, contactKinds
  `PROPERTY_MANAGER_ROLE`).

**What it implies.** Role-less partners (every imported caseworker, every AI
caseworker accepted from the chip) and landlord-based "Case worker" kinds
appear on neither the Caseworkers tab nor the Possible list; AI accuracy for
caseworker classification skews. D16/D17 need to include role-less partners
and non-tenant custom kinds, and the Caseworker preset must be taught to the
kind canonicalizer and the chip mapping.

---

## 12. [MEDIUM] (B) An importer re-run reverts "Make caseworker"

**What is wrong.** D17 converts a tenant to a partner and clears its housing
authority. The importer overwrites `type` on every run; under D9 it then also
FILLS the now-empty housing authority.

**Evidence.** `app/src/lib/import/apply.ts:966-967` (`'#type = :type'`
unconditional, inside `upsertContact` at :937); D9 fill-only when empty
(spec:253-256). The importer leaves
conversation types alone (`if_not_exists`), so the
re-typed `partner_1to1` thread stays (`apply.ts:1082-1091`).

**What it implies.** One re-import turns every converted caseworker back into
a tenant with a refilled authority, while its thread stays `partner_1to1` -
the type/thread mismatch I2 and D19 exist to prevent. D9 already redesigns the
importer for re-runs, so the type overwrite is in scope. Whether another prod
import is planned: UNVERIFIED (RUNBOOK documents `import:apply:dev` re-runs,
RUNBOOK.md:1623-1624).

---

## 13. [LOW] The spec misdescribes the importer's unit-side write

**What is wrong.** Spec:66 says the unit-side write "only fills an empty
list"; D9 calls it "already fill-only".

**Evidence.** `app/src/lib/import/apply.ts:1396-1413`: a unit with no
`updated_at` (never human-edited) gets an unconditional SET of every fact,
`accepted_authorities` included, on every run; only a human-owned unit takes
the `if_not_exists` branch, which fills an ABSENT attribute, not an empty list.

**What it implies.** A builder following D9 keeps the overwrite branch;
"fill-only" for units is not delivered. Practical damage is small (resolution
yields the same names), but the claim should be corrected and the cleanup
should say whether its unit writes stamp `updated_at`.

---

## 14. [LOW] The housing-authority clear is not carved out of D5

**What is wrong.** Table 5.2 says only for `agency` that "`''` still clears".
The edit form clears housingAuthority by sending `''`
(`dashboard/src/routes/contact/ContactEditForm.tsx:323-326`), which the server
maps to null/REMOVE (`app/src/routes/contacts.ts:631-636`; the history is
`docs/issues/contact-authority-clear-empty-string-500.md`). A literal D5
("anything else is refused") 422s the clear. State it.

---

## 15. [LOW] Ambiguity scope (within the field's kind or across kinds) is unspecified

D4 (spec:200-202) says a shared spelling matched by two or more entries is
ambiguous, then says kind matters (spec:208-210), without saying whether the
count is taken within the field's kind. The cleanup's `split: <authority> +
<agency>` decision makes a compound value "a spelling of the chosen entry"
(spec:472-474) when there are two chosen entries of different kinds. Under a
cross-kind count the compound is ambiguous everywhere and never resolves for
the importer or the AI.

---

## 16. [LOW] Appendix A has duplicate spellings under D4 normalization; D4 omits underscore

Under D4's normalizer, "Atlanta Housing" = "Atlanta housing", "HUD-VASH" =
"HUD VASH", and "Georgia Housing Voucher (GHV)" = "Georgia Housing Voucher,
GHV"; a store that validates per-entry uniqueness will reject its own seed.
D4's punctuation set does not include `_`, while the Tenants page grouping
folds it (`dashboard/src/routes/contacts/tenantFacets.ts:117-119`), so
slug-shaped values (seed residue; whether hosted dev holds any is UNVERIFIED)
land in `needs decision` instead of mapping.

---

## 17. [LOW] The 400 KB size claim is false under the stated notes cap

Spec:368-369 says even 500 entries stay "far below" 400 KB, but notes may be
up to 2000 characters each (5.1). At the cap an entry is about 2.4 KB, so the
item overflows near 170 entries and every list write then fails. Either cap
notes lower or add a size guard; do not state the bound.

---

## 18. [LOW] "The D2 script" is undefined in this document

Spec:484-485 says abort and failure reporting "follow the D2 script". This
spec's D2 is "the starting list seeds an empty store once", not a script. The
reference is to share-skip-fix's D2
(`app/scripts/enable-conversation-automation.ts:1-2`). Name the file.

---

## 19. [LOW] D2's freeze plus "Dev first" plus pending section 13 answers can give dev and prod different starting lists

D2 says later code edits to the starting list never reach an environment that
already has the item. Section 13 says Sam's answers change Appendix A, and
section 8 says dev goes first. If dev deploys before the answers land, dev's
rehearsal runs against a different list than prod will create. Say which
commit's Appendix A each environment gets, or fold the answers in before the
first deploy.

---

## 20. [LOW] Moving an agency out of housingAuthority can re-arm the missed-call intake text

The missed-call intake gate treats a contact with none of first name, last
name, voucher size and housing authority as blank and texts them
(`app/src/jobs/missedCallAutoText.ts:80,108-112`); `agency` is not an intake
field. A contact whose only recorded fact was an agency in housingAuthority
starts receiving the intake auto-text after `move to agency`. The spec lists
this reader (section 9) but gives no rule.

---

## 21. [LOW] (B) The tenant's free-text `caseworker` attribute is not in the caseworker model

Tour and placement People cards show `tenant.caseworker`, a free-text name
(`dashboard/src/routes/tours/TourDetail.tsx:650-652`,
`dashboard/src/routes/placements/PlacementDetail.tsx:238-240`; seeded at
`app/src/lib/seed/lean.ts:120`). Branch B adds caseworker contacts and
relationship links but never says how this field relates to them.

---

## Verified as described (no finding)

- Alias map: 23 spellings to 13 names, 4 agencies
  (`app/src/lib/housingAuthority.ts:34-58`); `HOUSING_AUTHORITY_VOCAB` adds
  College Park (`app/src/services/extraction/schema.ts:59-81`);
  `orgVocabulary.ts` has 8 + 4 (`dashboard/src/routes/contact/orgVocabulary.ts:17-30`).
- Exact-match blasts vs case-insensitive page grouping (`contactsRepo.ts:1166-1179`,
  `tenantFacets.ts:117-119`).
- Agency names treated as known and written by the AI and importer
  (`housingAuthority.ts:54-57,61-63`; `services/extraction/apply.ts:250-259`).
- The importer overwrites contact housingAuthority every run (`import/apply.ts:1015-1022`).
- Contacts POST ignores housingAuthority (`routes/contacts.ts:775-950`).
- The KindPicker cannot save partner + role (`KindPicker.tsx:32-43,96-110`);
  no partners tab (`dashboard/src/routes/contacts/useContacts.ts:16,30-41`);
  shares are tenant-only (`routes/broadcasts.ts:413-415,743`); both fan-out
  sites mint `tenant_1to1` (`jobs/broadcastFanOut.ts:871,1386`).
- Public intake writes no authority (`app/src/routes/public.ts:13,119-146`).
