# Planner review - spec conformance (SOR Stage 1)

Reviewer: read-only spec-conformance child of the planner (Claude Opus 5.5,
1M context), 2026-09-27. Worktree `W:\tmp\send-outcome-reconcile`, branch
`feat/send-outcome-reconcile`, HEAD `91a66577`, code final at `52220729`
(`git diff 52220729..HEAD -- . ':(exclude)docs'` is empty; tree clean), merge
base `bd752bd0`. Inputs: spec rev 11, plan rev 4, `handback.md`, the build
records (`build/`, `build-research/worklist.md`) and the code-review records
(`code-review/` rounds 1-4, FW1/FW2/FW4/FW5). Method: the diff
`bd752bd0...52220729` outside `docs/` read in full for the app source, the
dashboard source and fake-twilio; test files read by title and at the pins
cited. No test, gate, e2e lane or DynamoDB-backed run was executed. No tracked
file was edited; this file is not staged or committed.

File:line citations are at `52220729`. "design:N" is the spec file line.

## Bottom line

- 29 decisions plus RSW #1/#5/#6/#7 checked. None is missing. No blocking or
  high finding.
- CONFORMS: D1, D2, D3, D3a, D4, D5, D6, D7, D10, D12, D13a, D15, D16, D16a,
  D18, D19, D20, D20a, D21, D22, D23, RSW #1, #5, #6, #7.
- DEVIATES-DECLARED: D7a, D8, D8a, D9, D11, D13, D17 (each declared in a
  build or code-review record; direction given per row).
- DEVIATES-UNDECLARED: one, LOW, safe direction - D7a's failure-arm rule on
  the DEFERRAL arms (finding P-2).
- NOT-BUILT-BY-DESIGN: D14.
- Findings: 0 blocking, 0 high, 1 medium, 7 low (section H).

