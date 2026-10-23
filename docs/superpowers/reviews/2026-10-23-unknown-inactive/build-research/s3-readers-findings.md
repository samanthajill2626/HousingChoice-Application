# s3-readers findings - plan v4 section 7 (S3 backend readers)

Reader: s3-readers (Phase 1, read-only). Scope: S3.1 Step 2, S3.2, S3.3,
S3.4 Steps 6-9, S3.5, S3.6, S3.7. Excluded per dispatch: S3.1 W1 (the
orchestrator's) and S3.4 Steps 2-5 (moved into S1.1 by AR17; another reader).

Result: 0 BLOCKER, 0 MAJOR, 8 MINOR. Every quoted anchor in scope matches the
live tree line-for-line (the files are CRLF on disk; the Edit tool handles
that) and is unique where an Edit needs it. Every helper, fake, harness API and
import the S3 code calls exists with the shape used. Every stated RED and PIN
was traced through the current code and holds for the stated reason (S3.5's
filter=unknown RED holds once S1.1's `inactive` block is in). W4: no inbound
writer writes an EXISTING contact's `status` - no STOP. W2: a needs_review ->
inactive flip mid-walk does NOT meet the reopen trigger (a size condition).
Byte-exact quotes: `.superpowers/sdd/research/s3-readers-reference.md`.

1. MINOR - S3.4 Step 7 Edit C (the ruling-comment replacement) vs AR15.
   Tree: `app/src/routes/inbox.ts:2298` is the file's only `sortByActivity`
   mention and Edit C removes it. AR15 (plan 283-284) binds this rewrite to
   cite `sortForFilter` AND `compareUnknownTabRows`; the replacement (plan
   5064-5067) names only `useInbox.ts` and `compareUnknownTabRows`.
   Correction: in the replacement's "IT IS NOT THE ORDER THE OPERATOR SEES"
   paragraph write `(dashboard/src/routes/inbox/useInbox.ts, sortForFilter)`
   in place of `(dashboard/src/routes/inbox/useInbox.ts)`. S5.3 step 6's
   `grep sortByActivity` then still prints nothing, as it should.

2. MINOR - S3.4 Step 6 "Check" (plan 4950-4952).
   Tree: after Edits A-D the grep also prints Edit C's new line, which names
   the removed `active` block twice (it replaces `unknownQueue.ts:172`). The
   plan says it prints only Edit A's sentences and ~15-18.
   Correction: expected output = line 16, the Edit A replacement lines that
   name `active`, and the Edit C line. Anything else (for example
   `active: 1,`) means S1.1's order map did not land.

3. MINOR - S3.6 Steps 1-2 (the W2 record and the issue-body paragraph).
   Tree: `docs/issues/unknown-queue-status-flip-duplicates-across-pages.md:151-155`
   - the trigger is "the live unknown partition exceeds one dashboard page (100
   live rows with an open non-relay thread)". A flip mid-walk is the issue's
   condition 2, not the trigger, so the plan's "not met" conclusion is right.
   But the paragraph's "The change does not grow the partition (an Inactive
   unknown stays in it exactly as an Active one did)" understates it:
   (unknown, active) was edit-form-only and measured 0/0, while D2 makes
   Inactive a one-click header action whose purpose is to set an unknown
   contact aside WITHOUT a re-type or a delete - the only two exits that drain
   the partition (`app/src/lib/unknownQueue.ts:64-65`). The partition now
   accumulates every set-aside, and condition 2 becomes routine.
   Correction: in both the S3 report and the inserted paragraph, replace that
   sentence with: "The change adds no rows by itself, but Inactive is now the
   easy set-aside and it does NOT drain the partition, so the partition only
   grows except by re-type or delete, and a status write between Load-more
   clicks is now one click. The trigger is NOT met on the recorded counts (16
   dev / 7 prod 2026-08-25, 0 lean 2026-09-02); nobody re-measured. Re-measure
   with `--audit-triage-partition --no-status-narrow` beside the W7 re-count."
   File nothing new (AR14).

4. MINOR - S3.6 Step 3 (the W5 record) misses the first line of defense.
   Tree: `app/src/services/extraction/apply.ts:535-540` files a `status`
   suggestion ONLY for a (tenant, onboarding) contact, with `suggestedValue`
   hard-coded `'searching'`; anything else is dropped
   `status_not_onboarding_tenant` (:571). Direct writes are EXTRACTABLE_FIELDS
   plus address only (`apply.ts:500`, `services/extraction/schema.ts:24-33`,
   no `status`). So the AI never proposes `active` for any contact.
   Correction: record apply.ts:535-540 as the reason; keep the 409
   (`suggestionResolution.ts:822-825`) and the allowlist (`:298-299`) as the
   backstop for a suggestion filed while the contact was an onboarding tenant
   and re-typed since.

5. MINOR - S3.5 Step 1 W4 code reading (feeds the S3 report) is incomplete.
   Tree: none of these writes `status`, but the plan's bullets omit them and
   W4 (plan section 3) names their files: `twilio.ts:2161, 2661`
   touchPhoneLastSeen (`contactsRepo.ts:1158` SET #phones);
   `twilio.ts:3925, 3984` and `services/numberSuppression.ts:172-173`
   setFlag/clearFlag (`contactsRepo.ts:1491, 1505` SET #flag);
   touchLastHeardFrom at `twilio.ts:961, 1388, 2192, 2695`,
   `voice.ts:834, 1122, 1220`, `inboundEmail.ts:833` (`contactsRepo.ts:2021`
   SET #lhf); `inboundEmail.ts:806` touchEmailLastSeen (`contactsRepo.ts:1231`
   SET #emails); `unmatchedEmail.ts:323` addEmail (staff link) and `:462`
   create (new contact only); `jobs/extraction.ts:438-441` reads only, its
   writes go through `extraction/apply.ts:500` (no status). The contactCapture
   cite is `:23-25, 108-111`, not `22-24, 103-117`.
   Correction: list these in the S3 report's W4 section.

6. MINOR - S3.3 Step 1 coverage gap (optional extra RED).
   Tree: the Step 3 skip keys on thread type plus contact status, not contact
   type, so an INACTIVE team member's `unknown_1to1` thread also leaves Needs
   you now (spec D5 "skip Inactive", Goal 4). Every S3.3 team-member case is
   Active.
   Correction (optional): add a case mirroring the Active-team-member PIN with
   `status: 'inactive'`, expecting `newUnknownRefIds(items)` to equal `[]`; it
   is a real RED on current code (today.ts emits it at :784-808). Step 2's
   RED list then has three entries.

7. MINOR - S3.5 Step 3 Edit B, cross-slice note for S5.
   Tree: buildContactRow also builds resurfaced soft-deleted rows
   (`inbox.ts:1040-1078`), so a deleted contact whose status is `inactive`
   ships `deleted: true` AND `inactive: true`; AR5 does not exclude it.
   Correction: none in S3. S5.1 should decide and pin whether `InboxRow.tsx`
   shows both the Deleted chip and the Inactive tag on such a row.

8. MINOR - ASCII checks in S3.2, S3.3 and S3.5 cover too few files.
   Tree: `today.ts`, `todayApi.test.ts`, `listingSendsApi.test.ts`,
   `twilioSmsWebhook.test.ts` and `founderTriage.test.ts` already carry
   non-ASCII bytes; S3.2 and S3.3 have no check, and S3.5 Step 4 checks only
   `inbox.ts` and the new file. (The plan's S3 text itself is 0 non-ASCII
   bytes and holds no `\u` escape.)
   Correction: run plan section 0's added-lines check on every file each task
   commits.
