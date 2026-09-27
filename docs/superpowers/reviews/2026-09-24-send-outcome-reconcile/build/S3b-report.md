# S3b report - send.reconcile mutant pass (Task 10 verification)

Dispatch S3b of the SOR Stage 1 build: a FRESH verification child (Claude Opus
5.5, 1M context) that did not write the code under test ran the mutant pass
S3a deliberately skipped, pinned every surviving decision with a test, and
reported defects rather than fixing source. Worktree
`W:\tmp\send-outcome-reconcile`, base 83f0ad24, HEAD 6ab1370b.

Record note: the child returned this report as TEXT (the harness refuses
report-file writes from implementer subagents); the orchestrator landed it
here with its own checkpoint and adjudications appended, per AGENTS.md.

## Commit

- `6ab1370b test(jobs): send.reconcile S3b mutant pass - pin the 65 decisions no test held (D8, D11-D16, D18, A1, A7, T10-12)`.
  Only file changed: `app/test/sendReconcile.test.ts` (+641 lines, 38 new
  cases, 53 -> 91 in the file). Bare git status read; MERGE_HEAD absent;
  explicit path; 0 non-ASCII bytes in the staged added lines; Co-Authored-By
  trailer.
- Two corrections to that commit body: the pass ran 202 mutants, not 203; of
  the 22 survivors, 20 are equivalent and 2 were left unpinned on purpose
  (finding F-2), not "22 equivalent". Not amended.
- No file under app/src changed. Every mutant was written from a pristine
  scratch copy and restored from it; at the end `cmp` confirmed
  sendReconcile.ts, broadcastFanOut.ts, messagesRepo.ts and
  helpers/twilioWebhookHarness.ts match the pristine copies. Tree clean.
- One slip, fixed: a mutant id containing ">" used as a shell-unquoted file
  name made the redirect create a stray `app/2.json`; it was deleted before
  anything else ran, ids were sanitized, and that mutant re-ran as
  SR147-len-ge2.

## Gates (all bare, none in the background)

- Fast gates: vitest on sendReconcile, sendReconcile.integration,
  broadcastFanOut, relayFanOut, relayRetryLeg and
  twilioWebhookHarnessRepoAdditions.integration: EXIT=0, 6 files, 465 passed.
- `npm run typecheck`: EXIT=0, 0 `error TS` lines.
- `npx eslint app/test/sendReconcile.test.ts`: EXIT=0, nothing reported.
- No `[dynamoAdmin]` line in the gate logs or in any of the ~290 mutant runs.

## Totals

- 202 one-line (or small-block) mutants: 152 in sendReconcile.ts, 7 more for
  the parser and rung direction, 39 in the broadcastFanOut.ts adoption half, 2
  on the messagesRepo.ts:4052 legacy REMOVE, 2 on its harness twin
  (twilioWebhookHarness.ts:1726).
- 115 killed by the existing suites.
- 87 survived; 65 of those are now KILLED by the new tests (each new test was
  checked to fail with its mutant applied and to pass on the real code).
- 22 still survive: 20 equivalent (reasons below) and 2 left unpinned on
  purpose (F-2).

## Mutant table

Id prefixes: SR = sendReconcile.ts:line, BF = broadcastFanOut.ts:line, MR =
messagesRepo.ts:line, H = twilioWebhookHarness.ts:line (lines at 9db8fa22).
Test names refer to sendReconcile.test.ts unless marked int
(sendReconcile.integration), bft (broadcastFanOut.test) or HRA
(twilioWebhookHarnessRepoAdditions.integration).

Killed by the existing suites (115):
- SR145 no-queue-guard, SR147 drop-nonneg, SR147 len>=2, SR152 drop-max,
  SR152 index0: 18. SR157 no-delay: bft 1/4a/5a. SR196 continuation parsed
  when undefined: 40 cases. SR213 gt-len and drop-isInteger: "rejects a
  payload". SR371 no-notfound-exit: "owner cannot be resolved". SR386
  drop-state: A7. SR386 drop-at: 14. SR393 drop-at and drop-A7: A7. SR396
  checkNo: 4/int. SR400 always-lookup: 1/int. SR403 no-sid: 2/4/5. SR418
  always-status: 16b. SR422 warn-flip: 12. SR425 next+2: 4/5. SR426
  state-redriven: 17b. SR427 delay-checkNo: 4.
- SR451 raw-key: 21. SR457 swap-row: A1/int. SR464 drop-slot-keys: 15a/int.
  SR467 raw-key: 15a/21. SR476 drop-row: A1/8c/15. SR501 drop-roster-phone:
  3/3b/5. SR502 drop-phonekey: 15a. SR519 drop-media: 6b/6c. SR521 short-any:
  6b. SR521 long-any: 9. SR548 drop-system: 5b. SR555 drop-ts: 5. SR563
  row-undef-other: int/bft ordering.
