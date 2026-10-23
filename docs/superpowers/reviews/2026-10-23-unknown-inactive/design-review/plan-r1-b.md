# Plan review r1-b - unknown-inactive implementation plan

Reviewer: adversarial plan reviewer (b), 2026-10-23.
Plan: `docs/superpowers/plans/2026-10-23-unknown-inactive-plan.md` (v1 DRAFT @3d6e9ec9).
Spec: `docs/superpowers/specs/2026-10-23-unknown-inactive-design.md` (rev 3).
Method: every quoted anchor and helper the plan leans on was read in the tree
at the cited line; claims below cite what was read. Items not verified are
marked UNVERIFIED.

Overall: coverage of the spec is close to complete, and the anchors I checked
(about 60 of them across S1-S5) match the tree. The findings are one real
behavior defect in the edit form, a cluster of assembly contradictions around
AR17, one self-contradicting ASCII instruction, and several small items.

---

## F1. [HIGH] The edit form's type-change rule breaks on a change-and-back through the KindPicker "Other" panel: it silently writes a status

What is wrong. S4.4 3e rewrites `handleKindChange` as

    if (next.type !== null && next.type !== liveType) {
      setStatus(next.type === contact.type ? initialStatus : FIRST_STATUS_FOR_TYPE[next.type]);
    }

`liveType` is `kind.type ?? contact.type` (ContactEditForm.tsx:205). While the
Other panel is open with no base picked, KindPicker emits `type: null`
(KindPicker.tsx:150, `onChange({ type: null, role: ... })`), so `liveType`
falls back to the STORED type even though the status field still holds the
previous base type's first step. Picking the stored type as the Other base
(`handleBaseType`, KindPicker.tsx:170-171) then compares `next.type` against
that fallback, finds them equal, and never restores the stored status.

Reachable trace (stored tenant, status `searching`):
1. Change type -> Landlord: field moves to `interested` (correct).
2. Other: `type: null`; field keeps `interested`; the select now renders the
   TENANT options (statusOptionsFor(liveType = tenant)) with an off-list value.
3. Base = Tenant: `next.type ('tenant') === liveType ('tenant')` -> no setStatus.
4. Save: `typeChanged` false; isTenant; `statusTransition = status
   ('interested') !== initialStatus ('searching')` -> true; toStatus falls
   back to `needs_review` (3h) -> `setTenantStatus(needs_review)`.
A Searching tenant is demoted to Needs review by an edit that changed nothing.
Same shape: stored Parked landlord -> Tenant (`onboarding`) -> Other -> base
Landlord -> the PATCH carries `status: 'onboarding'` (legal for a landlord),
silently un-parking it.

Evidence. Plan section 8 S4.4 3e/3g/3h; ContactEditForm.tsx:199-205 (isTenant
and liveType from the live kind); KindPicker.tsx:140-151, 170-171.
Spec D3: "a change-and-back (tenant -> landlord -> tenant) [is] NOT [a] type
change: the Status field keeps the stored status and the save writes no status".

What it implies. The plan's own change-and-back test (S4.4 1e) only covers the
direct segment path, so this ships green. The rule must key on the base type
the CURRENT status came from (track the previous non-null kind type), or reset
whenever `next.type === contact.type` regardless of `liveType`, and must not
let the select show an off-list value while the Other panel holds `type: null`.
Add a test for the Other-panel round trip (the existing test at
ContactEditForm.test.tsx:216 already drives Other -> base Tenant, so the
fixture shape exists).

## F2. [MEDIUM] AR17 rewrites S1.1 and S3.4 implicitly; the slice text a literal builder executes still contradicts it

What is wrong. AR17 (plan section 4) says S1.1 flips the (unknown, active)
fixtures AND applies S3.4 Step 5 (`inbox.integration.test.ts`), adding that
file to S1.1's RED/GREEN commands and commit; S3.4 Step 1 "becomes a GREEN
state check" and Steps 2-5 apply only edits whose old text survives. The slice
text was never edited to match:
- S1.1 Step 2/Step 4 commands and the Step 6 `git add` list omit
  `app/test/inbox.integration.test.ts` (plan lines 858, 1239, 1266). A builder
  who makes the AR17 edit and then runs the literal `git add` leaves it
  uncommitted across S1.2-S3.3.
- S3 "Contradictions" note 2 (plan lines 4058-4064) says the opposite of AR17:
  "S3.4 owns those flips. S1 must not 'fix' them ... no gate may run between
  S1 and S3.4 expecting them green" - while S1.6 Step 3 runs the whole app
  workspace and expects green.
- S3.4 Step 1 (plan line 4516): "If none of these fail ... STOP". Under AR17
  none of them fail - the literal instruction stops the build.
