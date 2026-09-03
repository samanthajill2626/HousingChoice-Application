# Hermetic live self-QA - clickable communications links

Date: 2026-09-02
Commit under test: `f065942a`

## Controlled session

Started the feature worktree's dedicated `npm run e2e:session` lane and waited
for its ready record. The owned lane was 8: app 9801, dashboard 9811, and fake
Twilio 9821. `GET http://127.0.0.1:9811/__dev/ping` returned HTTP 200 with
`dev: true`, `lane: 8`, `tablePrefix: hc-local-8-`, and `appCommit: f065942a`.
This confirms the self-QA target was the hermetic feature lane, not a live
dashboard port.

## User-flow evidence

The interactive browser-control runtime had no available browser connection in
this execution environment, so no manual tab/screenshot could be driven. The
fallback is the real browser acceptance proof already run against the same
hermetic application contract:

- `npm run e2e -- tests/dashboard-next/comms-clickable-links.spec.ts` exited 0
  with `1 passed (15.5s)` after the repair. It logged in, injected an inbound
  message, visited the contact, measured exact link labels/hrefs/attributes and
  punctuation exclusion, opened the routed popup, and checked that the contact
  route and bubble metadata state did not change.
- The next isolated `inbox-comms.spec.ts` run exited 0 with `1 passed (15.1s)`,
  confirming E1's `afterEach` reseed returned the single-worker lane to lean
  state before subsequent dashboard behavior.

The automated proof measures the interactive boundary that cannot be observed
from a disconnected manual browser: external anchor opening, source/destination
identity, and stopped bubble propagation.

## Cleanup

`npm run e2e:stop` exited 0 and reported that it stopped only the recorded lane
8 launcher and children, dropped `hc-local-8-*` tables, released lane 8, and
removed owned session state. No live port, deployment, or infrastructure target
was accessed.
