# Code review round 3 - orchestrator adjudications (feat/unknown-inactive)

Report: `R3-review.md` (fresh reviewer on the FW2 diff, HEAD ed2363b3):
0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW, 3 INFO. FW2-1 REAL (pre-FW2 today.ts
swapped in fails exactly the two new cases, 2/70); FW2-2 REAL per opening
(revert fails 3/115); FW2-3 REAL with gaps. Battery-3 at ed2363b3
(orchestrator-read): typecheck 0; npm test 0 (app 527 / 11174 passed, 1
skipped; dashboard 266 / 5487; e2e workspace 22 / 508; 34 / 275; 13 / 111; no
`[dynamoAdmin]` line); smoke 0; e2e 0 (372 passed, 15.8m).

## FW3 - fix (one fresh child, small)

FW3-1 (R3-1, LOW, CONFIRMED; the reviewer challenged my R2-6 ruling and is
right) - the edit form's Save-off guard lasts one opening: the form's
`409 contact_type_changed` never makes the PAGE re-read the contact (the
header's 409 does, dashboard/src/routes/contact/ContactDetail.tsx ~:966-982),
so with the event stream down a Cancel + reopen rebuilds the form from the
stale contact and a redone type-change draft re-sends `{ type }` over the
colleague's re-type. Invariant (stated once, applied to EVERY 409 path the
branch added on the contact page): after a `409 contact_type_changed`, the
page re-reads the contact with a CONSISTENT read and shows it. Ruling: the
form gets an optional callback from ContactDetail (e.g. `onStale`) that it
calls on that 409; ContactDetail answers it exactly as its header 409 does
(`getContact(id, undefined, { consistent: true })` -> setContact; best-effort
on failure). The form's own Save-off and copy stay. RED: a ContactDetail-level
test - the form's status write answers 409 contact_type_changed -> the page
re-reads consistently and shows the new type; reopening the form builds it
from the re-read contact (its Status list is the new type's).

FW3-2 (R3-3 + R3-4, INFO, docs/comments precision):
- documentation/STATUS-MODEL.md 5b and documentation/GLOSSARY.md: the
  sentence that an Inactive unknown contact's or team member's text "shows
  only in the inbox" is too broad - a contact re-typed to unknown or
  team_member through the API keeps its typed (tenant_1to1 etc.) threads,
  which still feed Unreplied. Say precisely: its UNKNOWN threads do not show
  in Needs you now.
- The FW2-1 comment in app/src/routes/today.ts and the matching doc sentences
  name only the second number as the way a typed contact keeps an
  unknown_1to1 thread; also name the importer, which mints every imported 1:1
  thread `unknown_1to1` (app/src/lib/import/apply.ts ~:1284; filed as
  docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md). No
  edit to that issue: FW2-1 left typed owners' rows exactly as on main, so the
  behavior it describes is unchanged (AR14).

## RECORD (handback)

- R3-2 (INFO) - the contacts PATCH's own `409 contact_changed` (any of its
  guards, including the two this branch added: the status-only type guard,
  OR-3, and the kept-status guard, FW1-3) still shows the form's generic
  "Couldn't save - please try again." with Save on; a retry re-reads and can
  land the draft (a landlord status shared with the new type, or the draft's
  type over a colleague's re-type). Pre-existing class (main has the same
  copy and the same unfenced re-type); this branch made the FIRST attempt
  refuse where main would have written. The server-side fence for a
  type-changing PATCH (the form's base classification revision) is the real
  fix - same family as docs/issues/ha-review-close-name-patch-unfenced.md.
  Planner call; nothing filed (AR14).
