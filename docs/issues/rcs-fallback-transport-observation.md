---
id: rcs-fallback-transport-observation
title: Validate Twilio RCS fallback transport observations before enablement
type: decision
severity: med
status: deferred
area: app
created: 2026-09-01
refs: docs/superpowers/specs/2026-08-31-message-transport-fidelity-design.md
---

**Problem.** Twilio documents automatic RCS fallback and documents that a
successfully delivered RCS Message resource/callback has `From: rcs:<SenderId>`.
It does not document whether an SMS/MMS fallback retains the same Message SID or
the complete `From` / `ChannelPrefix` payload across every callback. Storage and
presentation can support requested-versus-actual transport now, but production
RCS fallback normalization must not be enabled from synthetic assumptions.

**Suggested fix.** Before any RCS sender is enabled, run a controlled Twilio test
covering successful RCS, SMS fallback, and MMS fallback. Preserve signed callback
payloads and fetched Message resources with phone numbers/content redacted.
Confirm SID continuity plus `From`, `ChannelPrefix`, `ChannelMetadata`, and SID
prefix behavior. Update the provider-boundary normalizer and fake-provider
contract tests from that evidence, then resolve this issue as part of the RCS
enablement change.
