# Independent adversarial review, round 2

Reviewed HEAD: `00c716221ba38b8e6b173c06ad43a801f9d07908`.
Fix source: `e0da8da38313e9f494d56bbbc96b8a3def720015`.
Implementation base: `d874915873a61864f6d051a0a9af3f0bb8e7e6e2`.

Verdict: CF-1 / R1-ADV-1 is closed by the current fix and saved focused evidence. No defect was found in that fix. The broader sweep found one separate P2 stale-writer concern requiring adjudication. It is established by the source interleaving below, not by an executed reproduction. R1-ADV-2 remains an explicitly accepted limitation, not a repaired defect.

## R2-ADV-1 - P2: A claimed authority-accept journal can add tenant authority after conversion

**Location:** `app/src/services/suggestionResolution.ts:341` (authority plan guard), `app/src/repos/suggestionResolutionRepo.ts:798` (domain commit condition), and their integration with `app/src/services/caseworkerConversion.ts:390` and `app/src/services/caseworkerConversion.ts:552`.

A suggestion acceptance has a durable stage between claiming the suggestion and committing its contact effect. Its plan guards only the attributes it intends to write: `guardForPatch` at `app/src/services/suggestionResolution.ts:194` records housingAuthority and housingAuthority_source for an authority acceptance, with no contact type or classification revision. The transaction applying that plan uses exactly those guards. A classification change that leaves those two attributes unchanged is therefore invisible to the writer.

**Concrete schedule:**

1. A tenant has neither housingAuthority nor housingAuthority_source, has a pending suggestion naming a valid listed housing authority, and has no conversion refusal. Staff accepts the suggestion. The service reads the tenant and builds the authority plan; its two guards both require attribute absence.
2. `claim()` at `app/src/repos/suggestionResolutionRepo.ts:638` atomically creates an active resolve# journal and deletes the sugg# row at line 684. The contact effect has not run yet. Execution can pause at the existing claimed boundary (`app/src/services/suggestionResolution.ts:832`) or the process can stop there.
3. Another staff request converts the contact. Conversion sets partner/Caseworker and increments classification_revision, while removing the two already-absent authority attributes. The pending-suggestion sweep completes.
4. The original acceptance resumes, or the durable journal is recovered. `commitContactEffect` at `app/src/repos/suggestionResolutionRepo.ts:770` still finds both absent-attribute guards satisfied, and its transaction writes the authority and AI provenance onto the caseworker. Recovery also reaches that writer without checking current classification (`app/src/services/suggestionResolution.ts:676`, `app/src/jobs/journalSweep.ts:244`).

**Boundary distinction:** After step 2 this is NOT a pending suggestion. Active journals deliberately omit ownerContactId and _pendingPartition (`app/src/repos/suggestionResolutionRepo.ts:8`), while conversion's list uses the byOwner index (`app/src/repos/extractionRepo.ts:710`). The sweep is not failing to delete a row within its stated pending boundary. The separate omission is allowing an earlier tenant acceptance to commit after conversion despite the classification change.

**Consequence:** The predicted final caseworker has a housing authority added after conversion and an accepted suggestion verdict, even though no new extraction run or new post-conversion staff decision occurred. If recovery performs the effect, this need not be confined to the model-call window described by the accepted extraction issue. Re-running make does not remove authority, because an existing caseworker takes the follow-on-only repair path (`app/src/services/caseworkerConversion.ts:521`).

**Evidence and limits:** This is a source-derived interleaving. No new test, request, experiment or service was run in this review. Existing repository tests demonstrate field-value guards rejecting changed fields, but do not cover conversion leaving both authority attributes absent. No saved runtime proof directly covers this schedule, so the runtime outcome is not reported as observed. A deterministic regression can claim an authority acceptance, convert before its domain effect, then release/recover the journal and assert that authority remains absent.

**Narrow direction / disposition needed:** Include the originating classification in the durable acceptance plan's commit guard, and account for already-created active journals, or explicitly adjudicate this human-accept/recovery writer as a separate accepted limit. Do not broaden the extraction-only deferral by implication. A pre-commit read without an atomic condition would leave the same ordering gap.

## Closure of CF-1 / R1-ADV-1

