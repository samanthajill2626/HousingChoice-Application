# Slice 6 - focused relay caller identity E2E

## Delivered

- Added `e2e/tests/dashboard-next/relay-inbound-caller-identity.spec.ts`.
- The hermetic scenario lean-reseeds, logs in as VA after reseed, creates an open
  two-member relay group, calls its actual pool number from a third unique E.164,
  and proves the fake recorded zero Dial legs.
- It polls the authenticated messages endpoint for the CallSid row via
  `provider_sid`, asserts `non_member`, normalized caller phone, and no external
  contact ID; then proves the phone has no contact record.
- It proves the staff relay card face, `Not connected`, collapsed details, and
  opened details including formatted phone, no-link state, non-member explanation,
  and the dashboard's shared full-seconds formatter. The test imports the shared
  dashboard `formatPhone` rather than reimplementing phone formatting.

## Focused proof

Command:

```text
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/relay-inbound-caller-identity.spec.ts
```

Final execution: exit 0; 1 passed; Playwright duration 15.4s (test body 2.723s).
Result artifact: `e2e/.artifacts/results.json`, final stats `expected: 1`,
`unexpected: 0`.

The first non-sandbox execution reached the test but failed because the new test
looked for the masked call's CallSid in `call_sid`; the authenticated messages
response exposes that CallSid as `provider_sid`. The test was corrected to use
the actual wire field, then the focused proof passed. The initial failure emitted
its screenshot, video, and error context under
`e2e/.artifacts/test-results/dashboard-next-relay-inbou-b85f2-g-and-is-explained-to-staff-chromium/`.
Those Playwright artifacts were cleaned by the successful rerun before they were
copied, so no retained first-failure attachment remains; the final result JSON is
present. The very first sandboxed command exited 1 before tests began because it
could not create `e2e/.artifacts`; the authorized rerun created the lane normally.

## Cleanup

`afterAll` calls the standard lean `reseed(request)`. The final run logged its
post-test `POST /__dev/reseed` as HTTP 200 with `profile: lean`, so the temporary
relay group and caller were removed before the run completed.

## Commit

`1065acce test: prove relay caller identity end to end`
