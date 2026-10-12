# Live self-QA - /join housing authority (orchestrator, Playwright MCP)

Lane 4 (`npm run e2e:session`, booted at 72473aec after the last commit; code identical to
the gated 15c1676f): app http://127.0.0.1:9401, dashboard http://127.0.0.1:9411. Project
Playwright MCP (bundled Chromium, isolated), driven with `browser_run_code_unsafe`; every
value below was MEASURED in the page or at the network boundary, not eyeballed. Screenshots
(gitignored) under `W:/tmp/join-housing-authority/.playwright-mcp/selfqa-*.png`.

| # | Scenario | Measured result | Verdict |
|---|---|---|---|
| A | /join first load (1280 px) | select "Housing authority" enabled, value and shown text "Atlanta Housing Authority"; options = the 12 starting-list names in D1 order, then "Not sure" last; help "The organization that runs your voucher." present and wired (`aria-describedby="intake-authority-help"`); "Sign me up" enabled after the load | PASS |
| A2 | StrictMode list reads | exactly 2 list requests on mount: the first `net::ERR_ABORTED` (effect cleanup), the second 200 - then NO further list read across three sign-ups and two "Sign up another person" | PASS (D9) |
| B | Three sign-ups in a row | POST bodies at the boundary: `housingAuthority: "Atlanta Housing Authority"` (default left alone), `"DeKalb County Housing Authority"` (chosen), and NO `housingAuthority` key for "Not sure" | PASS (D8) |
| B2 | Thank-you, then "Sign up another person" | heading "Thanks - you're signed up!" (rendered with the em dash) focused; after the button: focus on "First name", names/phone blank, consent unchecked, the select still on the previous choice (Atlanta, then DeKalb kept) | PASS (D9) |
| C | The leads, read as VA through the API and the contact page | all three: `type tenant`, `status onboarding`, `capture_source housing_fair`, `housing_fair_signup_v2 true`; authority Atlanta / DeKalb / none; contact page header shows "Onboarding" and "Atlanta Housing Authority", Details shows Housing authority + Status Onboarding (selfqa-04, -05) | PASS (D5) |
| D | Loading (list read held 3 s by a route) | select disabled, only option "Loading...", "Sign me up" disabled; then Atlanta default | PASS (D8) |
| E | Failed read (route aborts) | only "Not sure", note "The list of housing authorities could not be loaded." shown, send enabled; the sign-up POST carried no authority | PASS (D8) |
| E2 | "Sign up another person" after a failed read | the list is read again (1 response) and the default rule applies (Atlanta, full list) | PASS (D9) |
| F | Timeout (route never answers) | the select flipped to the failed state 10283 ms after navigation (10 s timer + page load) | PASS (D8) |
| G | 429 on the sign-up (fulfilled by a route; the server shape is pinned by app tests) | alert "Too many sign-ups from this network in the last minute. Wait a minute, then send again."; typed fields kept | PASS (D8) |
| H | REAL not-listed recovery: founder adds "Selfqa Test Housing Authority", /join lists it, it is chosen, founder DELETEs it (204), then send | server `400 {"error":"housing_authority_not_listed"}`; the form re-read the list: "Choose one" first and shown, "Not sure" last, the deleted name gone, send BLOCKED, all typed fields and the consent box kept, message "The housing authority list was updated. Choose the housing authority again."; choosing Atlanta re-enabled send; the second POST created an onboarding lead with Atlanta and the marker | PASS (D3, D8). Observed: the alert stays after the new choice until the next send (AR-7, accepted; accessibility angle filed as `join-not-listed-error-on-wrong-fields`) |
| I | Flyer page `/p/<a new available unit>` | no "Housing authority" select, no help text, ZERO list reads | PASS (D8: flyer unchanged) |
| J | 360 px, longest name ("Georgia Housing Voucher Program (DBHDD)") selected | `documentElement.scrollWidth` 345 = `clientWidth` 345 (no horizontal scroll); the select spans exactly the form (left 41, right 304); the closed native select clips the name's tail ("(DBHDD)"), the open list shows it in full | PASS (native select truncation, no overflow) |

Console: only expected entries - the injected list abort, the fulfilled 429, the real 400,
a 404 from the orchestrator's own `/p/null` probe, and an unresolvable example photo host on
the QA unit. No application error.
