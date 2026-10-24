# unknown-inactive - plan-blind adversarial code review (planner)

Reviewer: independent adversarial pass, diff and repo only (nothing under
docs/superpowers/ read). Range: `916258ae..798de475 -- app dashboard e2e
documentation docs/issues`. Read-only; no suite, e2e, dev server or npm command
was run.

## Summary

Counts: blocking 0, high 0, medium 1, low 7.

The concurrency work holds up when read end to end. The transition route's
`expectedType` pre-check, the service's `expect: type` conditional write, the
PATCH's status-only type fence (`statusTypeGuards`) and the kept-status fence
(`keptStatusGuards`) together leave no read-then-write window I could find
that stores a (type, status) pair the lists forbid. The one remaining writer
that can store one is the importer, and STATUS-MODEL.md already names it. The
SSE wiring is complete (route on/off, bridge, provider). The mirror test
compares real values, not empty lists. The findings below are about what the
new Inactive state does in code the diff did not touch, about refresh
freshness, and about docs that say too much.

## Findings

### F1 - medium - CONFIRMED - the missed-call auto-text still texts an Inactive contact

- Where: `app/src/jobs/missedCallAutoText.ts:126-130` (`needsMissedCallIntakeText`),
  called at `:232`. The type set it reads is at `:68-74`.
- What goes wrong: the intake gate skips a caller only for type
  landlord, partner or team_member, or when any intake field is filled in. It
  never reads `status`. Before this branch, an unknown contact could only be
  Needs review (Active was never reachable from the UI). Now staff can mark an
  unknown contact Inactive - the one-click way to set aside a wrong number,
  spam or robocaller - and such a contact usually has no name, voucher size,
  housing authority or agency on file.
- Scenario: (unknown, inactive) contact with only a phone -> calls the
  business number -> the call is missed -> `call.missedAutoText` runs ->
  `needsMissedCallIntakeText` returns true -> the tenant intake text goes out
  (one per CallSid, so on every missed call). The same happens for an Inactive
  tenant with blank intake fields. GLOSSARY.md now says an Inactive contact
  "is not chased", but this automated outbound still goes to exactly the
  contacts staff set aside.
- Suggested fix: return false from `needsMissedCallIntakeText` when
  `contact.status === 'inactive'`, pinned by a unit test. Or, if Cameron wants
  set-aside callers to keep getting it, write that rule into the
  Inactive glossary entry.

### F2 - low - PLAUSIBLE - Today and the inbox refetch on contact.updated with eventually consistent reads

- Where: `dashboard/src/routes/today/useToday.ts:156` and
  `dashboard/src/routes/inbox/useInbox.ts:591` (a 300 ms debounce, `:39` /
  `:142`). These trigger `app/src/routes/today.ts:358-370` (`getContact`, a plain
  `contacts.getById`, not consistent), the Today triage pass
  `listByType('unknown', {status:'needs_review'})` at `:902` (a GSI, always
  eventually consistent), and the inbox Unknown-tab block reads (the same GSI).
- What goes wrong: `contact.updated` is emitted right after the write commits
  (`app/src/services/statusTransition.ts:678`, `app/src/routes/contacts.ts:2227`).
  The contact page re-reads with `?consistent=1` for exactly this reason
  (`dashboard/src/routes/contact/useContact.ts:75-90`). Today and the inbox do
  not, and a GSI cannot be read consistently at all.
- Scenario: Today is open in tab B. In tab A, staff mark a threadless unknown
  contact Inactive. The event reaches B, B waits 300 ms and refetches, and the
  byTypeStatus GSI has not yet propagated, so the "New unknown contact" row is
  served again. Nothing else fires, so the row stays until some unrelated
  event or a reload. The live-refresh guarantee this event was added for does
  not hold in that window.
- Suggested fix: on contact.updated, schedule one extra delayed re-read (for
  example around 1.5 s). Or say in the events.ts docblock that the refresh is
  best-effort under GSI lag.

### F3 - low - PLAUSIBLE - useContact's "latest wins" ignores local setContact, so an older re-read can overwrite a newer mutation result

- Where: `dashboard/src/routes/contact/useContact.ts:75-90` (sequence counter)
  and `:49-51` (`setContact`, which does not bump the counter).
