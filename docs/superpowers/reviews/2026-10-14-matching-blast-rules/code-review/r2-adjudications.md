# Code review round 2 - orchestrator adjudications

Fresh reviewer on 0be33fef (`r2-review.md`): 0 blocking/high/medium; every
fix-wave-1 fix verified REAL (ADV-3, ADV-5, CONF-2, CONF-3 mutation-proven;
CONF-6, ADV-9 by reading); no round-1 ruling reversed; two widening asks.

| Item | Sev | Ruling | Action |
|---|---|---|---|
| R2-1 a seed past the 1000-row preview bound is cut silently and never texted | LOW | FILE | Pre-existing (the reviewer reproduced it against main's route), unreachable at today's volume. Filed `docs/issues/matching-preview-cap-drops-hand-picked-seed.md` with the fix (seeds first in the union; `truncated` when rows exceed the cap) and the spec D8 sentence it contradicts. |
| R2-2 Preview waits on two reads with no client timeout | INFO | NOTE | Bounded by the CDN origin timeout in prod, which settles the gate with its D3 notice. |
| FW-1 the ADV-4 issue's second suggested fix cannot work | INFO | FIX (docs) | `matching-composer-422-unmatched-member-clears-filter.md`: the `candidates` bullet replaced by the safe-but-stuck alternative, with the reviewer's reason. |
| FW-2 ADV-3's fail-safe shows a misleading 1:1 note after a rollback | INFO | NOTE | Rollback window only; nothing is sent unchecked; ticking the row works. |
| Challenge: ADV-2 issue too narrow; decide before merge | - | UPHELD | `matching-prefill-org-list-failure-fails-open.md` widened: the failed-property-load sibling (no voucher size either; `?unitId=` has no retry) and the stale-list sibling (one list read per mount); option 2 also closes the stale list; title says DECIDE BEFORE MERGING. The handback puts it to Cameron at the merge gate (the spec D3 contract stays as built until he decides). |
| Challenge: ADV-1 note should cover installed apps | - | UPHELD | `matching-default-check-stale-bundle-window.md` and the handback's post-merge note: reload open tabs AND relaunch installed dashboard apps (PWA). |

No code changed in response to round 2, so no further review round is
needed: the review chain closes at round 2 (docs-only follow-ups verified by
the orchestrator).
