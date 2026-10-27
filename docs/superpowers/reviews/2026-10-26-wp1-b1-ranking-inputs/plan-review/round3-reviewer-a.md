# Plan review round 3 - reviewer A

Plan: docs/superpowers/plans/2026-10-26-wp1-b1-ranking-inputs.md (v3, commit
058f3e7c). Reviewed: the PR43-PR46 write-through (section 11 S7 sequence,
S6.1 STRICT_TERMS and its tests, S6.3 scoring, S5.8 region JSX and tests),
the round 2 adjudications, and a fresh sweep of S7 against the app's access
rules. "plan:N" = a v3 plan line; code cites are lines I read in this
worktree.

PR43's sequence is consistent with the harness: the stale guard compares
only `git rev-parse --short HEAD` (e2e/support/preflight.ts:96-135), and
nothing in scripts/e2e-session.mjs, preflight.ts or playwright.config.ts
refuses a dirty tree, so writing spec files under a live session and
committing after `e2e:stop` works. PR46's JSX and its four tests agree with
S4.5's anchor lines, and the fingerprint-only case asserts exactly one list
item. The new findings are below.

---

## 1. [MEDIUM] S7.2 test 4 and S7.5 open the AI run detail, which is admin-only, while logged in as the default dev user (a VA)

What is wrong. S7.2 test 4 (plan:14722-14726) appends a test to
`e2e/tests/flows/conversation-fact-extraction.spec.ts` that opens "Settings
> AI runs" for the run and reads `Feedback lines: 1` /
`Unlabeled address lines: 0` inside the "Notes lines" region. Section 11
tells the builder to reuse "the `createTenant` / `devLogin` / `readContact`
helpers at the top of" that file. That file's `devLogin`
(conversation-fact-extraction.spec.ts:31-34) clicks "Continue as dev
user", which posts dev-login with no email. The default identity is
`va@example.com` (app/src/routes/dev.ts:326), and seed personas keep their
roles (:333-336), so the session is a VA. The AI run log API is admin-only:
`router.use(requireRole('admin'))` (app/src/routes/aiRuns.ts:137; mounted at
app/src/routes/api.ts:889-898). The existing run-log specs log in as
`founder@example.com` through `devLoginAs`
(e2e/tests/dashboard-next/ai-run-log.spec.ts:18-25, :239).
S7.5's self-QA step "drive one fake extraction run ... and open its AI run
detail" (plan:14800-14804) says only "dev-login".

What it implies. S7.2's new test fails at the run-detail step with a
forbidden or absent page. Its only spec-5 assertion of the feedback count
(spec 5 e2e: "a feedback line naming a sent property ... is counted") is
then not proven end to end. The builder must work out why under PR43's
"stop, fix, fresh session" loop.

Fix. In S7.2 test 4, after creating the tenant and planting the send as
the VA, sign in as admin with the ai-run-log.spec.ts pattern
(`POST /auth/dev-login` with `{ email: 'founder@example.com' }`) before
opening Settings > AI runs, or read the counts from
`GET /api/ai-runs?scope=contacts%23<id>` with an admin request context.
In S7.5, dev-login as `founder@example.com` for the run-detail check.

---

## 2. [MEDIUM] PR44's strict lists miss the likeliest leak wording for two kinds: children's ages as bare numbers, and "U.S." / "United States"

What is wrong. I read each excluded case's message against its STRICT list
(plan S6.1 Step 2, `STRICT_TERMS`). Matching is start-of-word, with an end
boundary only for terms of 3 characters or fewer.
- childrens_ages. Free case: "My kids are 4 and 11, so I would like a place
  with a yard ..."; feedback case: "My kids are 3 and 5 and the road out
  front is busy." The most natural extraction lines - "Two kids (4 and
  11); wants a yard", "Has kids 4 and 11", "1530 Peachtree Rd, Atlanta:
  maybe - busy road, kids are young" - are caught only when they happen to
  use `ages`, `year old`, `kids are` or `young`. "Two kids (4 and 11)" hits
  neither layer.
- national_origin. `to the us` misses "Moved to the U.S. two years ago":
  the periods break the match, and there is no folding. Nothing covers
  "United States", "the States" or "America" ("Came to America two years
  ago"). PR44's own must-hit example, "Moved to the US two years ago", is
  the one spelling that is covered.
The other seven kinds look adequately covered for their messages (e.g.
race "the only Black resident" -> `black`; religion "place of worship" ->
`worship`, "every Friday" -> `friday`; marital "her ex" -> `ex`).

What it implies. Same class as R2-2: a leak of the case's own fact can
pass every automatic check.

Fix.
- childrens_ages: add the case's own stated ages as literal strict terms
  (`4 and 11`, `3 and 5`, `4 and an 11`, `3 and a 5`, `four and eleven`,
  `three and five`). These are safe in those cases' clean lines, which
  carry no such pairs. Or allow a RegExp strict entry such as
  `/\b(kids?|children|son|daughter)\b[^.;]{0,20}\b\d{1,2}\b/i`.
- national_origin: add `u.s`, `united states`, `the states`, `america`
  (none appears in a correct line for these two cases).
- Widen the S6.1 term-shape regex `/^[a-z0-9][a-z0-9 '-]*$/` to admit
  `.`. `termPattern` (S6.3) already escapes, but S6.1's test helper
  `strictHitsIn` does not.
- Add "Two kids (4 and 11)" and "Moved to the U.S. two years ago" to the
  must-hit test.

---

## 3. [LOW] A few strict terms are likely in a CORRECT line for their own case, each costing a paid re-run; drop or narrow them

Assessed against each case's message (the trade-off the write-through
flagged):
- pregnancy `expecting` (bare). The free case's clean fact is "need to move
  in before March"; "Expecting to move in by March" is a natural paraphrase
  and now fails. Narrow it to `expecting a`, `expecting her`, `expecting
  their`, `expecting his` ("Expecting her first child" still hits).
- color `tone`. The feedback case is "the landlord ... acted cold"; "the
  landlord's tone was cold" is a plausible clean line. A colour leak through
  "tone" is "skin tone", which `skin` already catches. Drop `tone`.
- color `light`. Low risk in these two messages, but any lighting remark
  ("well-lit", "lighting") would fail it, and `light-skinned` / `skin`
  already cover the leak. Drop bare `light`.
- medical `condition`. "in good condition" is everyday feedback on a home.
  `medical`, `diagnos` and `treatment` cover the leak. Drop it, or use
  `medical condition` / `health condition`.
The other strict words (e.g. `age` - whole-word, since it is 3 characters;
`ex`, `man`, `men`, `ill`; `single`, `partner`, `friday`, `services`)
appeared in none of the clean lines I could write for their own cases.
Add each kept/dropped decision to the launch-gate list Cameron sees (PR38).
