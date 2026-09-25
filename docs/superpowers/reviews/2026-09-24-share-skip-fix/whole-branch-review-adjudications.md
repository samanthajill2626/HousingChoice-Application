# Whole-branch review - adjudications (share-skip-fix, Branch A, slices 2-6)

Date: 2026-09-25. Build orchestrator. Reviewed HEAD `34dc2bea`. Reviewers:
spec-conformance (`whole-branch-review-conformance.md`: 0 MUST-FIX, 2 SHOULD-FIX,
5 NOTE) and plan-blind adversarial (`whole-branch-review-adversarial.md`: 0
MUST-FIX, 2 SHOULD-FIX, 8 NOTE). All P3 gates green on this HEAD: typecheck 0,
smoke 0, npm test 0 (369/191/21/34/13, 0 dynamoAdmin), e2e 0 (278 passed),
eslint no-new (14 baseline errors on 5 files, baseline-confirmed).

Both reviewers converged. No MUST-FIX. The verdicts below drive ONE fix wave
(one behavior fix + test hardening + comment fixes), two filings/relays, and two
working-as-specified rulings. C = conformance finding, A = adversarial finding.

## Fix wave (one fresh child)

- **BEHAVIOR - C1 / A8b: "Add a tenant" silently discards an already-listed
  flagged tenant, contradicting this branch's own shipped note.** ACCEPT (the one
  user-visible fix). The note ships `Flagged tenants you picked stay checked`, but
  picking a filter-proposed, flagged, unchecked candidate through the combobox
  clears the box and returns the row unchanged (`RecipientPreview.tsx:210-214,
  :233`) - no check, no seed. Both reviewers reproduced it. Fix (the conformance
  reviewer's): in `addTenant`, when the contact is already a row, promote it
  (`seeded: true`, `checked: r.hasConsent`) and persist the seed when it was not
  one; a new test picks a flagged unseeded row and asserts it is checked and stays
  checked through Deselect all -> Select all. In scope: D5/I4 (the seeded-row
  behavior this branch owns). Guard: the `resolvedFor` 1:1 tests and the Select-all
  tests must stay green.
- **TESTS (no behavior change), all folded into the same wave:**
  - C2: `sendMessage.test.ts` I8 - add (a) an opted-out PHONE-MATCHED contact +
    clean `recipient` -> `ContactOptedOutError` (a DNC'd number must still refuse),
    (b) a deleted phone-matched contact + live `recipient` -> resolves. The code is
    correct (both reviewers' probes); a regression of `phoneContact?.sms_opt_out`
    to `contact?.sms_opt_out` would currently ship green.
  - C3: `broadcastFanOut.ts` I1 test - add an unreachable+deleted recipient (stays
    `unreachable`) and a deleted+no-consent recipient (`contact_deleted`, not
    `no_consent`), pinning the fence order beyond the opt-out case.
  - C4: `broadcastFanOut.ts` - a kill-switch case (SMS off) for a dashboard share:
    slot `skipped` / `sms_sending_disabled`, `skipped_other` 1, zero sends, the
    share finalizes `sent` so D6 reads "Not sent".
  - C5 / A (weak D4 pins): set the phone#-keyed dashboard-share test's conversation
    to `manual` and assert the audit `automated: false` (Review Focus 3: it must
    send as a PERSON'S send); adjust the "never breaker-metered" title, or add a
    `sendMessage` assertion that a person's send never calls
    `incrementAutomatedSendCount`. (The harness counter is a constant, so the
    breaker cannot be observed in the fan-out fixture - a fixture limit, not a
    defect; the e2e proves delivery into a switched-off conversation.)
  - A6: the finalize-log test - seed persisted stats that DISAGREE with the derived
    map (e.g. a stale `skipped_opted_out`) and assert the logged value is the
    DERIVED one; today both are 1, so a revert to `finalItem.stats.*` survives.
  - A8c: `broadcastApi.test.ts:387` - sum all buckets incl. `sending` and
    `skipped_other` (it passes today only because its fixture has neither).
- **COMMENTS (ASCII), same wave:**
  - C7 / A7: `dashboard/src/api/types.ts` `BroadcastRecipient.errorCode` doc (and
    the app twin in `broadcastsRepo.ts`) - it now carries skip reasons too, not just
    a Twilio failure class.
  - A7 (the snapshot): one line in the I8 comment - the deleted/consent gates judge
    the fan-out's snapshot (redundant with the fan-out's own fence).

## Filed / relayed (out of scope for Branch A)

- **A1 - "Sent to N tenants" on the property Activity card / landlord timeline
  counts skipped + failed recipients (`tenantCount` = recipients-map size).** OUT
  OF SCOPE: the property activity count and the listing-send ledger are explicit
  Branch B non-goals (spec section 2; confirmed in the B stub
  `2026-09-25-share-sent-outcome-design.md:47-51, :87`). The backend research
  reader flagged it there too. NO on-branch fix; named in the handback and already
  tracked by Branch B.
- **A5 / C6 - skip-reason codes are bare strings in three places (fan-out literals,
  repo bucket predicates, dashboard reason map) with no drift guard; a rename
  files opt-outs under `skipped_other` and renders `Not sent (code)`.** FILE as a
  low debt issue (`broadcast-skip-code-drift-guard`): a `BroadcastSkipCode` union
  used by every `recordRecipient({status:'skipped'})` and the predicates, plus a
  typed dashboard mirror. Deferred, not built here: `errorCode` is deliberately
  `string` and SOR/RSW ADD codes to these same sites - a union now would collide
  with their merges; do it when they land.
- **A4 - a person-sent share that fails 30003 into a switched-off thread gets an
  automated retry (refused `manual_mode`) and shows "Phone unreachable - will
  retry".** RSW's (it owns all 30003 wording and the retry window). RELAY in the
  handback; no change here.
- **C6 / A5 (merge-point) - any NEW app code on a FAILED share slot (SOR's
  `send_unconfirmed`, an RSW code) must get its own arm in `shareRecipientReason`,
  or it falls through to `deliveryReason`, whose internal map holds a whole-group
  sentence for `contact_opted_out`.** Today no failed share slot carries such a
  code, so D7's "no whole-group sentence on a share row" holds by absence. RELAY to
  SOR/RSW in the handback.

## Working as specified (recorded, no change)

- **A2 - a share whose slots are skipped + failed (nothing delivered, not
  all-failed) reads "Sent" in the positive tone.** This is the INTERIM D6 scope, on
  purpose: D6 relabels an ALL-SKIPPED share only; a share that finalizes `sent`
  (not all failed) keeps "Sent"; `broadcastFormat.test.ts:181` PINS this intended
  behavior. Spec R5-3 explicitly REJECTED widening D6 to failed closes ("Branch B
  derives labels from every outcome; A stays minimal"), and spec section 8 keeps
  the all-failed exclusion unchanged. The plan-blind reviewer could not see that;
  the reading is upheld against the spec. Branch B replaces it.
- **A3 - a draft created BEFORE this deploy sends as automated (the marker is
  stamped at creation, not send).** BY DESIGN: D4 records "person's share" at
  creation ONCE, and states a pre-2026-09-25 draft "is automated, exactly as
  today"; stamping at send would wrongly turn an engine-composed draft a person
  reviews into a person's send (D4: "the creator decides, not the person who
  presses Send"). Bounded, and now moot in prod: Cameron's bulk enable already
  switched the 634 one-to-one conversations on, so a pre-deploy draft sent
  post-merge lands on an `auto` conversation. Named in the handback; no code or
  RUNBOOK change.
- **A8a - an unreachable + deleted recipient is reported "unreachable", not
  "deleted".** The fence order (opt-out, unreachable, deleted, consent) matches the
  plan; both land in `skipped_other`; only the displayed reason differs and both
  are honest. Left as shipped; C3 above pins the order in a test.
- **A8d - the one-to-one default is " <link>" (leading space) on a property with
  no address.** Cosmetic, operator sees it before sending, and an available listed
  unit carries an address. Noted; no fix.
- **C5 (ii) / A NOTE - the "never breaker-metered" pin cannot fail in the harness
  (its counter is a constant).** A fixture limit, not a defect; C5 above strengthens
  the assertion that survives. The e2e proves delivery into a switched-off
  conversation end to end.

## Rejected

None.
