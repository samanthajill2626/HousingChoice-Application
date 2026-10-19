# Handback - feat/matching-blast-rules (tracker #6: Matching blasts follow the audience rules)

Build orchestrator (AUTO, subagent of the planner). Resumed 2026-10-18 20:47 EDT
after the 2026-10-14 usage-limit pause (nothing had been built; restarted at P1
research). Handed back 2026-10-19. Worktree `W:\tmp\matching-blast-rules`, branch
`feat/matching-blast-rules`, base main @a2b3d80d. Records (committed as
produced): this folder - `research/` (four drift checks + the orchestrator
worklist with OR-rulings and slice hand-downs), `build/` (S1, S2, S3a, S3b, S4
reports), `code-review/` (round 1 conformance + plan-blind adversarial, round 1
adjudications, fix-wave-1 report, round 2 fresh review + adjudications),
`self-qa/` (self-QA record + the QA-L1 fix report).

## Verdict

**MERGE-READY on feat/matching-blast-rules (W:\tmp\matching-blast-rules) - final
code commit 994be540, branch tip = the commit that adds this handback; 0 behind
main (a2b3d80d); UNMERGED (human gate).** All five gates are green on 994be540;
everything after it is docs only (766182f2: two `docs/issues/` sighting
appends; then this handback).

**Decide BEFORE merging (code review R2 ask; built exactly as the approved spec
says):** `docs/issues/matching-prefill-org-list-failure-fails-open.md`. Spec D3
makes three prefill failures fail OPEN with a notice: a failed organization-list
read, a failed property load (which also drops the voucher size, and a
`?unitId=` entry offers no retry), and a list read made before an authority was
added (the composer reads the list once per mount). The draft then carries no
housing authority filter, so the review lists - and checks - tenants of every
authority. The issue gives two options: (1) hold Preview with Try again (does
not cover the stale list), or (2) prefill the property's accepted authorities
verbatim and let the create's list check plus D3b remove an off-list one
(covers all three). Neither was built: it would silently amend D3.