- What goes wrong: the sequence orders the re-reads only against each other.
  A mutation response applied through `setContact` - most of which emit no
  contact.updated (staff notes, opt-out, phones, a PATCH that changes neither
  status nor type) - is not part of that order.
- Scenario: staff change the header status, so the event starts consistent
  GET #1. Before GET #1 answers, staff save Staff notes (no contact.updated)
  and `setContact(withNotes)` runs. GET #1 then lands with the contact as it was
  before the notes and replaces it. Nothing re-heals that state. The next
  notes save then carries a stale `staff_notes_updated_at` and gets
  `staff_notes_stale`. The window is small but the new emitters make it
  routine.
- Suggested fix: make `setContact` also increment `refetchSeqRef`, so a re-read
  started before a local commit is dropped.

### F4 - low - CONFIRMED - the edit form shows the generic save error on the new PATCH fences' 409 contact_changed

- Where: `dashboard/src/routes/contact/ContactEditForm.tsx:622-628` (fallback
  branch). The server side is `app/src/routes/contacts.ts:1689-1695`
  (`statusTypeGuards`), `:1814-1824` (`keptStatusGuards`) and `:2016-2019`.
- What goes wrong: the branch added two fences that answer 409
  `{error:'contact_changed', contact}`. The form special-cases only
  `contact_type_changed`, so both new 409s read "Couldn't save - please try
  again." with Save still enabled.
- Scenario: a landlord's Status is edited to Parked in the form while a
  colleague re-types the contact to team member. The PATCH loses its type
  fence and returns 409 contact_changed, and the form shows the generic copy.
  Retry -> 400 "status must be one of: needs_review, active, inactive" ->
  generic copy again. Nothing is corrupted, but staff never learn why.
- Suggested fix: map 409 contact_changed to the same path as
  `contact_type_changed` (copy, `retypedUnderForm`, `onStale`).

### F5 - low - CONFIRMED - the server's type-change status defaults now exist in four copies, one unpinned in the dashboard

- Where: `app/src/routes/contacts.ts:1770-1771` (auto-advance) and
  `:1805-1812` (normalize), `app/src/routes/contacts.ts:1013-1022` (create),
  `app/src/routes/unmatchedEmail.ts:1132`, and the new dashboard copy
  `dashboard/src/routes/contact/ContactEditForm.tsx:46-53`
  (`FIRST_STATUS_FOR_TYPE`).
- What goes wrong: the form relies on the server's tenant default. It skips the
  second write when the shown status is `'onboarding'` (`ContactEditForm.tsx`
  `statusTransition`, `typeChanged ? isTenant && (status !== 'onboarding' || ...)`).
  `contactStatusMirror.test.ts` pins the lists and labels but not this map.
- Scenario: someone changes the server's tenant first step (say to
  `needs_review`). The form still shows Onboarding by default, skips
  `setTenantStatus`, and the contact silently lands on the server's new
  default while the form showed Onboarding.
- Suggested fix: export one `firstStatusForType` from `app/src/lib/statusModel.ts`,
  use it at the server sites, and pin the dashboard map against it in
  `contactStatusMirror.test.ts`.

### F6 - low - CONFIRMED - the Inactive glossary entry overclaims "not a listing-send recipient"

- Where: `documentation/GLOSSARY.md` (the new **Inactive** entry: "not a
  listing-send recipient - `isEligibleRecipient`"). The code is
  `app/src/lib/listingSendOutcome.ts:108-122`, used only for follow-up
  eligibility (`app/src/services/followUps.ts:182`) and a sort rank
  (`app/src/routes/units.ts:301`, `dashboard/src/routes/listing/listingFormat.ts:353`).
- What goes wrong: the explicit-selection send fences
  (`app/src/routes/broadcasts.ts:636-645` resolveSeeds, `:1240-1246` send) check
  type, phone, opt-out and unreachable, never status. An Inactive tenant or
  caseworker picked by hand still gets the listing. The review row shows no
  status for a partner seed (`broadcasts.ts:658-661`), so staff cannot see they
  picked an Inactive caseworker.
- Scenario: Contacts > Caseworkers -> staff add a retired (Inactive)
  caseworker to a direct share -> the share sends to them. The glossary says
  this cannot happen.
- Suggested fix: reword the glossary to "not chased by Follow up (no waiting
  on a reply row)". If Inactive is meant to block sends, add the check to both
  broadcast fences instead.

