# Planner verdict - permanent flyer links

Date 2026-10-28. Branch `feat/permanent-flyer-links` at 7d1229d9 (last code
commit 595ca503), 0 behind main 71fb9b45. Verdict: MERGE-READY.

## Gates (planner, bare, quiet tree, 13:41-14:02Z)

Logs: `.superpowers/sdd/planner-gates/` (run state).

| Gate | EXIT | Notes |
|---|---|---|
| `npm run typecheck` | 0 | |
| `npm run smoke` | 0 | |
| `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- ...)` | 1 | 4 errors, all `react-hooks/set-state-in-effect`: FlyerPage.tsx x2, BroadcastComposer.tsx x2. Baseline: main's copies of both files report 2 errors each - pre-existing, none new |
| `npm test` | 0 | app 545 files / 11798 + 1 skipped; dashboard 273 / 5658; e2e unit 22 / 509; fake-twilio 34 / 275; fake-twilio-web 13 / 111. No `[dynamoAdmin]` warn line (the two log hits are test names) |
| `npm run e2e` | 0 | 385 passed (17.1m) |

## Review

- Orchestrator: two code review rounds + three fix waves; self-QA 13
  scenarios, no defect (self-qa.md).
- Planner: spec-conformance and plan-blind adversarial reviewers on
  3635160e (planner-review/); rulings in planner-review/adjudications.md.
  Q1 answered by Cameron (option c, intent.md decision 8); FW3 applied the
  wording, PC-2 and PA-7. Planner read f6ee0a76 (behavior-identical swap).
- Planner did NOT run a separate live session; live evidence is the
  orchestrator's self-QA plus the e2e suite on the final code (new
  fallback, Occupied flyer, status pin and D3a tests).

## For Cameron (not blocking)

1. At deploy every imported property not in Setup serves its flyer
   (accepted, option c).
2. A non-Available flyer keeps the Available copy except the listing link
   ("Same-day tours available", "Interested in this home?", the thank-you
   "about this home") - Sam may want to review the wording.
3. Fallback sign-ups land in Needs review with no housing authority, and
   the authority backfill skips them.
4. The whole repository is public on GitHub (README records a private
   repo) - separate decision.

Post-merge: none (no infra, backfill, dependency or env var). Deploy is
Cameron's call.
