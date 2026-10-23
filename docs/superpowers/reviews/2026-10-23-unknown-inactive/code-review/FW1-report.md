# Fix wave 1 report - feat/unknown-inactive (code review R1, FW1-1 .. FW1-6)

Base for this wave: 8a9d40d8 (R1 adjudications). Commits, in order:

- 9c6cb8fc FW1-2 test(status) - the transition write's own type condition
- f995b87b FW1-1 feat(status) - /tenant-status takes expectedType (app)
- 099d12ce FW1-1 feat(contact) - header and edit form send it (dashboard)
- 19a5e0f8 FW1-5 test(contact) - the porting arm of a type change to tenant
- 923f3df2 FW1-3 fix(contacts) - a re-type that keeps the status is fenced
- 55605ea2 FW1-4 fix(caseworkers) - the conversion emits contact.updated
- 57896482 FW1-6 docs - the one writer that can still store (unknown, active)

Gates run by this wave (the orchestrator re-runs the battery): typecheck
exit 0 (after FW1-1 app, FW1-1 dashboard, and at the end); app workspace
`npx vitest run` 527 files, 11172 passed, 1 skipped, exit 0, no
`[dynamoAdmin]` line, no AWS_ variable exported (battery-1: 11155 + 1; the
+17 are this wave's cases); dashboard workspace 266 files, 5486 passed, exit
0 (battery-1 5481; +5). eslint on the 16 touched TS files: exit 0, no
output. No e2e run. e2e/tests/dashboard-next/unknown-inactive.spec.ts and
e2e/support/selectors.md unchanged: the header still names itself "Contact
status" and the spec picks on a contact whose type the page shows.

## FW1-1 (ADV-1) - the client's type is fenced

Changed:
- app/src/routes/statusTransition.ts:78-88 `CONTACT_TYPE_KEYS`
  (Record<ContactType, true>, the services/orgRecords.ts idiom) and
  `isContactType`; :279-285 an `expectedType` present and not a ContactType
  is 400 `expectedType must be a contact type` (before the read, with the
  other body checks); :302-315 present and !== stored.type is
  `409 { error: 'contact_type_changed' }` after the 404 and BEFORE the
  allowlist check, logged with ids/types only, nothing written; :329 the
  service still receives `expectedType: stored.type` (AR4 unchanged).
  Header comment :6 names the field.
- dashboard/src/api/endpoints.ts:488 `expectedType?: ContactType`, :500 sent
  only when given; docblock :475-480.
- dashboard/src/routes/contact/ContactDetail.tsx:953 the header sends
  `expectedType: contact.type`; the 409 comment :965-971 now says what is
  true (stored type other than the expectedType sent, or a change between
  the route's check and its write). This is the FW1-6 ContactDetail item,
  done in 099d12ce because that commit made it true.
- dashboard/src/routes/contact/ContactEditForm.tsx:116
  `CONTACT_TYPE_CHANGED_SAVE_COPY`; :568 `expectedType: statusType` on every
  setTenantStatus call; :586-589 the 409 maps to the constant, draft kept.

RED seen (real code, before the change):
- route: `expected 200 to be 409` (a partner picked from the unknown list;
  the re-typed-to-tenant and re-typed-to-partner regressions),
  `expected 400 to be 409` (landlord: the allowlist answered first; the
  re-typed-to-landlord regression), `"robot": expected 200 to be 400`.
- dashboard: `expected "spy" to be called with arguments: [ 'k1', { toStatus:
  'on_hold', ...(2) } ]` and the same shape for the landlord, partner,
  team_member, unknown and 409 header cases, the endpoint case and six form
  cases; the form 409 case: `Received: Couldn't save - please try again.`
- TDD order, recorded: the form source was edited before its first run. To
  keep that RED honest the committed form source was put back with ONLY the
  new exported constant added (so the test import resolved), the RED above
  was taken, then the edited form was restored.

Tests: app/test/transitionRoutes.test.ts:391-499 (mismatch 409 writing
nothing - no audit, milestone or contact.updated; 409 before 400; match 200
PIN; five invalid values; absent PIN; the reviewer's stale-client cases via
the real PATCH, re-typed to tenant / partner / landlord, each 409 with the
re-typed pair standing). Dashboard: endpoints.test.ts:347;
ContactDetail.test.tsx:440, :481, :556-560, :591; ContactEditForm.test.tsx
:380, :400, :1715-1719, :1759 (`'tenant'` on the follow-up after a type
change), :1920 (re-rendered with a re-typed prop -> Save sends
`expectedType: 'unknown'`), :1946-1982 (409 with and without a field PATCH:
the copy, never the generic error, onSaved/onClose not called, draft and
Save intact).

Divergence from the adjudication's copy suggestion: the constant reads
"This contact's type changed while you were editing, so its status was not
saved. Reload the contact to pick a status for its new type." - "Reload"
instead of "Reopen Edit contact details". Reopening rebuilds the form from
the page's contact, which is fresh only if contact.updated reached the page;
with the event stream down it would offer the old list and 409 again. A
reload always reads fresh (the house precedent is DEPOSIT_CONFLICT_COPY,
"Reload the landlord and try again."). The copy claims nothing about the
other fields: when this 409 arrives any field PATCH already succeeded (the
status write runs only after it resolves), but porting rides the status
write, so "your other changes were saved" would be false for a tenant's
porting tick.

## FW1-2 (SPEC-F1) - the service's conditional write is pinned

Changed: app/test/statusTransition.test.ts:483 a re-type landing INSIDE the
update call (after the setter's own read) -> ContactTypeChangedError, stored
(landlord, needs_review), no status_source, no audit, no milestone, no
contact.updated, and the update's `expect` is exactly
`[{ attr: 'type', value: 'unknown' }]`. :505 replaces the misleading PIN:
without expectedType the update carries `[{ attr: 'type', value: 'tenant' }]`
and a re-type under the write is still refused (stored stays onboarding).
Real code: 72/72.

Discrimination (copy technique): an M1 copy of the service
(app/src/services/zz-fw1-mutant-statusTransition.ts: the conditioned update
replaced by `if (contact.type !== expectedType) throw new
ContactTypeChangedError(contactId);` plus an unconditioned update) swapped
in by a throwaway app/vitest.zz-fw1-mutant.config.ts (mergeConfig of
vitest.config.ts, resolve.alias for `../src/services/statusTransition.js`
and `../services/statusTransition.js`). statusTransition.test.ts +
transitionRoutes.test.ts under M1: 2 failed / 102 passed (104) - exactly the
two new cases: `promise resolved "{ contactId: 'uk-5', ...(5) }" instead of
rejecting` and `expected [] to deeply equal [ { attr: 'type', value:
'tenant' } ]`. Every older case passes under M1, reproducing the reviewer's
gap. Both scratch files deleted before the commit (git status clean). The
real service file was only read.

## FW1-3 (ADV-2) - a re-type that keeps the stored status is fenced on it

Changed: app/src/routes/contacts.ts:1662-1664 `statusAsRead` captured at the
read (the file's live-object convention); :1790 `keptStatusGuards`; :1814-1823
on the normalize fallback's keep path (a REAL type change whose stored
status is legal for the target and not inactive) the write is guarded on the
status as read; :1989 joins the write's guards; the 409 comment names the
new guard. A lost guard is the existing 409 contact_changed.

RED: `expected 200 to be 409` for both races in app/test/contactTriage.test.ts
:1363-1428 - (team_member, needs_review) PATCH `{type:'unknown'}` with a
`/tenant-status` write to active landing inside the PATCH's update call
(old code stored (unknown, active)); and (landlord, needs_review) PATCH
`{type:'team_member'}` with a write to parked (old code stored
(team_member, parked)). Now 409, the status write stands, no PATCH audit,
only the status write's contact.updated. PINs: the same PATCHes alone ->
200, Needs review kept.

Residual: fenced only on a real type change; a same-type PATCH cannot form a
new pair (classification_revision fences a concurrent re-type). API-only
reach, as the reviewer said (KindPicker offers neither target).

## FW1-4 (ADV-3) - the caseworker conversion emits contact.updated

Changed: app/src/services/caseworkerConversion.ts:569-575 one ID-only
`contact.updated` after the commit log line and before followOn.
app/src/lib/events.ts:298-310 names it as the third emitter.

RED: app/test/caseworkerConversion.test.ts:1038 `expected [] to deeply equal
[ { event: 'contact.updated', ...(1) } ]`; :1048 `expected [
'conversation.updated' ] to deeply equal [ 'contact.updated', ...(1) ]`
(pins "before followOn"). PINs: :1057 a refusal (open tour) and a guard lost
under the commit emit none; :1073 the repair path (no commit) emits none.

## FW1-5 (SPEC-F2) - the porting arm is pinned

Changed: dashboard/src/routes/contact/ContactEditForm.test.tsx:1773 re-type
an Inactive unknown contact to Tenant, tick Porting, keep Onboarding, Save:
one PATCH `{ type: 'tenant' }`, then exactly one setTenantStatus `{ toStatus:
'onboarding', source: 'manual', porting: true, expectedType: 'tenant' }`,
PATCH first. Written after FW1-1 (the expected call carries expectedType).

Discrimination (copy technique, practical for the component): a copy of the
form (dashboard/src/routes/contact/zz-fw1-mutant-ContactEditForm.tsx) with
ContactEditForm.tsx:534 `? isTenant && (status !== 'onboarding' ||
portingChanged)` reduced to `? isTenant && status !== 'onboarding'`, swapped
in for `./ContactEditForm.js` by a throwaway dashboard/vite.zz-fw1-mutant
.config.ts. Under the mutant the file is 1 failed / 113 passed (114) - only
the new case: `expected "spy" to be called with arguments: [ { contactId:
'u9', ...(4) } ]` (onSaved got the PATCH's contact; no status write was
sent, so the porting tick was dropped). Scratch files deleted before the
commit.

## FW1-6 (ADV-9, SPEC-F4) - claims made true

- app/src/lib/events.ts:298-310: the header, the edit form's no-type-change
  status save and its post-retype tenant write go through setTenantStatus;
  the PATCH carries the form's type changes (with a non-tenant target's
  status), a landlord's status with its park reason, and the unknown card's
  Mark as actions (verified: ContactDetail.tsx onTriage -> updateContact).
- documentation/STATUS-MODEL.md:248-253 and the UNKNOWN_STATUSES comment
  app/src/lib/statusModel.ts:209-213 name the one exception (a re-import
  that re-types a contact whose status staff set keeps it unchecked,
  lib/import/apply.ts preserveStatus; "the same family as" the filed
  importer issue, which does not itself describe the pair - SPEC-F4's
  planner call stays open). The PATCH race is not named: FW1-3 closed it.
- Beyond the list, the same overstated claim in two more branch-authored
  places: the statusAllowlistFor docblock (statusModel.ts:224-231, "so no
  path stores a pair its type does not allow") and unknownQueue.ts:60-61 +
  :71-72. Both corrected. unknownQueue.ts:67-68 kept on the same lines
  because docs/issues/unknown-queue-status-flip-duplicates-across-pages.md:41
  cites them (AR14: the issue is not edited).
- documentation/GLOSSARY.md: no such claim (its Inactive entry says an
  unknown contact has no "Active" among the offered choices, which holds).
  Unchanged.

## Residual risks (recorded, not built)

- A retry from the still-open form after the FW1-1 409 re-sends the field
  PATCH diffed against `base`; for a draft that changed the type, that PATCH
  re-types the contact again over the colleague's change (the PATCH carries
  no client-side type or revision fence). The copy sends staff to a reload,
  but Save stays enabled. Same class as the adjudication's RECORD item for
  the landlord status that rides the PATCH; pre-existing, not widened.
- API callers that omit expectedType keep only the route-read-to-write
  fence (by design).
- The FW1-4 emit precedes the thread re-types, so a Today/inbox refetch can
  briefly show the old thread type; the per-thread conversation.updated
  events that follow trigger their own refetch.
- Line citations in many older docs/issues files into contacts.ts,
  ContactDetail.tsx and ContactEditForm.tsx drift with these edits, as with
  every earlier slice; AR14 keeps them unedited.
