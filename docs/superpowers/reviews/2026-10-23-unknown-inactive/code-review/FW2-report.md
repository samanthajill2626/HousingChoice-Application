# Fix wave 2 report - feat/unknown-inactive (code review R2, FW2-1 .. FW2-3)

Base for this wave: b372e6a0 (R2 report + adjudications). Commits, in order:

- 8efaf752 FW2-1 fix(today) - the Inactive skip applies only to an unknown or
  team member owner
- 568402b4 FW2-2 fix(contact) - the edit form turns Save off after a 409
  contact_type_changed until reopened
- f98f09b7 FW2-3 docs(comments,issues) - D9 and the contact.updated emitters

Gates run by this wave (the orchestrator re-runs the battery):
todayApi.test.ts 70/70; ContactEditForm.test.tsx 115/115; typecheck exit 0
after FW2-1, after FW2-2 and at f98f09b7; app workspace `npx vitest run` 527
files, 11174 passed + 1 skipped, exit 0, no `[dynamoAdmin]` line, no AWS_
variable exported (battery-2: 11172 + 1; +2 are FW2-1's cases); dashboard
workspace 266 files, 5487 passed, exit 0 (battery-2 5486; +1, FW2-2's
second case - its first changed an existing case). eslint on the 7 touched
TS/TSX files (today.ts, todayApi.test.ts, inbox.ts, ContactEditForm.tsx,
ContactEditForm.test.tsx, ContactDetail.tsx, api/types.ts): exit 0, no
output. No e2e run. e2e/tests/dashboard-next/unknown-inactive.spec.ts
unchanged: it exercises only type='unknown' contacts (their skip is
unchanged) and never the edit form.

## FW2-1 (R2-1) - the Today skip keys on the owner's type too

Changed: app/src/routes/today.ts:769-777 - the collect-loop skip now needs
`unknown_1to1` AND an owner whose status is `inactive` AND whose type is
`unknown` or `team_member` (same memoized `getContact`, no new read; an
unresolvable owner is never skipped, as before). Comment :748-768 names the
owner-type rule and why (a second number can keep an unknown_1to1 thread).

RED (real code, before the change), app/test/todayApi.test.ts:
- :1123 the reviewer's probe flow through the real routes (unknown contact,
  phones P1 primary + P2, a thread on each, P2 unread; PATCH `{type:
  'tenant'}` re-types conv-p1 only; Today shows the "New unknown contact" row;
  `/tenant-status` `{toStatus:'inactive', expectedType:'tenant'}` -> 200):
  `expect(after).toEqual(before)` (:1167) failed with Received `[]` against
  the one row `{ attention: true, group: 'needs_you_now', refId: 'c-two',
  refType: 'contact', who: '(555) 036-0102', why: 'New unknown contact' }`.
- :1170 a directly seeded Inactive caseworker (partner) owning an unread
  unknown_1to1 thread: `expected [] to deeply equal [ { group:
  'needs_you_now', ...(5) } ]`; it pins the full row literal main emits.
PINs unchanged and green: the Inactive unknown, Inactive team member, Needs
review unknown, Active team member, Inactive tenant in Unreplied and the cap
cases (:1020-1110). One comment above the unchanged OR-6 case (:1045-1049)
said the skip keys "not on the contact's type"; now false, so amended
(comment only).

Docs: documentation/STATUS-MODEL.md:282-288 and documentation/GLOSSARY.md
:722-725 said an Inactive tenant's or partner's unread text "still shows in
Today's Unreplied". Still wrong after the fix for the case R2-1 is about: a
second number's unknown_1to1 thread shows in Needs you now as a "New unknown
contact" row (the pre-branch row, as for an Active owner). Both now say it
shows on Today where it would if the contact were not Inactive, naming that
case. The unknown / team member sentence was already true and is unchanged.

Tree vs adjudication: R2 and the adjudication say "triage re-types only the
primary phone's and the email threads". True of the contacts PATCH
(contacts.ts:2127-2143). The caseworker conversion re-types EVERY phone's
and email's thread (services/caseworkerConversion.ts:264, :384), so the
comment and docs say a second number "can keep" an unknown thread and name
the PATCH, not "triage" in general.

## FW2-2 (R2-6) - Save off after the status write's 409

