# Code review round 3 - fix wave 3 (FW3) - decisions record

Date: 2026-10-13. Branch `feat/last-heard-from`, base dec2346a (round-3
adjudications). Scope: the two ACCEPTED code/test items of
`adjudications-round3.md` - B R3-1 (Undo compare-and-clear) and A R3-1 (PIN
comment). A R3-2 (glossary) and B R3-2 (no change) were the orchestrator's.
Strict TDD: a RED test before the behavior change, run and confirmed red for
the stated reason. No slow gate run (no `npm test`, `npm run e2e`,
`npm run smoke`); Playwright not run.

## Commits (one per item)

| item | commit | what |
|---|---|---|
| 1 B R3-1 | ba87df0e | Undo (`clear`) is a compare-and-clear on the decline it READ; an Undo that read none writes nothing |
| 2 A R3-1 | 78063be9 | durable-supersession PIN comment states the creation-only limit; one PIN case shows it |

`npm run typecheck` exit 0 after each commit. eslint exit 0 on every touched
`.ts` file. Every added line ASCII (checked on the diff).

## 1. B R3-1 - Undo compare-and-clear (ba87df0e)

- Route `app/src/routes/units.ts:1392-1421` (the `clear` branch). When the row
  read at request time carries a decline, the clear passes
  `{ expectedAt: <its at> }` (:1408); on 'ok' it sets `wrote` and records
  `listing_decline_cleared` (:1409-1418). When it carries none, there is no
  clear call at all and `wrote` stays false.
- Decision (the dispatch asked to decide and state it): a 'not_found' from
  the compare-and-clear is NEVER a 404 for Undo - the row was counted when
  read. It records no event and falls through to the re-projection, which
  answers a re-declined row (200 not_interested) or, for a row that stopped
  counting, the plain 503 (no `saved`: nothing was written). `send_not_found`
  stays the pre-write ledger check's answer alone (:1261-1265). This mirrors
  the Interested branch (fix wave 2, B R2-1). Stated in the branch comment
  (:1393-1405) and the route header (:1218, :1230-1237); the SAVED paragraph
  and the `wrote` comment (:1289-1292) now name "a clear that answered 'ok'"
  and add "a lost compare" to the no-write cases.
- RED, `app/test/listingSendOutcomeApi.test.ts` (4 failed / 41 passed on the
  old route):
  - :220 (c) the ordinary Undo - clearDeclined was called WITHOUT
    `{ expectedAt }`;
  - :237 (a) a re-decline injected inside the harness clear - same failure;
    on the old code the re-decline was removed;
  - :260 (b) no decline read, another staff member's decline injected in the
    recipient read (between the row read and the clear - Reviewer B's proof
    shape) - clearDeclined was called once (and removed it);
  - :283 a lost compare on a row that stopped counting - expected 404 to be
    503.
- Beyond (a)/(b)/(c): the :283 case pins the "never a 404 for Undo" decision.
- Existing Undo cases stay green unchanged: :156 (clear after a decline),
  :171 (nothing to undo, no event), :181 (nothing to undo -> plain 503),
  :198 (removed a decline -> 503 saved:true).

## 2. A R3-1 - PIN comment (78063be9)

- `app/test/listingSendOutcome.test.ts:107-113`: the durable-supersession PIN
  header states the known limit (spec 14.7): only a tour's CREATION is
  durable; a reschedule / reopen after a decline supersedes while the tour
  qualifies, but a later cancel / no-show / not-a-fit overwrites the single
  `lastMarkedAt`; a durable revival would need the tours PATCH to clear the
  decline (a product call).
- PIN case :157: a tour created before the decline and rescheduled after it
  -> interested; the same tour later canceled -> not_interested. Green on
  unchanged code by design.

## Not changed / notes

- No caller now uses the bare (opts-less) `clearDeclined`. The optional
  `opts` and the idempotent bare form remain in the repo interface
  (`app/src/repos/listingSendsRepo.ts:211`) and its integration and parity
  tests - a contract surface this wave was not ruled to change.
- Undo records `listing_decline_cleared` on 'ok' whatever the decline's
  effectiveness (as before, keyed on the read record); the ruling asked for
  no effectiveness check.
- A STALE card's Undo still acts on the decline the server reads (A's
  stale-card race) - filed as
  `docs/issues/outcome-actions-act-on-server-read-decline.md`, not this wave.

## Test runs (final, after the last code commit)

- app: listingSendOutcomeApi 45, listingSendOutcome 47, listingSendTour,
  listingSendsApi, listingSendsRepo.integration,
  twilioWebhookHarnessRepoAdditions.integration - 6 files, 181 passed; no
  `[dynamoAdmin]` line.
- `npm run typecheck` exit 0.