- SR592 drop-code: 3. SR595 drop-sentAt: 1/2/int. SR629 drop-claim-other: 7.
  SR631 drop-undelivered: 3. SR636 sentAt-only: 3b/int. SR643 swap-leg-rung:
  3/3b. SR645 no-warn: 3. SR677 direction-const: A1. SR688 always-touch: 16.
  SR708 drop-other: 5d. SR712 no-undef-throw: 19.
- SR732 never-last and last-at-1: 9/11. SR734 drop-no-sender: 13a. SR736
  drop-digest: 13/14b. SR739 no-lead: 13b. SR744 siblings-since-attempt:
  8/8b/5e. SR745 self-included: 11. SR745 owner-identity: 5e. SR747
  no-sibling-sids: 5c. SR758 page-size, SR759 drop-token, SR766 drop-pages,
  SR771 gt: 10. SR762 swap-last: 12. SR768 drop-window: 13b. SR776
  newest-first: 7. SR779 drop-sibling-skip: 5c. SR781 drop-system: 5b.
- SR799 drop-continue: 4/5. SR800 >=0: 11. SR800 >1: 6c/9. SR804
  adopted-only: 8b. SR804 open-only: 8. SR804 drop-fingerprint: 8c. SR821
  bucket-failed: 9/14b. SR833 drop-closed: A1. SR833 drop-kind: 15b/16/17.
  SR852 no-finalize: 2/int. SR870 no-slot: 16b. SR887 no-cause: 5d.
- SR916 swap-arms: 17/17a/17b. SR920 slot-first: 17/17a. SR921 always-slot:
  17a. SR928 bucket: 17. SR933 no-afterClose: 17. SR952 attempt: 11. SR964
  drop-override: 15. SR966 attempt: 15. SR976 rung-no-redrive-flag: 15b.
  SR991 drop-bcast: 11. SR992 drop-kind: 15b. SR992 drop: 15a. SR993
  drop-open: 15. SR994 drop-member: 15a. SR1018 no-afterClose: 15b. SR1037
  no-refusal: 15. SR1041 enqueue-before-mark: 17/20. SR1042 gt1: 20. SR124
  broadcast-raw: 21/bft 12. SR130 leg-raw: 21.
- BF1134 no-phonekey: 21/bft. BF1238 drop-bcast: 5. BF1241 drop-contact:
  2a/15c. BF1297 automated-true: 2b. BF1299 drop-undelivered: 3. BF1318
  never-named: 2. BF1334 no-delivered: 1. BF1339 delivered-delta: 2/int.
  BF1349 no-carrierSentAt: 1/2. BF1357 no-tick: 2. BF1361 always-audit: 2a.
  BF1393 always-conv-emit: 1. BF1394 always-property: 3. BF1175
  always-listing: bft. BF1412 no-warn: 3.
- The carried legacy REMOVE, all four killed: MR4052 remove-always (HRA
  legacy case); MR4052 remove-never (int relay-leg case and HRA); H1726
  delete-always (HRA); H1726 delete-never (3b and HRA).

Survived, now killed by a new test (65 mutants, 38 tests; mutant(s) -> new
test -> what it pins):
- SR165, SR170, SR175, SR179, SR180, SR186, SR187, SR197, SR206, SR209,
  SR213-drop-neg (empty or missing ids, null payload, owner or continuation,
  numeric attemptedAt, checkNo -1) -> "the parser refuses every other
  malformed field" -> the parser's bounds.
- SR137 rung key hashed -> "toOwnerRef hashes a phone-bearing key for EVERY
  owner kind" -> D12/D18.
- BF1240, BF1242 -> "isBroadcastRowFor: ..." -> the three-way row test.
- SR386 drop-absent -> 14c -> an absent record is superseded; no throw loop.
- SR886 record-first -> 14d -> unresolved close: slot before record, and a
  redelivery completes it (D8).
- SR1042 >=0, SR1046 no-return -> 11c -> a twin chain that loses markRedriven
  closes and enqueues nothing.
- SR597, BF1320, BF1330 -> 5f -> a free match whose own dedupe lands on
  another share's row is not adopted (D11).
- SR569, BF1328 -> 5g -> a slot's tsMsgId makes the row mine, at both call sites.
- SR708 drop-system -> 1b -> a known SID the syssid marker holds is never fetched.
- BF1137 -> 1c -> consistent contact read.
- BF1299 drop-failed, BF1337, BF1403, BF1301 always-mms -> 3c -> a provider
  failed 30007 adoption: failed bucket, no property rows, no flag, row type sms.
