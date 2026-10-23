# Plan review round 3 (reviewer A, continued) - unknown-inactive plan v3

Reviewed: the v3 diff (43e971f5..34ca6c7f) in full; ContactEditForm.tsx read
end to end for every `contact` reference; the "Plan round 2" table
(R2P-1..5). Tree: main @916258ae. Read-only; nothing run.

Verified mechanically: all 26 one-line `old` anchors in S4.4 step 3j match
exactly one line of `dashboard/src/routes/contact/ContactEditForm.tsx`; S2.3
Edit G's anchor `const contact = await contactsRepo.getById(contactId);` is
unique (`app/src/services/statusTransition.ts:611`; the other read, `:338`,
reads `tenantId`). The 3j list covers every diffing read in `buildPatch`
(`ContactEditForm.tsx:334-455`) and the address seeds (`:307-310`); 3d/3e/3g
cover `:205`, `:291`, `:345`, `:519-521`.

## F1. [LOW] The kind control is split between `base` and the live prop, so a concurrent re-type can still be overwritten through the picker

What is wrong. 3j moves `kind`'s diff (`typeChanged`, `patch.type`) to `base`
but leaves two kind reads on the live prop, and lists only one of them:
- `savedRole` / `currentKindLabel` (`ContactEditForm.tsx:576-579`) - the
  collapsed "Change type" summary - shows the LIVE kind (3j: "display
  only").
- `offerCaseworker={isCaseworkerContact(contact)}` (`:639`) - not in 3j's
  "reads that STAY" list, and not caught by its check grep (the pattern
  `contact[.[]` does not match `contact)`). It decides whether the KindPicker
  offers the Caseworker preset. Ruling R4-15 (`KindPicker.tsx:30-33`) says
  the host decides that "from the STORED contact".

Consequence. Operator A has the form open on an unknown contact; B re-types
it to landlord (status Active). A's summary now reads "Landlord" while the
expanded picker still opens on Unknown (`kind` is seeded from the opened
contact, `:190-193`). If A clicks Landlord to "confirm" what the summary
says, `typeChanged` is true against `base` (unknown), statusType moves the
field to Interested, and the non-tenant-target PATCH writes
`{ type: 'landlord', status: 'interested' }` - B's Active is lost. This is
the same lost-update class R2P-1 closed, reached through the one display the
form left live. It is narrow (it needs a concurrent re-type and a misleading
click), so LOW. Fix: read `base` in the summary and in `offerCaseworker` too,
so the whole form describes one contact; list `:639` in 3j either way.

## Review of the round-2 changes (no further finding)

- R2P-1 `base` snapshot: sound. `const [base] = useState(contact)` is safe
  because ContactDetail resets `editing` on a contact switch
  (`ContactDetail.tsx:355-363`) and remounts the form on every open
  (`:1341-1351`), so `base` never outlives its contact. `onSaved` closes the
  form (`:1345-1348`), and the next open gets a fresh `base`. A partial
  failure (the PATCH commits, the follow-up `setTenantStatus` fails) keeps the
  form open with the old `base`, and a retry still converges: the re-sent
  `type: 'tenant'` is now a same-type PATCH, which S1.3 makes status-neutral,
  and 3g sends the one `setTenantStatus`. The reads left on the live prop do
  not feed a diff: the `useState` seeds (equal to `base` at mount),
  `contact.contactId`, and `let updated = contact` (overwritten by every write
  path before `onSaved`; the no-write path returns via `onClose`). F1 covers
  the two exceptions. The new test is RED on v2 for the stated reason (`type`,
  `lastName` and `status` all leak in against the live prop) and GREEN on v3.
  No existing form test rerenders (`rerender` appears in neither
  ContactEditForm.test.tsx nor ContactDetail.test.tsx). No other dialog on the
  page diffs a draft against the live contact: ConsentCaptureModal and
  StaffNotesCard send fixed payloads, and StaffNotesCard has its own stale
  guard.
- R2P-2 consistent setter read: correct and minimal. The guard's re-read runs
  only on a refused write, so "first getById" is the setter's own. No existing
  app test pins `getById` arguments on the setTenantStatus path. The S2.4 race
  test still counts route read, setter read, re-read in that order.
- R2P-3 `statusOptionsFor(statusType)`: correct. `statusType` is seeded from
  `base.type`, the same source as the `status` seed, and equals `kind.type`
  whenever that is non-null, so 3h's narrow via `liveType` agrees at save
  time.
- R2P-4 W8: recorded as a watch item in section 3 and in the S2 report.

## Adjudications contested

- R2P-4 (watch item, no mechanism): concede.
- None other.
