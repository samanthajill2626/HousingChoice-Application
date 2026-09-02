# Adversarial review R3: Relay inbound non-member caller identity

## 1. [HIGH] `recordRelayCallRefusal` is a convention, not an enforced semantic boundary

### What is wrong

The new service owns the correct lookup when its callers use it, but the revised public `NewMessage` contract still exposes a fully valid way for any route or job to construct `relayCallRefusal.reason: 'non_member'` with both a normalized phone and an arbitrary `contactId`. That input passes every stated generic runtime check when it uses `author: 'unknown'` and omits `relaySenderKey`. No type cast is required. The service's absence of a contact-ID argument therefore does not prevent the generic append callers from bypassing it, despite I12's claim that no route or job independently constructs resolved external identity.

### Evidence

- I12 says the dedicated service is the semantic boundary and that no route/job independently constructs resolved external identity: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:274-283`.
- The proposed public `NewMessage` union still permits `externalCaller?: { phone: string; contactId?: string }` on every non-member refusal: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:300-315`.
- The proposed append validation accepts precisely that combination provided the row is a masked inbound call, the phone is E.164, `author` is `unknown`, and `relaySenderKey` is absent; it does not require the service or verify the contact-ID/phone relation: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:325-332`.
- `messages.append` is already a broadly used direct API outside the voice route, including direct callers in `app/src/routes/api.ts:1690,1773`, `app/src/services/groupSend.ts:626`, `app/src/services/originateCall.ts:171`, and `app/src/routes/webhooks/twilio.ts:589,961,1697,2108`.
- `contacts.findByPhone` is the operation that actually resolves a phone to a contact; it is separate from messages append and can select a contact through its pointer-aware indexed lookup: `app/src/repos/contactsRepo.ts:1009-1035`.

### What it implies

A future direct append can persist a syntactically valid but unrelated contact ID, and the authenticated read path will hydrate that person as the caller. The R2 semantic-forgery finding is therefore not closed by adding a service alongside the still-public bypass. Remove caller-controlled contact identity from the generic append shape, make the resolved-refusal append private to the service, or introduce a runtime provenance/capability that the generic repository can actually verify. Add a test that a direct valid-shape `messages.append` call cannot bind an arbitrary contact ID.

## 2. [HIGH] The new all-reason service does not specify failure isolation for the existing roster-member contact read

### What is wrong

The service now owns every refusal reason, says that non-member lookup is best-effort, and promises the refusal TwiML regardless of contact lookup or append success. Yet it says the other reasons "may resolve the current member's author" without requiring that read to be caught. The live implementation performs exactly that `contacts.getById` before entering its append `try` block. If DynamoDB fails there, the webhook throws before it records the call or sends the masked `<Say>`/`<Hangup>`. The new extraction must explicitly make *both* external `findByPhone` and roster-member `getById` best-effort; otherwise it preserves the failure mode that the new service's stated guarantee claims to eliminate.

### Evidence

- The revised operation performs a special catch-and-continue rule only for the external lookup, while other refusal reasons may resolve the roster member's author: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:363-386`.
- The same section promises the existing refusal TwiML regardless of contact lookup or append success: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:382-386`.
- Current `handleMaskedInbound` awaits `contacts.getById(caller.contactId)` before the `try` that protects only `messages.append`: `app/src/routes/webhooks/voice.ts:887-904`. Its catch begins after the append call: `app/src/routes/webhooks/voice.ts:929-939`.
- The current refusal reasons include closed-thread, non-member, no-callee, and no-pool-number; the first, third, and fourth can have a roster caller and take that `getById` path: `app/src/routes/webhooks/voice.ts:892-920`.

### What it implies

A contact-table outage can turn a refusal into a webhook 5xx for a roster member, despite the service's promised no-bridge masked response. The service contract must state a safe `author: 'unknown'` fallback and catch/log policy for every contact read, with route tests that force `getById` to throw in closed-thread/no-callee/no-pool cases and still assert one stored refusal plus no `<Dial>`.
