# share-skip-fix (Branch A) - whole-branch review: SPEC CONFORMANCE (slices 2-6)

Reviewer: spec-conformance reviewer (read-only). Date: 2026-09-25.
Branch `feat/share-skip-fix` @ 34dc2bea, merge base bbaad87d. Scope: plan Tasks
6-14 (commits d9f9925c..34dc2bea) against the spec
`docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (D4-D8, D10,
I1-I4, I8, sections 5, 6 item 3, 7, 8). Slice 1 is out of scope.

Inputs read whole: `.superpowers/review/whole-branch-package.txt`, the spec, plan
Tasks 6-14. Whole-app greps: every reader of `skipped_opted_out` /
`skipped_no_consent` / `skipped_other`, every builder of an "already sent" set,
every share-label reader, every `status: 'skipped'` writer, every
`broadcasts.create` caller.

Runs (single files only; the lane-owning `npm run e2e` was never touched):
- `app/test/broadcastsRepo.integration.test.ts` - 21/21 pass (incl. the D5 union
  case and the D7 absent-nested-counter `ADD` case against DynamoDB Local).
- `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx` 36/36,
  `broadcastFormat.test.ts` 18/18, `StatChips.test.tsx` 14/14 - pass.
- Three THROWAWAY probes, each run alone and DELETED (results cited below as
  "probe"): `app/test/zz-conf-i8.test.ts` (5/5 pass),
  `app/test/zz-conf-fanout.test.ts` (3/4 pass; the 4th was an invalid control -
  see finding 5), `dashboard/src/routes/broadcasts/zz-conf-pick.test.tsx`
  (observational). `git status` clean afterwards for this reviewer's files.

## Verdict table

| # | Work-map item | Verdict | Evidence (file:line) |
|---|---|---|---|
| 1 | D4 / I2: dashboard share = person's send (automated false; switch + breaker off); every other share automated | CONFORMS | routes/broadcasts.ts:454 (hard-coded, not from the body; the only `broadcasts.create` caller in app/src); broadcastsRepo.ts:155, 331, 538; broadcastFanOut.ts:463-468; sendMessage.ts:364 (manual + breaker only when automated); harness mirror twilioWebhookHarness.ts:2896. Tests: broadcastApi.test.ts:164; broadcastFanOut.test.ts:345, 421 |
| 2 | I1: kill switch, opt-out, deleted, consent refuse every share | CONFORMS (kill-switch half untested - finding 4) | sendMessage.ts:296-298 (kill switch before any automated check), 317-360; broadcastFanOut.ts:395-448. Probe: dashboard share under SMS_SENDING_ENABLED=false -> `skipped` / `sms_sending_disabled`, persisted and derived `skipped_other` 1, no send |
| 3 | I8: wrapper judges the FENCED recipient for deleted + consent, no second read; opt-out on either flag; deleted fence after opt-out/unreachable, before consent; phone#-keyed recipient still sends | CONFORMS (tests pin only part - findings 2, 3, 5) | sendMessage.ts:250 (`recipient?: ContactItem`), 317-334 (`findByPhone` kept for the either-flag opt-out), 320 (`contact = recipient ?? phoneContact`), 340-343, 354; broadcastFanOut.ts:395-414 (opt-out, unreachable), 421-431 (deleted), 438-448 (consent), 471 (`recipient: contact` for every key), 692-700 (phone# keys resolve via findByPhone). Tests: sendMessage.test.ts:662; broadcastFanOut.test.ts:368, 389, 405. Probes: phone-matched opted-out duplicate + clean recipient -> ContactOptedOutError; deleted duplicate + live recipient -> passes every gate; phone#-keyed recipient into a MANUAL conversation -> sent |
| 4 | D5 / I3 rule: union of non-skipped keys across sent/sending shares; `failed` still counts; one set feeds both readers | CONFORMS | broadcastsRepo.ts:566-601 (skip at :590; status gate unchanged); routes/broadcasts.ts:521-524 (one call), 547-549 (per-candidate flag), 569 (hand-add annotation); harness double mirrors (twilioWebhookHarness.ts priorRecipientContactIds). Only builder of the set in app/ and dashboard/ (grep). Tests: broadcastsRepo.integration.test.ts:359 (c-both union, code-less legacy skip excluded, draft excluded); broadcastApi.test.ts:1196 |
| 5 | D5 / I4 review list: seeded row (preview seed OR in-session hand-add) starts checked when flagged and survives Select all; unseeded flagged starts unchecked, Select all skips it; no-consent never checkable | PARTIAL | RecipientPreview.tsx:53, 87, 91, 167, 227-229 (new-row hand-add), 157 (toggle fence), 204-209 (no-consent hand-add refused). GAP: 210-214 + 233 - picking a tenant ALREADY in the list via "Add a tenant" is discarded (finding 1). Tests: RecipientPreview.test.tsx:218, 290 (+ pre-existing :513) |
| 6 | D5 note copy exactly `Flagged tenants you picked stay checked; "Select all" skips the others.` | CONFORMS | RecipientPreview.tsx:353 (`&quot;` renders ASCII 0x22); test RecipientPreview.test.tsx:248; e2e share-skip-fix.spec.ts NOTE const |
| 7 | D7: every skipped recipient carries a reason (first fence opted_out / unreachable; refusal code otherwise) | CONFORMS | broadcastFanOut.ts:396, 406, 422, 439, 546 - the only five `status: 'skipped'` writers in app/src; every SendRefusedError has a non-empty literal code (sendMessage.ts:53-77) |
| 8 | D7: reason sentences BYTE-FOR-BYTE with the table; skipped/failed rows render them; per-surface (no whole-group sentence on a skipped row) | CONFORMS | deliveryStatus.ts:948-966 (byte-compared with spec lines 250-262: all ASCII, identical; the unreachable apostrophe is 0x27 in both); broadcastFormat.ts:144-152; DeliveryBadge.tsx:36; BroadcastResults.tsx:58-62 passes `errorCode` for every status; broadcastFormat.ts:175-196 keeps it. Tests: broadcastFormat.test.ts:132; StatChips.test.tsx DeliveryBadge cases. Residual hazard on FAILED rows - finding 6 |
| 9 | D7: derived stats AND persisted counters route consent -> no_consent, opt-out/code-less -> opted_out, else -> skipped_other; Skipped chip sums three; finalize log reports derived stats | CONFORMS | broadcastsRepo.ts:204-214 (predicates), 278-282 (derive), 307 (zeroStats); broadcastFanOut.ts:400, 410, 426, 443 (fence bumps), 547-551 (refusal bump via the same predicates), 756-769 (log from `deriveBroadcastStats`); StatChips.tsx:34; dashboard types.ts:2906. Tests: deriveBroadcastStats.test.ts:75; broadcastFanOut.test.ts:302, 321 (log asserts `skipped_other`); integration :147 |
| 10 | D7: 30003 wording and `deliveryReason` options/order untouched | CONFORMS | deliveryStatus.ts diff is one pure insertion (:937-966); INTERNAL_CODE_REASONS :913-935 and deliveryReason :983-1008 byte-unchanged; failed rows call deliveryReason with no options, exactly as the old badge did |
| 11 | D6 / I3: all-skipped finished share reads "Not sent" on results header + list row; presentation only; every other share keeps its label | CONFORMS | broadcastFormat.ts:95-104; BroadcastStatusPill.tsx:26; BroadcastsList.tsx:144; BroadcastResults.tsx:138. The two pill call sites are the only lifecycle-label readers (grep); SSE overlays patch status+stats together from derived stats (useBroadcastsList.ts:114-118, useBroadcastResults.ts:121-128, broadcastFanOut.ts:167-172). No repo/status/GSI/tab change. Tests: broadcastFormat.test.ts:171; StatChips.test.tsx pill case |
| 12 | D8: one-recipient composer pre-fills address + ONE space + flyer link only; blasts keep DEFAULT_SEND_TEMPLATE; resolved placeholder = one-to-one template | CONFORMS | resolveTemplate.ts:40; BroadcastComposer.tsx:195 (resolved-mode effect only; `seedContact` dropped from deps); MessageEditor.tsx:85; filter flip still resets to the blast default (BroadcastComposer.test.tsx resolved-mode describe). Tests: resolveTemplate.test.ts D8 describe, MessageEditor.test.tsx D8 describe; e2e matching-entry-points.spec.ts:138 |
| 13 | Seed (section 5): lean gains exactly one switched-off one-to-one tenant conversation, byte-stable; no other world's behavior changes | CONFORMS | lean.ts:34 (TS0 13:20 < T2 14:05:45), 50-51, 188-198 (camelCase, consent, voucherSize 1), 274-287 (`tenant_1to1`, `ai_mode: 'manual'`, object participants, `unread_count: 0`, import stamp). matrix.ts / performance.ts gain only `created_via: 'dashboard'` (spec section 5: seeded shares a test sends as staff must carry it) and `skipped_other: 0`; cast.ts comment only. Test: seedData.test.ts:89 |
| 14 | D10: the three issues exist with their assigned content | CONFORMS | docs/issues/ai-mode-switch-gates-all-automation.md item 8 (line 66: engine sends use their own path, never the dashboard route); import-conversations-missing-phone-claim.md (missing claim normal, mismatch is the risk); tenant-timeline-property-sent-milestone-after-failed-delivery.md (Branch B decides) |
| 15 | e2e (section 7): all six acceptance items; failed test keeps TWO recipients; `?cta=text` targets | CONFORMS | share-skip-fix.spec.ts:146 (items 1, 3a, 6; switch asserted `manual` first at :154; slot proven to ride conv-0002 at :195); :205 (items 2, 4, 5: header :217, reason :219, list row by href :229, not flagged :236); :240 (item 3b, two recipients :259, reason :266, header Sent :268, flagged :273); `?cta=text` at :136, :168 |
| 16 | Section 6 item 3 merge points left in the promised shape | CONFORMS | sendMessage.ts: one optional input + opt-out condition (other callers unchanged when `recipient` is absent); fan-out: localized fence/send/finalize-log hunks; deliveryReason + INTERNAL_CODE_REASONS untouched; `shareRecipientReason` is the single results-row gate (broadcastFormat.ts:144) over SHARE_SKIP_REASONS beside the internal map; derived buckets extend by one switch arm; `created_via` on BroadcastItem for SOR's adoption. See finding 6 for one hazard SOR/RSW must know |

## Findings

1. SHOULD-FIX - D5 / I4: picking an already-listed flagged tenant through "Add
   a tenant" is silently discarded, contradicting the shipped note.
   Evidence: RecipientPreview.tsx:210 clears the search box BEFORE the dedupe;
   :214 returns `prev` unchanged when the contact is already a row; :233 skips
   seed persistence for it. The search candidates are all tenants
   (RecipientPreview.tsx ContactSearchField `candidates={tenantCandidates}`), so
   a filter-proposed, flagged, unchecked row can be picked. Probe
   (zz-conf-pick): preview with unseeded flagged "Bo Flag", pick Bo via Add a
   tenant -> `afterPick=false afterSelectAll=false seedPatchCalls=0`. Spec D5:
   "a hand-picked tenant is a seed from the moment staff add them in the review
   step, so a flagged one starts CHECKED"; the note now tells staff "Flagged
   tenants you picked stay checked" - here a pick leaves them unchecked and
   "Select all" keeps skipping them.
   Fix: in `addTenant`, when the contact is already a row, promote it
   (`{ ...r, seeded: true, checked: r.hasConsent }`) instead of returning
   `prev`, and persist the seed (append to `seedsRef`, `updateBroadcastSeeds`)
   when it was not already a seed. Add a RecipientPreview test: flagged unseeded
   row, pick it via the search, assert checked and still checked after
   Deselect all -> Select all.

2. SHOULD-FIX - I8 is pinned only on the recipient's side; the phone-matched
   contact's half is unpinned (a TCPA-relevant regression would ship green).
   Evidence: the new wrapper test sendMessage.test.ts:662 covers (a) recipient
   consent beats a no-consent phone match, (b) a deleted RECIPIENT refuses, (c)
   the RECIPIENT's own opt-out refuses. Nothing gives a clean `recipient` while
   the PHONE-MATCHED contact is opted out (staff Do Not Contact sets only the
   contact flag - spec section 1 item 2), nor a deleted phone-matched duplicate
   with a live recipient. Changing `phoneContact?.sms_opt_out` to
   `contact?.sms_opt_out` at sendMessage.ts:322 would pass every branch test and
   text a DNC'd number. The shipped code is right - probe (zz-conf-i8): both
   cases behave per I8 (ContactOptedOutError; deleted duplicate does not refuse).
   Fix: add both cases to the I8 test at sendMessage.test.ts:662 (`makeFakes`
   with an opted-out phone contact + `recipient: real` -> ContactOptedOutError;
   a `deleted_at` phone contact + `recipient: real` -> resolves).

3. NOTE - the deleted fence's position is pinned against opt-out only.
   Evidence: broadcastFanOut.test.ts:368 proves opt-out beats deleted (`c-both`).
   No case has unreachable + deleted (must stay `unreachable`) or deleted + no
   consent (must be `contact_deleted`, not `no_consent`). Code conforms
   (broadcastFanOut.ts:395-448 order: opt-out, unreachable, deleted, consent).
   Fix: add those two recipients to the I1 test with their expected codes and
   buckets.

4. NOTE - I1's kill-switch half has no fan-out-level test for a dashboard share.
   Evidence: no `SMS_SENDING_ENABLED` case in broadcastFanOut.test.ts. Probe
   (zz-conf-fanout): created_via dashboard + kill switch off -> slot `skipped` /
   `sms_sending_disabled`, persisted and derived `skipped_other` 1, zero sends,
   share finalizes `sent` (so the D6 label reads "Not sent").
   Fix: add that case (wireHandler builds its config from `testConfig()`; take
   an env override).

5. NOTE - two pins pass regardless of the D4 rule (question (a)).
   (i) broadcastFanOut.test.ts:405 (phone#-keyed recipient of a dashboard share)
   uses a switched-ON conversation, so it passes even if phone#-keyed
   recipients were sent automated; Review Focus 3 asked "still sends as a
   person's send". Probe: the same share into a MANUAL conversation sends.
   (ii) broadcastFanOut.test.ts:345's title claims "never breaker-metered", but
   the harness counter is a constant (`incrementAutomatedSendCount` returns 1,
   twilioWebhookHarness.ts:724-726), so no fan-out test can observe the
   breaker; my control probe (automated share "at the cap") therefore sent too -
   a fixture limit, not a defect. Only the audit `automated: false` assertion
   is load-bearing. Wrapper probe: `automated: false` on a manual row never
   calls `incrementAutomatedSendCount` (sendMessage.ts:364).
   Fix: set the phone# test's conversation `manual` and assert the audit
   `automated: false`; drop "never breaker-metered" from the D4 title or add a
   sendMessage.test.ts case asserting the counter is untouched for a person's
   send.

6. NOTE - failed-row reasons fall through to the internal-code map, which holds
   a whole-group sentence (merge-point hazard for SOR/RSW).
   Evidence: broadcastFormat.ts:150-151 special-cases only `no_contact`, then
   calls `deliveryReason`, whose INTERNAL_CODE_REASONS maps `contact_opted_out`
   to "Everyone here has opted out - nothing was sent" (deliveryStatus.ts:914),
   and prints any other unmapped code as "Delivery failed (error <code>)"
   (:1007) rather than the table's "Not sent (code)". Unreachable today: failed
   share slots carry only `no_contact`, `transient_cap`, `enqueue_failed` or a
   Twilio code (broadcastFanOut.ts; the webhook rollup writes the provider
   ErrorCode). D7's "a share recipient's row never shows a whole-group
   sentence" therefore holds by absence, not by construction.
   Fix: none required for this branch. State it in the handback's SOR/RSW relay:
   any new app code on a FAILED share slot (SOR's `send_unconfirmed`, any
   RSW code) must get its own arm in `shareRecipientReason`.

7. NOTE - stale type doc. dashboard/src/api/types.ts:2955 still documents
   `BroadcastRecipient.errorCode` as "Twilio error class on a failure"; it now
   also carries every skip reason (opted_out, unreachable, contact_deleted,
   no_consent, the wrapper refusal codes). The app twin
   (app/src/repos/broadcastsRepo.ts BroadcastRecipient.errorCode) has no doc.
   Fix: one-line doc update in both.

## The three judgments asked for

(a) Rule or fixture? The load-bearing tests test the rule: the D5 union
(integration :359 and route :1196 would fail on the old union), the D7 bucket
split and reason strings (exact literals), the D6 label (legacy and mixed
cases), the D8 composer text (a regex the old "Hi Tasha," body fails), and the
e2e (switch asserted `manual` BEFORE the send, the slot's conversation proven to
be conv-0002, "Already sent" absent after a skip). Expected values that are
true by construction: finding 5's two pins; the e2e "row is checked" assertions
after a seeded open (share-skip-fix.spec.ts test 2 end, :274) hold by seeding -
supplementary, the discriminating assertions sit beside them (:236, :273); the
MessageEditor placeholder test compares against the imported constant (wiring,
not value - the value is pinned in resolveTemplate.test.ts).

(b) Contradictions elsewhere in the app: none found. The only readers of the
skip buckets are StatChips.tsx:34 and broadcastFormat.ts:100 (both updated),
the fan-out, the repo, and a2p-compliance.spec.ts:479 (reads
`skipped_no_consent`, routing unchanged for `no_consent`). The finalize log line
has no consumer outside its own test. One "already sent" builder
(broadcastsRepo.ts:566); the property/contact "sent" cards read the listing-send
ledger, which the fan-out writes only after a successful send, so a skipped
recipient never appears there (Branch B territory, untouched). One share-label
path (presentShareLabel via BroadcastStatusPill; the results H1 is a reach line,
"To N tenants", not a status). `created_via` is set only by the draft route and
seeds; the composer's edit-is-recreate model (useComposerDraft.ts:1-11) means an
edited draft is re-created through the dashboard route - irrelevant today (no
engine), worth one line under WP2 item 8 when WP3 designs engine drafts.

(c) Merge points: clean (verdict row 16). `sendMessage.ts` changes nothing for a
caller that omits `recipient`; finalize differs only in its log line;
`deliveryReason` and the internal map are untouched; `shareRecipientReason` is
the single gate SOR was promised; the derived buckets extend by one arm and the
exported predicates (broadcastsRepo.ts:204-214) are the natural place for SOR's
`unconfirmed`. Relay finding 6 with the handback.

## Counts

MUST-FIX 0; SHOULD-FIX 2 (findings 1, 2); NOTE 5 (findings 3-7).
