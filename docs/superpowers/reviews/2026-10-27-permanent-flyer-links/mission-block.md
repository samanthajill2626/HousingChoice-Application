# MISSION: Permanent flyer links
Worktree: W:\tmp\permanent-flyer-links  Branch: feat/permanent-flyer-links  (cut from main @d0e2c2d8)
Profile: W:\tmp\permanent-flyer-links\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md (rev 3, APPROVED)
Plan: docs/superpowers/plans/2026-10-27-permanent-flyer-links-plan.md (v2, final)
Design review: spec R2 (closed), plan R1 (closed) - adjudications at
  docs/superpowers/reviews/2026-10-27-permanent-flyer-links/design-review/adjudications.md
  docs/superpowers/reviews/2026-10-27-permanent-flyer-links/plan-review/adjudications.md
Records: docs/superpowers/reviews/2026-10-27-permanent-flyer-links/ (commit as produced)
Work map:
  T1 FLYER_PUBLIC in the app status model + re-export (D1)
  T2 Flyer API serves FLYER_PUBLIC; listing_link null off Available (D2, D3a)
  T3 Sign-up attribution + pin status suffix; drop the unused SHAREABLE import (D5, D6)
  T4 Dashboard FLYER_PUBLIC mirror + cross-workspace mirror test
  T5 FlyerPage neutral fallback stage (D4)
  T6 Property page flyer line (D7)
  T7 Broadcast staff copy only; guard unchanged (D8)
  T8 Docs and comment sweep (spec section 4) incl. selectors.md fallback row
  T9 e2e: public-pages, listing-photos, environment-identity, broadcasts, new Occupied sign-up in flyer-leads
  T10 main sync once, gates, self-QA, records
Watch items: plan section 3 (WI1-WI8). Key traps: SHAREABLE keeps governing
  broadcasts; 'not_shareable' audit value keeps its name; Setup is NOT a
  take-down (never document it as one); seeded units read-only in e2e
  (unit-0001 stays under_application); FlyerPage fallback tests must await
  the h1 before absence checks; never edit dashboard/app source while this
  worktree's e2e runs.
Gates (bare, from the worktree, real exit codes):
  npm run typecheck; npm test; npm run smoke; npm run e2e;
  npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
Post-merge obligations already known: none expected (no infra, no data
  backfill, no new dependency). Deploy is Cameron's call.
