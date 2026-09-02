# Adversarial review R2: Relay inbound non-member caller identity

## 1. [HIGH] The new append validator proves field shape, not that the stored identity is true

### What is wrong

The revision correctly prevents an external caller object on the wrong *kind* of row, but it does not enforce the two semantic facts that make the new identity safe:

1. a `non_member` refusal must have `author: 'unknown'` and no `relay_sender_key`; and
2. an optional `contactId` must be the non-deleted result of looking up that exact normalized external phone at arrival.

The proposed runtime checks validate only call type, inbound direction, `masked`, refusal reason, E.164 syntax, and that contact ID is nested beneath a phone. A future writer which type-casts around the TypeScript union can therefore append a fully validator-compliant non-member row such as `{ phone: '+16175550198', contactId: 'unrelated-contact' }` together with `author: 'tenant'` and a valid current-member `relaySenderKey`. The authenticated reader will hydrate and display the unrelated contact. Depending on the card wiring, the existing relay summary can also attribute the row to the roster member because that reader already treats `relay_sender_key` as authoritative.

### Evidence

- D5 requires a matched contact to remain `author: 'unknown'` with no `relay_sender_key`, and permits storage only after the phone lookup returns a non-deleted contact: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:116-130`.
- I3 preserves the one meaning of `relay_sender_key`; I11 promises the append funnel protects the shape even when a future writer type-casts around TypeScript: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:194-199,257-264`.
- The revised enforcement list does not validate `author`, `relaySenderKey`, or the phone-to-contact relationship; it only requires that a contact ID be inside a phone-bearing external-caller object: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:306-311`.
- `NewMessage` currently exposes `author` and `relaySenderKey` as independent generic append fields, and the append mapper independently persists both: `app/src/repos/messagesRepo.ts:601-625,1865-1886`.
- `messagesRepo` receives only document client/environment/logger dependencies, not a contacts resolver capable of validating a contact ID against a phone: `app/src/repos/conversationsRepo.ts:530-536`; the actual phone resolver returns the contact selected by the byPhone index: `app/src/repos/contactsRepo.ts:1009-1035`.
- The live Relay card resolves `relay_sender_key` against the current roster before composing its normal summary: `dashboard/src/routes/contact/Timeline.tsx:1161-1192,1253-1255`.

### What it implies

The stated append-boundary guarantee is still bypassable by a structurally valid but semantically forged record. That can make a non-member caller appear to be an unrelated contact or a current relay participant, which is exactly the identity/roster conflation D5 and I3 forbid. The design must either make the refusal append a dedicated trusted operation that owns `author`, roster-key absence, and contact lookup, or extend the enforcement mechanism to prove those facts (including an exact phone-to-contact re-fence). Add rejection tests for a non-member refusal with any `relaySenderKey`/non-unknown author and for a contact ID that does not resolve from the supplied phone.
