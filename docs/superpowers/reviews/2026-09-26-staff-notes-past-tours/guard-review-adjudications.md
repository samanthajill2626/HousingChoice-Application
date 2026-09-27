# Stale-save guard review - adjudications

Change: commit ec45bc83 (the Staff notes stale-save guard, spec 3.9), added
2026-09-27 at Cameron's request after the planner's review flagged the silent
overwrite. Reviewer: one fresh adversarial reviewer, opus
(`guard-review-adversarial.md`, 1 BLOCKING, 1 MEDIUM, 5 LOW). Planner: Opus
(this session, after Cameron switched the model this morning).

| # | finding | ruling |
|---|---|---|
| 1 [BLOCKING] | `useContact.test.tsx:71` pins the exact save body, which now also carries `staff_notes_expected_updated_at`; `npm test` red at ec45bc83 | ACCEPT - my miss (I ran the card's neighbors, not the whole contact directory). The gate run on ec45bc83 caught it independently at the same time. Fixed: the assertion includes the expectation (null: A was never saved). The whole `dashboard/src/routes/contact` directory now runs green (1324). |
| 2 [MEDIUM] | the two-page e2e does not wait for the colleague's save to LAND before sending the stale one; the text check passes against the colleague's still-open textarea, so save order is timing | ACCEPT. The test now waits for the colleague's editor to close (it closes only on a successful save) before the second save. |
| 3 [LOW] | "Someone else saved these notes while you were editing" is wrong for the same user in two tabs, a lost-response retry, or a page simply left open | ACCEPT (copy is the planner's call; the reviewer flagged it as Cameron's, but the spec's words were mine). New copy names what changed, not who: "These notes were changed since this page loaded. The current version is below, and your text is still in the box. Save again to replace it, or Cancel to keep it." Spec 3.9 updated. |
| 4 [LOW] | the conflict panel is not linked to the box; "They cleared the notes." looks like note text | ACCEPT. The textarea carries `aria-describedby` pointing at the panel while it is up (pinned in a test); the cleared case reads "(The notes were cleared.)" in muted italics. Focus stays where the user left it (Save); the panel is `role="alert"`, so it is announced without a focus move. |
| 5 [LOW] | `contactsRepo.update` with a guard and an EMPTY patch returned success without checking the guard | ACCEPT. The no-op path now checks the guard on a consistent read and throws ConditionalCheckFailed on a mismatch, matching the doc and the fake; pinned in the DynamoDB Local test. |
| 6 [LOW] | `staff_notes_expected_updated_at: ''` is accepted but can never match | ACCEPT. Refused with 400 `must be a non-empty string or null`; pinned. |
| 7 [LOW] | two card tests claim more than they check (a stale 409 with no contact never runs; Cancel never checks their note shows) | ACCEPT. Added the no-contact case (falls back to the plain alert, no description link); the Cancel test now uses a stateful parent and asserts the colleague's note is what read mode shows. |

Re-verification after the fixes: app 101 across the four contact files
(incl. DynamoDB Local), typecheck 0 (app, dashboard, e2e), card 20/20, the
whole contact directory 1324/1324, lint clean on every touched file except the
pre-existing `useClosedTours` error. The two-page e2e is re-run with the final
gates.
