---
id: org-rewrite-pass-start-pacing-gap
title: An org.rewrite pass paces its first lock check from the pass start, so a stall just before a pass (a late-landing claim write, the previous pass's last page read) lets up to 20 s of records be written under a lapsed lock
type: bug
severity: low
status: open
area: app/jobs
created: 2026-10-07
refs: app/src/services/orgRecords.ts:501, app/src/jobs/orgRewrite.ts:128, app/src/jobs/orgRewrite.ts:150, app/src/services/orgRewrite.ts:272, app/scripts/clean-org-names.ts:669
---

**Problem.** The rewrite pass (`OrgRecordsService.rewrite`) checks its heartbeat before
every record but at most every 20 s, and starts that pacing clock fresh at the start of
each pass (`let lastBeat = Date.now()`, `app/src/services/orgRecords.ts:501`); the job
calls it once per field. Time spent BEFORE a pass is therefore invisible to it:

- (a) The job's claim stamps `heartbeatAt` when the claim is computed, before its Put is
  sent (`app/src/services/orgRewrite.ts:272`). A Put that lands about 16 minutes later
  (the DynamoDB client sets no request timeout) stores a heartbeat that is already stale.
  An add of the rewrite's from-text then passes (the lock looks lapsed), staff save a
  record with that new exact name, and the first records of pass 1 - inside its 20 s
  pacing window - are written with no lock check: the new exact name is cleared or
  rewritten, and the job finishes `done`.
- (b) A two-pass rename or merge of a housing authority: a stall in pass 1's LAST page
  read (which visits no record, so no beat follows) is followed by pass 2 writing
  unchecked for up to 20 s.
- The cleanup script has the same start gap (`app/scripts/clean-org-names.ts:669`:
  `lastBeat` starts after `peek()`), where it is benign.

Found by the round-4 code review of feat/clean-org-names (R4-1,
`docs/superpowers/reviews/2026-10-06-clean-org-names/code-review/R4.md`), reproduced in a
fake world. Same 15-minute-stall trigger as the closed R3-BE-1; LOW because it also needs
the staff add and save inside the first seconds of a pass. The comments in
`app/src/jobs/orgRewrite.ts`, `app/src/services/orgRewrite.ts` (claim step c) and
`app/src/services/orgRecords.ts` name this residual.

**Suggested fix.** (1) Let the job's `leasedHeartbeat` own the pacing - ONE clock across
passes, started when the claim is sent; the pass calls it before every record and it calls
through once 20 s have passed since the last send (minimal alternative: start each pass at
`lastBeat = Number.NEGATIVE_INFINITY`, one extra list write per pass). (2) Judge an answer
by its round trip: a claim or heartbeat that answers true at or after
`sentAt + ORG_REWRITE_LEASE_MS` counts as lost. (3) Cleanup: start `lastBeat` at
`lockedAt`.
