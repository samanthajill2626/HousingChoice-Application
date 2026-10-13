# S2 research - findings (live-tree verification of plan slice S2)

Kind: FINDINGS. Byte-exact quotations, the anchor table and the full caller
and implementer lists are in the gitignored reference
`.superpowers/sdd/research-S2-reference.md`.

Tree: `W:\tmp\primary-contact-integrity`, branch
`feat/primary-contact-integrity`, tip 14c2856b; the code tree is
byte-identical to the plan base 0e565b86. Plan read: lines 1-360, the rulings
file, and slice S2 (plan lines 3588-11166, tasks S2.1-S2.14) in full, plus the
S1 text S2 builds on (S1.1, S1.3, S1.4). Reader: read-only; no test, gate or
repo write was run.

## Verdict

- Anchor mismatches: 0. All 53 `old_string` anchors and all 11
  marker-region replacements in S2 were checked by script, not by eye. The 40
  that anchor on today's files occur exactly once in their target file. The
  13 that anchor on text an earlier task writes (S1.4 Edit B; S2.2a; S2.4a,
  S2.4c, S2.4e; S2.6a, S2.6c; S2.7c; S2.8e) were verified by applying S1.4
  and every S2 edit in plan order in memory: each anchor is unique in its
  file at its turn. After the chain, `routes/units.ts` holds no bare
  `autoRoutingEligible` and no `soleLandlordToPromote`, the R16 line occurs
  exactly twice, and the final propertyContact import is the line S3.5 3a
  expects. Every test file, test title, helper, function, error class and
  import S2 names exists as quoted; none of the 12 new test files, the new
  service, or the new symbol names exists yet.
- Mid-S2 500 windows: exactly the two the plan names. See F5 for a third,
  benign split that produces no error.
- Cycle (ruling R3): safe from the unitsRepo side. unitsRepo.ts reads only
  `LISTING_STATUSES` and `SHAREABLE` at load time (`app/src/repos/unitsRepo.ts:53`,
  `:56`), and both come from `lib/statusModel.ts`, which imports nothing.
  S2's new value imports (`applyPrimary`, `chooseHeir`, `rosterContactIds`,
  `isContactDeleted`) are used only inside function bodies. contactsRepo.ts
  does not import unitsRepo, so S2 adds no second cycle. The runtime cycle
  starts at S2.5; S2.2's import is type-only and is erased.
- Writer sweep: every writer of the primary flag, the scalar, `landlordId`
  or the roster is in spec 9.1 or plan 3.1. The sweep covered app/src,
  app/test, app/scripts, the seeds, the importer, the dev seams and e2e.
  There is no uncovered writer.
- Nothing below blocks S2. F1 is LOW-MEDIUM; the rest are LOW, INFO or nits.

## Findings

F1 (LOW-MEDIUM, uncovered docs). Four OPEN issues are resolved, or
contradicted, by S2, and no task updates them. Neither the spec (section 12)
nor the plan names any of the four slugs. The slice map gives `docs/issues/`
to S5, but S5's tasks touch only `tour-reminder-zero-primary-e2e-gap` and
`relay-provision-includes-deleted-contacts`.

- `docs/issues/unit-primary-contact-unchecked.md` (status: open). Its first
  "suggested fix" is "stop accepting it on the unit create / PATCH body". That
  is exactly S2.1 (P2b). S2.13 also fixes the stale comment it cites,
  `app/src/repos/conversationsRepo.ts:207`. Once S2 lands this issue is
  resolved, and its refs (`lib/unitFields.ts:104`, `conversationsRepo.ts:207`)
  go stale.
- `docs/issues/restore-without-landlord-can-leave-nobody-reachable.md`
  (open).
  - Shape 1 (no row flagged, so the restore never counted as clearing the
    primary) is the decision `landlordWasPrimary` makes: no flag means
    hand-off (S2.7e, S2.8b).
  - Shape 2 changes. Two or more eligible contacts now promote the
    earliest-added one. Zero eligible still promotes nobody, and S4's
    property box then shows it after the S4.10 refetch.
  - Refs `app/src/routes/units.ts:445`, `app/src/repos/unitsRepo.ts:1292` and
    `app/test/helpers/twilioWebhookHarness.ts:3145` go stale.
- `docs/issues/auto-routing-changes-not-named.md` (open). Its premise
  changes:
  - The restore now promotes the earliest-added eligible contact, not "the
    one remaining".
  - Auto-primary now also fires on an edit of the contact's own row.
  - Every automatic change now appends `unit_primary_contact_assigned`.

  S1's P1 resolves its "Related" paragraph ("the resolvers do not filter
  soft-deleted contacts"). Refs `units.ts:1845` and `unitsRepo.ts:1347` go
  stale.
- `docs/issues/contact-list-rule-duplication-and-fake-drift.md` (open).
  Partly resolved:
  - "The cleared landlord was the primary" becomes ONE shared rule,
    `landlordWasPrimary`.
  - The fake's primary decisions call the shared pure functions
    (`decideAutoPrimary`, `chooseHeir`, `applyPrimary`).
  - `removeContact`'s eventually consistent reads become consistent (S2.5).

  Still open: the seat and claim duplication, and the live-object `getById`.
  Its refs `units.ts:467` and `unitsRepo.ts:1060`, `:1111`, `:1312` go stale.

Suggested: give S5's docs task (or a closing S2 step) one RESOLVED or UPDATE
block per issue, per AGENTS.md "Issue, TODO, and known-problem tracking".

F2 (LOW, slice-gate coverage). S2.7 step 1(c) creates
`app/test/landlordWasPrimary.test.ts`, but the file is missing from three
places:
- S2.7's "Files:" header (plan :7285-7289). Its own commit command at :8282
  does add it.
