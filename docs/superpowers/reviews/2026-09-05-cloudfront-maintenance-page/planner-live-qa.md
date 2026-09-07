# Parent live QA: CloudFront maintenance page

Date: 2026-09-07
Tested revision: `39647ace4c8f1ea094eaaaa66569b6dbfbf997dd`

## Target and method

The parent started the repository's hermetic `npm run e2e:session` lane 14
after the full suite stopped and its ports were confirmed closed. The dashboard
was `http://127.0.0.1:10411`, with the app on 10401, fake transport on 10421,
and public app on 10431. No human live app ports were used.

The parent rendered the real Terraform template and canonical catalog through
`e2e/support/maintenancePage.ts`; this exited 0 and wrote
`.playwright-mcp/planner-maintenance.html`. The isolated Playwright MCP browser
fulfilled only test-owned failure/form routes on that hermetic dashboard origin.
Recovery navigation to `/` reached the actual, unmocked dashboard.

This proves document rendering and browser recovery. It does not prove that
CloudFront has applied or substituted the document.

## Observations

| Scenario | Observed result |
| --- | --- |
| GET failure, HTTP 502, 320x800 | Correct title and approved copy, one maintenance marker, no external document dependencies, and 0px document/main horizontal overflow. |
| Keyboard recovery from GET failure | Tab focused Try again with a solid 3px outline. Enter navigated to `/` as GET, with no body or query, received HTTP 200, and displayed the real Sign in with Google screen. No maintenance marker remained. |
| Form POST failure, HTTP 504, 1280x900 | One POST with `submission=once` received 504 and the real rendered maintenance document. No external document dependencies and 0px document/main horizontal overflow. |
| Narrow view with enlarged text | At 320x800 with root font size 200 percent, measured text size was 32px. The action remained visible and focusable, with 0px document/main horizontal overflow. This is text enlargement, not native browser zoom. |
| Keyboard recovery from POST failure | The navigation ledger contained form GET, one failing POST, then one fresh GET to `/`. The final GET had no body or query, received 200, and displayed the real sign-in screen. No submission replay occurred. |

The parent visually inspected both screenshots copied into this worktree:

- `.playwright-mcp/planner-maintenance-desktop.png`
- `.playwright-mcp/planner-maintenance-narrow.png`

The desktop card and narrow focused action fit without clipping. The screenshots
and rendered HTML are ignored local artifacts, not version-controlled records.

## Native zoom limitation

The builder's earlier keyboard attempt did not change native browser zoom. The
parent attempted to inspect the dedicated Chrome for Testing window using the
computer-use tool, but window inspection failed twice, including after refreshing
the window list: `window id 462354 no longer belongs to Chrome; current owner is
Chrome`. No computer-use input actions occurred. Native 200 percent browser zoom
therefore remains a manual verification gap; it must not be inferred from the
passing text-enlargement check.

## Teardown

The parent closed its isolated browser tab. `npm run e2e:stop` exited 0, stopped
launcher 50048 and its children, dropped only lane 14's tables, and released its
lease. The session launcher subsequently exited 1 because of that deliberate
stop; this is not a test failure. The shared DynamoDB Local service was retained.
The session output is `.superpowers/sdd/planner-live-session.log`.