**Post-merge (deploy is Cameron's): NO infra, NO backfill, NO data migration, NO
new dependency, no env change.** After the deploy, reload every open dashboard
tab AND relaunch installed dashboard apps (phones and desktop). Until then, an
already-loaded old bundle checks tour-held tenants by default with its old local
rule (never worse than before the deploy:
`docs/issues/matching-default-check-stale-bundle-window.md`). Nothing is BROKEN
before or after that reload.

## Work map - shipped / deviated / skipped

| Item | Result |
|---|---|
| S1 app foundations (Tasks 1.1-1.5) | SHIPPED (4f2a017e, d9cae3b3, e0d012e8, dbc80324, c08c6614). `blastAudienceRules.ts` (holds, `checkedByDefault`, `authoritiesOfFilter`, wire shape) at binding 2.1 exactly; `AudienceFilter.housing_authorities`; `toursRepo.listByStatus(status, { createdAtFrom })` + the harness fake; the resolver reads searching then onboarding with authorities any-of in memory; create's list check + legacy body; `storedFilterRefusal` per member; wire projections. Deviations: OR-S1-3 ADDED a 4-row AR3 parse edge-case test; OR-S1-1/2 instruction corrections only. |
| S2 app rules in routes (Tasks 2.1-2.5) | SHIPPED (4172121c, c18aea28, df5270d1, 7b1139a1, cdb6b7e4). `readOpenTourHolds` / `readAudienceRules` / `buildReviewRows`; preview `tourHold?` + `checkedByDefault` + `tourHolds`, filter-draft 503, seeds-only degrade, `declineLabelsUnavailable` removed; estimate = default-checked count; path (c) minus held and declined; seed one legacy + one list; comments (GSI and `listByHousingAuthority` untouched - comment changes only). Deviations: OR-S2-1 (AR32's truncation string), OR-S2-2 (header sentence re-anchored, insert-only per AR9), OR-S2-4 (two dep-doc clauses). |
| S3 dashboard (Tasks 3.1-3.6) | SHIPPED in two sequential children (orchestrator call, context safety): S3a 933737c7, e80344f8, 004e4bab, b3480811; S3b 188c7a8e, c0db6987. Rulings implemented per the worklist: AR23/AR35 `hold` (no draft until the prefill settles; derived `reachPending`), AR33 (Change stays enabled; the pinned test unchanged), AR34/AR40 rewrites, AR39 refusal record + property-keyed 422 removal, AR37/AR41 picker loading/failed/aborted states, AR43 copy. Deviations: the `hold` check anchored on the effect's own comment line (still the effect's first statement); `Couldn't load the properties.` uses `role="alert"` (AR37 gave only the copy). Lint: 2 of the base's 4 `set-state-in-effect` errors removed, none added. |
| S4 e2e, docs, completion (Tasks 4.1-4.5) | SHIPPED. 4.1 bd9b9243: five Matching specs + selectors.md repaired, plus AR22's draft-delete test (stricter variant: the LAST create whose `body_template` includes the typed message). 4.2 ae97dd30: the new spec. 4.3 9418c720: GLOSSARY (+ OR-S4-2 fail-closed sentence), RUNBOOK, truncation issue RESOLVED, 422 issue refreshed (OR-S4-3). 4.4/4.5 (orchestrator): main sync = no-op (main unmoved at a2b3d80d, AR28 checked); gates below; lint record in `docs/issues/lint-backlog-repo-wide.md` only (994be540; AGENTS.md untouched, AR38/AR42). |
| Beyond the plan | Fix wave 1 (review round 1): 5bc9cfa8 ADV-5, 2b503eed ADV-3, b58e5daf CONF-2/3, af46ff63 CONF-6, 763c7d24 ADV-9 + three filed issues. Self-QA fix c3e8118b (QA-L1, review tags wrap). |
| Skipped | Nothing in the work map. |

## Gates on the final code commit 994be540 (bare, from the worktree)

Run `final` (`.superpowers/gates/run-gates.sh`, 01:29-01:53 EDT; no `AWS_*` env exported; DynamoDB Local and MinIO up):

```
gate1 typecheck exit=0
gate2 test exit=0
gate3 smoke exit=0
gate4 e2e exit=1
gate5 lint exit=1
```

- Gate 2 (`env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test`): app
  `Test Files 509 passed (509)`, `Tests 10454 passed | 1 skipped (10455)` (the
  skip is the built-dashboard diagnostic in `staticSmoke.test.ts`); dashboard
  `250 passed (250)`, `4812 passed (4812)`; e2e workspace `22 passed (22)`,
  `508 passed (508)`; fake-twilio `34 passed (34)`, `275 passed (275)`;
  fake-twilio-web `13 passed (13)`, `111 passed (111)`. Zero `[dynamoAdmin]` lines.
- Gate 3: `smoke-dist: OK - 1707 import specifier(s) across 297 emitted file(s) resolve under plain Node.`
- Gate 4, run 1: `2 failed`, `361 passed (21.9m)`. Both failures are the KNOWN
  environmental blank-document signature (screenshots entirely white): 
  `settings.spec.ts:27` (`page.waitForURL(/\/settings\/team$/)` 15 s after
  `page.goto('/settings')`) and `post-tour-application.spec.ts:270`
  (`expectTodayReady` at sign-in). Neither spec is near this feature; 2127
  TIME_WAIT sockets right after the run. Isolation (`final-isolate`): both files
  `8 passed (57.7s)`, `EXIT:0`. **Gate 4, run 2 - the full suite again on the SAME
  commit 994be540 with `E2E_TRACE=1` (`final-e2e-2`): `EXIT:0`, `363 passed (23.0m)`,
  0 failed, 0 flaky.** Sightings appended to
  `e2e-blank-document-after-contact-navigation` (eleventh) and
  `e2e-blank-first-paint-at-sign-in` (fourth); run-1 artifacts kept at
  `W:\tmp\matching-blast-rules\.superpowers\gates\final\e2e-artifacts\`.
- Gate 5: `3 problems (3 errors, 0 warnings)` over the branch's 39 `.ts/.tsx`
  files; baseline comparison by rule id from ESLint JSON
  (`.superpowers/gates/lint-compare.mjs` vs the merge base):
  `BroadcastComposer.tsx | react-hooks/set-state-in-effect | head 2 | base 4 | removed by branch`,
  `useComposerDraft.ts | react-hooks/refs | head 1 | base 1 | pre-existing`,
  `branch-attributed: 0`. The 3 are pre-existing (the composer's two
  `setMessage` effects, the draft hook's ref write). Repo-wide `npx eslint .`:
  20 errors across 17 files, 0 warnings (base 22/17).
- Pre-review run `p3` on 53a13055 (before the fix wave): all five green, e2e
  `363 passed (20.6m)`.

## Commits (58 on the branch since a2b3d80d)

Code/test/docs commits (records and planner design commits omitted):
4f2a017e, d9cae3b3, e0d012e8, dbc80324, c08c6614 (S1); 4172121c, c18aea28,
df5270d1, 7b1139a1, cdb6b7e4 (S2); 933737c7, e80344f8, 004e4bab, b3480811 (S3a);
188c7a8e, c0db6987 (S3b); bd9b9243, ae97dd30, 9418c720 (S4); 5bc9cfa8, 2b503eed,
b58e5daf, af46ff63, 763c7d24 (fix wave 1); a8d9c22b (R2 issue follow-ups);
c3e8118b (self-QA QA-L1); 994be540 (lint record); 766182f2 (sightings).
Planner commits on the branch during the build: f62cc62f (AR43 label copy,
Cameron 2026-10-18 - expected).

Net vs base, excluding `docs/superpowers/`: 57 files, +5891 / -869 (app,
dashboard and e2e alone: 43 files, +5442 / -845). Files: app `blastAudienceRules.ts`
(new), `broadcastsRepo.ts`, `toursRepo.ts`, `audienceResolution.ts`,
`routes/broadcasts.ts`, comment-only `contacts.ts`, `dev.ts`, `import/apply.ts`,
`seed/lean.ts`, `contactsRepo.ts`, seed `matrix.ts`; app tests
`blastAudienceRules.test.ts` and `toursRepoListByStatusRange.test.ts` (new),
`audienceResolution`, `broadcastApi`, `toursRepo.integration`, `seedOrgNames`,
the harness fake; dashboard `api/types.ts`, `api/endpoints.ts`, broadcasts
`AudienceFilters`, `BroadcastComposer`, `RecipientPreview` (+ css + tests),
`useComposerDraft`, `broadcastFormat`, `tourHoldLabel` and `authorityPrefill`
(new); e2e five repaired specs + `matching-blast-rules.spec.ts` (new) +
`support/selectors.md`; `documentation/GLOSSARY.md`, `RUNBOOK.md`, 13 issue files.

## Review

- Round 1 (53a13055, both reviewers parallel): conformance 204 CONFORMS / 3
  PARTIAL / 3 MISSING (one finding), 0 blocking/high/medium; 14 mutants, 11
  killed, the 2 expected survivors became CONF-2/3. Plan-blind adversarial: 0
  blocking/high, 2 MEDIUM, 4 LOW, 3 INFO.
- Adjudications (`code-review/r1-adjudications.md`): FIX ADV-3 (rollback
  payload crash), ADV-5 (a tenant moved between the two partition reads
  resolved twice - de-duplicated), ADV-9, CONF-2 (AR12 precedence pinned),
  CONF-3 (unbounded tour paging pinned), CONF-6; FILE ADV-1 (stale bundle
  window), ADV-2 (prefill fail-open - spec D3's explicit choice), ADV-4 (a 422
  naming no on-screen member empties the filter - the designed fallback, rare);
  REJECT ADV-6 (the caption is Cameron's verbatim D8 copy); NOTE ADV-7/8,
  CONF-5; CONF-1 (lint record) done by the orchestrator (994be540).
- Fix wave 1 (one child, TDD): every fix's regression test fails without it.
- Round 2 (fresh reviewer on 0be33fef, charged with misses first): 0
  blocking/high/medium; every fix REAL (4 mutation-proven); R2-1 LOW
  (pre-existing: above the 1000-row preview bound a hand-picked seed is cut
  silently - FILED); FW-1 (an issue's unworkable suggestion - text fixed); two
  challenges UPHELD (ADV-2 widened to its property-load and stale-list siblings
  and marked decide-before-merge; ADV-1's note now covers installed apps). No
  code change from round 2, so the chain closed at round 2.
- Your eye (not blocking): the self-QA fix c3e8118b (4 CSS lines + a 20-line e2e
  pin) was verified by the orchestrator's geometry measurement at 8 widths and
  its own RED->GREEN e2e pin, not by a separate code reviewer.

## Live self-QA (orchestrator-driven; `self-qa/self-qa.md`)

Hermetic lane 10, Playwright MCP, fixtures through the real routes (3
run-unique authorities incl. a 99-character name, 3 properties, 11 tenants, 5
tours). PASS: Available-only picker (bare and `?contactId=`); all accepted
authorities prefilled; the first `POST /api/broadcasts` only after the property
loaded (+610 ms) and already carrying the prefill; caption in both forms;
"Reaches 4" = the 4 rows that start checked; held rows unchecked with labels
(`Tour Oct 24`, `Toured Oct 16, needs outcome`, `Tour requested Oct 19, no date
yet` - AR43) and names (`... - tour requested oct 19, no date yet`); no-consent
row consent-only; Select all skips held; Add a tenant joins Placing / Needs
review checked and Select all keeps them; the send reached exactly the 4 checked
phones once each; prefill ownership (edit kept, a different property resets, the
same property keeps); a held seed via `?contactId=` starts checked with its
label; `?unitId=` of a Setup property keeps the banner and the Make Available
dialog; 0 console errors/warnings. FOUND and FIXED QA-L1: in the wide review
layout the tag spans could not shrink, so long tour labels ran 12-34 px past the
list at 1280 (and the pre-existing consent tag 81 px), scrolling it sideways;
c3e8118b lets tags wrap; re-measured: max clip 0 px at every width 360-1440, no
sideways scroll in the wide layout, short tags unchanged. Screenshots:
`W:\tmp\matching-blast-rules\.playwright-mcp\qa*.png`. Not covered live
(unit-tested): the 503 / seeds-only / failed-read notices and the 422 member
removal (no switch to fail those reads on a hermetic lane).

## Issues

- RESOLVED: `broadcast-audience-truncation-drops-searching-tenants`.
- FILED: `matching-prefill-org-list-failure-fails-open` (med, decision -
  decide before merge), `matching-default-check-stale-bundle-window` (med),
  `matching-composer-422-unmatched-member-clears-filter` (low),
  `matching-preview-cap-drops-hand-picked-seed` (low, pre-existing),
  `review-recipients-narrow-authority-overflow` (low, pre-existing: a long
  authority name overflows the narrow review row; the real 50-character
  HUD-VASH name can do it on a phone).
- UPDATED: `composer-org-422-offer-renamed-entry` (one-member removal; still
  open), `unknown-queue-cap-starves-needs-review` (cross-reference),
  `lint-backlog-repo-wide` (status 2026-10-19: 20/17), the two blank-document
  e2e issues (sightings).
- Planner-filed earlier: `matching-add-recipient-search-caseworkers` (deferred).

## Process record

- Children: 14 foreground opus dispatches (4 research readers, 5 implementers
  S1/S2/S3a/S3b/S4, 2 round-1 reviewers, fix wave 1, round-2 reviewer, self-QA
  fix). Zero misfires, zero deaths. Recoveries: 0 budget-consuming, 0 infra-tier
  (the 2026-10-14 usage-limit kill preceded this dispatch; the planner closed it
  out as no agent failure).
- Research found S3's task text predated rulings AR23-AR41 in six places and
  S4's lacked AR22's step; the worklist OR-rulings carried every override and
  were followed. The shared DynamoDB Local container had exited with the host
  and was STARTED (never restarted) per AR2/AR29.
- Known flake signature this run: the blank-document pair above (environmental,
  green alone and green on the full re-run). AGENTS.md has no named-flake list;
  this is the documented environmental class, recorded as sightings.

## Tracker #6 note (paste as is)

Matching blasts now follow the decided audience rules: only tenants in
Onboarding or Searching are included, the housing authority filter fills in
from the property (a property can accept several), and only Available
properties can be picked. Tenants with an unresolved tour are listed unchecked
with a label such as "Tour Oct 20" or "Tour requested Oct 12, no date yet", next
to the existing Not interested label, and "Reaches N recipients" counts exactly
the recipients who start checked. A tenant added by hand, or sent a property
from their own page, always gets it.
