# E1 browser acceptance report

## Scope

Owned and added only `e2e/tests/dashboard-next/comms-clickable-links.spec.ts`.
No production code, fixture endpoint, manifest, lockfile, or dashboard test changed.

## Live fixture contract checked

`POST /__dev/extraction/message-fixture` accepts the lean seed's `conv-0001`, a
non-empty `body`, ISO `createdAt`, inbound direction, and `{ mode: 'legacy' }`;
it returns a `tsMsgId`. Lean already supplies `contact-tenant-0001`, so no full
seed profile or new endpoint was necessary.

## Browser proof

The test reseeds lean, plants one inbound body with explicit
`https://example.com/explicit?x=1#top` and bare
`example.com/bare/path?unit=2#photos` surrounded by `,`, `(`, `)`, and `.`.
It signs in through the dashboard, visits the seeded contact, and proves both
visible anchor names, exact normalized hrefs, `_blank`, and `noopener noreferrer`.
It also proves punctuated names do not exist as anchors. A routed, hermetic
`https://example.com/**` target opens the explicit link in a popup at the exact
URL while the dashboard remains on the contact and the message bubble never gains
its `revealed` metadata class.

## Verification

Initial run was already-green by design: this is a post-integration acceptance
test after S1-S3's red-to-green unit/component work, so a pre-integration red
run would not be meaningful.

The first sandboxed invocation could not create gitignored e2e artifacts
(`EPERM`), not a test failure. The authorized rerun was:

`npm run e2e -- tests/dashboard-next/comms-clickable-links.spec.ts`

Exit 0: `1 passed (33.8s)`.

Post-run owned lane check read `e2e/.artifacts/lane.json` for lane 8 and reported
`e2e-lane-ports-free` for app 9801, dashboard 9811, fake 9821, and public base
9831.

## Commit

`070655f8 test(e2e): prove clickable communications links`
