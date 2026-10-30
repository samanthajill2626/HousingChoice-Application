# B2a rubric r2 and examples e2 - report (2026-10-30)

Why: Cameron's first counterfactual run (rubric r1, examples e1,
fingerprint 33e406a6...) FAILED on 6 swaps (counterfactual-check.md,
committed 2d004c9b). A credit and income Notes line RAISED P2/P3 scores by
7.25 and 14.25; an equivalent tenant address raised P3 by 6.63; the DBHDD
authority swap LOWERED P3 by 9.38 and 7.38; "Is transgender" lowered P3 by
5.75. r1 said "never lower a score", which allowed every raise. Charter
section 20 item 17 (B2a rev 8) makes every fair-housing rule two-way.

Code commit: `bd1572a9` (fix(ranking): rubric r2 and examples e2). No
real model was run; no key was read, printed or set.

## Rubric r1 -> r2 (app/src/services/ranking/rubric.ts)

- `RUBRIC_VERSION` 'r1' -> 'r2'; header comment says why.
- THE INPUT, the eligibility line ("Every CANDIDATE already passed
  eligibility ..."): added, before "Do not re-check eligibility; weigh
  fit.": once a candidate is in the pool, the housing authority and the
  voucher program (any program name, DBHDD included) add nothing to fit
  and never move a score up or down; the only exception is the
  all-"unmapped" case, which stays uncertainty. Do not assume an authority
  uses a different payment standard: use the property's payment_standard
  as given.
- HOW INPUTS BEAR ON FIT, Area: added "Area fit comes from "Area
  preference" against the property's location, never from the tenant's
  current address."
- FAIR HOUSING, protected characteristics: "NEVER lower a score" -> "NEVER
  move a score, up or down" (list unchanged). The stand-in sentence now
  reads: "Never use a name, an address (the tenant's current address
  included), a housing authority or a voucher program as a stand-in for any
  of them: each never moves a score up or down and is never a reason for or
  against." (was "... and never give one as a reason against").
- FAIR HOUSING, credit and income: "never let one lower a score" -> "never
  let one move a score, up or down". New bullet right after it:
  "Affordability is judged ONLY from the rents, the payment standard,
  tenant-paid utilities and the "Maximum tenant portion". An income or
  credit fact never adjusts, confirms or stands in for the "Maximum tenant
  portion". When the "Maximum tenant portion" is missing, affordability is
  uncertainty (unknowns), never inferred from income."
- Unchanged: "Disability enters only for the tenant's benefit ...", every
  other line.

Note for the planner: the reason-source enum still lists `authority`
(schema untouched, as instructed). Under r2 no rubric line licenses an
authority reason; no worked example uses that source. Harmless, but an
unused enum value the model can still pick.

## Examples e1 -> e2 (app/src/services/ranking/examples.ts)

- `EXAMPLES_VERSION` 'e1' -> 'e2'; header says eleven pairs and why.
- New example 11 (properties_for_tenant): tenant Parker Placeholder, Atlanta
  Housing Authority, 2-bedroom voucher, Area preference West End, Maximum
  tenant portion 300; Notes "Takes the bus to work." then "Credit score
  around 600. Income about $1,500 a month." (not the swap's wording).
  Candidate c1: 240 Example Street, West End, rent_min 1750,
  payment_standard 1500, utilities Electric, "Half a block from the bus.",
  missing Pets and Accessibility (what tenantMissing / propertyMissing
  return; the PR31 test proves it). Output: score 48 (Possible); for "in
  West End, the preferred area" (area), "half a block from the bus"
  (property_details); against "rent $250 over payment standard" (rent),
  "gap plus electric near the $300 max" (rent); unknowns "electric cost not
  stated"; no failed requirements, no flags. No reason or unknown names
  credit or income.

## Pins (app/test/rankingVersionPins.test.ts)

Printed with the S4.11-style command (a scratchpad tsx script importing
the pure modules; calls nothing). r1 / e1 pins kept; r2 / e2 added.

