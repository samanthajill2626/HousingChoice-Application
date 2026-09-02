# Spec review R1 - reviewer B

## 1. [HIGH] The privacy/data-shape invariant is declared but not enforceable at the append boundary

### What is wrong

The spec says `relay_external_caller_phone` and
`relay_external_caller_contact_id` are allowed only for a
`relay_refusal_reason: 'non_member'` call, and that the phone must be the
normalized E.164 result.  Its proposed data model instead adds three unrelated
optional properties to the globally shared `NewMessage` shape and directs the
generic `messages.append` writer to copy them into the flexible message item.
Nothing in the specified mechanism ties those fields to `type: 'call'`,
`masked: true`, `direction: 'inbound'`, or the `non_member` reason, and nothing
checks that the phone is normalized.

### Evidence

- Spec 5, lines 247-269 defines independent optional write fields and says the
  generic append maps them directly, while also claiming the two identity fields
  are allowed only for `non_member`.
- Spec I3 and I5, lines 179-198 make the identity separation and normalized-only
  storage load-bearing invariants; D7, lines 134-150 makes disclosure
  participant-facing sensitive.
- The current generic writer already follows the same unconstrained optional
  field-to-item pattern: `app/src/repos/messagesRepo.ts:601-625` exposes one
  shared `NewMessage` type and `app/src/repos/messagesRepo.ts:1865-1918` builds
  the item by conditionally copying any supplied optional fields.  It has no
  call-kind/refusal-reason validation at that boundary.
- `messages.append` is used beyond the voice route (for example
  `app/src/services/groupSend.ts:626` and
  `app/src/services/originateCall.ts:171`), so the append shape is a real
  multi-writer mutation surface, not an implementation detail of the one new
  webhook arm.

### What it implies

An accidental or future `messages.append` caller can persist an unnormalized
external number or attach this identity to a member, closed-thread, outbound,
or non-call row.  The read path then collects the contact ID from any current
page and sends the data to the dashboard, defeating the narrowly approved
non-member disclosure contract.  Require a discriminated/validated call-refusal
write shape (or enforce the equivalent in `messages.append`) that rejects these
fields unless all of the stated conditions hold and validates E.164; add direct
repository tests for rejected combinations as well as the happy path.
