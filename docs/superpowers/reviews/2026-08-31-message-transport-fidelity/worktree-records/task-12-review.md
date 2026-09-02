# Task 12 independent review - `c3f4aa39..1cfc5d70`

Result: FINDINGS

## P2 - several required states are not actually distinguished by the browser proof

`e2e/tests/dashboard-next/message-transport-fidelity.spec.ts:91-96` defines
`expectTransport` as a start-of-text matcher. It accepts both a requested-only
label and a requested-to-actual transition: `expectTransport(..., 'RCS')`
matches `RCS`, `RCS - ...`, and `RCS -> SMS`.

Consequently, the claimed pending proof at `:253-262` passes when the initial
paint has already (incorrectly) rendered `RCS -> SMS`; the post-callback
assertion checks only that same already-present string. The incomplete-recipient
proof at `:271-275` likewise passes for `RCS -> SMS` so long as it is not
`Mixed`. The native text-only group proof at `:345-350` accepts `MMS -> SMS`.
The direct outbound agreement proof at `:339` accepts every label containing
`SMS`, including a fallback label.

Reproduction: temporarily have the presenter return `RCS -> SMS` before the
signed callback for the fixture at `:115-124`; the initial `expectTransport`
and the later callback assertion both still pass. That violates Task 12.1
points 1, 2, 5, and 8: the states are seeded and visible but the advertised
requested-only / agreement / native-MMS facts are not proven.

Fix with exact, bubble-scoped assertions for the transport segment (or positive
expected label plus a negative `->` assertion) before and after the callback;
make the optimistic and native-group checks distinguish their exact labels too.

## P2 - excluded-recipient absence matcher encodes a backspace, not a word boundary

At `e2e/tests/dashboard-next/message-transport-fidelity.spec.ts:296-300`, the
template literal ends in `\b`. In a JavaScript string literal that produces U+0008
(backspace); it does not provide the `RegExp` word-boundary escape. The resulting
regex source is `^\\(555\\) 091-0005\b` where the final character is a literal
backspace, so it cannot match the normal accessible row name
`(555) 091-0005 - ...`. The `toHaveCount(0)` assertion therefore passes whether
or not the excluded recipient is shown.

Probe executed with Node: the produced regex returned `false` for
`(555) 091-0005 - RCS`; the equivalent source containing `\\b` returned `true`.
This leaves Task 12.1 point 12's excluded-without-code absence claim unproven.

Use `\\b` in the template literal (or, more clearly, an exact accessible-name
matcher / an escaped separator) and retain the zero-count assertion.

## Checked and no finding

- The fixture router remains structurally unreachable in deployed environments:
  `app/src/lib/devRoutes.ts:15-23` requires `devAuthEnabled`, non-production,
  and a DynamoDB Local endpoint; `app/src/lib/config.ts:531-536` refuses
  `DEV_AUTH_ENABLED` in production.
- The callback helper signs the public callback URL and the exact sorted form
  fields (`e2e/fixtures/fakeTwilio.ts:47-54,120-143`), matching the app's
  existing signature model. The provided `SM` callback SID selects the real
  append path and its durable `sid#` pointer (`app/src/routes/dev.ts:1000-1036`),
  so the status route can reach and update the planted message.
- No body/media or fabricated SMS/MMS `ChannelPrefix` inference was added; the
  direct helper permits only RCS channel-prefix evidence.