- BF1300, BF1340 -> 2c -> a success status carries no code; the sent bump
  comes out of queued.
- BF1162 -> 2d -> a unit-less share's milestone refType.
- BF1318 always-named -> 2e -> recipient_contact_id only while the contact
  holds the number.
- BF1352, BF1354 -> 2f -> a skipped adoption: no move, bump, rows or emit.
- BF1381 always-touch, BF1393 never-conv-emit -> 2g -> the inbox moves
  forward only, and a moved thread is announced.
- BF1369, BF1385, BF1409 -> 3d -> the audit row, touch and flag are best-effort.
- SR768 >= becomes > -> 13c -> the lead bound is inclusive.
- SR771 drop-token -> 10b -> exactly 5 pages is not page_bound.
- SR822 no-tick -> 12b -> a non-last unresolved close ticks the results page.
- SR465 drop-roster-keys -> 1d -> a legacy source with no slot resolves
  through the roster.
- SR631 drop-failed, SR636 createdAt-only -> 3f -> relay failed 30007 carries
  its code and the provider's date_sent.
- SR632 -> 3g -> a relay success status carries no code.
- SR642 -> 3h -> a skipped leg adoption emits nothing.
- SR564, SR781 drop-other -> 5h -> a sid# row (a pool announcement) is never
  adopted by a relay owner.
- SR554 -> 5i -> another conversation's pointer is not a repair.
- SR556, SR560 -> 5j -> another member's pointer: no fetch, and the holder is
  redacted (D18).
- SR782 -> 5k -> a mine candidate needs no fingerprint.
- SR788 -> 5l -> a mine candidate whose claim is lost is unresolved, never
  passed over toward a re-send.
- SR716 -> 5m -> a known-SID claim lost to another leg closes unresolved
  rather than stranding the record.
- SR531 -> 8d -> sameFingerprint compares media too.
- SR532 inner-or -> 8e -> a short sibling does not withhold a long attempt.
- SR804 reconciling-only -> 8f -> an attempting sibling withholds never_sent.
- SR1012 record-first -> 14e -> redrive_refused: slot before record,
  completed by the redelivery.
- SR995 drop-row, SR859 no-root-guard -> 15d -> missing source or retry row:
  refused with its cause; the rung announces nothing and does not throw.
- SR639 -> 19b -> an adoption onto a missing row throws (a genuine retry).
- SR694 -> 16c -> the rung's inbox touch is best-effort.
- SR869 rung direction constant -> 16d -> an outbound retry row announces
  outbound (A1).

Equivalent (20):
- SR147 drop-isFinite: parseInt never yields Infinity, and NaN already fails n >= 0.
- SR201 override-empty-ok: parseRelayFanOutPayload (relayFanOut.ts:226-228)
  drops an empty senderNameOverride anyway.
- SR218 continuation-always: an undefined key is dropped by the envelope's
  JSON, and every reader tests === undefined.
- SR393 drop-done: besides done, only a redriven record can share the
  payload's attemptedAt; its slot is queued (finalize defers), a leg's
  afterClose does nothing, and a rung gains one refetch-only emit.
- SR418 never-status, SR870 no-passed, SR892 no-failed: the emit's
  deliveryStatus has no reader. The only server listener forwards it to SSE
  (api.ts:2572-2596), and every dashboard consumer refetches or marks read
  (useRelayThread:496, useContactTimeline:542, useContactMedia:141,
  useMarkContactRead:210, useGroupThread:338). Wherever the slot moved, the
  consistent re-read equals the passed status.
- SR452: an undefined broadcast yields no key, so the key check already returns.
- SR463: the webhook appends every retry row with its member slot
  (twilio.ts:2961) and no writer removes a slot.
- SR485: performance only.
- SR494 and SR736 drop-phone-undef: an empty or undefined phone's digest can
  never equal a real one, so the result is digest_mismatch either way.
- SR532 outer-and: when only one side is short, the hashes of a body under 3
  characters and one of 3 or more always differ.
- SR688 >= becomes >: an equal timestamp rewrites the same value.
- SR688 no-conv-guard: unreachable; conversationsRepo has no delete path.
- SR768 drop-dedupe: a repeated SID is the same message.
- SR822 drop-moved: the repo returns item only when the write moved
  (broadcastsRepo.ts:568-570).
- BF1242 drop-undef-guard: a stored row always has a tsMsgId.
- BF1301 always-sms: the mms arm is unreachable. Broadcast claims record
  mediaCount 0 (broadcastFanOut.ts:840) and the match requires an equal media
  count.
