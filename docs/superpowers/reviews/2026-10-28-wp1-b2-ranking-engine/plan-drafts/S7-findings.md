# S7 plan-draft findings (WP1 B2a, plan section 11)

Draft: `.superpowers/sdd/plan-draft-S7.md`. One finding needs a planner
ruling; everything else the draft resolves in its Contradictions and
Cross-slice notes.

## F1. The S6/S5 wire contract is not fixed by the spec or the plan head

What the tree and the docs say:

- Spec D9 names the read's parts (`anchor`, `job`, `rows`, `flags`) and the
  row's fields, and D12 names the endpoints, but neither fixes the response
  envelopes (`{ job }` vs a bare record for the job read), the shape of
  `poolTooLarge`, how "not ranked yet" vs "not scored" is carried on a row,
  or the run-list row fields.
- Spec D18 requires the runs list to show the anchor "(name or label)", but
  the run record (spec D11) stores only `anchorKind` / `anchorId`; a display
  must be resolved by the S6 route.
- Spec D18 requires the run detail's pairs to show "missing", but D11's
  `results[]` lists only `unknowns`; the D3 merged `missing` list is
  computed by the job (S5) for the match row and is not stored on the run.
- Spec D18 requires each pair's band; PR7 / WI13 forbid a second band or
  cap function, so the dashboard cannot derive it from `score` and
  `cappedAtRun` - the server must return it.
- The event's `batchesDone` (D12, WI16) is not typed: the job record holds
  an index array (D7), the event could carry a count.
- The version rule's "current model" (D9) is not defined for the fake and
  console drivers; D6 implies it is the configured driver's stamp. Read as
  the configured model id, every hermetic match is out of date at once.
- PR3 fixes only `readRanking`'s signature (`Promise<RankingRead>`), not its
  fields; S6's drafter writes the routes in parallel.

The draft's choice: S7.1 types every response exactly as the draft's
Cross-slice note N1 lists (envelopes, `notScored: boolean` with
`match: null`, `poolTooLarge?: { size }`, run-list `anchorDisplay`,
0-based `batchIndex`, expired pointers, run-detail `input` decompressed by
the server as text, pairs carrying server-computed `band`, `missing` and
`currentRunId`, cost `{ environment, weeks[] }`), N2 (`batchesDone:
number[]` in the event), N3 (`missing` on each `results[]` entry), N10
(current model = the configured driver's stamp).

Ruling needed: adopt N1, N2, N3 and N10 as a binding PR (so S5 and S6 build
to them), or reconcile them field by field with S6's draft and have S7.1
follow the ruled names. Either way the ruling must cover: the job read's
envelope, the row's unranked/unscored encoding, `poolTooLarge`, the run
list's `anchorDisplay`, `missing` on `results[]`, the server-side pair
`band`, the event's `batchesDone` type, and the current-model rule.
