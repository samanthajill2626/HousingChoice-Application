---
id: vi-webhook-unrecognized-event-400
title: Signed VI webhooks without transcript_sid are 400'd blind - unidentifiable payload, and the 400 keeps Twilio retrying (noise loop)
type: bug
severity: med
status: resolved
resolved: 2026-07-20
area: app
created: 2026-07-20
refs: app/src/routes/webhooks/voice.ts:1625, app/src/middleware/twilioSignature.ts:100
---

**Problem.** On 2026-07-20 the /webhooks/twilio/voice/intelligence endpoint
received 14 requests total (its first day live): 1 valid transcript-completed
webhook (processed fine) and 13 Twilio-SIGNED (bodySHA256-verified) JSON POSTs
(~1.4KB) with NO top-level `transcript_sid`, each rejected 400 with
`vi webhook: missing transcript_sid - rejected`. Because the handler never logs
bodies (PII rule), the 13 payloads are unidentifiable from our side; Twilio's
debugger alert detail was empty too.

Context/evidence: the VI service was created 18:01Z with a broken webhook URL
(`.../nowhere/webhooks/...` - webhook-base misconfig, since corrected; debugger
95200 at 19:03Z). Four transcripts completed during the broken-URL window; the
400s began right after the URL was fixed, in two bursts of exactly FOUR plus
trailing singles at widening intervals - consistent with Twilio retrying the
stranded events in some retry/event shape we do not parse. Ruled out: Event
Streams (no sinks), Conversations (no webhooks configured), operator results
(0 operators attached), a second VI service (only one exists). No data was
lost - the voice.reconcileTranscript safety net fetched the stranded
transcripts regardless.

Open question the current code cannot answer: are these (a) a one-time retry
backlog that will drain, or (b) a second event type fired for EVERY transcript?
The next inbound-call test disambiguates - a fresh 400 arriving a minute after
a successful transcript webhook means (b).

**Suggested fix.** In the /intelligence handler, when a SIGNATURE-VERIFIED
request lacks `transcript_sid`: log the payload's top-level KEY NAMES only
(bounded count, never values - PII-safe) plus content-length, and ack 200
instead of 400 so Twilio stops retrying an event we have chosen not to process.
Keep 400 for unverifiable/shapeless requests. Once a logged key-set identifies
the event type, decide whether to handle or keep ignoring it (documented).

**Resolution (2026-07-20).** Implemented as suggested: a signature-verified
JSON OBJECT without `transcript_sid` now acks 200 and WARN-logs
`keys` (first 32 top-level key names, never values) + `keyCount` +
content-length; a shapeless (non-object) body keeps the 400; unverified
requests keep the middleware 403. Unit-covered (voiceIntelligenceWebhook:
ack + key-names-only including a value-leak assertion; shapeless 400).
FOLLOW-UP TRIGGER: the next occurrence's `keys` log line identifies the
event type - if fresh transcripts keep producing these (scenario (b) in the
evidence above), file a new issue to handle that event type explicitly.

**Update (2026-07-21) - keys read from dev CloudWatch (`/hc/dev/app`).** Every
occurrence has the identical top-level shape `keys: ["eventType","timestamp",
"data"]` (keyCount 3, contentLength varying 434-1440) - Twilio's nested event
envelope, NOT our top-level `transcript_sid` shape. Disambiguation from the
evidence above:
- Scenario (b) is RULED OUT. The two real inbound bridge calls in the window
  (`recording mirrored` @ epoch 1784579944 / 1784592321) each fast-persisted via
  the webhook (`vi transcript saved`, then reconcile logged `webhook won`) - the
  `{transcript_sid}` "transcript available" webhook still works. The
  `{eventType,timestamp,data}` events are NOT correlated with any call: zero
  recording callbacks and zero inline `VI transcript created` precede them. So
  nothing is lost by ignoring them; they are a distinct Twilio event we do not
  process, not a transcript we are dropping.
- Still unidentified: the `eventType` VALUE (our PII-safe log recorded key NAMES
  only). Handler now (this change) logs the `eventType` VALUE (a bounded Twilio
  enum - PII-safe) + `data` KEY NAMES, at INFO not WARN (a chosen-to-ignore
  event, not a fault), still acking 200. PENDING: deploy to dev, read one line's
  `eventType`, then decide explicit name-handling vs. permanent ignore (and
  update this issue). Test updated to assert eventType-value logged + data-values
  never logged.
