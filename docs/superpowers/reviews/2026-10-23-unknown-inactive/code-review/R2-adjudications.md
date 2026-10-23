# Code review round 2 - orchestrator adjudications (feat/unknown-inactive)

Report: `R2-review.md` (fresh reviewer, plan-blind except the code-review
folder; HEAD ba39fe2b): 0 CRITICAL, 0 HIGH, 0 MEDIUM, 2 LOW, 4 INFO. Every
FW1 fix verified REAL by revert (each revert fails exactly its own new tests).
Battery-2 at ba39fe2b (orchestrator-read): typecheck 0; npm test 0 (app 527
files / 11172 passed, 1 skipped; dashboard 266 / 5486; e2e workspace 22 /
508; 34 / 275; 13 / 111; no `[dynamoAdmin]` line); smoke 0 (1733 specifiers,
301 files); e2e 0 (372 passed, 15.8m).

## FW2 - fix (one fresh child)

FW2-1 (R2-1, LOW, CONFIRMED; reverses the R1 RECORD of ADV-10) - the Today
skip (app/src/routes/today.ts ~:763-767) keys on the THREAD type only, so an
Inactive TENANT (or landlord/partner) whose secondary-number thread triage
never re-typed (still unknown_1to1, contacts.ts ~:2137-2145 re-types only the
primary phone's and the email threads) loses that unread text from Today
entirely; before the branch it showed (mis-bucketed) as a "New unknown
contact" row. Orchestrator ruling: narrow the skip to owners whose TYPE is
`unknown` or `team_member` - the types whose own threads are unknown_1to1 -
so every other owner keeps today's behavior (spec D5: "skip Inactive" for the
contacts whose threads feed Needs you now; D4: an Inactive tenant's or
caseworker's unread text is not hidden). Same memoized getContact, no extra
read. RED: an Inactive tenant owning an unread unknown_1to1 thread is still
emitted exactly as before the branch. PINs: Inactive unknown and Inactive
team member still skipped (the S3.3/OR-6 cases), the cap case unchanged.
Keep the today.ts comment, STATUS-MODEL 5b and GLOSSARY true (they promise an
Inactive tenant's text is not lost).

FW2-2 (R2-6, INFO, FW1-introduced docblock + a cheap guard) - after the edit
form's `409 contact_type_changed`, Save stays enabled; a draft that changed
the type would re-send `{ type }` over a colleague's re-type on a retry (the
overwrite class itself predates FW1). Ruling: after that 409 the form
disables Save (Cancel stays) until it is reopened - its copy already sends
staff to reload - and the CONTACT_TYPE_CHANGED_SAVE_COPY docblock says what
is true. Test: a mocked 409 shows the copy, keeps the draft, and Save is
disabled; Cancel still closes.

FW2-3 (R2-3, R2-4, R2-5, INFO - comments and one issue body):
- app/src/routes/inbox.ts ~:993-1000 (`passesFilter` `case 'unknown'`,
  UNREACHABLE): its comment must say that since D9 the arm no longer matches
  the Unknown tab (an Inactive unknown contact's row is on the tab with
  `needsTriage` false), so it must be rewritten before anything makes it
  reachable. Comment only - the arm stays (exhaustive switch). Same for the
  comment near ~:1093 if it repeats the old rule.
- dashboard/src/routes/contact/ContactDetail.tsx ~:313-322: the page now
  hears a contacts-PATCH re-type and the caseworker conversion through
  contact.updated (useContact re-reads on it); say so, and keep the TODO for
  the server-side fence (the event can be late or the stream down).
- dashboard/src/api/types.ts ~:2129-2134 ContactUpdatedEvent docblock: name
  the three emitters as app/src/lib/events.ts now does (the transition route
  - header and the form's status saves; the contact PATCH - type changes, a
  landlord's status, Mark as; the caseworker conversion).
- docs/issues/ha-review-close-name-patch-unfenced.md (open): AR14 allows an
  existing issue's body update where the branch changed the behavior it
  describes. Append a short dated "Update (2026-10-23, tracker #30)"
  paragraph: a contacts-PATCH re-type and the caseworker conversion now emit
  contact.updated and useContact re-reads on it, so the review closes after
  either when the event arrives; the server-side fence is still owed (stream
  down, or the window before the event lands). Do not change its status.

## PLANNER / RECORD

- R2-2 (LOW, PLAUSIBLE) challenges the W8 record: the live Today drop and
  inbox tag rest on one refetch 300 ms after contact.updated over eventually
  consistent reads (today.ts:362 default GetItem, :892-899 GSI; inbox byPhone
  GSI); a stale answer is never corrected. R2 proposes a second refetch about
  2 s later on contact.updated in useToday and useInbox. The plan's W8 ruled
  "no mechanism change" (plan section 3, design review R2P-4), so the build
  does not override it; PLANNER call, named in the handback with R2's
  proposal (small, dashboard-only).
- R1 RECORD items stand otherwise (ADV-4/W8 above, ADV-5/W7, ADV-6, ADV-8,
  SPEC-F6); ADV-10 moves to FW2-1.
