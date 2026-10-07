# Code review round 4 - adjudications (orchestrator)

- One fresh reviewer (R4) on fix wave 3 (FW3-A 284d7a71..0d278206, FW3-B
  053accdc..ebb0d0c4), both halves, plan-blind. Counts: CRITICAL 0, HIGH 0,
  MEDIUM 0, LOW 2, INFO 1. No MEDIUM+ regression from wave 3; every wave-3
  fix is real (B20 run against the pre-fix composer; the others traced).
- Round-3 stop rule: after wave 3 a LOW/INFO is filed, and only a MEDIUM+
  regression reopens the review loop. None was found, so the review loop is
  CLOSED. Two of the three items are one-line fixes in code this branch
  already changed; they are taken as a micro-wave (FW4) verified by the
  orchestrator with a revert check per fix (the tour-auto-close precedent: a
  tests-first one-liner verified by a hand-applied mutant needs no further
  review round).

## Rulings

| finding | severity | ruling | where |
|---|---|---|---|
| R4-1 a pass paces its first lock check from the pass start: a late-landing claim write, or a stall in the previous pass's last read, lets up to 20 s of records be written under a lapsed lock | LOW (a residual of A11; same 15-minute-stall trigger as R3-BE-1, plus a staff add and save inside a pass's first seconds) | FILE - the fix moves the pacing clock across passes (an architecture change that would need its own review); the four comments that overclaimed are corrected to name the residual | `docs/issues/org-rewrite-pass-start-pacing-gap.md`; comments in jobs/orgRewrite.ts, services/orgRewrite.ts (claim step c), services/orgRecords.ts |
| R4-2 composer: a change reverted before its create lands leaves Preview disabled beside "Sizing the audience..." until another edit (pre-existing at d839494a, in the effect wave 3 edited) | LOW | FIX (one branch: clear reachPending, stale and error when the screen matches the live draft again) | FW4 B26 |
| R4-3 after a failed RE-read, an EMPTY picker is still disabled although the list is in hand | INFO | FIX (one expression, in the shared hook and AudienceFilters: disable an empty picker only when no list was ever loaded) | FW4 B27 |

## Fix specifications (FW4)

- B26 (R4-2). In `dashboard/src/routes/broadcasts/useComposerDraft.ts`, the
  draft effect's early-return branch (the key equals the live draft's again)
  also clears `reachPending`, `stale` and `error`. RED: the reviewer's T5 -
  type "X" then Backspace inside the debounce -> Preview stays disabled with
  "Sizing the audience..."; after the fix Preview is enabled again.
- B27 (R4-3). `disabled` for an EMPTY picker under a failed list uses
  `orgListUnknown(list)` (no list ever in hand), in
  `dashboard/src/routes/orgs/useTypedOrgText.ts` and the same rule in
  `AudienceFilters.tsx`. RED: the reviewer's R4-4 - after a failed re-read,
  clearing "Hope" in Agency must leave it enabled.
