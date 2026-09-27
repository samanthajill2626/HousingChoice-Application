# Code review round 4 - focused re-review of FW5

Reviewer: a FRESH read-only re-reviewer (Claude Opus 5.5), dispatched
2026-09-27 16:47 EDT over FW5 (ddd3e134..52220729) with `r3-review.md`,
`r3-adjudications.md`, `fw5-report.md`, `r2-adjudications.md` section 1 (for
background), the FW5 diff package and repository access. HEAD 1d3bc869 (code
= 52220729). Charge, in order: (1) the FW5 diff cold, (2) a holistic pass over
`lookup()`'s final verdict table, (3) adjudication challenges, (4) verdicts.

Record note: the reviewer returned this report as TEXT (the harness refuses
report files from subagents); the orchestrator landed it here verbatim apart
from the heading. The orchestrator's rulings are in `r4-adjudications.md`.

---

ROUND-4 RE-REVIEW (FW5): feat/send-outcome-reconcile, HEAD 1d3bc869 (code = 52220729). Read-only review. I wrote one throwaway test file, ran it twice, and deleted it. `git status --short` is empty and HEAD is unchanged. I did not run npm test, e2e, smoke or any build.

Bottom line: FW5-1 is sound. At HEAD, never_sent is reachable only from a complete walk at the last check. A partial read can adopt only what a complete walk could. FW5-2's text is true for both arms. I found one new LOW (F-1, logging only) and one interpretation that is unpinned but harmless. Nothing is BLOCKING, HIGH or MEDIUM.

## (1) Defects in the FW5 diff

FW5-1 mechanics, checked cold:
- The catch sets `listFailure` and breaks before `pages += 1` (sendReconcile.ts:839-842).
- The error-first return (:892-896) comes before every cause below it (:897-906). So one lookup can reach never_sent (:906) only when listFailure is unset, cut is unset and the check is the last one: a complete walk.
- `cut` and `listFailure` cannot both be set, because the bound breaks before the next call (:854-857 against :839-842).
- A page-1 failure reads nothing and falls straight to the error verdict, exactly as before.
- Every adoption guard works per candidate and does not care whether the walk finished:
  - the window filter (:847)
  - the sibling-SID skip (:863)
  - heldBy (:864-865)
  - the fingerprint match (:866)
  - the claim (:870)
- So an error-ended walk can adopt only what a complete walk could. The one difference is the oldest-first pick among the candidates read (:860). That can only swap same-fingerprint messages between siblings, the same class round 3 walked for cut walks.
- Probes P1-P6 confirm all of this (section 5).

F-1. LOW, CONFIRMED (P9). A list error mid-walk that comes before an adoption is logged nowhere.
- Where: lookup returns found (:871), or the loop's sid_held_elsewhere (:872-880), and `listFailure.err` is dropped. The found INFO in runCheck (:430-441) carries no error.
- Before FW5, the same failure always left a WARN (checks 0-1) or the provider_unreachable ERROR.
- User-visible: nothing on screen. An operator loses the only trace of a failed next-page call whenever the walk adopts from pages it already read. That next-page call (messages.getPage on the next-page URL, messaging.ts:1139-1140) is the path spec Sec 10 lists as unverified against real Twilio. Walks that adopt nothing still show the error, so a systematic failure is undercounted, not hidden.
- Evidence (P9, the T1 shape):
  - The err messages across ALL captured lines were exactly ['down 0', 'down 1'].
  - Failing assertion zz-r4-1.test.ts:326 `expect(capture.lines.some((l) => ...message === 'page 2 down')).toBe(true)` gave "expected false to be true".
  - T1 does not pin this either way: its WARN count (:1072) is taken before the last check runs.
- This pairs with the implementer's named residue (the provider_unreachable ERROR carries no page count). One small log-only change would close both: put `pages` and the list error on the found line, the sid_held_elsewhere line and the error verdicts' extra.

FW5-2: no defect.
- Known arms: one guardWrite runs setRecipient, then bumpStats (broadcastFanOut.ts:698-705). The emit cannot fail it, because the bus isolates listener throws (events.ts:348-357).
- Generic arm: a single UpdateCommand writes both slot and stats (broadcastsRepo.ts:536-577).
- No write, carry, flag or counter moved (:755-773).
- Consumers of the text:
  - The only text poll is e2e send-outcome-reconcile.spec.ts:475 ('send rejected by the provider'), which the carry line does not contain.
  - Outside the review records, the old text has zero matches. The new text appears only at :763 and in the 5 pins.
  - There are no matches in infra/, dashboard/, scripts/, docs/issues or RUNBOOK.
- The added lines contain 0 non-ASCII bytes.

## (2) The final verdict table at HEAD

Walk end states:
- L: list end, a complete walk.
- S: early stop. Checks 0-1 only, gated `!last` (:852).
- B: cut at the bound (:854-857).
- E1: list error at page 1.
- Ek: list error at page k>1.

Judge-loop outcomes:
- A: adopted (:871).
- H: sid_held_elsewhere (:872-880).
- N: nothing adopted, split into U (unmatched > 0), F (a same-fingerprint sibling open or adopted) and 0 (neither).

Checks 0 and 1:
- L or S: A gives found; H gives unresolved sid_held_elsewhere; N gives continue nothing_adoptable (:897).
- B: A gives found; H gives sid_held_elsewhere; N gives continue page_bound (:897).
- E1: continue provider_error with err (:895).
- Ek: A gives found; H gives sid_held_elsewhere; N gives continue provider_error with err (:895).

