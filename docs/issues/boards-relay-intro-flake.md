---
id: boards-relay-intro-flake
title: boards.spec.ts relay-intro e2e failure (pool-number provisioning gap)
type: bug
severity: med
status: resolved
area: e2e
created: 2026-06-15
resolved: 2026-06-16
refs: e2e/tests/dashboard/boards.spec.ts
---

**Problem.** The `boards.spec.ts` "set up its relay thread → both parties get the intro
text" test failed. Two causes: the relay-thread setup provisions a pool number, which the
fake-twilio mock used to `501` (`AvailablePhoneNumbers`/`IncomingPhoneNumbers.json`); and
once those were implemented, the app's `relayLiveProvisioning` kill-switch still defaulted
OFF under `MESSAGING_DRIVER=twilio`, returning `503 relay_provisioning_disabled` before
reaching the fake.

**Resolution (2026-06-16, on the fake-twilio voice work).** (a) The fake now implements
real number provisioning (voice work, Phase 6); (b) `config.relayLiveProvisioning` defaults
ON when `twilioApiBaseUrl` is set (mock mode) — explicit `RELAY_LIVE_PROVISIONING` still
wins; prod-safe because `TWILIO_API_BASE_URL` is rejected at boot in production. The pool
number is now minted through the fake and the intro SMS fans out to both parties as the
spec asserts. Live-verified green (`5 passed`, incl. the voice flows).

Migrated from the former `docs/KNOWN_ISSUES.md`.
