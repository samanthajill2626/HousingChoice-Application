# Independent adversarial review, round 1

Reviewed HEAD: `76357a5fed86172e4645516bd16b74647fbc0cd5`.
Base: `d874915873a61864f6d051a0a9af3f0bb8e7e6e2`.

Plan-blind assessment of the implementation package and repository code/tests. No feature spec, plan, worklist, mission reasoning, or other review report was read. Two actionable P2 findings remain.

## R1-ADV-1 - P2: Concurrent partial edits can create a caseworker without conversion

**Location:** `app/src/routes/contacts.ts:1615` (merged classification check) and `app/src/routes/contacts.ts:1743` (unfenced update).

The new restriction validates the merged type and role from a consistent contact read, but its subsequent update has no classification condition. Its only possible condition is the independent staff-notes guard. Consistent reads do not serialize overlapping requests.

**Trigger and consequence:** Start with a tenant whose role is absent. Request A changes only type to partner, while request B changes only role to Caseworker. Both read the original tenant before either writes. A validates partner/no-role and B validates tenant/Caseworker, so both pass the new check. The two partial updates then compose into partner/Caseworker. This skips the conversion's refusals, organization migration, thread/suggestion work, and conversion record. In the reproduction, the tenant had an open application placement: the actual conversion endpoint first refused with `caseworker_open_placement`, but the two PATCH responses were both 200. The final contact was partner/Caseworker with classification revision 2, its original housing authority and agency intact, and no `caseworker_conversion` record.

**Evidence:** The focused in-memory experiment used the real Express router, cloned read snapshots, and a barrier immediately before the two updates. It completed successfully before the interruption:

`node --import tsx .superpowers/review/adversarial/r1-patch-race.mts`

The script is preserved at `.superpowers/review/adversarial/r1-patch-race.mts`. Both captured update options were null; its assertions check the two successful responses and resulting classification. No database or external service was used.

**Narrow fix direction:** Fence every classification-changing PATCH against the raw classification revision used by its merged-state check, composing this with any staff-notes condition. On a conflict, reject or repeat the read and merged validation before writing. Add a regression for the two individually permissible partial edits above; after fencing, they must not jointly create a caseworker outside conversion.

## R1-ADV-2 - P2: An in-flight tenant extraction can undo conversion cleanup

**Location:** `app/src/services/caseworkerConversion.ts:380` (one-time suggestion sweep) and `app/src/services/caseworkerConversion.ts:552` (classification and authority cleanup). Interacting writer: `app/src/jobs/extraction.ts:586`, `app/src/jobs/extraction.ts:614`, and `app/src/services/extraction/apply.ts:500`.

Conversion removes housingAuthority and its source and supersedes pending suggestions. However, an extraction job reads the tenant before awaiting its model call, then passes that original contact object into applyExtraction after the call returns. Field eligibility uses that snapshot (`app/src/services/extraction/apply.ts:137`). Direct field updates and ordinary suggestion publication do not fence the contact's classification; the special protection around type suggestions does not cover these writes.

**Trigger and consequence:** A job captures the tenant, waits for its model result, and resumes after conversion and its suggestion sweep have finished. Its old tenant snapshot still authorizes tenant fields. A late result can restore the deliberately removed housing authority with AI provenance and publish new tenant-only suggestions on the caseworker after the cleanup has drained them. This is a missing integration with an existing writer, not a claim that this change introduced that writer.

**Evidence:** The saved experiment captured a tenant snapshot, called the real conversion endpoint successfully, then passed that snapshot to the real applyExtraction service. The conversion response was 200 with housingAuthority absent. After applying the held result, the contact remained partner/Caseworker but housingAuthority was restored to Atlanta Housing Authority with AI provenance, and a pets suggestion for two dogs was pending. The experiment completed successfully before the interruption:

`node --import tsx .superpowers/review/adversarial/r1-extraction-race.mts`

The script is preserved at `.superpowers/review/adversarial/r1-extraction-race.mts`. It asserts authority removal after conversion, restoration after apply, and the new pending suggestion. The source path establishes that the job supplies precisely this pre-model snapshot. The full job was not run with a paused fake model; this proof exercises the real conversion and apply services directly.

**Narrow fix direction:** Reject extraction effects whose originating contact classification is no longer current. Protect scalar writes at their commit boundary and ordinary suggestion publication against conversion, so a conversion that wins cannot be followed by stale tenant effects. A fresh read alone before applying leaves another read/write race. Add a delayed-result regression that converts before releasing the result and asserts the removed authority stays absent and tenant suggestions stay drained.

## Scope and limits

The static sweep covered contact classification/create/edit flows; conversion/refusal collection; contact and conversation repositories; pointer and shared-address ownership; possible-caseworker discovery; extraction, suggestion resolution, imports, placement/tour/roster writers; organization validation, usage, rewrites and settings; partner recipient resolution and broadcast fan-out; listing-send projections, retries/reconciliation and timelines; and the dashboard routes, conversion dialog, contact forms, partner file, caseworker list, organization pickers/settings, and property-sharing surfaces. Source/test reading found no further substantiated defect in the settings or partner-share paths reviewed.

An unresolved concurrency question remains around a placement, tour, or unit association being added after conversion's refusal reads. The related create routes are already permissive about contact types; this review did not establish a new regression or run a focused reproduction, so this is not an additional finding. No claim of atomic refusal enforcement is made.

The review was interrupted by a platform content-safety flag reported by the parent. On recovery, the parent prohibited further experiments. Continuation was limited to static source checks, inspection of the two saved fixtures, and this report. No blocked action was repeated and no full paused-job experiment or further interleaving experiment was launched. The exact platform error text was not supplied to this continuation.

The empirical evidence uses in-memory repositories and real application logic, not DynamoDB integration or browser execution. Aggregate suites, browser suites, live human ports, infrastructure and external services were not used. Production source was not edited, staged or committed. Every command launched by this reviewer has returned; no reviewer-owned command remains running.
