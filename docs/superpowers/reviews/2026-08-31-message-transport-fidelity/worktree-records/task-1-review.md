# Task 1 independent review - domain and Twilio evidence normalizer

Reviewed range: `7ca5394c..4f5d2fcaf9280829323cc0e5c0d6ed4df0725ae7`

## Verdicts

- Spec compliance: PARTIAL
- Task quality: NEEDS_FIX

## Finding 1 - P1: non-empty ChannelMetadata without type is silently downgraded

Evidence:

- `docs/superpowers/specs/2026-08-31-message-transport-fidelity-design.md:154-155` requires unknown or conflicting non-empty evidence to remain absent and emit one safe structured warning.
- `app/src/adapters/twilioMessageTransport.ts:38-40` parses a non-empty object such as `{}` as `absent` merely because `type` is absent.
- `app/src/adapters/twilioMessageTransport.ts:145-146` then returns `missing/unresolved-channel-evidence`, so an authenticated provider caller has no `conflict` result from which to emit the required warning.
- `app/test/twilioMessageTransport.test.ts:86-102` covers malformed metadata but not a valid, non-empty object without `type`; `:123-131` therefore cannot catch the silent downgrade.

Reproduction:

```text
node -e "... normalize({ direction: 'inbound', authenticatedProviderTraffic: true, messageSid: SM..., to: '+16175550100', channelMetadata: '{}' }) ..."
{"actual":{"kind":"missing","source":"unresolved-channel-evidence"},"expected":"conflict","pass":false}
EXIT 1
```

Required correction:

Treat a non-empty parsed metadata object that lacks `type` as unknown rich-channel evidence, returning `conflict` for authenticated traffic (and the existing quiet `missing` result for unauthenticated fixtures). Add a table-driven case for `{}` with a valid SM/MM SID and a matching unauthenticated counterpart. That regression test fails if the implicated `type === undefined ? 'absent'` behavior is restored, because it receives `missing` instead of `conflict`.
