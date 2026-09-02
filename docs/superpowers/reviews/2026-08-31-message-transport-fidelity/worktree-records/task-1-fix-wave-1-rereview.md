# Task 1 fix-wave 1 fresh re-review

Reviewed fix: `3ed5b053` (`app/src/adapters/twilioMessageTransport.ts`,
`app/test/twilioMessageTransport.test.ts`).

## Verdicts

- Spec conformance: CONFORMS
- Task quality: PASS

## Fresh sweep and cold review

No new findings.

- The full caller/importer sweep finds the normalizer has no production caller
  yet; Task 1's only consumers are its direct tests. `messageTransport.ts` is
  independently pure and has no Twilio-field reader. This matches the staged
  Task 1 boundary in the plan.
- Provider-evidence precedence remains conservative. Malformed and unknown
  metadata, a non-RCS channel prefix, and a non-RCS channel `From` are all
  rejected before any explicit RCS or SID inference at
  `app/src/adapters/twilioMessageTransport.ts:108-119`. Explicit documented
  RCS evidence is then considered before `SM`/`MM` at `:121-134`.
- The fix makes every non-empty parsed metadata object other than exactly
  `type === 'rcs'` unknown (`:33-42`). Thus `{}`, `{"type":"sms"}`, and an
  object with an unrecognized type cannot silently authorize SMS/MMS SID
  inference. Authenticated provider traffic produces the existing safe
  `conflict`; fixtures produce the quiet missing result through `conflict()`
  at `:60-80`. Safe facts remain limited to SID prefix and schemes, rather
  than endpoints.
- The new table test covers both sides of that authenticated-vs-fixture
  boundary for `ChannelMetadata: '{}'` at
  `app/test/twilioMessageTransport.test.ts:104-129`.

## Original P1 adjudication

P1 is resolved. The predecessor expression treated an object with no `type` as
`absent`, enabling the `missing/unresolved-channel-evidence` path. The current
unconditional `return 'unknown'` instead reaches
`conflict(..., 'unknown-rich-channel-evidence')` for authenticated traffic.
The regression is meaningful: restoring the predecessor
`type === undefined ? 'absent' : 'unknown'` expression makes the authenticated
`{}` row receive `missing/unresolved-channel-evidence`, not its asserted safe
conflict. The fix-wave report records that exact red result (2 failures) before
the production correction and 51 focused tests green afterward.

## Independent check note

I attempted the prescribed focused test command. It could not start because
Vite was denied creation of a generated config file under
`app/node_modules/.vite-temp` (`EPERM`, exit 1), before any test executed. This
is an environment/write-permission failure, not a test assertion or code finding;
the already-recorded fix-wave focused green proof remains the executable
evidence for this review.
