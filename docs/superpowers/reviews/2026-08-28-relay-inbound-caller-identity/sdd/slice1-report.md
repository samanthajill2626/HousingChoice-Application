# Slice 1 report: durable append contract

Commit: `c337bcc2 feat: store relay refusal caller facts`

Changed paths:

- `app/src/repos/messagesRepo.ts`
- `app/test/repos.test.ts`
- `app/test/helpers/twilioWebhookHarness.ts`

Delivered:

- Added the three typed write and persisted call-item fields.
- Added the storage-only append guard: call, inbound, masked, exact non_member,
  unknown author, no relay sender key, E.164 phone, and contact-ID-requires-phone.
- Mapped supplied fields through production and the in-memory webhook harness.
- Narrowed the raw-counterpart privacy comment while retaining the prohibition for
  party labels and roster attribution.

TDD evidence:

- Red: `npm run test -w @housingchoice/app -- test/repos.test.ts` exited 1 with
  9 expected failures before implementation: the fields were absent and each
  invalid storage shape resolved instead of rejecting. The first sandboxed run
  could not create `node_modules/.vite-temp`; the same command with the required
  worktree permission produced the behavioral red result.
- Green: `npm run test -w @housingchoice/app -- test/repos.test.ts` exited 0:
  1 file, 20 tests passed.
- Green: `npm run typecheck -w @housingchoice/app` exited 0.
- `git diff --check` passed; added lines are ASCII-only.

Residual risk:

- This slice deliberately performs no relay resolution, roster lookup, contact
  lookup, routing, or refusal response change. The existing voice refusal path
  supplies the new metadata in the next slice.
