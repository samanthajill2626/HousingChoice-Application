# Task 8 review - e924b412

Verdict: NEEDS_FIX

Scope reviewed: Task 8 plan steps 8.1-8.6; the committed diff; import, lean/full/performance seed, dev fixture, fake engine/signer/control, fake-web client mirror, and e2e callback controls. This was a read-only static review; no tests were run.

## Findings

### F1 - Full cast writes an MMS-with-media row as actual SMS

Severity: must-fix

`app/src/lib/seed/cast.ts:25` includes `msg-cast-milu-003` in `CAST_INBOUND_SMS_IDS`, and `:39` expands that list to `{ actual: 'sms' }`. The underlying row at `:1246-1257` is explicitly an inbound `type: 'mms'` message with an `image/jpeg` attachment. The resulting full-profile seed writes schema version 1 with `actual_transport: 'sms'` for an MMS fact, so it exercises an impossible transport rather than the intended explicit provider evidence.

Repro: call `castItems()`, find the item whose `tsMsgId` ends in `#msg-cast-milu-003`, and observe `{ type: 'mms', media_attachments: [...], actual_transport: 'sms' }`.

Fix: move that ID to an inbound-MMS declaration and add a full-cast assertion that every declared media/MMS scenario has its intended explicit actual transport. Do not infer in the helper; correct the explicit declaration.

### F2 - Direct e2e inbound helper can fabricate undocumented SMS/MMS ChannelPrefix

Severity: must-fix

`e2e/fixtures/fakeTwilio.ts:61` accepts arbitrary `channelPrefix: string`, and `:73` forwards it directly into a signed app callback. Consequently a test can call `postInboundSms(..., { channelPrefix: 'sms' })` or `mms` and create exactly the synthetic `ChannelPrefix=sms|mms` shape forbidden by the spec section 11 and Task 8.3. The fake engine/signer correctly restrict this control to `rcs`; this bypass creates an inconsistent second fake-provider path.

Repro: invoke `postInboundSms(request, { from, body, messageSid, channelPrefix: 'sms' })`; the generated signed form contains `ChannelPrefix=sms` rather than rejecting before the request.

Fix: use the same RCS-only validation/union at this e2e boundary and add a focused regression that `sms` and `mms` are rejected while omitted and `rcs` remain supported.

### F3 - Versioned outbound dev rows can be persisted without requested transport

Severity: must-fix

`app/src/routes/dev.ts:867-878` accepts `{ mode: 'versioned' }` with neither fact, and `:884-886` rejects only the inverse inbound-requested combination. `withSeedTransport` has the same one-sided check at `app/src/lib/seed/messageTransport.ts:40-44`. Thus `POST /__dev/extraction/message-fixture` with `direction: 'outbound'` and `transport: { mode: 'versioned' }` writes a new version-1 outbound carrier message with no `requested_transport`. This violates the Task 8 requirement to validate explicit dev inputs and the approved acceptance criterion that every newly persisted outbound message stores requested transport.

Repro: submit the payload above; the route reaches `PutCommand` at `dev.ts:888-900` and emits `transport_schema_version: 1` without `requested_transport`. The existing dev test only covers the analogous no-fact fixture as inbound (`app/test/devMessageTransportFixture.test.ts:51-55`), so it does not catch the invalid outbound state.

Fix: make the shared declaration validator reject versioned outbound declarations without `requested`; add the rejected dev fixture case. Preserve `legacy` outbound support for intentionally historical rows.

### F4 - Fake-phones' documented engine-type mirror was not updated

Severity: should-fix

`fake-twilio/src/engine/types.ts:21-34` adds `DeliveryProfile.transportEvidence`, but the separate fake-web mirror still ends at `errorCode` in `fake-twilio/web/src/api/types.ts:15-23`. Its header at `:3-6` explicitly requires updating both copies when engine types change. Present UI controls still send subset profiles, so this does not break existing sends, but the client DTO is now stale and cannot type an explicit callback-evidence profile.

Fix: mirror the optional `transportEvidence` shape in fake-web types (or centralize the shared DTO) and add/adjust its contract test if one exists.

## Conformance notes

- Import output remains schema-absent (`app/src/lib/import/apply.ts:406-431`), with a focused regression test added.
- Lean and performance seeds use explicit helper declarations rather than helper inference; live and matrix correctly prove they generate no carrier rows of their own.
- Fake signer serializes object metadata once and passes string metadata through unchanged (`fake-twilio/src/engine/signer.ts:28-35`, `:211-224`); scheduled status callbacks use stored endpoints unless explicitly overridden (`engine.ts:502-515`).
- Fake engine/control reject non-RCS `transportEvidence.channelPrefix` (`engine.ts:166-171`, `fake-twilio/test/control.test.ts:76-83`).

Conclusion: PARTIAL / NEEDS_FIX. F1-F3 are required before Task 8 can be accepted; F4 prevents a claimed mirrored fake-client contract from remaining true.
