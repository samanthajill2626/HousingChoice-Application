# Plan review R1 - adjudications (planner)

Plan: `docs/superpowers/plans/2026-09-26-voicemail-greeting.md` DRAFT 1
@b07b85be -> DRAFT 2. Reviewers: A (`plan-r1-reviewer-a.md`), B
(`plan-r1-reviewer-b.md`), opus, same brief, independent. B ran every
runtime claim as a throwaway probe on this machine's Node 24 / express 5 /
supertest 7 / user-event 14 / playwright 1.61 / vite 7.

## Reviewer B

B1 [BLOCKING] supertest sends `Connection: close` by default, so the 3 MiB
and 6 MiB refusal tests reset even against the correct route - ACCEPT. The
`admin()` helper now sets `Connection: keep-alive` (B verified 400/413 JSON
x3 with it); the Step 6 troubleshooting note names supertest's header as
the cause instead of blaming the route. Decision changed: NO.

B2 [BLOCKING] The chunked over-cap `res.once('finish', () => req.destroy())`
resets the client before it reads the 413 (5/5); `req.resume()` delivers it
(5/5); supertest cannot send a Readable - ACCEPT. The spec's DRAFT 3 wiring
for the chunked case was never measured (the round-2 probe measured
pipe+resume). Spec 4.3 precision edit: EVERY refusal drains with
`req.resume()`; the only unbounded shape (a chunked body over the cap from
a non-browser client) is accepted as bounded by admin-only access and the
10/min limiter, and named in 4.3 and the handback. The chunked route test
drives a raw `http.request` (two writes, `Transfer-Encoding: chunked`)
against `app.listen(0)`. Decision changed: NO.

B3 [HIGH] Task 5's tests reference a non-existent `harness` and sit outside
the describe that owns `world` / `seedRingingBridge` - ACCEPT. The tests
are placed INSIDE that describe; `founderHarness(world, opts?)` learns the
harness options; a new `seedRingingBridgeWith(opts)` returns `{ app,
capture }` while `seedRingingBridge` keeps its signature for the existing
callers.

B4 [HIGH] `aria-labelledby` on the block wrapper duplicates the "Voicemail
greeting" label (RTL and Playwright both fail) - ACCEPT. The wrapper is a
plain `<div>`; only the `<h3>` and the `<audio aria-label>` carry the name.

B5 [HIGH] user-event's `applyAccept` filters the M4A out - ACCEPT. The block
tests use `userEvent.setup({ applyAccept: false })`.

B6 [HIGH] A throwing injected `fetchStatus` aborts `leaveVoicemail` -
ACCEPT. The engine wraps the call in try/catch (status 0 on throw), so
"continues regardless" holds for any implementation, not only the default.

B7 [HIGH] The e2e header comment contains the banned literal - ACCEPT.
Reworded ("the guard-banned document-width expression").

B8 [MEDIUM] Wrong uploader identity in Task 4 tests - ACCEPT.
`TEST_ADMIN_USER.userId` / `.email` are used.

B9 [MEDIUM] Test (g) is an empty body - ACCEPT. Written in full from the
file's masked-miss case (`seedRelayGroup` + masked `/voice` + `/status`).

B10 [MEDIUM] Test (e) cannot show `withTimeout` exists; hung GetItem /
presign unpinned; no adapter test for the forwarded `abortSignal` - ACCEPT.
Test (e) keeps the hung-head shape (it proves the abort signal path) and a
new (e2) hangs the SETTINGS read (`world.settingsRepo.getOrgSettings`
replaced by a never-settling promise - the router holds the object
reference) so only `withTimeout` can end the wait; it asserts the WARN's
`err.message` contains `exceeded`. Task 4 gains
`app/test/mediaStore.head.test.ts` with the fake-client pattern of
`mediaStore.getStreamRange.test.ts`, asserting `abortSignal` reaches
`client.send`.

B11 [MEDIUM] The e2e server-refusal assertion is vacuous; the Vite dev proxy
forces `Connection: close` so a multi-MB server refusal resets in LOCAL DEV -
ACCEPT. The e2e waits for the PUT's 400 response (`page.waitForResponse`)
and asserts the alert after the client-side alert was cleared by the new
choice; the body stays 200 KB. The dev-proxy limitation is recorded in
spec 4.3 as a local-dev-only known limitation (production is CloudFront ->
origin, persistent; UNVERIFIED) and in the handback.

