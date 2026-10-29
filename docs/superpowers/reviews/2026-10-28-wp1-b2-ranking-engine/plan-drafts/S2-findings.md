# S2 plan draft - findings for the planner

Draft: `.superpowers/sdd/plan-draft-S2.md` (plan section 6).

## F1 - A startup rule the spec does not state: RANKING_PAIR_TTL_DAYS >= RANKING_MAX_AGE_DAYS

- Charter 10.2 (docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md,
  the "ranking-job record lives in the AI runs table" sentence) requires the
  job record's TTL to be "at least `RANKING_MAX_AGE_DAYS`", because its
  failed-batch list must outlive the matches it flags.
- Spec D7 sets the job's `expires_at` to now + `RANKING_PAIR_TTL_DAYS`, and
  D19 lets both variables be any positive integer. A configuration such as
  `RANKING_PAIR_TTL_DAYS=5` with the default `RANKING_MAX_AGE_DAYS=7` would
  break the charter's rule with nothing to catch it.
- Draft's choice (S2.1, `parseRankingConfig` in app/src/lib/config.ts):
  startup THROWS when `RANKING_PAIR_TTL_DAYS < RANKING_MAX_AGE_DAYS`
  (pinned by `configRanking.test.ts`, "RANKING_PAIR_TTL_DAYS below
  RANKING_MAX_AGE_DAYS stops startup"). The defaults (180 >= 7) are
  unaffected; no deployed configuration changes.
- Ruling needed: keep the refusal (my recommendation - it is the charter's
  invariant made fail-fast, in the file's own style), or drop it and accept
  that the invariant rests on the defaults.
