# WP1 matching charter - design review round 5, reviewer A

Spec reviewed at 5e85b185 (cited as "spec L<n>"). I read it end to end as a
builder starting B1 cold, then tested the round-4 text against the code.
Code was read at the worktree head. ASCII only.

Stop rule. Finding 1 is a DECISION: it changes the cap's input. Findings 2
to 7 are PRECISION edits. Finding 2 widens an existing invariant to a
surface it already claims to cover, and finding 3 assigns an unowned
surface to a slice. I contest no adjudication.

On the round-4 text:
- Select all (L675-681) now matches today's checkedByDefault
  (blastAudienceRules.ts:181; RecipientPreview.tsx:9-19).
- The app-side conditional claim with a renewed lease (L553-560) closes
  the dead-job and double-pay holes.
- Per-pair accommodation flags (L425-426) and the legacy reaction fallback
  (L279-283) are consistent with listingSendsRepo.ts:41-43, 231-236.
- The job-record key family (L562-564) is out of reach of the readers I
  checked: listing goes through byEntity pointers (aiRunsRepo.ts:148-157)
  and detail goes through run# ids (aiRuns.ts:228-249).

These fixes are correct, except where noted below.

---

## 1. [MEDIUM] [DECISION] The cap reads only the pair's own flags, so an unlawful requirement flagged on another pair still caps

What is wrong. Spec L430-434: a pair is capped when a failed key "is not in
the same pair's `fairHousingFlags`". UNLAWFUL flags are about the record:
"unacceptable for every tenant" (L380-381). They are "merged across batches
by property and field" (L425).

What it implies. The model is not consistent per pair. Say it flags
`qualifications` as unlawful ("no kids") on pair A, and on pair B lists
`qualifications` in failedRequirements without a flag. Code then caps B on
the requirement it has already identified as unlawful for that property.
The guarantee at L433-434, that the cap "can never enforce a requirement
the rubric disregards", is then false.

Fix. The cap must ignore a key that appears in the property's MERGED
unlawful flags (across all pairs and batches of the call set), in addition
to the pair's own flags of either kind. Accommodation stays per pair.

## 2. [MEDIUM] [PRECISION] The landlord card would carry credit and income, which 6.1 says the model never sees

What is wrong. Section 6.1 (L212-214) excludes "the unit's credit and
income requirement notes" and promises "the model never sees them". The
section 6.2 landlord switch (L255-257) adds "the landlord-of-record's
recorded requirements, and notes". The landlord's recorded requirements
include `req_credit_requirements` and `req_income_requirements`
(contactsRepo.ts:362-363; requirements.ts:35-36), and a landlord's `notes`
is free text staff write.

What it implies. A builder of the switch following 6.2 sends both to the
model. Extend the 6.1 exclusion to the landlord's req_credit_* and
req_income_* keys.

## 3. [MEDIUM] [PRECISION] No slice owns the matching-facts display, the remove control or its suppression record

Section 6.4 (L319-322): written facts "show on the tenant record with the
message they came from; Sam can remove a wrong one, and a removed fact
suppresses later facts with the same label and value". The B1 row (L761)
lists the extraction schema and the never-extracted test, but not this
tenant-record UI or the suppression tombstone. No other row lists them
either. Since B1 ships to production first and writes facts live, the
remove path belongs in B1.

## 4. [LOW] [PRECISION] The window toggle sits in the wrong slice

The B3 row (tenant anchor) owns the "window toggle" (L763). The window
exists "property anchor only, where tenants are candidates" (9.1, L467-469;
5, L164-170). It belongs to B4.

## 5. [LOW] [PRECISION] The B2 row still says "server-sent results"

The B2 row (L762) reads "stage-one call as a job with server-sent
results". Section 10.2 (L540-544) now sends no results over SSE: only
"anchor, batch n done". Results come by GET and polling.

## 6. [LOW] [PRECISION] "Join" ignores the window toggle

The pool depends on the toggle ("a toggle to include older tenants",
L169-170), but the claim is per ANCHOR (L554-556). A toggle-on press that
joins a toggle-off job never scores the older tenants. The opposite case
pays for candidates the presser hid. Either key the claim on anchor plus
pool setting, or say that a joining press gets the running job's pool.

## 7. [LOW] [PRECISION] Three small cross-section mismatches

- 13.1 (L657-658) lists the banner cases as "not searching or not
  available". Section 5 (L181-183) also has "not sendable" (a tenant).
- 19 (L873) says the composer shows the pool "in last-heard-from order
  while results arrive". On the tenant anchor the candidates are
  properties, which have no last-heard-from.
- 4 (L128-130) lists "the only deterministic parts". The list omits the
  7.4 cap and the 13.1 selection and Select all rules, which are now
  deterministic code too.
