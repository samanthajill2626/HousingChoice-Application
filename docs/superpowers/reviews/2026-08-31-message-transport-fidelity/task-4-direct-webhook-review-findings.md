# Task 4 direct and webhook review finding

Reviewed commit: `eea8a4fe feat: record transport on direct message flows`

## P1: generic native-group webhook fabricates the Group MMS rail fact

`app/src/routes/webhooks/twilio.ts:1741` writes literal `actualTransport: 'mms'`
for native-group inbound messages. The route does not consume a group-adapter
authority/normalizer, leaving generic webhook business code as the rail authority.
The approved design locates this fact in the group adapter/provider boundary.

Expose an adapter-owned inbound Group MMS authority (or dedicated group provider
normalizer), consume it from the route, and add a signed webhook test that proves
the route uses the authority rather than inferring from media/body/ordinary SMS
evidence. Keep native-group current MMS behavior and all direct/relay paths intact.

The independent review otherwise confirmed direct intent persistence, inbound
versioned actual-only writes, stored-request status normalization, independent
status/actual writes, SSE semantics, safe warning fields, and no fabricated
SMS/MMS channel prefix.
