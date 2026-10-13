# Planner final review - adjudications (2026-10-13)

Branch `fix/caseworker-integrity`, reviewed at 63b66bc1 (product tip 5ffcb6c6,
main @5c0d3f6a merged in). Cameron delegated every remaining decision to the
planner overnight (2026-10-12 ~21:50: "make all decisions and get this merge
ready when I get up in the morning"); each ruling below is the planner's and
is listed in the morning verdict so he can reverse any of them.

Reviewers (independent of the build, both opus, read-only, run beside the
planner's gate run):
- spec conformance: `conformance.md` - CONFORMS 100 / DEVIATES 2 / MISSING 0,
  no BLOCKING/HIGH/MEDIUM.
- adversarial, PLAN-BLIND (diff + repo + charter; no spec, plan, records,
  issues or RUNBOOK): `adversarial.md` - 0 BLOCKING, 0 HIGH, 2 MEDIUM, 7 LOW.

Planner gates on 63b66bc1 (bare, from the worktree): typecheck exit 0;
`npm test` exit 0 (app 459 files 9530 passed + 1 skipped, dashboard 237/4476,
e2e-ws 22/503, fake-twilio 34/275, fake-twilio-web 13/111, no `[dynamoAdmin]`);
smoke exit 0; lint gate 5 over 95 files exit 1 with exactly the two baseline
errors (ScheduleTourForm.tsx:242 set-state-in-effect, TourDetail.tsx:342
purity - at the merge base :241 / :341, attributed by baseline); e2e exit 0,
"346 passed (25.5m)" (run after waiting for TIME_WAIT sockets to drain below
400). All five green on 63b66bc1 before the fix wave below.

## Rulings

| # | Finding | Ruling | Action |
|---|---|---|---|
| A1 | MED - re-running the importer re-adds a landlord that "Restore without a landlord" removed: the human-owned branch writes `landlordId = if_not_exists(...)` from the import plan's name match, never the contact's stored type (`app/src/lib/import/apply.ts:1510-1552`) | DEFER (verified) | The importer is out of scope by the approved spec (non-goals; filed `import-bypasses-contact-type-rules`). The interaction is new in kind because this branch makes a live ownerless property a deliberate state. Appended to that issue as the FIRST item to fix before the next `import:apply` run, with the reviewer's two fix options; named in the verdict. |
| A2 | MED - the restore dialog's explicit landlord choice is dropped with a 200 when the plain path applies (another staff restored it meanwhile, or the stored landlord became a landlord again); a second `unit_restored` audit is written (`app/src/routes/units.ts:1723-1764`) | ACCEPT - FIX | A body is sent only after a 409 `restore_needs_landlord`; one arriving when the plain path would apply means the state changed under the dialog. Answer 409 `unit_roster_conflict` and write nothing (no restore, no audit); the dialog's conflict path re-reads and, when the property is no longer deleted, closes and shows the page's real state. Spec precision (revision 6): replaces "a body is ignored when the stored landlord is still valid". The pinned test flips. |
| A3 | LOW - typed contact-list refusals (`contact_list_caseworker`, `landlord_not_landlord`) skip the re-read the 409 path does, in exactly the race where the card is stale (`ListingDetail.tsx:443-447`) | ACCEPT - FIX | After a typed refusal, run the same best-effort `getUnit` + `applyRosterUnit` settle. |
| A4 | LOW - auto-primary on add does not exclude a soft-deleted contact or a routing pointer, while the restore promotion does (`units.ts:452-462` vs `:1230`) | ACCEPT - FIX | One shared route-side predicate for automatic routing (typed landlord, not soft-deleted, not a routing pointer), passed to `addContact` as an `autoPrimaryEligible` fact and used by the restore promotion; `landlordTyped` stays for the I3 claim check. Real repo + every fake. |
| A5 | LOW - the housing-authority "close name" path writes via a plain contacts PATCH; a review dialog left open across a conversion can still write the authority onto the caseworker (`ContactDetail.tsx:820-844`, `haReview` reset only on contact id) | ACCEPT (client) + DEFER (server) | Client: close the review when the contact stops being a tenant. Server fence (refuse tenant-only fields on a non-tenant in the contacts PATCH, or fence the write on the revision the page read) is a contacts-PATCH contract change - filed `ha-review-close-name-patch-unfenced` (low). |
| A6 | LOW - an API-only PATCH of `landlordId` leaves the old landlord's contact-list row and primary behind | DEFER (already recorded) | Pre-existing, no dashboard sender; recorded in `landlord-of-record-no-reassign-ui` (the row-swap sentence). The reviewer's point that the new I3 check makes the path look validated is added there. |
| A7 | LOW - duplicated rules / hand-copied fakes can drift; FakeWorld `getById` returns the live object (a mutation-in-place race test would pass vacuously); `addContact`'s per-attempt read is eventually consistent | ACCEPT (read) + DEFER (refactor) | Make `addContact`'s per-attempt unit read consistent (the refusals it throws are then decided on a fresh read). The shared-helper refactor and the FakeWorld clone change touch many tests - filed `contact-list-rule-duplication-and-fake-drift` (low). |
| A8 | LOW - automatic routing changes (the restore's sole-landlord promotion, auto-primary on add) are not named before the write | DEFER | UX polish on rules Cameron asked for; the Contacts card shows the new primary afterward. Filed `auto-routing-changes-not-named` (low). |
| A9 | LOW (inherited) - re-sending an accept refused by reclassification answers 200 because the completed journal keeps no outcome | DEFER (accepted residual) | Pre-existing for `suggestion_field_edited`; spec D1.5 scopes the specific answer to the uninterrupted request; the dashboard does not auto-retry. Filed `suggestion-refusal-replay-answers-200` (low) unless an existing issue already covers it. |
| C1 | LOW - the plain restore write is not conditioned on the landlordId it read (spec "Each write conditions on the landlordId it read") | ACCEPT as ruled (S4-2) | Spec precision (revision 6): the plain restore is today's unconditioned write; only `restoreWithLandlord` conditions; the residual is the L1 window. |
| C2 | LOW - the `contact_not_tenant` copy is the ruled phrase form ("a landlord", "not classified yet", fallback "not a tenant"), not the spec's literal label form | ACCEPT as ruled (P-1) | Spec precision (revision 6): fold the phrase table into section 4. |
| C3-C8 | INFO | noted | No action (C8's terminal-exit read is documented in RUNBOOK and filed). |

Fix wave: A2, A3, A4, A5 (client), A7 (consistent read) + spec revision 6
(A2, C1, C2) + issue updates (A1, A5, A6, A7, A8, A9). Dispatched through the
build orchestrator (fresh foreground child), then the planner re-runs every
gate on the new tip.

## Round 2 (re-review of the FWF fix wave, 1358fb42)

Both reviewers were continued with the re-review charge. Adversarial: 1
MEDIUM, 4 LOW; conceded A1, A5-server, A6, A7-refactor, A8, A9 as
non-blocking. Conformance: re-walked items CONFORMS 33 / DEVIATES 2 /
MISSING 0; C1, C2 closed; A3-A9 not contested.

| # | Finding | Ruling | Action |
|---|---|---|---|
| R2-1 / R2-F3 | MED - FWF-1 introduced a dialog loop: a late body answers 409 `unit_roster_conflict`; when the re-read shows the property STILL deleted (its landlord is a landlord again, or it is ownerless), the dialog stays open saying "try that change again" and every retry gets the same 409 | ACCEPT - FIX (planner's own regression) | Distinct 409 `restore_landlord_not_needed` (still writes nothing) for "a body arrived but the plain restore applies"; `unit_roster_conflict` keeps meaning "the list or landlord changed, retry". Dashboard: on `restore_landlord_not_needed` the dialog closes, the page re-reads, and when the property is still deleted the page says "This property's landlord changed while you were choosing. Choose Restore again." The plain restore is NOT re-run automatically (it would silently override the staff member's explicit choice - the A2 complaint). Tests: still-deleted and live re-reads. |
| R2-4 / R2-F6 | LOW - addContact's conflict re-read (`unitsRepo.ts:1018`) is still eventually consistent and throws from it | ACCEPT - FIX | Make that re-read consistent. removeContact's reads are pre-existing and untouched by this branch: noted in `contact-list-rule-duplication-and-fake-drift`. |
| R2-2 | LOW - the HA-review close fires only on `suggestion.updated`; a plain re-type usually emits none, so the review can stay open | ACCEPT (comment + issue) | Make the comment state the real trigger (the conversion path); add the plain re-type case to `ha-review-close-name-patch-unfenced`, which carries the server-side fence that closes it fully. |
| R2-F5 | INFO - the FWF-2 comment overstates when typed refusals arrive | ACCEPT | Comment fix. |
| R2-F1, R2-F2 | LOW - spec rev 6 text: a `{ landlordId: <id> }` restore retries a contacts-only race (only `null` refuses it); section 8 still says "a body ignored when not needed"; "the only Restore button" (there are three entry points on one `onRestore`) | ACCEPT | Spec revision 7 precision. |
| R2-F4 | LOW - the A1 gate ("fix before the next import:apply run") lives only in the issue; the RUNBOOK import procedure does not mention it | ACCEPT | One operational caution line in the RUNBOOK `import:apply` procedure pointing at the issue. |
| R2-3 / R2-F7 | LOW - the I3 claim is type-only, so an API caller can make a soft-deleted landlord-typed contact the landlord of record of an ownerless property, and the resolvers fall back to it (they never filter deleted contacts) | DEFER | Pre-existing resolver behavior (any soft-deleted landlord of record routes today); API-only (the picker lists live contacts). Appended to `auto-routing-changes-not-named` as "the resolvers do not filter soft-deleted contacts; the I3 claim is type-only". |
| R2-5 | LOW - the type-change landlord sentence says "must stay a landlord" to a legacy landlord of record that is not typed landlord | DEFER | Appended to `contact-type-refusal-copy-edge-cases`. |
| R2-F8 | INFO | noted | No action. |

Micro-wave FWF2: R2-1, R2-4, R2-2 (comment + issue), R2-F5, spec rev 7
(R2-F1, R2-F2), RUNBOOK caution (R2-F4), issue appends (R2-3, R2-5).
