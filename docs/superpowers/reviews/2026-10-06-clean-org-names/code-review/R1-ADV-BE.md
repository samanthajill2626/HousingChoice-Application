# R1-ADV-BE - adversarial, plan-blind review of the BACKEND half

Reviewer: R1-ADV-BE. Branch feat/clean-org-names vs merge base d839494a, app/ only
(diff package .superpowers/review/pkg-backend.diff), with the whole repository swept
for other readers and writers of every field, route, item and helper the diff touches.

Covered: lib/orgNames.ts, lib/orgStartingList.ts, repos/orgListRepo.ts,
services/orgNames.ts, services/orgRecords.ts, services/orgRewrite.ts,
jobs/orgRewrite.ts (+ registration, worker and in-process wiring, SQS consumer),
routes/organizations.ts (+ /api mount, auth, CloudFront prefix), the D5 checks in
routes/contacts.ts, routes/units.ts, routes/broadcasts.ts (create, preview, send),
the D8 suggestion accept (routes/suggestions.ts, services/suggestionResolution.ts,
suggestionResolutionRepo valueKey, journalSweep), extraction (orgListBlock, prompt,
job read, apply resolution and dismissal keys, drop reason), importer
(lib/import/apply.ts, scripts/import-apply.ts), the cleanup script
(scripts/clean-org-names.ts), seeds + devReset, /__dev/org-fixture, missedCallAutoText
D15, contactsRepo.rewriteOrgFields, unitsRepo.rewriteAcceptedAuthorities.

Counts: CRITICAL 0 | HIGH 0 | MEDIUM 1 | LOW 3 | INFO 2.
All four non-INFO findings were reproduced (CONFIRMED) with throwaway tests, run
alone and deleted by exact name afterwards.

---

## R1-ADV-BE-1 | MEDIUM | CONFIRMED | app/src/services/orgNames.ts:249 (add), app/src/services/orgRecords.ts:546 (matches)