Check 2 (the last):
- L: A gives found; H gives sid_held_elsewhere; U gives unresolved unidentified_candidate (:899); F with U = 0 gives same_fingerprint_sibling (:903-904); 0 gives never_sent (:906).
- S: unreachable.
- B: A gives found; H gives sid_held_elsewhere; N gives unresolved page_bound {pages} (:898).
- E1: unresolved provider_unreachable {err} (:894).
- Ek: A gives found; H gives sid_held_elsewhere; N gives unresolved provider_unreachable {err} (:894).

At any check, before the walk: no_sender (:768) and digest_mismatch (:770-771).

Reading the table:
- never_sent is reachable only at (last, L, 0). No cell is wrong.
- No read, adoptable message is closed unresolved, apart from the old race-only case where H is ordered first (unchanged).
- The misleading-cause question is limited to Ek at the last check, which reads provider_unreachable although some pages were read. That is the named residue, plus F-1.

Across checks: a list error at check 0 does not stop a complete last-check walk from ruling never_sent (P7). That is correct by design: the last walk decides.

Consumers:
- Every kind, cause and reason the table can produce already belonged to Verdict (:304-308) and UnresolvedCause (:291-300).
- runCheck's switch (:427-469) handles each one:
  - continue provider_error: the WARN with err (:448-450), then enqueueOrClose (:1035-1069).
  - unresolved: closeUnresolved with its extra (:1003-1024).
  - never_sent: redrive (:1170-1195), reached only from the complete-walk cell.
  - found: the adopted close plus afterClose (:428-446).
  - The superseded re-apply (:415-419, slotCloseOf :922-933) covers unresolved of any cause.
- In the e2e spec, :412 and :559 are single-page lanes and :508 fails page 1 at each check (failList count 3). Neither changes.

Deviation 2 (sid_held_elsewhere outranks the error):
- It holds at HEAD. P8, relay leg: check 0, a page-2 error, and a candidate this leg's pointer holds whose claim is lost. The result is a terminal sid_held_elsewhere with no next check.
- It is UNPINNED. No committed test holds this order on an error-ended walk, so a mutant gating :872 on `listFailure === undefined` would survive.
- Harmless either way: the flip would give continue provider_error, and the next check meets the same candidate. Treat it as a NOTE.

## (3) Adjudication challenges

Nothing substantive. I agree with:
- the FW5 semantics
- accepting deviation 2 (it should be pinned or named as unpinned)
- keeping FW5-2's combined gate
- declining R2C-1's lighter alternative

Two wording points:
- r3-adjudications.md:59 "an added call can only ADD evidence": true for verdicts, not for logs. Per F-1, a failed added call can now erase the only trace of its own failure.
- r3-adjudications.md:64 "NOT a behavior change against the spec or main": main has no reconcile, so "main" says nothing. The real ground is spec D13 (design.md:589, "a walk that exhausts the bound is unresolved"). This is handback wording only.

## (4) Verdicts

FW5-1: REAL.
- Code: sendReconcile.ts:824-829, :839-842, :892-896; comments :760-763, :814-817, :883-891.
- Pins in app/test/sendReconcile.test.ts:
  - :1054 T1: adopted after a page-2 error at the last check.
  - :1081 T2: provider_unreachable ahead of never_sent, unidentified_candidate and same_fingerprint_sibling.
  - :1123 T3: adopted at check 0; with nothing adoptable, continue provider_error.
  - :1232 test 12: a page-1 failure at every check.
- Residue: F-1 (LOW), plus deviation 2 unpinned.

FW5-2: REAL.
- Code: broadcastFanOut.ts:763 (text), :756-760 (comment), :681-685 (docblock).
- Pins in app/test/broadcastFanOut.test.ts:
  - :1791: no carry line on the success path.
  - :2274 and :2277: 21211, the generic arm.
  - :2295: 30007, the slot write throws.
  - :2314: 30005, the slot write throws.
  - :2336 and :2339: new, the D-2 case where the stats bump throws.

## (5) Not verified, and the throwaway tests

Not verified:
- Real Twilio list behaviour: the sort key, next-page URL paging and the page size.
- The red runs of T1-T3 on 4eef5efa and the 11/11 mutant table were not re-executed, since that needs a checkout or edits to tracked source. I checked each pin against its mutant by reading.
- Relay rungs on error-ended walks were not exercised. The walk does not depend on the owner kind, and P8 covered a relay leg.

Throwaway test app/test/zz-r4-1.test.ts, run alone twice and then deleted:
- P1-P4 PASS. With a page-2 error at the last check, nothing is adopted and the verdict is provider_unreachable, for each of: a sibling record's SID, matching bodies at -61 s and +91 s (outside the window), another share's row, and the syssid marker.
- P5 PASS. A page-3 error at check 0 still adopts the orphan read on page 2.
- P6 PASS. A repair (a row of this recipient) on page 1 is adopted at the last check despite a page-2 error.
- P7 PASS. A page-2 error at check 0, then complete walks, gives never_sent (by design).
- P8 PASS. Deviation 2's behavior, as above.
- P9 FAIL at :326, as intended (F-1).

Timing: both runs started at 16:55 EDT or later. By then npm test had finished and the gate chain was in the Playwright e2e (npm run e2e, started 16:54:21). vitest globalSetup created 22 hc-local tables and teardown dropped 23 under this worktree's test key (hctest...), not lane 8's. I expect no interference with the running gates.

Finished at 16:58 EDT, inside the timebox.