Changed, dashboard/src/routes/contact/ContactEditForm.tsx:
- :328 `retypedUnderForm` (useState, the file's flag idiom; no effect).
- :603 set by the `409 contact_type_changed` arm, beside the copy (the only
  emitter is the transition route, app/src/routes/statusTransition.ts:313,
  :386).
- :625 `canSave` adds `!retypedUnderForm` (Save `disabled={!canSave}`);
  Cancel stays `disabled={saving}`, so it is enabled after the catch.
- :524 the submit handler's guard becomes `saving || retypedUnderForm`, so a
  submit by another route (Enter in a field) is closed too.
- :109-120 the CONTACT_TYPE_CHANGED_SAVE_COPY docblock: the list is
  `statusType`'s (as opened, or the draft's new type), a field PATCH may
  have saved the draft's type change, and why Save is off (a retry 409s
  again, or re-sends the draft's type over the colleague's re-type and then
  succeeds). Copy text unchanged. The form unmounts on close
  (ContactDetail.tsx renders it under `editing ?`), so reopening resets it.

RED (real code, before the change), ContactEditForm.test.tsx:
`expect(element).toBeDisabled()` - "Received element is not disabled" at
:1983 (both rows of the it.each) and :2023.
- :1946-1991 the FW1 it.each case asserted `expect(save()).toBeEnabled()`,
  the opposite of this ruling; its assertion and title now say Save is
  disabled, Cancel is enabled and closes (onClose once), and no further
  write is sent.
- :1993-2030 new: R2-6's interleaving - an Inactive unknown contact
  re-typed to Tenant with Searching, the PATCH resolves, the status write
  409s: the copy, `{ type: 'tenant' }` PATCH once, the status write once
  with `expectedType: 'tenant'`, onSaved not called, Status still
  Searching, Save disabled, a `fireEvent.submit` on the form sends nothing,
  Cancel closes.
Discrimination of the submit guard (in place, reverted before the commit):
with `if (saving) return;` restored, only the new case fails, `expected
"spy" to be called 1 times, but got 2 times`.

## FW2-3 (R2-3, R2-4, R2-5) - comments and one issue body

- app/src/routes/inbox.ts:1001-1008 the unreachable `case 'unknown'` arm:
  since D9 `needsTriage` is not the tab's rule (an Inactive unknown row is on
  the tab with it false), a routing change would drop those rows as
  `drops.filtered`, rewrite before anything makes it reachable. The arm is
  unchanged. Divergence from R2's suggested fix, recorded in the comment:
  `row.role === 'unknown'` alone is not the tab either - a team member's row
  has that role (roleFromContact falls through) while the tab is built from
  `listByType('unknown')` only (inbox.ts:2025-2028 comment).
- app/src/routes/inbox.ts:1102-1110 the `needsTriage` comment repeated the
  old rule ("so it needs triage, and it is what the unknown filter serves");
  now names the Inactive exception and points at the arm.
- dashboard/src/routes/contact/ContactDetail.tsx:313-324: the page hears a
  contacts-PATCH re-type and the caseworker conversion through
  contact.updated (useContact re-reads on it); the late-event / stream-down
  window remains. TODO kept verbatim.
- dashboard/src/api/types.ts:2129-2139 ContactUpdatedEvent names the three
  emitters as app/src/lib/events.ts:298-313 does.
- docs/issues/ha-review-close-name-patch-unfenced.md:68-79 the dated
  "Update (2026-10-23, tracker #30)" paragraph; status, frontmatter and the
  earlier paragraphs unchanged (their line refs drift, AR14).

## Residuals (recorded, not built)

- The deeper cause of R2-1 is untouched and pre-existing: a typed owner's
  unknown_1to1 thread (a second number) renders on Today as "New unknown
  contact" in Needs you now, Inactive or not. R2 proposed filing it or
  giving it to #31; this wave files nothing (no new issue files) - PLANNER.
- FW2-2 guards only the form that saw the 409. The contacts PATCH still has
  no type fence (FW1 residual 1, pre-existing, not widened): a second open
  form, a non-tenant type-change save (no status write follows, so no 409)
  or an API caller can still land a type over a colleague's re-type.
- R2-2 (one refetch over eventually consistent reads) stays the PLANNER
  call per the adjudication; the FW2-1 skip still reads the owner through
  the default-GetItem `getContact` (today.ts:358-370).