**A name ADDED while a rewrite runs is rewritten away by that rewrite.** The pass's own
documented PRECONDITION (orgRecords.ts:35-39: "no from-text may normalize equal to the
exact NAME of an entry of the field's kind other than toName ... the pass has no list
to test 'on the list' against") is enforced only when the rewrite STARTS
(orgRewrite.ts:351-362). `OrgNamesService.add` (orgNames.ts:249) never consults the
D11 lock - unlike changeKind (:332) and remove (:361), which refuse while a rewrite
runs - and POST /api/organizations (routes/organizations.ts:202) is open to every
signed-in user. The pass's `matches()` (orgRecords.ts:546-551) compares only against
the from-texts captured at start, so once the value becomes a listed name the pass
clears / moves / rewrites records that now hold an exact list name, and audits it as
the admin's action.

Scenario (concrete interleaving):
1. Admin: Settings > Not on the list > housingAuthority "Fulton HA" > Clear (or Use X
   without "Remember this spelling", Move, Split). lastRewrite running, job queued.
2. VA: POST /api/organizations { kind: housing_authority, name: "Fulton HA" } -> 201
   (no lock check).
3. VA: PATCH a tenant's housingAuthority to "Fulton HA" -> D5 passes (exact name).
4. The org.rewrite pass reaches that tenant: normalize("Fulton HA") is a from-text ->
   housingAuthority REMOVED; audit org_name_rewrite { action: clear }.
Result: the list holds "Fulton HA", the record that held it exactly is cleared; the D3
invariant the D5 check just enforced is silently undone. Same root cause, smaller
window: a rename whose old-name spelling was skipped (orgRewrite.ts:280-286) lets the
old name be re-added mid-pass; and the cleanup script resolves every record against
ONE snapshot read at start (scripts/clean-org-names.ts:601) while adds and spelling
edits are not locked out.

Evidence: throwaway `zz-review-R1-ADV-BE-1.test.ts` (fake world + real services + real
runOrgRewriteJob). Assertion `expect(addRefused || tNew.housingAuthority === 'Fulton HA').toBe(true)`
failed; logged `{"addRefused":false,"listed":true,"tNew":"(removed)"}`; job outcome `done`.

Fix: make the pass self-guarding - refresh the field's listed names whenever it
heartbeats (heartbeat() already reads the item) and never rewrite a value that is
currently an exact name of the field's kinds other than toName (counted `skipped`).
That also covers the cleanup. At minimum, refuse `add` with 409 org_rewrite_running
while isOrgRewriteRunning(lastRewrite), as delete/changeKind already do.

---

## R1-ADV-BE-2 | LOW | CONFIRMED | app/scripts/clean-org-names.ts:193,209 ; app/src/services/orgRecords.ts:281-292

**Machine writes that REMOVE housingAuthority leave its AI provenance stamp behind.**
The retired vocabulary listed agencies (HUD VASH, Hope Atlanta, Claratel, Step Up) as
housing authorities, and the old extractor WROTE them directly with
`housingAuthority_source: { source: 'ai' }`. The cleanup's automatic move to agency
(planContact :190-195) and the rewrite actions clear / move_to_agency REMOVE
housingAuthority through rewriteOrgFields, which by contract writes nothing else
(contactsRepo.ts:812-818) - so `housingAuthority_source` survives on an empty field.
The human-edit path clears it for exactly this reason (routes/contacts.ts:1605-1613),
and the dashboard renders the badge from the stamp alone
(dashboard/src/routes/contact/TenantFile.tsx:161-164,188;
suggestionTargets.ts:25-31): "Housing authority: - [Auto <date>]" on every contact
the cleanup moved.

Evidence: `zz-review-R1-ADV-BE-2.test.ts`: (a) planContact({ housingAuthority:
'HUD VASH', housingAuthority_source: AI }) -> write.next is `{ housingAuthority: null,
agency: 'HUD-Veterans ...' }`, assertion `toHaveProperty('housingAuthority_source',
null)` failed; (b) a move_to_agency job run left `{"agency":"Step Up","src":{"source":"ai",...}}`
with housingAuthority absent; `expect(c.housingAuthority_source).toBeUndefined()` failed.

Fix: when a machine write REMOVES housingAuthority (cleanup move, rewrite clear /
move_to_agency), REMOVE `housingAuthority_source` in the same conditional UpdateItem
(e.g. a `clearProvenance` option on rewriteOrgFields). Value replacements (rename,
merge, use) can keep it.

---

## R1-ADV-BE-3 | LOW | CONFIRMED | app/src/services/orgNames.ts:286 ; app/src/routes/organizations.ts:255

**PATCH { spellings } is a blind full-list replace.** GET / returns `version`
(organizations.ts:132) but nothing checks one on write; mutate() re-applies the
request's WHOLE list on top of whatever is stored. Spellings the server added after
the editor loaded - the old name kept by a rename (orgRewrite.ts:280-286), "Remember
this spelling" (:426-435), a merge transfer - are silently dropped by a stale save
(another tab, another admin). Consequence: the old name stops resolving, so the AI
block, the importer, D5 checks and later "Not on the list" resolution treat it as
unknown.

Evidence: `zz-review-R1-ADV-BE-3.test.ts`: read Atlanta's spellings, rename Atlanta
(old name kept as spelling), then updateSpellings(loaded + 'ATL HA'). Result
`{"version":4,"spellings":["AHA","Atlanta Housing","Atlanta (AHA)","ATL HA"]}`;
`expect(after.spellings).toContain('Atlanta Housing Authority')` failed.

Fix: accept `expectedVersion` on PATCH /:orgId (409 org_list_changed on mismatch),
or send spelling add/remove deltas instead of the whole list.

---

## R1-ADV-BE-4 | LOW | CONFIRMED | app/scripts/clean-org-names.ts:676,714

**The cleanup's audit append is unguarded.** A failed `org_name_cleanup` append throws
out of run() AFTER the record write landed (:668-677, :706-715), aborting the whole
apply (PARTIAL, lock released failed). The documented recovery - re-run, idempotent -
finds the record already clean and never writes its event: a permanent audit gap per
abort. The job's twin catches and logs the same failure ("the record write landed",
services/orgRecords.ts:524-528).

Evidence: `zz-review-R1-ADV-BE-4.test.ts` (DynamoDB Local, own table prefix, tables
dropped after): two contacts holding "Atlanta (AHA)", first append throws
ProvisionedThroughputExceededException, then a clean re-run. Logged
`{"aborted":"ProvisionedThroughputExceededException","values":["Atlanta Housing Authority","Atlanta Housing Authority"],"cleanupEvents":["contacts#c-1"]}`
- both records rewritten, one event. `expect(aborted).toBeUndefined()` failed.