- S3.4 Step 3 Edit F (plan lines 4673-4711) anchors on the `honest` cursor
  with `status: 'active'`, which S1.1 1f already flipped, but its replacement
  carries the NEW pre-deploy-cursor cases (D9's 400-once and block-start pins).
  Under AR17's "skip edits whose old text is gone" a builder drops the only
  test of the D9 pre-deploy cursor unless they notice "and every NEW test case
  those steps add" and hand-merge.

What it implies. "Rulings win over slice text" is a tie-break, not a merge; it
leaves the builder reconciling four sites by judgment. Edit S1.1's commands
and commit list, delete S3 note 2, rewrite S3.4 Step 1 as the green check, and
re-anchor Edit F on the post-S1.1 text (`status: 'inactive'`) so the
pre-deploy cases are an append.

## F3. [MEDIUM] S2.4 writes the `[backslash]u2192` escape into test code with the Edit tool, which the plan itself says decodes it

What is wrong. Plan section 0 and the S1 header (plan lines 45-47, 332-335):
"The Edit/Write tools DECODE `\u` escapes ... Test code in this slice NEVER
writes the six-character escape `[backslash]u2192`"; tests use
`String.fromCharCode(0x2192)`. S2.4's new test (plan line 3052) writes
`expect(timeline.map((e) => e.label), contactId).toEqual(['Status [backslash]u2192 Inactive']);`
and then says "confirm the label escape survived as six ASCII characters"
(plan lines 3105-3110, repeated in S2.10 Step 1), with no instruction for the
failure the plan predicts.

What it implies. Following the plan literally produces a literal U+2192 in an
added line; S2.10's ASCII gate (`... | wc -c` prints 0) fails and the builder
has no prescribed fix. Use the S1 pattern
(`const arrow = String.fromCharCode(0x2192)` and a template literal).

Empirical: writing THIS review file with the Write tool turned the quoted
six-character escape into a literal arrow (the ASCII check printed 9 bytes
until the three spots were rewritten as `[backslash]u2192`). The trap is real
on this toolchain, not hypothetical.

## F4. [LOW] S1.3 claims a RED that the harness cannot produce: "tenant re-typed to landlord" is already labelled "Interested" on unchanged code

What is wrong. S1.3 Step 2 lists `labels a tenant re-typed to landlord
"Status -> Interested"` as failing with the raw key. The PATCH reads `stored`
from the fake, which hands back the LIVE array object
(twilioWebhookHarness.ts:2280-2282) and mutates it in place on update
(:2446-2449; the handler itself notes this at contacts.ts:~1605 "same object
graph"). After the write, the old label code's `stored.type` is already
`landlord`, so it picks LANDLORD_STATUS_LABELS and prints "Interested". The
case is a de-facto PIN in the harness (the production bug is still real: the
real repo returns a copy).

What it implies. Not blocking - `unknown -> partner` still goes red (tenant
map has no `active`). But the RED list misleads the builder into "fixing" a
case that is already green; relabel it (PIN) and say why the harness hides
the production defect.

## F5. [LOW] D3's tenant-target follow-up write races an eventually consistent type read; AR4 turns one stale case into a refusal

What is wrong. On a type change to tenant with a non-Onboarding status, S4.4
sends the PATCH, then immediately `setTenantStatus`. The route validates
`toStatus` against `contacts.getById(contactId)` with no `consistentRead`
(routes/statusTransition.ts:268; contactsRepo.ts:1350-1351 defaults to
eventual). A stale read of the OLD type 400s a tenant-only value (pre-existing
shape), and with AR4 a stale read whose list happens to accept the value (e.g.
partner -> tenant with Inactive shown) now becomes a 409 `contact_type_changed`
where it previously wrote the right pair. Either way the PATCH has committed:
the contact is a tenant at Onboarding and the form says "Couldn't save".

What it implies. Spec D3 "Whatever the field shows at save time is the status
the contact ends up with" fails under the race. Cheapest fix: the route's
check read uses `{ consistentRead: true }` (one strongly consistent GetItem per
header/form status change). At minimum the S4 report should name it; the plan
does not.

## F6. [LOW] Comments that still describe (unknown, active) as a live class are left with no owner

- `dashboard/src/routes/inbox/inboxFilters.ts:78-80`: "an unknown contact
  already moved to `status: 'active'` is still on this tab (class f)". No
  slice touches the file.
- `app/scripts/measure-unread-contact-coverage.ts` ~661-664 (the `active`
  create default): S3.6 Step 3 says "S1's D6 surface ... record it for the
  planner, do not edit it here", and S1 never edits it.

What it implies. Future readers re-learn a removed state. Assign both to a
slice (comment-only).

## F7. [LOW] The plan says the spec is approved; the spec file says it is not

Plan line 5: "revision 3, APPROVED by Cameron 2026-10-23". Spec lines 3 and 9:
"DRAFT revision 3 (2026-10-23), at Cameron's spec gate ... Next: Cameron's
approval." A builder with only these files cannot tell which is true. Stamp
the spec's status line (or drop the claim from the plan) before launch.

## F8. [LOW] AR19's S1 record has no step

AR19 says "S1.2 records in the S1 report whether anything [ai-run-log.spec.ts]
asserts depends on it". S1.2 has no such step and the S1.6 Step 5 report
checklist omits it; only S6.1's pin run touches it. Add it to the S1.6
checklist or drop the S1 half of AR19.

---

## Coverage walk (no finding)

Checked and delivered by a named task: D1 lists and labels (S1.1, S4.1 mirror);
D2 dropdown, conditional write, 409, notify (S2.1-S2.9, S4.3); D3 options,
display, save paths (S4.4 - except F1); D4.1 (S3.2), D4.4 (S4.2; list rows
plain text per AR21), D4.5 (S1.3, S1.4); D5 collect-loop skip before the cap
(S3.3, matches today.ts:743-748 and the triage pass at :845-941 reading only
needs_review); D6 every path (S1.1, S1.2; unmatchedEmail C1 confirmed at
unmatchedEmail.ts:73); D7 both guards (S1.3; contacts.ts:1724-1762 as quoted);
D8 (S4.5); D9 chip, tag, block order, sort, ruling comments, pre-deploy cursor
(S3.4, S3.5, S5.1-S5.3; contactless rows inbox.ts:1175, :1566 untouched); W4
writers (contactCapture/groupMembers/groupConvert create-if-absent only;
twilio.ts:1210/:1251 and voice.ts:727 consent-only updates). The type-suggestion
accept goes through the contact PATCH (`accept_type_via_triage`,
suggestionResolution.ts:296), so D7 covers it. No other app or dashboard reader
of `status === 'active'` on a contact exists (grep of app/src and
dashboard/src).