The route now captures the raw revision immediately after its consistent classification read (`app/src/routes/contacts.ts:1531`) and ANDs that condition with any staff-note condition in the single repository update (`app/src/routes/contacts.ts:1746`). The repository adds the revision increment and expectation to the same UpdateCommand (`app/src/repos/contactsRepo.ts:1501`, `app/src/repos/contactsRepo.ts:1551`). Two type-only/role-only edits that validated the same snapshot cannot both commit.

Absent revision remains an attribute-not-exists condition; stored zero remains numeric zero. The fake checks every expectation before mutation (`app/test/helpers/twilioWebhookHarness.ts:2413`), matching the real condition construction for these values. No repository interface or fake change was needed.

The conflict branch consistently rereads: disappearance returns 404; classification-only staleness returns contact_changed; a stale supplied note expectation takes staff_notes_stale precedence. It returns before suggestion deletes, verdicts, conversation changes, audit and events. Note-only writes retain their previous behavior. Generic edits to a soft-deleted contact remain permitted as before; the fix does not quietly add a deletion rule. The edit form retains its draft and displays its generic save failure for contact_changed; a retry undergoes the fresh server classification check, so it does not reopen the original race.

The new route tests use independent cloned contact snapshots, hold both requests before either commit, and cover both winner orderings with absent and zero initial revisions. They verify the winning contact and pending suggestions survive the loser unchanged and that retry reaches the dedicated-conversion refusal. Combined note/classification cases cover neither, either and both conditions changing, plus disappearance and unaffected note-only behavior. These assertions test the invariant rather than merely inspecting the new options.

I inspected the saved final evidence, without rerunning it:

- `.superpowers/sdd/checkpoints/FW1-red-final.log` and `.exit`: exit 1, nine failed and 77 passed; the original route accepts writes the regression expects to reject.
- `.superpowers/sdd/checkpoints/FW1-green-final.log` and `.exit`: exit 0, 230 passed across five files, including the real/fake repository parity suite, with no skipped tests shown.
- Final typecheck and lint checkpoint exits are zero. Their saved logs were inspected; these are prior implementer results, not checks performed by this reviewer.

The unchanged direct importer still does not bump classification_revision. The fix does not close that separately documented writer race, and I do not claim it does.

## Adjudication assessment

The parent's acceptance of CF-1 is correct: the merged-state restriction required a commit fence, and the current implementation supplies it without changing ordinary write permissions.

For R1-ADV-2, the source and original saved proof still support the defect. The explicitly allowed adjudication and `docs/issues/extraction-in-flight-writes-onto-converted-caseworker.md` record its acceptance, and RUNBOOK describes the limits of make-again repair. I accept that disposition for the extraction writer only. R2-ADV-1 has a different producer, durable state and recovery path and is not covered by that wording. The issue's optional suggestion of a fresh type read is not itself race-safe; the adjudication correctly identifies commit-boundary fencing as necessary.

The earlier placement/tour/association window remains unproven as a new defect; this round did not execute it or infer a broader atomic-refusal guarantee. C6 remains outside this fix, with its proposal unapplied. No new independent evidence here overturns that scope disposition; the earlier C6 reports were not read.

## Coverage and limits

The review first sought missed interactions in suggestion claim/commit/recovery, conversion refusal and thread ownership, possible-caseworker discovery, organization usage and rewrite consumers, partner seed resolution, fan-out and adoption, and dashboard caseworker/contact/file refresh flows. It then inspected the fix cold, its real/fake repository behavior, all new conflict branches, prewrite versus post-write effects, and test assertions before reading the authorized adjudication and fix report. Round-one coverage of the remaining unchanged consumers was retained where applicable. No further substantiated defect was found in the organization/settings or partner-sharing paths reviewed.

No full feature spec, plan, worklist, other reviewer's report or prohibited feature reasoning was read. Only the expressly allowed adjudication/fix report and the named issue/runbook operational limit supplemented source, tests and saved evidence. This round was static only: no tests, experiments, services, browser, external endpoints, background commands or previously interrupted operation were launched. Production source was not edited, staged or committed. Every owned command has returned; no reviewer-owned command remains running.
