# Code review round 2 - adjudications (orchestrator)

- Fresh re-reviewers on fix wave 1 (FW-A 1575a305..155d5e36, FW-B
  579ae6c2..55f1294d), plan-blind, charged in order: what round 1 missed,
  the fix diff cold, challenges to round-1 rulings, then "are the fixes
  real". R2-BE: 0 CRITICAL, 0 HIGH, 1 MEDIUM, 1 LOW, 5 INFO. R2-FE: 0
  CRITICAL, 0 HIGH, 3 MEDIUM, 5 LOW, 2 INFO.
- Verdict on wave 1: all fourteen fixes are real (each new test fails on the
  pre-fix code), but B1, B4, B6, B8 and A1/A3/A5 are incomplete as found
  below - the "fix waves ship defects" pattern again. Fix wave 2: two
  sequential children, FW2-A (backend) then FW2-B (dashboard + e2e), every
  item test-first; then a fresh round-3 re-review of the wave-2 diff.

## Rulings

| finding | severity | ruling | where |
|---|---|---|---|
| R2-BE-1 a job delivered after its lock lapsed runs unvalidated; heartbeat revives a lapsed lock | MEDIUM | FIX (challenge to A1 upheld) | FW2-A A6 |
| R2-BE-2 the new cleanup counters miss the abort path and the lock; done line stays INFO | LOW | FIX | FW2-A A7 |
| R2-BE-3 recordsWithBlankValues counts a blank agency the same run overwrites | INFO | FIX (same function) | FW2-A A8 |
| R2-BE-4 a blank member defeats "drop an agency unless that empties the list" | INFO | FIX (one condition) | FW2-A A9 |
| R2-BE-7 the cleanup's lock compares the operator machine's clock with the servers' | INFO | DOC: one RUNBOOK sentence (sync the clock first); no code | FW2-A A10 |
| R2-BE-5 a property edit's blind list SET can undo a concurrent rewrite | INFO | ACCEPT - the S6 check-then-write residual already ruled (RB-4); the record reappears in "Not on the list" | handback |
| R2-BE-6 extraction resolves on a snapshot taken before the model call | INFO | ACCEPT - ruled residual RG-3 | handback |
| R2-FE-1 a failed list read with typed text in a picker blocks Save for good | MEDIUM | FIX | FW2-B B10 |
| R2-FE-2 removing a chip wipes typed text, then Save succeeds without it | MEDIUM | FIX | FW2-B B11 |
| R2-FE-3 composer: typed-not-picked filter + Preview = unfiltered send | MEDIUM | FIX (challenge to B1's composer ruling upheld; D7 kept - no per-keystroke recreate) | FW2-B B12 |
| R2-FE-4 B8 groups placeholder values the server never groups | LOW | FIX | FW2-B B13 |
| R2-FE-5 one hung poll read freezes the Settings status | LOW | FIX | FW2-B B14 |
| R2-FE-6 the blur note says "Not saved" for text Save then commits | LOW | FIX (truthful note) | FW2-B B15 |
| R2-FE-7 B6 does not cover a renamed entry | LOW | FIX | FW2-B B16 |
| R2-FE-8 the blur note reflows the form between mousedown and mouseup | LOW (plausible) | FIX (reserve the line while text is pending) | FW2-B B17 |
| R2-FE-10 a repeated refused Save is silent to a screen reader | INFO | FIX (cheap) | FW2-B B18 |
| R2-FE-9 no e2e covers the new typed-text behavior | INFO | FIX - AGENTS.md asks for a spec for new UI behavior | FW2-B B19 |
| Note on the filed issue org-rewrite-single-message-pass ("safe by design") | - | update the issue text after A6 | FW2-A A10 |

## Fix specifications

### FW2-A (backend)

- A6 (R2-BE-1). The org.rewrite job CLAIMS its rewrite atomically before any
  pass: one org-list mutate that (a) answers not_current unless `lastRewrite`
  is this jobId and `running`; (b) when its heartbeat is STALE
  (`ORG_REWRITE_STALE_MS`), re-validates exactly as Run again does - target
  names still entries of the expected kind, and no from-text now normalizes
  equal to the NAME of an entry its `fields` accept other than `toName`
  (extract Run again's two checks into ONE shared helper used by both) - and
  on a refusal finishes the rewrite `failed` with an error naming the
  reason, so the queued message can never run it; (c) writes a fresh
  heartbeat. `heartbeat(jobId)` answers false (writes nothing) when the stored
  heartbeat is already stale - a lapsed lock is no longer the caller's; the
  pass stops (`lock_lost`, no finish) and Settings offers Run again, which
  re-validates. With the claim refreshing the heartbeat, no record is written
  before a fresh beat. Tests: RED - the reviewer's interleaving (a Clear
  queued, the lock lapses, the from-text is added as a name and a tenant set
  to it, the job is delivered late) -> the tenant keeps the name and the
  rewrite ends `failed`; RED - heartbeat on a stale lock answers false; PIN -
  a late job whose re-validation passes runs to `done`; PIN - a fresh job
  runs as before. Update `orgRewriteJob.test.ts` cases that relied on a
  lapsed lock running (their lock heartbeat must be fresh, or the case must
  assert the new behavior) - say which in the report.
- A7 (R2-BE-2). `flatCounts` carries `auditFailed` and
  `recordsWithBlankValues`, so every log line (PARTIAL, COMPLETED, the lock
  release failure) and the lock's stored counts include them; the done line
  logs at WARN when `auditFailed > 0`. One test on the abort path.
- A8 (R2-BE-3). Count blank values from the plan's outcome: a record counts
  only when a blank field is one the write leaves as it is.
- A9 (R2-BE-4). `planUnit`: "unless that would empty the list" counts only
  non-blank, non-agency members as remaining.
- A10. RUNBOOK cleanup section: one sentence - run it from a machine whose
  clock is synced (its rewrite lock compares this machine's timestamps with
  the servers'). Update `docs/issues/org-rewrite-single-message-pass.md` so its
  safety claim names the job's claim (A6) for a delivery after the lock lapsed.

### FW2-B (dashboard + e2e)

- B10 (R2-FE-1). The forms never block Save on a picker the user cannot edit:
  while the list failed to load, the typed-text guard skips that picker (its
  value stays unchanged) and the load-error text stays visible (the typed-text
  alert never replaces it); while the list is still loading, a Save with typed
  text is refused with "Still loading the list - try again in a moment."
  (copy in orgCopy.ts), not the unknown-text copy. Tests for both paths in
  the tenant form and one property form.
- B11 (R2-FE-2). Removing a chip no longer discards typed text: the text stays
  in the input and keeps being reported, and Save settles it (single: a
  resolved name replaces; multi: it is added). Tests: single and multi.
- B12 (R2-FE-3). Composer: AudienceFilters forwards the picker's typed text;
  "Preview recipients" is disabled while the housing authority picker holds
  typed text, with the hint "Pick the housing authority from the list, or
  clear the text." The draft is still recreated only on a pick or a clear.
  Test: typed exact name -> Preview disabled, no preview call; pick -> enabled.
- B13 (R2-FE-4). The settle confirm groups rows by the server's equality:
  key = normalized text when it is not '', else `exact:` + the trimmed value.
- B14 (R2-FE-5). A poll read older than about 5 x pollMs is aborted and
  restarted (skip-while-in-flight stays for younger reads). Keep StrictMode
  safety and the existing StrictMode tests. Test: the first poll read never
  settles -> a later read lands and the status advances.
- B15 (R2-FE-6). The blur note tells the truth for its host: in the forms,
  typed text that settles to one entry -> "Save will use <name>."; text that
  does not -> "Not saved - pick a name from the list, add it as new, or clear
  the text."; in the composer -> "Not used as a filter - pick a name from the
  list, or clear the text." Use ONE shared settle helper (in orgCopy.ts or
  beside OrgPicker) for both the note and the forms' Save, instead of three
  copies of the rule.
- B16 (R2-FE-7). A provisional entry (noteAdded) wins over a read entry with
  the same orgId until a read returns that name, so a renamed entry used
  from the dialog never reads "Not on the list".
- B17 (R2-FE-8). Reserve the note's line under the input while the picker
  holds typed text (fill the text on blur), so a blur never reflows siblings
  between mousedown and mouseup.
- B18 (R2-FE-10). Each refused Save re-announces its alert (key the alert on
  an attempt counter, or equivalent).
- B19 (R2-FE-9). e2e (`e2e/tests/dashboard-next/org-lists.spec.ts`): (1) a
  tenant's Housing authority typed as an exact list name and saved WITHOUT
  picking is stored as that name; (2) unresolvable typed text blocks Save
  with the alert and saves nothing; (3) the composer's Preview is disabled
  while typed text is pending. Run only that spec through the e2e workspace.