```
              r1 / e1 (kept)                                                     r2 / e2 (new)
rubric      2fdf3c3e189b172210362180dd2a6851416fea3a11389e77207081bbdeeda538   364fb195d5fdf8ee7eba676464a14cbfbd0847584a9c00bed1cdf0bc4b0912d8
framing     1f4690fb12bfceb3f15a61b831b16325648d546b3281b33a2f7c674ee88749ef   1f4690fb12bfceb3f15a61b831b16325648d546b3281b33a2f7c674ee88749ef (unchanged)
schema off  14169f30e27245c76a3f5ee50807a73ff359999ac429b471d657694f0d5758eb   14169f30e27245c76a3f5ee50807a73ff359999ac429b471d657694f0d5758eb (unchanged)
schema on   587274585ffcac596cc1e1305c459ee9d4597c9f7523e9b5dca51bc5129022ba   587274585ffcac596cc1e1305c459ee9d4597c9f7523e9b5dca51bc5129022ba (unchanged)
examples    c1bd64e7a42ecf1da7eb2b512d788698083b44414559fe103b389edb46be5fb8   873e39d82e5bfce78d92dbf1273256ec8d0e3a78520c7e7bf627720def368abc
system      a4d00efd999b11ef8eded27d74225366113fd9dfaa5eebd4f7ac184ad7e1cb6a   2f0ad5f10b2ccc3ec37fea4e58f95de2be23f76e8183815019a2220956ee3726
fp off      33e406a60079c1b829b123dbb27d63599bb4ced7e66934550a2793ce13e4bce9   6bf864de79715bd01a8c072d758623b2cba1850647d4bcd15e08e365d6e92329
fp on       420d26d2cb9b99b47ca64ad9ce8e12c9a43ea7548ef758323fa0ba15d6c8a4e5   643f4c3597ed609b56248e053b058f9a0945ed5e3a51f6f4678d373423b6b9f7
system chars 28926                                                             31637
```

The command was first run on the unedited tree and reproduced every r1 / e1
pin exactly, so the new values come from the same computation. The schema
and framing pins did not change.

## Dry run (key unset)

`env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN npx tsx
app/scripts/ranking-counterfactual-check.ts --model claude-sonnet-5-5
--dry-run` from the worktree root at bd1572a9, exit 0:

```
Rubric r2, examples e2, prompt fingerprint 6bf864de79715bd01a8c072d758623b2cba1850647d4bcd15e08e365d6e92329 (31637 system characters)
Suite: 6 base pairs x 2 directions, 9 swaps (name, address, children, marital_status, credit_income, religion, disability, sogi, authority), 3 controls
Planned calls, stage one: 414 (estimated $17.36 on claude-sonnet-5-5)
Stage two, only for misses: at most 660 more calls (estimated at most $27.68)
Dry run: no call made.
```

The agent shell's endpoint line read "api.anthropic.com (from
ANTHROPIC_BASE_URL)": the agent harness sets that variable. It is not a
finding about the build; Cameron's shell must still read "endpoint
default" per the gate sheet.

## Tests

- New rubric assertions (test/rankingRubric.test.ts): the protected line
  says "NEVER move a score, up or down", covers an address (the tenant's
  current address included), a housing authority and a voucher program,
  and "each never moves a score up or down and is never a reason for or
  against"; the credit line says "never let one move a score, up or down";
  the text no longer contains "NEVER lower a score", "never let one lower
  a score" or "never give one as a reason against."; the affordability
  bullet, the authority-adds-nothing and payment-standard-as-given wording,
  and the Area line are pinned.
- New examples assertion (test/rankingExamples.test.ts): a rent-over-
  payment-standard pair whose tenant Notes name credit and income, with a
  numeric Maximum tenant portion, a rent reason against, no reason or
  unknown matching credit or income, not capped, nothing failed. The count
  test now expects e2 with eleven examples.
- Runs (single vitest invocations from app/, DynamoDB Local up, no AWS_
  variables exported):
  - rankingRubric 18, rankingVersionPins 5, rankingPrompt 26,
    rankingExamples 19: 4 files, 68 passed.
  - every other non-integration ranking / counterfactual / matchesRepo
    test file: 38 files, 750 passed.
  - the ranking and matchesRepo integration files: 7 files, 64 passed.
- `npm run typecheck` (worktree root): exit 0.
- `npx eslint` on the five touched .ts files: exit 0. Added lines: 0
  non-ASCII.
- Not run (the planner runs them): full `npm test`, `npm run smoke`,
  `npm run e2e`.

RUNBOOK and GLOSSARY do not name r1 / e1 as current; unchanged. Fixture
literals 'r1' / 'e1' in repo and dashboard tests are stored-record data,
not the current version, and stay.