The handback's section 3 table is accurate in substance but labels several
declared deviations "CONFORMS" (P-4). Its Section 1 guarantee 1 ("nobody is
texted twice by this branch") holds only up to the filed double-text windows
listed in section C - all declared and held by Cameron's 2026-09-27 ruling.

## A. Per-decision verdicts

| item | verdict | code | pinned by | notes |
|---|---|---|---|---|
| D1 | CONFORMS | `app/src/lib/sendOutcome.ts:94-113` (kill switch :95; known codes first :103-104; 5xx :105; standalone 20429 after 5xx :106; 429/4xx :107-110; network :111; default :112) | `app/test/sendOutcome.test.ts` describe "classifySendFailure (spec D1/D2)" (12 cases incl. Review Focus 1, the C-5 20429 case, real SDK shapes) | C-5 closed by FW1-7 |
| D2 | CONFORMS | `sendOutcome.ts:112`; broadcast untyped error -> unknown `app/src/jobs/broadcastFanOut.ts:1037-1058` | sendOutcome "anything it cannot place is unknown"; bft "14 anything else thrown at the send is an UNKNOWN outcome" | |
| D3 | CONFORMS | `app/src/services/sendMessage.ts:217` / `:232` / `:266` (classes); `notAttempted` never wraps a refusal `:425-432`; wrapped steps `:452`, `:481`, `:551-564`, `:590-604`; provider throw `:620-625`; append `:676`; post-append best-effort and `conversation.updated` skipped on a failed touch `:686-723` | `app/test/sendMessage.test.ts` describe "typed send errors (spec D3)" (10 cases); `app/test/apiRoutes.test.ts` "answers 201 ... when the inbox touch fails" (D-5) | every pre-provider await is wrapped (read `:452-617`); all bare throws there are `SendRefusedError` subclasses (`:107-200`). Added `beforeProviderSend` hook `:615-617` is ADV-1's (declared, see D8a) |
| D3a | CONFORMS | bft record phase `:940-959`, catch `:975-985`; `SendAcceptedNotRecordedError` arm `:1029-1036`; relay record phase `app/src/jobs/relayFanOut.ts:2038-2073`, catch `:2125-2138` | bft "5a"/"5b"; relay "6"/"6b"; rung "a record-phase failure on the real unit hands the rung to reconcile WITH its SID" | never classified, never re-sent |
| D4 | CONFORMS | `app/src/adapters/messaging.ts:650` (`SEND_THROTTLE_CODES` gains 20429), marker `:826` | `app/test/messaging.test.ts` "fires send_throttled on a real 20429 and not on ECONNREFUSED (spec D4)" | |
| D5 | CONFORMS | bft `onRejected` `:687-774` (30007/30005/30006 arms `:696-732`, flag `:725`); relay `:2163-2209` (`sms_sending_disabled` kept `:2188`); broadcast kill switch refused earlier (`sendMessage.ts:460-463`) | bft "13b", "13c"; relay "5", "17", "18", "19" | relay recognized only 30007 + 429/30022 on main (`git show bd752bd0:app/src/jobs/relayFanOut.ts:104`), so no relay 30005 arm was owed |
| D6 | CONFORMS | bft retryable `:1044-1056` + `deferClaimed` `:620-627`; relay `:2210-2226`; `isProviderCode` `sendOutcome.ts:64-66` | bft "10", "10b"; relay "18" | see P-2 for the write-failure sub-case |
| D7 | CONFORMS | record to `reconciling` then enqueue: bft `handToReconcile` `:598-614` -> `handOff` `:554-583`; relay loop `:1411-1424` -> `handOff` `:1204-1240`; rung `app/src/jobs/relayRetryLeg.ts:898-...` -> `handOff` `:610` | bft "1 an unknown error on recipient 3 of 5" (`app/test/broadcastFanOut.test.ts:1258`), "6"; relay "send outcomes ... first test must fail on main" (`app/test/relayFanOut.test.ts:1380`), "20"; rung "handed_to_reconcile enqueues send.reconcile" (`app/test/relayRetryLeg.test.ts:1418`) | enqueue-failure close writes the slot first, the record only if it resolved (FW2-2). A KNOWN-SID hand-off whose enqueue fails still closes `send_unconfirmed` (C-11, filed) - D7's letter |
| D7a | DEVIATES-DECLARED (plus P-2 undeclared) | phase-tracked units: bft `runRecipient` `:841-1060`, relay `sendOneRelayLeg` `:1750-2262`; `guardWrite` `app/src/lib/guardWrite.ts:16-29`; claim placement bft `:869-879` (after fences, before `send`), relay `:1941-1952` (after acquire `:1917-1934`, before presign `:1994-2000`); rung switch exhaustive `relayRetryLeg.ts:871-1119` | bft "3", "3b", "5a-5d", "10b", C-2/C-3 cases; relay "15", "SOR 13", "6", "7"; rung stranded / sent_unrecorded cases | Declared: RECORD order - broadcast best-effort follow-ups before record done/sent (R2C-4c, FW2-6; bft `:949-950`), SAFE; relay pre-claim throw writes no slot (worklist A3), SAFE; terminal arms close the record only after their slot write resolved (FW2-2, matches D7a); N-1 double faults left for the sweeper (filed). Undeclared: P-2 |
| D8 | DEVIATES-DECLARED | shared gate `app/src/lib/sendAttemptGate.ts:30-39`; closes: `closeBroadcast` bft `:419-479`, `closeRelay` relay `:1259-1312`, fences `declineAtFence` bft `:636-670`, relay suppression `:1854-1915`, rung `closeUnlessOwned` `relayRetryLeg.ts:672` (sites `:749`, `:801`, `:974`, `:999`, `:1022`, `:1046`); conditional closes `closeRecipientIfQueued` `app/src/repos/broadcastsRepo.ts:931-935`, `closeRelayRecipientIfUnsent` `app/src/repos/messagesRepo.ts:3949-4014` | bft "8" (`:1851`), "11"-"11d", C-4 / R-a cases; relay "4" (`:1539`), "11a-11f", "14", C-4 cases; rung closeSites matrix (`:1971`, foreign attempting/reconciling `:2022`) | Declared: (a) the job's own closes write the RECORD first (ADV-2 / FW1-4, `r1-adjudications.md` sec 1) against D8's "slot FIRST" (design:393), SAFER; (b) the per-slot-type conditional write D8 requires (design:370-376) is used by the cap/enqueue closes and the reconcile, NOT by the fences (blind `setRecipient`, bft `:660` via `:1488-1495`), the relay suppression arm (`persistRelayRecipientResult`, relay `:1885-1888`) or the rung's `refuseGate` / `closeTerminally` on legacy rows - round 1 C-4, ruled residue R-b, filed `send-attempt-gate-then-close-window` (which names the blind writers), mislabel-only (P-3); (c) the gate read and the close are non-atomic (same issue). Per-key catches in the close loops against Sec 2's "stay unwrapped" (C-9), SAFER. Batch-read clause N/A: no batch read exists (D-1) |
| D8a | DEVIATES-DECLARED | `app/src/repos/sendAttemptsRepo.ts`: claim `:422-446` (TransactWrite with index item `:338-377`, `:196-207`); fenced transitions `:453-584`; hashed sort key `:176-181`; 30-day `expires_at` `:48`, `:187-189`; own repo module; relay slot clock `relayFanOut.ts:1982-1991` (broadcast slots none) | `app/test/sendAttemptsRepo.integration.test.ts` (fence, takeover, index cases); harness parity `twilioWebhookHarnessSendAttempts.integration.test.ts`; bft "7a" (`:1560`); relay "1", "2" (`:1527`), "4d" | Declared: the RE-ARM (`rearm` `:379-420`, called bft `:920-928` via `sendMessage.ts:615-617`, relay `:2020-2025`) moves `attemptedAt` to the last pre-call instant, so the TTL, takeover and window run from the re-arm and the slot clock (claim instant) differs from the record's (ADV-1 / FW1-1 / FW2-1, R2C-4a), SAFER (narrows the ADV-1 double text; residue A-1 filed). The `owner` map keeps the raw recipient key (declared, `sendFingerprint.ts:31-42`; hashes unkeyed like `relayRetryClaim.ts:26`, filed `send-attempt-recipient-hash-unkeyed`) |
| D9 | DEVIATES-DECLARED | bft loop `:1067-1097` (unknown counted `:1057-1058`); relay `:1353-1463`, `isUnknownOutcome` `:1633-1645`; last-rung close via `claim.attempt >= MAX` bft `:1147-1151`, relay `:1508-1511` | bft "4a" (`:1380`)-"4e"; relay "8a" (`:1752`)-"8h" | Declared: on relay a STRANDED rejection or refusal (a double fault) counts toward the brake though D9 says a rejection resets (R2C-4d / FW2 deviation 5); the broadcast twin does not - an asymmetry, harmless. A re-drive's second unknown counts on both (S2a deviation 2) - consistent with D9 |
| D10 | CONFORMS | codes `sendOutcome.ts:14-19`; no new status anywhere (closes write `failed` only, `messagesRepo.ts:3949`, `broadcastsRepo.ts:931-935`) | mirror test `dashboard/src/routes/contact/sendOutcomeCodesMirror.test.ts`; bft "13" (HTTP status never a slot code) | `send_retryable` renders as queued (`deliveryStatus.ts:1142`) |
| D11 | DEVIATES-DECLARED | no marker `app/src/jobs/sendReconcile.ts:356-359` (doc `:10-17`); conditions `sendAttemptsRepo.ts:542-576`; op token `:453-482`; consistent twins `messagesRepo.ts:2458`, `:3381`, `:4196`, `:4236`, `broadcastsRepo.ts:650`; index Query `sendAttemptsRepo.ts:585-615` | reconcile "registers WITHOUT the run-once marker", "14", "14a", "14b", "11c"; `sendReconcile.integration.test.ts` redelivery cases (`:206`, `:248`) | Declared: two coordination reads still go through a GSI for a `phone#`-keyed broadcast recipient - `heldBy`'s contact read (`sendReconcile.ts:596` via `resolveContact`, bft `:1192-1200`) and the adoption's (bft `:1351`) - against D11's "no coordination read through a GSI" (C-8 remainder, filed `send-reconcile-job-residues` item 10, whose filer reads one path as able to reach `never_sent` and a re-send, UNVERIFIED); the roster read behind the digest check is eventually consistent (`sendReconcile.ts:485`, worklist A10/R3, item 5); duplicate chains with different verdicts (D-3, item 9). Op tokens (FW1-5) are an addition, SAFER |
| D12 | CONFORMS | `toOwnerRef` hashes the recipient `sendReconcile.ts:126-145`; parser `:210-224`; current number `:516-535`; digest check and `no_sender` `:768-772`; known-SID path skips the digest `:426`, `:737-749` | reconcile "13" (Review Focus 2), "13a", "21", C-8 case; relay "13", "21" | plan deviation 4: `continuation.senderKey` is carried verbatim and is a `phone#` key for a contact-less SENDER (declared; D12 forbids a recipient phone). A contact member off the roster reads `digest_mismatch` without reading the contact (C-10, filed item 4), SAFE |
| D13 | DEVIATES-DECLARED | `lookup` `sendReconcile.ts:765-907` (window `:777-779`; siblings `:787-796`; walk `:830-858`; judge oldest-first `:860-882`; verdicts `:892-906`); `matches` `:552-554`; `sameFingerprint` `:562-564`; `heldBy` `:577-611`; known SID `adoptKnown` `:737-749`; constants `sendOutcome.ts:30-49` | reconcile 1-13c, 5-5m, F-1/C-1/FW4-1/FW5-1 cases; relay 7, 8, 8b-8f | Declared: (a) two-sided window `[attemptedAt-60s, attemptedAt+90s]` instead of "to now" (design:591-592; FW1-2 / R2C-4b) - MIXED: it stops a late check adopting a later attempt's message (C-1) but a message created after +90 s is invisible (Window TRAIL, filed `send-attempt-rearm-residues` item 2, a possible double text); (b) body hash AND media count for every body (S3a / F-2 / FW1-3), SAFE (an own orphan that fails to match ends unresolved, never never_sent); (c) never_sent needs a COMPLETE walk; a cut or error-ended walk judges what it read (FW4-1, FW5-1), SAFE. Runtime page-size check WARNs (`messaging.ts:1142-1150`) where D13 says "asserts" - the plan's own reading (T4 test "the D17 UNVERIFIED guard"), consistent with D17 |
| D13a | CONFORMS | delays `sendOutcome.ts:30`, `reconcileDelayMs` `sendReconcile.ts:156-158`; parser bound `:218`; lane seam `:148-153` (guarded on `JOBS_QUEUE_URL`), `scripts/e2e-session.mjs:296`; one re-drive `markRedriven` `sendAttemptsRepo.ts:550-556`; second unknown closes at the site bft `:782-811`, relay `:2230-2255`; re-drive pass claims no rung up front bft `:507`, `:1119-1136`, relay `:1323`, `:1479-1501`; `enqueueOrClose` `sendReconcile.ts:1035-1069` | reconcile "4", "17", "17a", "17b", "18", "20"; bft "9a", "9b" (`:1941`), "9f", "9g"; relay "9a", "9c", "10" (`:1958`) | hop budget not pinned by a test (P-7) |
| D14 | NOT-BUILT-BY-DESIGN | - | - | filed `send-attempt-sweeper` (med) with the record's shape and the build's strands |
| D15 | CONFORMS | broadcast `adoptBroadcastRecipient` bft `:1341-1479` (SID claim first `:1366-1393`; slot from `queued` with conversationId/tsMsgId/carrierSentAt and stats in one write `:1396-1416`; follow-ups only when moved `:1418-1478`; `automated` from `created_via` `:1359`; property rows only for sent/delivered `:1456-1463`; 30005/30006 flag + WARN `:1465-1477`); relay `adoptRelay` `sendReconcile.ts:651-691` (conditional pointer claim `messagesRepo.ts:4156-4190`; forward-only slot `:4016-4076`; rung inbox touch `sendReconcile.ts:718-728`) | reconcile 2-3h, 16-16d; integration "an adoption never regresses a slot" (`:294`), C-7 receipt routing (`:339`) | Declared refinements: the audit row only for a FRESH append (S3a deviation 2); residues filed (`send-reconcile-job-residues` items 1, 2, 3, 5, 11). Relay maps provider accepted/sending to `queued` - that IS the relay success path's own mapping (`relayFanOut.ts:2044`), which D15 says adoption follows |
| D16 | CONFORMS | dispatch `runCheck` `sendReconcile.ts:386-470`; re-drive envelopes `:1078-1115`; relay pre-check `:1123-1130`; closes `:1003-1024`, `:1140-1160`; rung outcome switch handles both hand-off kinds `relayRetryLeg.ts:898-...`; log levels found INFO `:430`, never_sent WARN `:1190`, unresolved ONE ERROR `:1018` | reconcile 11, 11b, 15, 15a, 15b, 15d, 17 | |
| D16a | CONFORMS | `finalize` bft `:1514-1575` (consistent read `:1521`; defers on any `queued` `:1527-1531`; status from the map `:1532-1537`; prose `:158`); `finalizeStatus` `broadcastsRepo.ts:937-984` (conditional on `sending`, op token) | bft finalize describe (`:2557` N callers, `:2571` Review Focus 5, `:2593` stale counter, both orderings) | residues: finalize throw (`fanout-close-path-robustness-residues`), route `markFailed` (`broadcast-route-markfailed-blocks-finalize`) |
| D17 | DEVIATES-DECLARED | port `messaging.ts:305-322`; Twilio `listMessages` `:1131-1157`, `getMessage` `:1159-1177`; console `:1372`, `:1391-1405`; timeout pinned `:692`, `:753`, `:757`, `app/src/adapters/twilioHttpClient.ts` | messaging.test.ts describe "listMessages / getMessage (spec D17)" (11 cases) | Declared: plan deviation 1 (no `createdAfter`; the job filters); T4-1 (`TwilioClientLike` not widened - asserted resource interfaces instead, C-9); field `providerStatus` and arg `pageSize` are the plan's shapes. SAFE |
| D18 | CONFORMS | `safeRecipientKey` / `logSafeMemberKey` on every new line; errors only under `err` (serializer allowlist `app/src/lib/logSerializers.ts:32-86`); rejected arms log code + status, never `err` (S2a deviation 4) | reconcile "21", relay "22", bft "12", ADV-9 case | P-8 (UNVERIFIED): the lookup logs a list/fetch error's `message` |
| D19 | CONFORMS | `fake-twilio/src/routes/rest.ts:37` (Smart Encoding on read-back only), `:153`/`:163`/`:180` (three modes), `:201` list, `:242` fetch; `fake-twilio/src/routes/control.ts:109` | fake-twilio rest/control tests; e2e specs | `fail-list` seam (`control.ts:124`) is beyond D19 but in plan T11 |
| D20 | CONFORMS | `dashboard/src/routes/contact/deliveryStatus.ts:122` (presentation with its own reason), `:811` (leg by code, ahead of retry states), `:1055`; broadcast `broadcastFormat.ts:140`; hint suppressed `BroadcastResults.tsx:56`; `relayRetryJoin.ts` needs no change (projects the code) | deliveryStatus.test "send_unconfirmed - Not confirmed by code alone"; Timeline.delivery "three positions" incl. the rung; relayRetryJoin.test "projects a rung closed send_unconfirmed"; BroadcastResults / DeliveryBadge / broadcastFormat cases; mirror test | C-6 closed by FW2-9 |
| D20a | CONFORMS | `deliveryStatus.ts:301`; `api/types.ts` `attemptedAt` | deliveryStatus.test D20a cases (neither clock never ages; sentAt wins); Timeline "attempt clock" describe | slot clock is the claim instant (declared R2C-4a) |
| D21 | CONFORMS | `deliveryStatus.ts:560` (out of K), `:586` (into J), retrying excluded | deliveryStatus.test "counts a leg whose last rung closed send_unconfirmed under not confirmed" and the disjointness case | |
| D22 | CONFORMS | `broadcastsRepo.ts:303`, `zeroStats`; unresolved close bumps `unconfirmed` (`sendReconcile.ts:1022`, bft `:563-568`); `StatChips.tsx:38`; `skippedTotal` excludes it; seeds `app/src/lib/seed/matrix.ts:1228`, `:1252`, `performance.ts:1006` | deriveBroadcastStats.test; StatChips order and sum; broadcastFormat "the unconfirmed bucket (SOR D22)"; BroadcastResults unconfirmed row | |
| D23 | CONFORMS | `deliveryStatus.ts:1052`, `:1055-1057` | deliveryReason D23 describe; mirror test; e2e "Delivery failed (error 21211)" | one token, two sentences (filed `send-outcome-dashboard-residues` item 3, a product call) |

## B. Section 2a carry-overs

| item | verdict | code | pinned by |
|---|---|---|---|
| RSW #1 | CONFORMS | rung re-drive is a plain `enqueue` of the same rung `sendReconcile.ts:1105-1112`; the handler's gates `relayRetryLeg.ts:746-749` and window `:798-801` run on it; the marker keys on the fresh jobId `:450-456` | rung "a re-driven rung declined by the window gate" (`relayRetryLeg.test.ts:1790`); reconcile "15b" |
| RSW #5 | CONFORMS | `deadline_exceeded` before any claim `relayFanOut.ts:1926-1932`; terminal `retry_window_closed` through the gated `refuseGate` `relayRetryLeg.ts:1036-1046`, never the transient arm | rung "deadline expires during the acquire" (`:1811`); relay "SOR deadline_exceeded returns before any claim" (`relayFanOut.test.ts:3709`) |
| RSW #6 | CONFORMS | gates and window run before `sendOneRelayLeg` (`:746`, `:798` vs `:836`); window closes are gated (`:801`, `:999`, `:1046`); no `window_closed` outcome needed (`sendAttemptsRepo.ts:55-64`) | closeSites matrix rows "the window gate", "the send deadline" |
| RSW #7 | CONFORMS | `relayRetryJoin.ts` untouched (`WINDOW_CLOSED_CODE` `:104`, `:424`); SOR presents by code at `deliveryStatus.ts:811` | RSW `relayWindowCloseMirror.test.ts` unchanged; SOR `relayRetryJoin.test.ts` "projects a rung closed send_unconfirmed" |

The rest of Sec 2a holds: fenced files have empty diffs
(`retrySend.ts`, `jobs.ts`, `sqsJobConsumer.ts`, `routes/webhooks/twilio.ts`,
`app/test/helpers/sendRefusalCases.ts`); no new refusal gate in `sendMessage`;
the fan-out passes no deadline (relay loop args `relayFanOut.ts:1368-1385`);
`skippedTotal` excludes `unconfirmed`; the internal-map entry is in place;
`created_via` is read by the pass (bft `:912`) and the adoption (`:1359`); the
e2e never uses `contact-tenant-0002` / `conv-0002` (only a comment at
`send-outcome-reconcile.spec.ts:58`); RSW's lane seam is reused and the new
`E2E_SEND_RECONCILE_DELAYS_MS` is separately guarded.

## C. Section 1 guarantees against the filed residues

Issues added or amended by the branch (`git diff --name-status
bd752bd0...HEAD -- docs/issues`: 26 added, 10 modified). The ones that weaken
a guarantee:

**Guarantee 1 - "nobody is texted twice by this branch".** Can still text
twice:
- `send-reconcile-hosted-dev-checks` item 1 (med) - if Twilio's Messages list
  omits a message until it has a `date_sent`, a message held in Twilio's queue
  past +240 s is ruled `never_sent` and re-driven. Spec-level unknown (R2C-2),
  not a build defect; see P-1.
- `send-attempt-rearm-residues` item 1 (low) - a ~90 s DynamoDB stall inside
  the re-arm plus a concurrent taker (A-1, confirmed in the harness).
- `send-attempt-rearm-residues` item 2 (low) - a provider request that
  trickles past +90 s creates its message outside the two-sided window
  (introduced by the DECLARED D13 deviation (a)).
- `send-reconcile-job-residues` item 10 (low) - a stale byPhone GSI read in
  `heldBy` reads our own row as another owner's and a complete walk ends
  `never_sent` (filer's reading, UNVERIFIED; needs a crash plus a number
  move inside the window).
- `send-attempt-sweeper` Addendum (low) - a pass-1 broadcast REJECTION whose
  slot write threw is taken over and re-driven once: a second provider call
  for a rejected send (not a second delivered text).
- Out of this branch's adopted callers, recorded not weakened:
  `manual-retry-double-send-residual-windows` (the webhook's ungated
  `closeRetryLegEnqueueFailed`, a mislabel, "at most one text"),
  `exactly-once-send-intent` (staff sends, manual Retry, native group).
- Mislabel only, never a second send: `send-attempt-gate-then-close-window`,
  `send-reconcile-job-residues` item 9 (D-3).

**Guarantee 2 - "every attempted recipient reaches a terminal state".** Left
non-terminal (the share reads Sending / the leg Sending) until an unbuilt
sweeper:
- `send-attempt-sweeper` (med) - items 1-6 and the N-1 addendum: a relay
  strand is NEVER taken over (the 5 s + 10 s ladder never outlasts the 30 s
  TTL; the rung does not even carry); a broadcast strand in pass 2/3 or any
  re-drive pass; an orphan owner; `markRedriven` then a crash; a `takeOver`
  that applied then threw; the D14 crash windows.
- `fanout-pass-setup-throw-strands-pass` (med) - per-pass setup and the new
  re-drive post-loop pass claim (bft `:1124`, relay `:1484`) throw under the
  marker.
- `fanout-close-path-robustness-residues` (amended) - a `finalize` throw
  leaves the broadcast `sending`; C-11 known-SID hand-off failure.
- `relay-continuation-early-return-strands-slots` (low) - ordinary
  continuations that early-return (a re-drive pass now closes; T8-9).
- `send-reconcile-job-residues` item 7 (low) - a reconcile that keeps
  failing ends in the DLQ with the record `reconciling` (the spec's designed
  DLQ page; the record is the sweeper's).
- `send-attempt-rearm-residues` item 4 (low) - a re-arm that commits and then
  throws leaves the record `attempting`.
- `relay-retry-stranded-claim-window` (amended) - the webhook's claim window.
- `retry-send-lost-under-job-marker` (med) - the 1:1 retry is not adopted
  (Stage 1b, out of scope by Sec 2a).
- Observability of the above: `relay-staleness-alarm-assumed-not-built`,
  `relay-fanout-closes-emit-nothing`.

**Guarantee 3 - "an ambiguous outcome is resolved by the platform".**
Weakened (safe direction - unresolved, never re-sent):
- `status-callback-passive-match-for-pending-reconcile` (med) - receipts
  dropped before adoption; webhook side effects never run.
- `send-reconcile-hosted-dev-checks` items 2 and 4 - page size / order; link
  shortening or Advanced Opt-Out rewrite every stored share body, so no share
  would ever adopt. P-5 adds the media half.
- `send-reconcile-job-residues` item 12 - more than 5000 messages from one
  sender closes `page_bound` (the spec's own bound rule).

## D. The plan's four declared deviations against the build

1. `createdAfter` not a port argument - BUILT as declared:
   `ListMessagesArgs` is `{ to, from, pageSize, pageToken? }`
   (`messaging.ts:129-139`); the job filters `createdAt`
   (`sendReconcile.ts:844-848`).
2. Dashboard code constants in `deliveryStatus.ts`, pinned by a mirror test -
   BUILT: `deliveryStatus.ts:101-104`; `sendOutcomeCodesMirror.test.ts` pins
   the four codes and the `transient_cap` / `enqueue_failed` prose to the app
   values.
3. A send site's post-claim slot write keeps only the slot's own guards, is
   written before the fenced `finishAttempt`, and a lost fence is WARN with no
   rollback - BUILT: broadcast `recordRecipientOutcome(['queued'])` then
   `finishAttempt` with WARN (bft `:941-957`); relay slot, pointer, then
   `finishAttempt` with WARN (`relayFanOut.ts:2039-2072`). Note: on a LEGACY
   relay row the "existing guard" is none - `markRecipient` is wholesale
   (`:2421-2433`) - as the plan's wording allows.
4. Continuation payloads keep their `phone#` shapes; the reconcile OWNER
   field is phone-free; `continuation.senderKey` verbatim - BUILT:
   `toOwnerRef` (`sendReconcile.ts:126-145`); relay hand-off carries
   `payload.senderKey` (`relayFanOut.ts:1212-1215`); test 21 is scoped to the
   owner field (reconcile "21", relay "21").

## E. In the diff, not asked by the spec

All recorded and adjudicated; none is unreviewed scope:
- `SendAttemptsRepo.rearm` and the new optional `sendMessage` input
  `beforeProviderSend` (`sendMessage.ts:378-387`, `:615-617`) - ADV-1 under
  Cameron's minimal-site-half ruling. The only change to the shared send
  service's public input.
- Op tokens: `last_op` on every fenced record transition
  (`sendAttemptsRepo.ts:453-482`) and `finalize_op` on the broadcast item
  (`broadcastsRepo.ts:207-213`, `:937-984`) - ADV-3 / FW1-5.
- Strongly consistent FIRST-pass broadcast snapshot (bft `:370`) - ADV-7; the
  spec asked only for continuations.
- Relay re-drive passes close their carried members `redrive_refused` on an
  early return or a departed member (`relayFanOut.ts:1124`, `:1143-1150`,
  `:1494`, `:1680-1719`) - T8-9 / ADV-5, beyond Sec 9's "strand".
- `stranded` leg outcome and `afterSend` flag (`relayFanOut.ts:1592-1622`) -
  plan.
- fake-twilio `fail-list` seam and the fourth e2e spec (`:491`) - plan T11/T12.
- Per-key try/catch in both close loops - C-9 (Sec 2 said "stay unwrapped").
- `sendAttemptGate.ts` shared helper (ADV-10), `listByConversationConsistent`,
  `AppendResult.conversationId`, the redirecting client's `timeout` (A11),
  `e2e/support/broadcastSelectors.ts` extraction, Timeline.tsx comment edits
  (A6), `deliveryReason('send_retryable')` answering nothing.

## F. Asked by the spec, exercised by no test

- D13a's hop budget ("worst-case chain depth 8 of 10") - no test (P-7).
- Sec 8 item 6 "a batch read with an unprocessed key re-reads it" - not
  applicable: every gate is a per-key consistent Get (D-1).
- Sec 8 item 6 "the reconcile job's own close writes the slot before the
  record" - deliberately inverted (ADV-2); the tests pin the inverse
  (reconcile "14d", "14e").
- D7a's deferral arm whose slot write fails after the claim - no test pins
  the record's end state (the broadcast "3b" case at
  `broadcastFanOut.test.ts:1351` is the PRE-claim deferral) (P-2).
- The Sec 10 hosted-dev checks (order, page size, Smart Encoding in prod)
  are owed by design; the media-count half is not on that list (P-5).
- "Must fail on main" for Sec 8 item 3: recorded as seen red in `S2a-report.md`
  (method paragraph) and `S2b-report.md` ("Fails on main"); not re-run here.

## G. The handback's section 3 table, checked

Substance verified; labels differ from mine for D7a, D8, D8a, D9, D11, D13,
D17 (declared deviations shown as "CONFORMS") and D14 ("CONFORMS (recorded,
not built)" = NOT-BUILT-BY-DESIGN). Its section 4 does list every deviation I
found except P-2. Its section 2 claim that the fenced files and the run-once
marker are untouched holds; `send.reconcile` registers without the marker
(`registerHandlers.ts:77`, `sendReconcile.ts:356-359`); broadcast slots carry
no `attemptedAt`.

## H. Findings

**P-1 (MEDIUM, declared residue, guarantee 1).** The one double-text residue
that could be SYSTEMATIC rather than rare is R2C-2
(`send-reconcile-hosted-dev-checks` item 1): if the Messages list omits
queued messages, every ambiguous send whose message sits in Twilio's queue
past +240 s - the Twilio-incident scenario the reconcile exists for - is
ruled `never_sent` and re-driven. The D9 brake bounds it to a few recipients
per pass, but continuations and later passes keep going. The spike's B1/B3
steps fit either reading. Held by the ruling ("a double text is annoying");
recommend that the hosted-dev item 1 check run before anything depends on
the reconcile in prod, and before Stage 1b / Branch B build on the record.

**P-2 (LOW, DEVIATES-UNDECLARED, safe direction).** D7a (design:328-331):
"A failure-arm write (the D5/D6/D7 writes) that itself fails ... the record
keeps `attempting` and the slot keeps whatever it held." The DEFERRAL arms
release the record `done`/`retryable` even when their slot write failed:
broadcast `deferClaimed` (`broadcastFanOut.ts:620-627`, used by the
retryable arm `:1054`, the SendNotAttempted arm `:1026` and the defensive
post-claim prepare arm `:962-965`); relay post-claim prepare catch
(`relayFanOut.ts:2088-2096`) and retryable arm (`:2214-2220`). FW2-2 fixed
only the terminal arms and its scope line says "Deferral arms are unchanged"
(`r1-adjudications.md` sec 3), but no record names this as a deviation from
D7a. Safe: nothing was sent and the recipient is carried, and releasing the
record lets the next claim proceed at once - better than the spec's letter,
which on relay would strand the member until the sweeper. No test pins it.
Suggest: declare it in the merge note (no code change).

**P-3 (LOW, declared).** D8's per-slot-type conditional close write
(design:370-376) is not used by the broadcast fences (a blind `setRecipient`,
bft `:660`), the relay suppression arm (`relayFanOut.ts:1885-1888`) or the
rung's `refuseGate` / `closeTerminally` on legacy rows. Round 1 C-4 found it;
the adjudication (R-b) ruled it residue while reasoning about the full
ATOMIC gate-plus-close fix. The cheaper half - the conditional write alone,
which the repos already expose (`recordRecipientOutcome(..., ['queued'])`,
the shape `deferSlot` uses at bft `:542-544`; `closeRelayRecipientIfUnsent`)
- would remove the "blind writer overwrites a send that landed" sub-case
without a transaction, and was never ruled on separately. Mislabel-only
(the fence's `skipped`/`opted_out` over a delivered text, which also drops
the slot's `tsMsgId` so later receipts cannot roll up). Suggest adding the
cheap half to `send-attempt-gate-then-close-window`'s suggested fix.

**P-4 (LOW, record accuracy).** `handback.md` section 3 marks D7a, D8a, D9,
D13 and D17 "CONFORMS", D8 "CONFORMS for the redriven case" and D11
"CONFORMS, residue", while section 4 lists their deviations. A reader of the
table alone would miss that D13's window is two-sided (with its own
double-text residue) and that D11's GSI reads remain.

**P-5 (LOW, residue gap).** The hosted-dev checklist verifies the BODY half
of the D13 fingerprint (Smart Encoding, link shortening, Advanced Opt-Out)
but not the MEDIA half: whether Twilio's listed/fetched `num_media` for an
outbound MMS equals the number of media URLs submitted, and whether the
Messaging Service's MMS Converter (which can deliver media as a link) is on.
Either would make every relay photo leg unmatched - `unresolved`, "Not
confirmed", never adopted (safe direction). The fake stores
`num_media = mediaUrls.length` (`fake-twilio/src/routes/rest.ts:83`,
`toMessageResource`), so no test can see it. Suggest one line in
`send-reconcile-hosted-dev-checks`.

**P-6 (LOW, spec errata owed).** The approved spec now disagrees with the
build in declared places: D8 "the reconcile job's own closes ... write the
slot FIRST" (design:393; inverted, ADV-2); D13's window "to now"
(design:591-592; two-sided); D8a rev 11 "the broadcast ladder ... clears it"
(design:444-445; pass-1 strands only); D7a "as today" versus D8's
conditional close (C-4); Sec 2's broadcast `attemptedAt` (design:99; not
built, correctly per D8a); Sec 8 item 6 "redriven untouched" (superseded by
D8 rev 11). The handback lists them as notes (section 4). Suggest an erratum
block on the spec at merge so Stage 1b's addendum builds on the record as
built.

**P-7 (LOW, untested claim).** D13a's worst-case chain depth (8 of
`MAX_HOP_COUNT` 10) has no test. My reading of `app/src/jobs/jobs.ts:166-170`
(hop = parent + 1, throw above 10) agrees with the spec's arithmetic, and an
overflow is handled - every enqueue inside the job and at the sites is
wrapped (`enqueueOrClose`; `closeBroadcast` / `closeRelay` with
`enqueue_failed`) - so the failure would be honest. A re-drive pass with a
transient remainder reaches hop 9 and 10 on its continuations; the claim at
the cap closes it first in practice. UNVERIFIED by execution.

**P-8 (LOW, UNVERIFIED, D18).** The lookup logs a failed list or fetch under
`err` (`sendReconcile.ts:449`, `:894`); the serializer keeps `err.message`
(`logSerializers.ts:56`). The build deliberately keeps `err` off send-time
rejection lines because "a Twilio 4xx message can carry the phone number"
(S2a deviation 4), but a list/fetch 4xx (not 404) would be logged with its
message. The list uses a phone the platform already sent to, so a 4xx there
is unlikely; whether Twilio's list 4xx messages embed the `To` number was
not checked.

## I. Not verified here

- No suite was run; every "pinned by" is from reading test titles and the
  pins cited, plus the build and review records' red/green and mutant
  evidence.
- The "must fail on main" evidence is the S2a/S2b records' word.
- `send-reconcile-job-residues` item 10's double-text reading and every
  Twilio-behavior question in section C (queued listing, order, page size,
  body rewriting, `num_media`) are unverified by design until the first
  hosted-dev run.
- P-8's Twilio error-message content.
