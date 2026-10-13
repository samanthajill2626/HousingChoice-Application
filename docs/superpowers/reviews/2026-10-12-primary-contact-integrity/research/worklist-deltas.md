# Build research - adjudicated deltas folded into the slices

Date: 2026-10-13. Orchestrator adjudication of the four read-only research
readers (S1, S2, S3+S5app, S4+S5e2e), run against tip 14c2856b. The code tree
(app, dashboard, e2e) is byte-identical to the plan's base 0e565b86 and to
`main` (which is two docs-only commits ahead), so this pass verified the plan's
anchors and swept the invariant surfaces rather than hunting drift.

Result: ZERO anchor mismatches across all five slices (S1: 26 anchors; S2: 53
anchors + 11 marker regions, chain-applied in memory in plan order; S3 +
S5.1-5.5: every anchor, one exactly-twice `res.json` line as intended; S4 +
S5.6-5.12: 93 anchors chain-applied). No writer or reader of the primary flag,
the `primary_contact` scalar, `landlordId` or the roster exists outside spec
9.1 / 9.2 and the plan's 3.1 matrix. The `propertyContact <-> unitsRepo`
runtime cycle (ruling R3) is safe on both sides as long as S2 adds no
top-level reads. Findings per reader: `S1-findings.md`, `S2-findings.md`,
`S3-S5app-findings.md`, `S4-S5e2e-findings.md` in this folder.

Everything below is ADDED to the named slice. Nothing in the plan is removed
or changed, except the two spec amendments that record rulings the plan
already carries (R17, R23). Each slice brief points here.

## S1 additions

- S1.6: the `memberFromContact` docblock says "soft-deleted or record-less
  (missing)", not only soft-deleted (S1-F6); refresh the `RosterResolutionDeps`
  docblock (`rosterResolution.ts` around :144-154) where it describes the
  contact read (S3-F8).
- Informational, no change: `routes/tourReminders.ts` also calls
  `resolveTourContactNames` with no unit (around :963) and `composeInputsOf`
  has three call sites (S1-F4) - the new `propertyContact?` field is present
  only when a unit was passed. The readers outside spec 9.2's list
  (`relayFanOut.ts resolveMemberRole`, `contactHoldings.ts:107`,
  `caseworkerConversion.ts:229-236`, dashboard `buildContactFile.ts`,
  `useContactFile.ts`, `useListing.ts:119-127,185`) read the landlord of
  RECORD or label roles: unchanged, confirmed. Ruling R15's "exactly one
  `getManyByIds` call" tolerates zero calls on an empty id list (S1-F8).

## S2 additions

- S2.7: `app/test/landlordWasPrimary.test.ts` belongs to the slice's vitest
  and eslint lists; run it in the S2.14 gate (S2-F2).
- S2.7 / S2.8: retitle and recomment the three kept no-flag pins that still
  speak of the scalar (`unitsRepoRestoreWithLandlord.int.test.ts` around :154
  and :248, comments :150-153 and :209-217; `unitsRestoreLandlord.test.ts`
  around :386) so they say they pass because no row is flagged (S2-F3).
- S2.13 widens to the `unitsRepo.ts` docblocks around :58-70 and :336-348
  (the `primary_contact` docblock names the three old resolver files and
  describes "row marked primary, else landlordId" without the skip for
  deleted contacts) and to S2.3's own new comment text (S1-F2, S2-F4).
- Informational: a third split S2.7->S2.8 is benign (no 500) (S2-F5); S2.11
  runs the hand-off Scan before the unread-reset and presence fan-outs -
  spec-conformant, keep (S2-F7); `contactsCrud.test.ts` has no DELETE call
  (S2-F6).

## S3 additions

- None to code. Accepted as the plan governs, noted for the handback: the
  intro job's INFO line is emitted when the intro is composed (the dev
  intro-replay endpoint emits it too), which the spec's "when it sends"
  wording loosely describes (S3-F7). `contactTimeline.ts` keeps a fixed
  event-type list, so `unit_primary_contact_assigned` never appears on a
  landlord's timeline - the spec places it on the property's Activity tab
  only (S3-F6).

