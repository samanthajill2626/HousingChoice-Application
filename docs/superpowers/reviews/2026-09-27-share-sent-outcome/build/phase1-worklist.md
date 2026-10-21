# Phase 1 worklist - share-sent-outcome build (orchestrator drift check, 2026-09-28)

## Drift verdict: NONE

- `git diff --stat cebc7d23 HEAD -- app dashboard e2e fake-twilio scripts package*.json RUNBOOK.md README.md` is EMPTY.
  Every commit since the research cut (92e6e2fc..a8a75e8e, 10 commits) is docs-only
  (spec restatement, two research records, plan v1-v5 + adjudications, the mission block).
  => every `path:line` in the plan, in `research-1b-as-built-findings.md` and in
  `research-surfaces-refresh-findings.md` (and their gitignored references) holds at HEAD a8a75e8e.
- `git log --oneline HEAD..main` is EMPTY; merge-base = 3f38bcc2 = main HEAD. Zero behind main.
- No `.git/MERGE_HEAD`. Tree clean. Deps installed (`npm ci` EXIT=0). DynamoDB Local container up.

## Anchors re-verified by reading at HEAD

| anchor | holds |
|---|---|
| `app/src/routes/webhooks/twilio.ts:3529` gate `broadcast_id ... && message.retry_of === undefined` | yes |
| `twilio.ts:3904` give-up WARN, non-ASCII (U+2014) - re-word in ASCII when touched | yes (3 non-ASCII bytes) |
| `app/src/repos/broadcastsRepo.ts:68` `MAX_BROADCAST_RECIPIENTS = 1500` | yes |
| `broadcastsRepo.ts:136` `BroadcastRecipient`; `:702` `priorRecipientContactIds` | yes |
| `broadcastsRepo.ts:740` non-ASCII line (3 bytes) | yes |
| `app/src/repos/listingSendsRepo.ts:136` `recordSend`; `:182` `listByUnit` | yes |
| `app/src/jobs/retrySend.ts:798-802` handOff catch; `:859-861` onUnknown second-unknown branch | yes |
| `app/src/jobs/sendReconcile.ts:541-543` found arm (`closeFromReconcile(adopted)` at :542); `:1366-1368` closeSlot retry_send arm (WITHDRAW) | yes |
| `app/src/services/retryChain.ts:31` `RETRY_ROOT_WALK_MAX_HOPS = 16` | yes |
| `dashboard/src/routes/broadcasts/BroadcastResults.tsx:74` non-ASCII (3 bytes) | yes |

## Invariant sweep (protected state = share slots + stats; the listing-send ledger)

Slot/stats WRITERS in `app/src` at HEAD (grep of the repo methods) - all named by the research map section A:
- `broadcastFanOut.ts`: `closeRecipientIfQueued` :452, :563, :786; `recordRecipientOutcome` :543, :739, :941, :1407 (adoption); `bumpStats` :664, :703, :1002; `setRecipient` :1498 (`recordRecipient`); `finalizeStatus` :1542.
- `sendReconcile.ts:1332` `closeRecipientIfQueued` (the share owner's close).
- `routes/broadcasts.ts:747` `markSending`, `:769` `markFailed`.
- `webhooks/twilio.ts:3924` `setRecipient` (sent branch), `:3949` `setRecipient` + `:3975` `bumpStats` (terminal branch, SOR's two-write residue - NOT widened).
- NEW in this branch: `applyAttemptOutcome` (T1) called ONLY through `applyLaterAttempt` (T4) from the webhook retry path (T5), the reconcile adoption + unresolved close (T6), the job's two arms (T6), the repair (T13).

Slot/stats READERS at HEAD: `deriveBroadcastStats` callers - `twilio.ts:3936`, `:3981`, `routes/broadcasts.ts` results :293 + list :311, `broadcastFanOut.ts` finalize :1536/:1563 + emit :230; `priorRecipientContactIds` route :523 + harness :3367 (DELETED in T8, replaced by `priorRecipientKeys`); the results route's `enrichRecipients`; the SSE payload consumers (dashboard hooks T10); units activity + landlord timeline (D5, T11 - read the share by id).

Ledger WRITERS at HEAD: ONE - `broadcastFanOut.ts:1239` `recordSend` (pass + adoption); seeds write raw items (`lib/seed/cast.ts`, `matrix.ts`). After this branch: `putShareMemory` through `applyShareLedgerEntry` only (T3/T4/T5/T7/T13); `recordSend` DELETED in T7.
Ledger READERS at HEAD: `routes/contacts.ts:1168` `listByContact`; `routes/units.ts:946` `listByUnit`; `lib/seed/history.ts:995-1008` (one milestone per row - must skip `counted === false`, T3); the tour form default (dashboard, reads the API); NEW: `getByKeys` for the milestone words (T12).

## Spec-vs-tree flags (all already recorded by the research maps M1-M11; nothing new found)

- The `retry_of` rollup skip (M1) is the interim the spec restatement names; T5 removes it and rewrites the pin at `twilioStatusWebhook.test.ts:374`.
- No bare `GET /api/broadcasts/:id` (M5): `?view=stats` goes on `/results` (Cameron's ruling).
- Pins that FLIP are enumerated per task in the plan (T1 identity pin holds; T7, T8, T9, T10, T14). Everything else red = regression.

## Per-slice worklist (the plan is the byte-exact source; tasks by line range in `docs/superpowers/plans/2026-09-28-share-sent-outcome.md`)

- Header (deviations 1-16, Global Constraints, Review Focus, file structure, shared interfaces): lines 1-205.
- S1: T1 :209-556, T2 :559-962, T3 :965-1286.
- S2 (order T4, T7, T5, T6): T4 :1289-1625, T7 :1968-2059, T5 :1628-1776, T6 :1779-1965.
- S3: T8 :2062-2125, T9 :2128-2224, T10 :2227-2321, T11 :2324-2416, T12 :2419-2506.
- S4: T13 :2509-2683, T14 :2686-2718, T15 :2721-2745.

## Orchestrator-owned deliverables (not owned by any slice)
- Slice reports committed under `docs/superpowers/reviews/2026-09-27-share-sent-outcome/build/`.
- Review round records under `.../code-review/`; fix-wave report; self-QA; handback.
- Issue filings the review finds out of scope.