- BF1381 < becomes <=: same state; only one redundant conversation.updated emit.

Unpinned on purpose (2): SR521 always-hash and SR532 always-hash (compare the
short body's hash as well) - see F-2.

## Findings

Neither finding was written as `it.fails`, because neither is unambiguous
against the spec text.

**F-1 (plausible defect, medium): the same-fingerprint guard cannot see a
sibling that claimed before this attempt's window.**
- Where: sendReconcile.ts:739, :744 and :804 (the plan's lookup sketch passes
  the window start as the index lower bound). The index sort key is the claim
  time (sendAttemptsRepo.ts:301, :480).
- Spec: D13 says never_sent is withheld "UNLESS another attempt ... with the
  same fingerprint ... is open or was adopted inside the window".
- Interleaving, with the default delays of 5/30/240 s:
  1. S (a media leg from Alice to Bob, caption C, one photo) claims at t=0.
     The call times out before Twilio creates the message.
  2. O (Alice's next captionless or same-caption photo to Bob) claims at
     t=238. Twilio creates O's message; the response is lost, so O's record
     has no SID.
  3. S's final check at t=240 lists O's message. It is inside S's window and
     free, and it matches S's fingerprint, so S adopts it (pointer or row).
  4. O's checks at 243 and 268 skip the message as held by S.
  5. O's final check at 478 finds no candidate. listByRecipient(since t=178)
     cannot see S, which claimed at t=0. The verdict is never_sent and O is
     re-driven.
- Consequence: Bob receives O's photo twice and S's photo never - the exact
  hazard D13 and Sec 1 guarantee 1 guard against. Count-neutral for identical
  text bodies.
- Fix direction: widen the sibling lower bound to cover any chain that could
  still adopt inside the window, for example windowStart minus the last check
  delay.

**F-2 (observation; the code follows the spec's letter and deviation 1): a
short-body record matches ANY short candidate with the same media count**
(sendReconcile.ts:521, :532).
- Relay legs are composed as "<Name>: <body>" (relayFanOut.ts:255-258), so a
  media-only leg from a member whose display name normalizes to fewer than 3
  characters (a first-name-only contact such as "Al" or "Jo") is short.
- Two such members' orphaned photo legs to one recipient can adopt each
  other's messages, which swaps the photos and their receipts.
- An adopted short sibling also withholds the other's genuine never_sent, so
  it closes unresolved instead of being re-driven.
- The surviving mutants (also compare the short normalized body's hash)
  remove both effects and add no double-send path, since NFKC plus the
  letters/digits filter already absorbs Smart Encoding. Not pinned; for the
  orchestrator to adjudicate against deviation 1.

Note, S3a residue 6 extended: a known-SID relay adoption onto a missing row
claims the relaysid pointer (:628) before it throws (:639); every retry
re-finds that pointer and throws again, leaving a pointer to a row that does
not exist. Unreachable in practice (relay rows are never deleted).

## Not covered

- Log-only fields: recordClosed, the continue reason, the holder text for
  broadcast rows.
- The lazy dependency wiring in registerSendReconcileJobHandler.
- Code outside S3a's slice: finalize, the send sites (S2), the classifier and
  adapter, and the rest of broadcastFanOut.ts beyond the adoption half and
  recordPropertySent.

Scratch (mutant driver, specs, per-mutant logs and JSON, pristine copies,
results tables) is in the session scratchpad `S3b\`.

## Orchestrator checkpoint and adjudications

Verified at 6ab1370b: only `app/test/sendReconcile.test.ts` changed; no
`app/src` diff; the stray `app/2.json` is absent; 0 non-ASCII bytes in the
added lines; `sendReconcile.test.ts` + `sendReconcile.integration.test.ts`
re-run EXIT=0 (94 passed).

- F-1: ACCEPTED as a defect against D13's intent (the sibling "was adopted
  inside the window" - S adopted a message inside O's window - yet the query
  bounds the sibling by its CLAIM time). Routed to the review fix wave as a
  must-fix: the sibling lower bound becomes the window start minus the last
  lane-aware check delay (`reconcileCheckDelaysMs()`), with a test for the
  interleaving above.
- F-2: ACCEPTED in the safe direction, routed to the same fix wave: the match
  rule becomes body hash AND media count for EVERY body (the short-body
  special case disappears; the spec's own definition of a fingerprint in D13's
  same-fingerprint sentence is exactly "body hash and media count"). A
  non-matching own orphan is an UNMATCHED candidate, which ends `unresolved`
  at the final check, never `never_sent`, so tightening the match cannot
  produce a re-send. Recorded as a spec-text deviation (extending S3a's
  deviation 1) for the handback.