Fix: wrap the append like orgRecords does (log with the record id, count
`auditFailed` in the result and the summary) and continue.

---

## R1-ADV-BE-5 | INFO | PLAUSIBLE | app/src/jobs/orgRewrite.ts:94-101 ; app/src/adapters/sqsJobConsumer.ts:129

A whole rename/merge pass (every contact of every type, every unit, a conditional
write + audit per hit) runs inside ONE SQS message. The consumer awaits the full batch
(`await Promise.all(...)`) before it polls again, so on the single worker every other
job (sends included) waits for the pass; a pass beyond the 120 s visibility timeout
(infra/modules/jobs/main.tf:36) is redeliverable (safe by design - conditional writes
and the jobId check - but the counts then split between runs). At today's volumes this
is seconds; it grows with the data. Consider chunked continuations (the
relay/broadcast precedent) if the book grows.

## R1-ADV-BE-6 | INFO | PLAUSIBLE | app/src/services/orgRewrite.ts:303-308

Merge from-texts exclude a source spelling shared with ANY other entry - the target
included. Merging Augusta into Atlanta leaves records holding "AHA" (formerly ambiguous,
now Atlanta's alone) unrewritten; they stay in "Not on the list" (resolution match)
until an admin settles them by hand. Matches the code comment's rule; flagged only in
case the intent was "spellings no entry other than source and target shares".

---

## Areas checked and found clean

- requireRole('admin') on merge / delete / resolve / run-again and the inline admin check on PATCH spellings/name/kind; /api/organizations sits behind csrfOrigin -> session -> requireAuth; /api/* is already a mutating CloudFront behavior.
- /__dev/org-fixture: mounts only through lib/devRoutes.ts (devAuth on, not production, DYNAMODB_ENDPOINT set).
- orgListRepo: create-only first write with loser re-read; read-and-bump with "absent OR equal" version condition; 5-attempt busy; byte cap measured before send; mutate() no-op for an unchanged item (heartbeat/finish of a stale run write nothing).
- D11 lock: start/runAgain/acquireForCleanup refuse while running and fresh; heartbeat and finish act only for the caller's jobId; Run again mints a new id so a late delivery is not_current; job never rethrows; changeKind/remove refuse while running.
- Rewrite pass: partitions (active/deleted) are exact complements for contacts (byTypeStatus filter) and units (Scan filter); cursors followed; GSI projection ALL; conditional per-record writes on both org fields; whole-list equality for units; no updated_at stamp (importer human-ownership signal preserved); variant and on-list refusals for value actions at start.
- Every writer of contact housingAuthority/agency and unit accepted_authorities is covered: contacts PATCH (create body accepts neither field), units POST/PATCH, extraction apply, suggestion accept, importer (fill-only), seeds, cleanup, job; public intake and unmatched-email creates carry neither field; no denormalized copies of either field elsewhere.
- Broadcasts: create checks and stores the exact name; preview of a draft and the filter-resolving send re-check the stored value; PATCH only edits seeds; audience resolution stays an exact byHousingAuthority match that excludes deleted contacts.
- D8 accept: refusal before the claim; valueKey copied through claim/complete/recovery; re-accept with a different value is 409.
- Extraction: one consistent list read per run after the skip gates; the same snapshot renders the block and resolves; block never contains TRANSCRIPT, control characters flattened, budget drops logged; only call site of driver.extract updated; dashboard DROP_REASON label mirrored.
- Importer and cleanup read the list with peek() (never create); dry runs write nothing; seeds write exact list names and a byte-stable org-list item; devReset window covered by the unconditional seed Put.
- Retired helpers (housingAuthorityFor, KNOWN_AUTHORITIES, HOUSING_AUTHORITY_VOCAB) have no remaining importers anywhere in the repo; nothing else scans the settings table.
- Audit event types org_name_rewrite / org_name_cleanup: the unit Activity projection passes string from/to; no contact audit reader exists to break.
- The "Clayton" -> DCA starting-list mapping was checked against the retired alias map and is a recorded launch-gate ruling (app/test/orgStartingList.test.ts:96-99), not a defect.