## S4 additions

- S4.1: fix the stale comment at `dashboard/src/api/types.ts` around :1103
  ("the property's primary contact + the tenant") (S4-F7).
- S4.2: update the comment at `RosterConfirmDialog.test.tsx` around :397-398
  that calls the duplicate warning the dialog's only `role="status"` (S4-F2).
- S4.9: retitle / recomment `ListingDetail.test.tsx` around :1348-1353 ("sole
  landlord-typed") to the earliest-added eligible rule (S4-F6).
- S4 also owns the `dashboard/src/api/endpoints.ts` docblocks for `getUnit`,
  `restoreUnit` (around :1037-1043), `addUnitContact` (:1072-1088) and
  `removeUnitContact` (:1100-1107): describe the shipped rules and the new
  409 `primary_contact_deleted` / 503 `roster_read_failed` answers (S3-F5,
  S4-F1).
- S4.10b: the plan's code blocks carry a 3-space list indent in the raw
  markdown - strip it before using them as edit strings; the "delete the
  blank line too" step needs an old_string ending in two newlines (S4-F11).
- Gate-5 baseline: `TourDetail.tsx:342:85` `react-hooks/purity` is
  PRE-EXISTING and stays (name it in the gate record);
  `RosterConfirmDialog.tsx:113:5` `react-hooks/set-state-in-effect` is
  removed by S4.3 (S4-F8).

## S5 additions

- S5.5: [WRONG - corrected 2026-10-13 after S5a] this delta claimed the RED
  step answers 403 because an unmatched `/__dev` path falls through to
  `originSecret`; `originSecret.ts:45` exempts the whole `/__dev/` prefix, so
  the tree answers the plan's original 404. The S5a implementer trusted the
  tree (S5a-report.md D1). Reader finding S3-F2 is withdrawn.
- S5.1-S5.3: `consistentRead` is typed on `list`'s own parameter, as S2
  ships it (S3-F1) - use the shipped signature.
- S5.3 / S5.4: add ONE DynamoDB-Local test that runs the script's real wiring
  (`buildAssignDeps` and `main`'s default `run`) on the
  `cleanOrgNames.test.ts:309` pattern - the script is a prod post-merge
  operation and must not be proven only through injected fakes (S3-F3).
- S5.7: `property-roster.spec.ts` comments around :4-6, :17-18 and :243 drop
  the masked-call framing (S4-F5).
- S5.8: `selectors.md` restore-dialog row (around :138) gains the 503 sentence
  (S4-F3); `e2e/scenarios/steps.ts` around :38-41 no longer claims
  `tourContacts` value-imports `unitContacts` directly (S1-F1).
- S5.9: `documentation/GLOSSARY.md` around :262-264 ("who we put on threads
  and dial") contradicts the new entry - rewrite it with the entry (S4-F4).
- S5.11 widens to RESOLVED / UPDATE blocks on four open issues S2 resolves or
  contradicts: `unit-primary-contact-unchecked`,
  `restore-without-landlord-can-leave-nobody-reachable`,
  `auto-routing-changes-not-named`,
  `contact-list-rule-duplication-and-fake-drift` (S2-F1); and
  `lint-backlog-repo-wide.md`: the `set-state-in-effect` error at
  `RosterConfirmDialog.tsx:113` is gone after S4.3 (22 errors / 17 files)
  (S4-F8). `AGENTS.md`'s dated "23 errors across 18 files" sentence is left
  as a dated statement.
- Spec amendments applied with this record: section 8 narrowed to ruling R17;
  section 10's seam sentence to ruling R23 (S3-F4).
- Informational: S5.6 uses no scenario verbs, matching the existing
  dashboard-next specs (S4-F9); `tour-roster.spec.ts`,
  `roster-quiet-hours.spec.ts` and `scenarios/steps.ts` open undated tours and
  will now show the fallback box ("This tour has no date and time yet.") -
  no selector collision (S3-F9, S4 point 4).
