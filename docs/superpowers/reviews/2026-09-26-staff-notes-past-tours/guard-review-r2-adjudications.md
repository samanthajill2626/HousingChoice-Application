# Stale-save guard + undated tours review, round 2 - adjudications

Reviewer: the round-1 guard reviewer, continued (opus), over ec45bc83..5b30bdd5
plus the voicemail merge 28098b04 (`guard-review-r2-adversarial.md`: 0
BLOCKING, 0 HIGH, 0 MEDIUM, 5 LOW, 1 unscored nit). Planner: Opus, 2026-09-27.
Every load-bearing claim was re-read in the code before ruling.

| # | finding | ruling |
|---|---|---|
| 1 [LOW] | a toured tour dated AFTER today (Mark toured early, or "Mark toured anyway" with a future date, then the outcome dialog dismissed) is on no Tours tab until its day | ACCEPT. Same class as 4.2a and Cameron's reason for it ("if we go to look for the tour, we wouldn't be able to find it"). Verified: Upcoming keeps `status === 'scheduled'` only (`useTours.ts:79`), Mark toured has no time gate (`TourDetail.tsx:582-587`), and the status=toured read already returns the row. The last group now also keeps toured rows needing a decision whose `scheduledAt` is after the window's end, shown with their date; same 90-day touch window, same order. The selector is renamed `selectOffRangeTours`; spec 4.2a amended. |
| 2 [LOW] | two undated tours for one tenant and property are indistinguishable; the row docblock's "names stay distinct" is false | ACCEPT IN PART. The docblock now states the invariant for dated rows and names the undated exception. No second visible fact: Cameron's copy ruling is "just say 'undated'", and the case needs two tours for one pair, both marked already-toured with no date, both undecided. Each row still links to its own tour. |
| 3 [LOW] | the undated e2e relies on the first test's rows; alone, or after a failure (fresh worker reseeds), it fails | ACCEPT. The test creates its own dated past tour and asserts the undated row sits after it, with retrying assertions; no dependence on test 1. Proven by running the file. |
| 4 [LOW] | contest of round-1 ruling 4: "focus stays on Save" was asserted, not checked | ACCEPT the contest. The box is `readOnly` (not disabled) while saving, so it can take focus; on a stale refusal focus now moves to the box, whose `aria-describedby` names the conflict panel. Done in an effect keyed on a refusal counter so the description is attached before focus lands and a second refusal refocuses. Pinned in the card test. |
| 5 [LOW] | contest of round-1 ruling 5: the fake checks the guard BEFORE the index-key refusals; the real repo throws them first | ACCEPT the contest. The fake now validates the whole patch's index keys first (as the real repo does before any network call), then not-found and the guard, then applies. This also removes the fake's half-apply when a bad field follows a good one. Test-only change; the app suites re-run in full. |
| nit | the KNOWN GAP note's GET list omits the contact/unit walks and the shared query shapes | ACCEPT. The comment in `e2e/performance/routes.ts` and the issue `perf-pages-tours-past-surface` now name both. |

Re-verification is recorded in the planner verdict.