### F7 - low - CONFIRMED - the transition route accepts a phone-pointer id and 500s

- Where: `app/src/routes/statusTransition.ts:296-330`. There is no
  `phone_ref`/`email_ref` guard; compare `app/src/routes/contacts.ts:1648-1651`.
  The write is `app/src/services/statusTransition.ts:650-652`.
- What goes wrong: a pointer item (`app/src/repos/contactsRepo.ts:1133-1138`)
  has no `type`. The allowlist for an undefined type is PARTNER_STATUSES, so
  `toStatus:'inactive'` passes. `expectedType` then becomes `undefined`, and
  `contactsRepo.update` builds `#expect0 = :expect0` with an undefined value
  (`contactsRepo.ts:1642-1650`): a marshalling or ValidationException, so a
  500. Before the branch the same call wrote a status onto the pointer, so
  this is no worse for data, but it is an unhandled 500 an API caller can hit.
- Suggested fix: 404 a `phone_ref`/`email_ref` record in the route, as the PATCH
  does. Map an absent stored type to a `value: null` (attribute_not_exists)
  clause.

### F8 - low - CONFIRMED - AI extraction keeps running on Inactive unknown contacts

- Where: `app/src/jobs/extraction.ts:457` (type-only eligibility),
  `app/src/routes/contacts.ts:2681-2688` (the manual trigger's mirror), and Today's
  `ai_suggestions` group at `app/src/routes/today.ts:987-1011` (skips only
  deleted contacts).
- What goes wrong: an Inactive unknown contact that keeps texting (spam, a
  wrong number) still gets an LLM run on every inbound. Its suggestions put a
  "<n> suggestion(s)" row on Today. That is not Needs you now, so D5 is not
  broken, but it is paid work and Today attention for a contact staff set
  aside.
- Suggested fix: decide explicitly. Either skip extraction (and the Today AI
  row) for `status === 'inactive'`, or note in the Inactive glossary entry that
  extraction continues so staff can later learn who it is.

## Swept and found sound (no finding)

- (type, status) writers: create (`contacts.ts:911-918`); PATCH status-only,
  re-type, auto-advance and normalize (`:1689-1825`); `/tenant-status` (route
  `:279-330` plus the service conditional write); AI status accept
  (`suggestionResolution.ts:297-311`, onboarding->searching on tenants only,
  `extraction/apply.ts:535`); caseworker conversion (partner/active pair);
  auto-capture, group stubs and voice stubs (needs_review); seeds (pinned by
  `seedContactTypeInvariants.test.ts`); import (`apply.ts:972` allowlist,
  `preserveStatus` gap already documented in STATUS-MODEL.md and
  `import-bypasses-contact-type-rules.md`).
- `status_source: 'manual'` now stamped on non-tenants by `setTenantStatus`:
  no reader keys behavior on it except the import, which already preserves
  any non-import provenance, undefined included (`apply.ts:1142-1146`).
  Derivation gates on the override status, not provenance
  (`statusTransition.ts:368-369`).
- Readers of `inactive` / `needs_review` across app/src: follow-ups, the inbox
  row builder, the Today unread and triage passes, the unknown queue blocks and
  cursor decoder (a stale `active` cursor 400s once, as documented), blast
  filter audiences (tenant partitions only), the Contacts list (all pages
  walked, Unknown view re-sorted client-side), StatusBadge/StatusMenu tones
  (an off-list value humanizes).
- SSE: route on/off registration, the bridge's APP_EVENT_NAMES coverage, the
  provider listener, the ID-only payload. Authorization is unchanged: every
  staff role can already reach these routes, and no new route was added.
- Tests checked for wrong-reason passes: the service race tests inject the
  re-type inside `update` (`statusTransition.test.ts`, SPEC-F1 case), the mirror
  test compares non-empty lists, and the useContact latest-wins test releases
  out of order. No assertion found that cannot fail.