B12 [LOW] `minimalWav` imported from a test file re-runs Task 1's suite -
ACCEPT. Moved to `app/test/helpers/audioFixtures.ts`.

B13 [LOW] Perf-contract drift (routes.ts citations, templates.ts endpoint
list, VOICE_TERMINAL) - ACCEPT for the two cheap edits (citations gain
`useVoicemailGreeting.ts`; `ENDPOINT_TEMPLATES` gains the three greeting
endpoints); `VOICE_TERMINAL` left alone (an extra satisfied alternative is
harmless and `perf:pages` is human-invoked).

B14 [LOW] Stale "DRAFT 2" and the hard-coded trailer - ACCEPT. Header says
DRAFT 3; the trailer text says "name the AUTHORING model".

B15 [LOW] No task carries the handback items - ACCEPT. Task 10 gains the
handback checklist (assumptions A-H, 4.10 infra facts, the section 7 dev
check, the local-dev proxy limitation).

B16 [LOW] Client MIME aliases widen the spec; 0xFFF9 and body+rawBody
untested - ACCEPT. Spec 4.7 precision edit names the aliases; the two
tests are added.

## Round 1 outcome (B)

Accepted: B1-B16. Rejected: none. Decisions changed: NONE (test mechanics,
harness shape, one refusal-wiring correction that the spec's own round-2
probe had already measured). Reviewer A's findings are adjudicated below
when its report lands.

## Reviewer A

A1 = B1, A2 = B2, A3 = B3, A4 = B9, A5 = B4, A6 = B7, A7 = B5, A8 = B8,
A9 = B6, A13 = B10 (adapter test), A14 = B12, A16 = B14, A18 = B15,
A19 = B16 - all ACCEPT, folded in once. A independently reproduced B1/B2
(ECONNRESET 6/6 and 10/10) and ran the Task 8 hook, block and tests
verbatim under the dashboard's vitest (3 of 10 red as written; 10 of 10
green with the aria-labelledby and applyAccept fixes) - the strongest
evidence in either report.

A10 [MEDIUM] The Vite dev proxy forces `Connection: close`, so e2e, local
dev and SELF-QA hit the reset on multi-MB refusals; a self-QA could "fix"
correct wiring - ACCEPT (extends B11). The mission block's watch items
carry it explicitly: a multi-MB server refusal resetting through the Vite
proxy in self-QA is the PROXY, not the route; verify the route with the
supertest keep-alive tests and a raw `http.request`, never by "fixing"
the wiring.

A11 [MEDIUM] A failed Remove renders its alert behind the modal backdrop -
ACCEPT. While the dialog is open, `state.error` renders INSIDE the Modal
body (the ConfirmRemoveDialog shape); a remove-failure test is added.

A12 [MEDIUM] The audio GET is undeclared in the perf route contract and
the endpoint templates - ACCEPT. `VOICE_GETS` gains
`conditional('/api/settings/voicemail-greeting/audio', ['v'])`;
`ENDPOINT_TEMPLATES` gains the three greeting endpoints; `routes.test.ts`
updated; the Spinner-satisfies-terminal remark is noted, not changed
(`perf:pages` is human-invoked and the terminal's other alternative still
holds).

A15 [LOW] The Task 6 twimlInterpreter "append" re-imports - ACCEPT. The
task says: create the file with the imports if absent, else add only the
`describe`.

A17 [LOW] Playwright invoked outside the sanctioned entry point - ACCEPT.
Task 9 uses `npm run e2e -- tests/dashboard-next/voicemail-greeting.spec.ts`
(e2e/README.md line 67 documents that form).

## Round 1 outcome

Accepted: every finding from both reviewers (B1-B16, A10-A12, A15, A17,
plus the shared ones). Rejected: none. Decisions changed: NONE - all
corrections are test mechanics, harness shape, a refusal-drain detail the
spec's own probe had measured, and two perf-contract rows. Both BLOCKING
findings were empirical and reproduced by both reviewers independently.
Round 2 continues reviewer A (it ran the dashboard tests for real and
found the modal and perf-contract gaps B missed) with the re-review
charge and B's report path.
