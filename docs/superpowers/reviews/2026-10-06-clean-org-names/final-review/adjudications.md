# Final independent review - adjudications (planner, 2026-10-07)

Branch `feat/clean-org-names` at the orchestrator's handback (merge-ready
@4b777d26, tip 7be31184; 0 behind main @a5eabcb3). Planner session on Fable
(Cameron's instruction); the three reviewers and the fix-wave implementer on
Opus.

## Gates - the planner's own runs on 7be31184, bare, from the worktree

| Gate | Exit | Result |
|---|---|---|
| 1 `npm run typecheck` | 0 | |
| 2 `npm test` | 0 | app 424 files, dashboard 222, e2e 22, fake-twilio 34, fake-twilio-web 13 - all passed; 0 `[dynamoAdmin]` lines |
| 3 `npm run smoke` | 0 | 1608 import specifiers across 279 emitted files resolve |
| 4 `timeout 2700 npm run e2e` | 0 | 324 passed, 19.9 min, no flakes; lane 13 torn down (no listener on 10301/10311/10321/10331, launcher gone) |
| 5 `npx eslint <153 changed files>` | 1 | 25 errors; baseline comparison at the merge base (same file + rule, counts; react-hooks messages embed line numbers, which the branch shifted) = 25 pre-existing, 0 NEW. Files: BroadcastComposer.tsx (4 set-state-in-effect), useComposerDraft.ts (refs), TemplatesSection.tsx (refs), seeds cast/live/matrix, extraction.ts, and tests |

Both DynamoDB-backed suites ran with the tour-list mission finished and its
lane stopped (no competing stack).

## Reviewers (three parallel opus readers; read-only, no test runs)

| Report | Result |
|---|---|
| `conformance.md` (spec + plan work map + interfaces + handback) | 88 rows: SHIPPED 81, PARTIAL 2, MISSING 0, DEVIATED 5 - all 7 LOW; every handback deviation holds; nothing from branch B built; interface drift additive only |
| `adversarial-backend.md` (plan-blind; app/, RUNBOOK) | BLOCKING 0, HIGH 0, MEDIUM 1, LOW 7, INFO 8 |
| `adversarial-frontend.md` (plan-blind; dashboard/, e2e/) | BLOCKING 0, HIGH 0, MEDIUM 0, LOW 12, INFO 6 |

## Rulings

Rule applied (Cameron's standing one): keep a fix only when it is small and
contained; file the rest. Three fixes, one fix wave, full gates again.

| # | Finding | Ruling | Change |
|---|---|---|---|
| F1 | BE MEDIUM-1: `clean-org-names --apply` has no guard against an environment not yet (or no longer) running the new code - the lock itself creates the `org-list` item, so a premature `--env prod --apply` rewrites prod data while main's free-text composer, extractor and edit form are live | FIX | the apply refuses when `peek()` finds no stored item (the deployed app creates it on its first read): exit 1, nothing read or written, the message says to deploy, open Settings > Housing authorities & agencies once, then re-run; dry run unchanged; the existing test that pinned apply-creates-the-item flips; RUNBOOK step 4 gains the "open Settings once" step and a rollback note; spec section 8 precision line |
| F2 | BE LOW-1: typographic punctuation (iPhone smart quotes, en dashes) and invisible format characters are neither folded nor refused - a visually identical duplicate entry can be added and records split across two names | FIX | `normalizeOrgText` (server and the dashboard mirror) folds U+2018/2019/201A/201B/2032 to `'`, U+201C/201D/201E/2033 to `"`, U+2010-2015/2212 to `-`, and strips format characters (U+00AD, U+200B-200F, U+202A-202E, U+2060-2064, U+2066-206F, U+FEFF) before the D4 steps; `hasOrgControlChar` refuses those format characters in NEW names and spellings (`org_name_invalid`), so canonical names never carry an invisible character; tests on both sides; spec D4 precision line |
| F3 | FE L6: the Settings tables' hidden "Actions" header (`.srOnly`, absolutely positioned) is not contained by `.tableWrap` - the defect class main fixed in 13b64f60; the self-QA MEASURED no overflow at 360 px (345/345), so this is prevention | FIX | `.tableWrap { position: relative }` in OrgListSection.module.css (one line) |
| F4 | CONF row 1 (DEVIATED LOW): D5 compares the trimmed request to the raw stored text, so a padded legacy value re-sent by an API caller is checked as new | ACCEPT | the dashboard never re-sends an unchanged field; an API caller re-sending a padded exact name gets it stored clean - an improvement |
| F5 | CONF rows 2 + 6 (PARTIAL LOW): whitespace-only stored values are skipped by "Not on the list" and counted (not listed) by the cleanup (`recordsWithBlankValues`) | ACCEPT | planned in plan review P33: such a value cannot be named by any request (the body trim), D5 treats it as a clear, and the counter tells the operator it exists |
| F6 | CONF row 3 + BE LOW-7: in-app Move/Split treat a whitespace-only Agency (or one that is a spelling of the target) as a conflict; the cleanup treats it as free | FILE | `org-names-backend-review-lows` (parity item); both are safe, the in-app one is the stricter |
| F7 | CONF rows 4, 5, 7 (DEVIATED LOW): add refused while a running rewrite would erase the new name; Run again stricter; accepted race windows | ACCEPT | each reason holds against the code; the races were ruled during the build and are filed |
| F8 | CONF + FE I6: 16-17 older e2e specs still create units with the `atlanta_housing` slug through POST /api/units and pass only because the slug resolves through the seeded "Atlanta Housing" spelling | FILE | `org-picker-settings-review-lows` (e2e debt item); a mechanical sweep for a later small-fix branch |
| F9 | BE LOW-2: a one-word generic entry ("Housing", "County") is accepted and then poisons compound detection | FILE | `org-names-backend-review-lows`; suggested guard: refuse a new name made only of GENERIC_WORDS |
| F10 | BE LOW-3: spelling edits allowed while the cleanup holds the lock; the cleanup resolves against its start-time snapshot | FILE | `org-names-backend-review-lows`; the RUNBOOK already says to add spellings BEFORE the apply |
| F11 | BE LOW-4: `POST /not-on-list/resolve` `value` has no length limit and is persisted on the shared item | FILE | `org-names-backend-review-lows`; admin-only, values come from stored rows |
| F12 | BE LOW-5: duplicate SQS deliveries of one `org.rewrite` job do more than split counts - a failing duplicate marks the healthy run failed; the first finisher releases the lock while the other writes for up to 20 s | UPDATE the filed issue | `org-rewrite-single-message-pass` body gains both consequences |
| F13 | BE LOW-6: a blast resolved while a rename/merge is running, failed or stalled silently omits tenants not yet rewritten | ACCEPT + FILE | spec D11 states this window; a composer hint while a rewrite runs is a low improvement - `org-names-backend-review-lows` |
| F14 | BE INFO (8): contacts with an unrecognized `type` invisible to the job and the Settings page; a new rewrite replaces a stalled one's definition; raw leftover text shown to every user in the last-rewrite record; pre-deploy suggestion replay (RG-1, Cameron's open question); deploy-window effects (a stale bundle's unrendered 422s; an old worker dropping `org.rewrite` until the worker deploys - RUNBOOK step 3 deploys app + worker together); merge keeps a spelling the target already carried; duplicated heartbeat/lease logic; any user may add names that reach the AI prompt | NOTED | the first is already filed (`contactsMissingTypeOrStatus` counter); the rest are design-stated or out of threat model; no change |
| F15 | FE L1-L5, L7-L12 (LOW): pickers never re-read the list after a 422; a false "Couldn't load" on a failed RE-read with a list in hand; "Yes, add it" enabled before close names show on a stale failed check; Cancel on "Add as new" loses the typed text; a hung /check never times out; Settings status changes not announced to screen readers; row buttons without the value in their name; ArrowDown does not reopen a dismissed list, highlighted option not scrolled into view; stale rows after a failed details re-read; a 403 reads as "try again"; e2e: a fixed 1.5 s negative wait, substring row lookup, no 360 px / polling / composer-422 coverage | FILE | `org-picker-settings-review-lows`; none changes stored data; the server refuses every duplicate and every off-list value regardless |
| F16 | FE INFO (6): a test pins call arity; dead `.input` CSS and no disabled chip style; Preview still shows raw `err.message` for other errors (pre-existing); copy nits; settle buttons do not wrap at 360 px; the `atlanta_housing` e2e debt (F8) | NOTED / F8 | no change |

Counts: 3 fixes (F1-F3), 1 filed-issue update (F12), 2 grouped issues filed
(F6, F8-F11, F13, F15), the rest accepted or noted. The three fixes touch
`app/scripts/clean-org-names.ts` (+ test, RUNBOOK), `app/src/lib/orgNames.ts`
+ `app/src/services/orgNames.ts` + `dashboard/src/routes/orgs/orgCopy.ts`
(+ tests), and one CSS line - so the five gates run again on the fixed tip.

Cameron's open questions from the handback, with the planner's recommendation:
1. RG-1 (a suggestion accept claimed before the deploy and replayed after it
   writes its old text unchecked): keep as an accepted gap - the replay window
   is seconds, and the value surfaces in "Not on the list".
2. Typed-but-unpicked text on Save: accept - text naming exactly one entry is
   committed as that entry, anything else is refused with a visible reason;
   nothing is dropped silently (self-QA steps 2c, 2d; screenshots 06, 07).
3. Bare "Clayton" stored before the deploy was saved by the old importer as
   "Clayton County", so the cleanup maps those tenants to Jonesboro Housing
   Authority; the launch-gate ruling (bare Clayton -> DCA) reaches only NEW
   raw imports. The RUNBOOK says to review bare-"Clayton" rows in the Airtable
   export with Sam.
