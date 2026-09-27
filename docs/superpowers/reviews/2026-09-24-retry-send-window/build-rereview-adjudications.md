# Retry send window build - re-review adjudications (build orchestrator)

Branch `feat/retry-send-window` @ `72e1ae95` (fix wave `5a6cf53a..72e1ae95`),
merge base `da04d0cb` (= `main`, not moved). Input: `build-rereview.md` (fresh
re-reviewer: the fix wave is REAL and behavior-preserving; 0 blocker, 0 major,
0 minor; NITs N1 and F1; challenges to C4, A2 and A10). Adjudicated 2026-09-26
by the build orchestrator (a fresh orchestrator resumed after the previous one
died on a usage limit; see the worktree ledger).

Orchestrator's own check of the fix wave before the re-review, at `72e1ae95`:
clean tree; 0 non-ASCII bytes added or removed; diff read in full; typecheck
EXIT=0; 15 app test files, 524 tests, EXIT=0, no `[dynamoAdmin]` line; 5
dashboard test files, 239 tests, EXIT=0.

| # | Finding | Verdict | Reason / instruction |
| --- | --- | --- | --- |
| N1 | NIT: a dashboard tab loaded before the deploy renders a window-declined relay leg as "Delivery failed (error retry_window_closed)" | NOTE + a dated note on the existing issue | Confirmed by the re-reviewer's probe against the base bundle. Nothing in this branch can change code already in people's browsers. The handback's deploy note says: reload every open dashboard tab after the deploy (nothing forces a reload - there is no build-stamp check in `dashboard/src`); the same reload clears A10's two items and the old "will retry on every 30003" copy. The structural fix (a build-stamp check that prompts an open tab to reload) is already filed as `optional-call-outcome-breaks-already-loaded-bundles`; add a dated note there naming this branch's three already-loaded-bundle effects, so the class is visible where its fix lives. |
| F1 | NIT: the new issue `one-to-one-retry-promise-outlives-job-decline` says spec section 9 accepts exactly this class | FIX (doc) | Verified against the spec (`docs/superpowers/specs/2026-09-24-retry-send-window-design.md`, section 9, "A promise with nothing behind it"): it enumerates an automated retry the breaker refuses at send time, a failed-read fail-open the job then refuses, the D4 window at send time, a provider send failure, an enqueue failure whose correction write failed too, and a crash or throw between the stamped write and the enqueue. It does NOT list a refusal whose cause arose DURING the backoff after successful reads (a STOP, the kill switch, manual mode on an automated original's thread, a soft-delete, lost consent), nor the original-missing / not-outbound exits. Reword the issue to separate the two groups: the first is accepted by section 9; the second is newly found by the build review and is Cameron's call (his gate answer 3 - "will retry" only when a retry will actually be attempted - bears on it). |
| 4.1 | C4 fixed only the versioned WINDOW decline; the versioned GATE decline's root slot is unpinned (a root-slot write on every gate decline survives all 54 tests) | FIX (test) | Spec section 6 intention 2 ends "the slot on the root is unchanged in every case". Add the root-slot `toEqual` to the versioned team-send gate-decline case (`relayRetryClaim.webhook.test.ts`, "a TEAM send declined at the claim keeps its mirrored shape and its gate code") or the versioned data-shape row, and prove the re-reviewer's surviving mutant now fails. |
| 4.2 | A2: agree with FILE, not with its recorded reason | ACCEPT | The recorded reason in `build-review-adjudications.md` row A2 ("Spec section 9 ... accepts exactly this class") is corrected here: section 9 accepts only part of the class (F1). The FILE outcome stands - the fix is new worker writes and emits after the execution marker, beyond the approved spec, for at most about 3 minutes on rare exits - and the handback puts the during-backoff refusals to Cameron as an open question, not as ruled. Withdrawing a promise changes only the screen, never whether a text is sent, so a fix would not conflict with ruling 4. |
| 4.3 | A10: the deploy note is incomplete | ACCEPT | The handback's deploy note covers N1 as well as A10's two items, and says nothing forces a reload (see N1). |

Every other re-review position is agreement (C1, C2, C3, C5, A1, Q4, A3-A9, Q1-Q3,
Q5); no row changes.

## Fix wave 1b (re-review NITs)

One small fresh implementer: 4.1 (the versioned gate-decline root-slot assertion,
with the mutant proof), F1 (the issue reworded), and N1's dated note on
`optional-call-outcome-breaks-already-loaded-bundles`. Test and docs only - no
production code changes. The orchestrator verifies it cold, re-running the
re-reviewer's surviving mutant itself, then re-runs all five gates on the final
commit.
