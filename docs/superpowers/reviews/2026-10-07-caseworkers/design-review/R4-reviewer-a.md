# Design review R4 - reviewer A - branch B (caseworkers), revision 12 (narrow)

- Date: 2026-10-07
- Scope: only the revision-12 changes, `git diff 500e1a24 98a4e290` (5 points).
- Read-only; nothing run.

**Verdict: terminal.** Nothing below changes WHAT gets built. The three LOW
items are plan precision or an accepted-race sentence.

## 1. Preview read - consistent; one advisory gap (LOW)

What holds:
- It is computed by "the same server code the conversion runs", read-only, with
  404/400 as `make`.
- It returns refusals, removed values, the pending-suggestion count, thread
  counts, and the organization with its source. That matches every input
  `make` uses.
- The path `/:contactId/caseworker-review/preview` is deeper than
  `/:contactId`, so it does not collide with `GET /:contactId`
  (`app/src/routes/contacts.ts:1141`).

The gap: "advisory, make recomputes" is enough for refusals and counts, but not
quite for the organization.
- When staff leave the picker untouched, `make` omits `organization` and
  re-derives it from the values `make` reads.
- The new commit condition (point 3) protects `make`'s own read-to-write
  window, not the preview-to-make window.
- So if someone edits agency between the preview and Confirm, the record gets
  an organization the dialog never showed.

This is a seconds-long race. One sentence accepting it is enough. Closing it
would mean `make` taking the preview's read values as an expect token; not
required.

Also unstated: what the preview returns for a contact that is already a
caseworker, where `make` means repair. That is reachable only through the API
(the page action and the list both exclude caseworkers). Not material.

## 2. Organization wire - correct

The rules:
- omitted = the server decides (stored, else derived, carry included);
- non-empty = a staff pick, D5-checked against either kind;
- `''` = clear;
- the dialog sends `organization` only when staff changed the picker.

This closes R3 finding 2. An untouched carried value is never sent, so it
never meets D5. A carried value cannot be re-picked from the list (it is not
an entry), so "changed" cannot reproduce it. Consistent with D17 ('' ->
absent).

## 3. Commit condition - correct in intent; the repo must be extended (LOW, plan precision)

The spec still says the write goes "through the classification fence
(`contactsRepo.update`, conditional on ...)". Today's `UpdateContactOptions`
cannot express that:
- `expect` is ONE string attribute (`app/src/repos/contactsRepo.ts:625-627`),
  built as one equality or `attribute_not_exists` clause (:1386-1395).
- `classification_revision` is a NUMBER, bumped with `if_not_exists(...) + 1`
  and no condition on its prior value (:1351-1357).

The conversion needs four guards in one condition:
- the revision (number);
- `housingAuthority` (value or absent);
- `agency` (value, `''`, or absent);
- `organization` (value or absent).

So the repo gains a multi-attribute, typed guard. The failure must also map to
409 `contact_changed`, re-reading to tell "gone" (404) from "stale", as the
PATCH does (`app/src/routes/contacts.ts:1660-1675`). This does not change what
is built, but the plan should name the repo change.

## 4. Type-keyed page action - correct

The action is keyed on `contact.type` (tenant, landlord or partner), on a live
contact, and not shown on a caseworker. That matches the route's domain:
- team_member is excluded, although it renders the tenant page
  (`dashboard/src/routes/contact/ContactDetail.tsx:563-573`);
- deleted contacts get no action;
- `unknown` keeps its own entry point (Mark as Caseworker).

## 5. `caseworker_conversion` replacement and the RUNBOOK line - acceptable (LOW)

- A re-conversion replaces the record, and "the earlier one survives in that
  conversion's audit".
- That audit is step 4, written best-effort AFTER the commit, which is exactly
  why the record moved into the commit write. So an earlier conversion whose
  audit failed is lost on re-conversion.
- That needs a double rarity: a failed audit, then convert, revert and convert
  again. Accepted as written; at most add "(best-effort)".
- The section 11 RUNBOOK line now matches D19. A contact created as a
  Caseworker has no record; that is consistent.
