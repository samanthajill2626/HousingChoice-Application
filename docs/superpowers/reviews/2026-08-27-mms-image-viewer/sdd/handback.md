# In-app MMS image viewer handback

## Result

`MERGE-READY @70705b1c45fdf7b8550775293f3d38516b1ad57f on feat/mms-image-viewer (W:\tmp\mms-image-viewer), 0 behind main, UNMERGED (human gate)`.

The branch is clean, has no `MERGE_HEAD`, and `main` was still
`bd17b7d497c26eb3ec80d2c32032befc6545e0ce` at the final freshness check.

The original prerequisite was not on main at dispatch.  The human explicitly
authorized its direct merge into this feature branch; it was verified at
`e3a97e7741d24d400f01b2a434aae9cd842a3031` and merged intact in normal merge
commit `5b2d3a3741e2260dd9420190c8b0db66eb49d697`.  No main branch was moved or
merged by this mission.

## Work map

- S1 shipped: shared Modal supports the media layout while preserving its prior lifecycle.
- S2 shipped: history-state and nested-scroll capture/restore primitives.
- S3 shipped: authenticated app-level provider, portal, focus, inert, scroll, and same-URL Back/Forward lifecycle.  The review fix places the provider inside `AuthGate` and proves sign-out cannot leave media open on Forward.
- S4 shipped: fitted geometry plus wheel, trackpad-pinch, touch-pinch, and pan with hard transient 1..8 bounds; `react-zoom-pan-pinch@4.0.4`, `smooth=false`, and padding disabled.  Only Close and Download are visible.
- S5 shipped: eligible Timeline images open the viewer.
- S6 shipped: MediaGallery/file panes open the same single-image viewer.
- S7 shipped: current Timeline hosts have explicit coverage.
- S8 shipped: desktop, mobile, and relay Playwright coverage; final browser battery passed.
- S9 shipped: full gates, independent specification and adversarial review, one fix wave and fresh re-review, self-QA attempt, issue filing, and handback.

No carousel, visible zoom/reset controls, restorable media URL, or new MIME eligibility was added.

## Final gates on 70705b1c

- `npm run typecheck`: exit 0.  The log records successful app, dashboard, e2e, fake-twilio, and fake-twilio-web TypeScript checks.
- `npm test`: exit 0: `344 passed | 1 skipped` files and `6185 passed | 9 skipped` tests (app); `182/2827` (dashboard); `19/492` (e2e); `34/240` (fake-twilio); `13/111` (fake-twilio-web).
- `npm run smoke`: exit 0: `smoke-dist: OK - 1346 import specifier(s) across 238 emitted file(s) resolve under plain Node.`
- `npm run e2e`: exit 0: `259 passed (17.0m)`.
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`: exit 1 with four errors and one warning, all source-identical to `main`: `app/test/messaging.test.ts` unused-disable warning; `ContactDetail.test.tsx` unused `PlacementsPage` and `UnitsPage`; `Timeline.tsx` existing `setNow(fresh)` effect rule; and `outbound-mms.spec.ts` unused `DIANA_ID`.  Baseline comparison found no new lint error under the touched-file ratchet.

`git diff --check main...HEAD` exit 0.  `npm ls react-zoom-pan-pinch -w @housingchoice/dashboard` reported `react-zoom-pan-pinch@4.0.4`.

## Review and QA

Specification review: `.superpowers/review/spec-conformance.md`; adversarial review: `.superpowers/review/adversarial.md`; findings/adjudications: `.superpowers/review/findings.md`; fresh fix re-review: `.superpowers/review/fix-wave-rereview.md` (PASS).

- Fixed SC-1 by proving backdrop dismissal restores both scroll owners and focus.
- Fixed AD-2 by scoping the provider to authenticated `AuthGate` content and testing close/sign-out/Forward.
- Fixed AD-4 with a same-turn double-open latch and coverage.
- Filed open high-risk follow-up `docs/issues/authenticated-mms-media-browser-cache.md` for pre-existing source-identical private-media cache policy (AD-1); it is deliberately not a partial cache-header change in this viewer mission.
- Retained the approved disconnected-trigger focus behavior (AD-3): the stated contract skips focus restoration when the prior trigger is disconnected.

I ran `npm run issues`; it generated the ignored index and reported `264 open, 154 closed, 418 total`, with an existing warning for `perf-selfqa-route-contract-drift.md`'s unknown `medium` severity.

Live self-QA was attempted through `npm run e2e:session`, but the available browser control session returned no browser after bootstrap checks, so manual visual inspection could not be completed.  The session was stopped safely.  This is recorded as a harness limitation, not claimed as manual visual proof; the final hermetic real-browser suite above exercises the desktop, mobile, relay, history, focus, scroll, and media scenarios.

## Change accounting

Commits are `5b2d3a37` (human-authorized prerequisite merge), `94cd86d3`, `b0290ed0`, `313017a8`, `d648d941`, `d00e6399`, `a1062c36`, `2002d90c`, `4178276e`, `de6a6535`, `4ca47f50`, `48d21f60`, `775f4ed5`, and `70705b1c`.

Against `main`, the branch is 77 files, `12,703` additions and `231` deletions, including the directly merged prerequisite.  The viewer work after that prerequisite is `4,155` additions and `198` deletions.

No deployment, infrastructure mutation, backfill, environment change, mainline merge, or post-merge operation is owed.  A normal dependency install will receive the committed lockfile update.