- S2.14 step 3's vitest list (:11121).
- S2.14 step 5's eslint list (:11143).

The step 5 list also omits the eight existing test files that S2 edits:
- `app/test/unitFields.test.ts`
- `app/test/unitsApi.test.ts`
- `app/test/unitsRepoAutoPrimary.integration.test.ts`
- `app/test/unitsApiRosterAutoPrimary.test.ts`
- `app/test/unitsApiRoster.test.ts`
- `app/test/unitsRepoRoster.integration.test.ts`
- `app/test/unitsRepoRestoreWithLandlord.integration.test.ts`
- `app/test/unitsRestoreLandlord.test.ts`

Step 4 (the whole app workspace) still runs the new test, and gate 5 at the
end of S5 (`main...HEAD`) lints every touched file. The gap is therefore only
at the slice boundary. Add the missing paths to both lists.

F3 (LOW, test titles and comments that will mislead). Three kept no-flag pins
stay green after S2.7 and S2.8 because NO row is flagged
(`landlordWasPrimary`). They are named, and commented, for the scalar, which
S2 stops reading:
- `app/test/unitsRepoRestoreWithLandlord.integration.test.ts:154`, "moves the
  primary to the new landlord when only the primary_contact scalar named the
  old one", with its comment at `:150-153`;
- the same file, `:248`, "without a landlord: promotes when only the
  primary_contact scalar named the cleared landlord", whose block comment at
  `:209-217` says "its row flagged, or the scalar naming it";
- `app/test/unitsRestoreLandlord.test.ts:386`, "promoted too when only the
  primary_contact scalar named the cleared landlord".

The plan says "their scalar no longer matters" (:7963-7968) but leaves the
titles and comments. A reader of a failure would chase the scalar. Retitle
them ("... when no row is flagged ...") or add one comment line each, in
S2.7 and S2.8.

F4 (LOW, comment accuracy; extends S1-findings F2 from the S2 side). After
S1, the property contact is the LIVE flagged primary, else the LIVE landlord
of record, through `lib/propertyContact.ts`. These unitsRepo.ts comments,
all in S2's file, still describe the old ladder, "the row marked primary,
else the landlordId", with no skip of a deleted or missing contact:
- the `UnitContact` docblock, `app/src/repos/unitsRepo.ts:58-70`;
- the `primary_contact` docblock, `:336-348`. It also names the three
  resolver files and says only `addContact` keeps the scalar consistent; S2
  adds `removeContact`, `restoreWithLandlord` and `handOffPrimaryFrom`;
- S2.3's NEW text repeats the same wording, in the interface docblock part
  (b) (plan :4892-4897) and in the write-region comment (plan :5042-5049).

No behavior impact. Fold in "live" while S2.3 rewrites these lines.

F5 (INFO, a third transitional split; it confirms the plan's two windows).
Between S2.7 and S2.8 the CLEAR branch is decided by two different rules.
The route still runs `main`'s `soleLandlordToPromote`, which asks whether the
row is flagged OR the scalar names the landlord (`units.ts:467-468`). The
repo already uses `landlordWasPrimary`, which asks whether the row is flagged
OR no row is flagged.
- No row flagged, and the scalar does not name the old landlord: the route
  sends `promote: null`, and the repo clears (nothing is flagged) and REMOVEs
  the scalar.
- A stale scalar while another row is flagged: the repo ignores the route's
  promote and keeps the flagged row.

Neither case throws, and neither changes who the property contact is. Both
go away at S2.8. Apart from that, the only real callers are
`removeContact` (`units.ts:1323`) and `restoreWithLandlord`
(`units.ts:1850-1856`); neither route catches `RosterReadFailedError` before
S2.6 or S2.8, and Express turns the throw into a 500. So the two 500 windows
the plan names are the only ones. The FakeWorld keeps `main`'s rules until
the matching fake edit, which is why the route tests do not see them.

F6 (INFO, mislabeled sweep). The S2 watch items (plan :3742-3745) and the
S2.11 step 4 text (:10684-10685) call
`app/test/contactsCrud.test.ts` an existing contact-delete suite. That file
has no `.delete(` call. The suites that do call
`DELETE /api/contacts/:id` are:
- `contactSoftDelete.test.ts`
- `contactEmailReaders.test.ts`
- `voiceInboxActivity.test.ts`

`contactPhones.test.ts` and `contactsEmailCrud.test.ts` delete only phone and
email sub-resources. None of these seeds a unit, so the conclusion ("nothing
breaks") stands.

F7 (INFO, ordering option). S2.11 inserts the hand-off right after the
`contact_deleted` audit (`app/src/routes/contacts.ts:2262-2265`). That puts a
full consistent units Scan, plus a write for each target unit, in front of
the unread-reset fan-out (`:2329-2344`) and the presence fan-out
(`:2353-2357`). Every contact delete pays this, tenants included, and it
delays those SSE refreshes by the Scan time. This conforms to spec 4.6
("after the delete is saved"). The hand-off emits no events, so the
documented order ("authoritative emits LAST", `:2279-2297`) also holds if it
moves to just before the final emit loop (`:2360-2362`). This is a latency
choice, not a defect; it is the same watch item as the plan's
roster-paging note.

F8 (nit, marker precision). Five region descriptions say the closing line is
"the line before" the next marker, but a blank separator line sits in
between:
- S2.3d: `unitsRepo.ts:1054`, with the marker at `:1056`;
- S2.5c: `:1132` / `:1134`;
- S2.4d: `units.ts:1312` / `:1314`;
- S2.6b: `:1347` / `:1349`;
- the S2.5b test region: `unitsRepoRoster.integration.test.ts:317` / `:319`.

Selecting through the named closing line keeps the blank separator. A
selection that took the blank line too would drop it, which is cosmetic
only.
