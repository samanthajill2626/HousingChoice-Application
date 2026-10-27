# MISSION: WP1 B1 Ranking inputs (Amendment No. 1, slice 1 of 4)
Worktree: W:\tmp\wp1-b1-ranking-inputs  Branch: feat/wp1-b1-ranking-inputs  (cut from main @d0e2c2d8)
Profile: W:\tmp\wp1-b1-ranking-inputs\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md (rev 10, APPROVED)
Plan: docs/superpowers/plans/2026-10-26-wp1-b1-ranking-inputs.md (v6; section 4 rulings PR1-PR58 win over slice text)
Design review: spec R5 (57 findings, 0 rejected), plan R5 (29 findings, 0 rejected; R5 a clean confirming pass) - adjudications at
  docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/design-review/adjudications.md and
  docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/plan-review/plan-adjudications.md
Work map (strictly serial):
  S1 Tenant matching inputs: leaf list module, contact types, PATCH/create parsers, dashboard mirror + form + intake card, full-seed tenant
  S2 Priority on/off: boolean validator, PROPERTY_FORM_FIELDS 35 -> 36, New/Edit checkbox, ListingDetail row + pill
  S3 Extraction reconciles the four fields: schema, coercion by kind (one rule), text_field_filled drop, 12 -> 16 targets, every count
  S4 Notes lines: { text, confidence }, EXTRACTION_FACT_MIN_CONFIDENCE, filterNoteLines, guard before cap, demotion, run-detail region
  S5 Feedback lines: propertyLabel/labelMatches, getDisplaysByIds requireComplete, PROPERTIES SENT block, required job deps, counts
  S6 Probe: --suite never-written judged by a model grader (S6.1a adapter client), --baseline, stub tests; fake driver note; RUNBOOK, env examples, GLOSSARY
  S7 e2e (one session, then commits), sync main once, five gates, self-QA, gate-run command sheet
Watch items: plan section 3 WI1-WI16, especially WI1 (fake driver bypasses the parser), WI2 (transcript
  render + per-message hash unchanged), WI4 (noteLines shape reaches every fixture; typecheck green at
  end of S4), WI9 (required deps at every construction site), WI10 (no listing_sends write), WI16 (no
  network; the grader is a stub in every test). PR1: NO agent runs the probe or the grader against a real model or reads ANTHROPIC_API_KEY. PR29: every
  git command carries -C W:/tmp/wp1-b1-ranking-inputs. Never edit source or commit while e2e runs.
Gates (bare, from the worktree, after one main sync): npm run typecheck; npm test; npm run smoke;
  npm run e2e; npx eslint on the branch's own *.ts/*.tsx/*.js/*.mjs/*.cjs files vs main...HEAD
  (skip if empty; attribute errors by merge-base baseline).
Handback: "merge-ready PENDING the never-written gate run" (Cameron, testing key, claude-sonnet-5-5),
  with gate-run-commands.md written (S7.6).
Post-merge obligations already known: deploy dev + prod (Cameron's ask); no infra, no new required env
  var (EXTRACTION_FACT_MIN_CONFIDENCE optional, default 0.7).
