# Adversarial review R4: Relay inbound non-member caller identity

## 1. [HIGH] The dedicated operation cannot validate the relay-membership fact it claims to own

### What is wrong

The generic bypass is closed, but `recordRelayCallRefusal` is still a public `MessagesRepo` operation whose input contains only a `conversationId`, raw `From`, refusal reason, and caller object. It receives neither the selected relay conversation/participant roster nor a conversations resolver. Consequently it can prove only that a supplied caller's *phone* equals `From`; it cannot prove the caller is a current participant of the supplied relay group, that `conversationId` names a relay group at all, or that an omitted caller for `non_member` is actually absent from that roster. A direct caller can therefore record a `non_member` refusal for a real member by omitting `caller`, or record a member refusal with a fabricated `ConversationParticipant` that happens to use the same phone, on any conversation ID.

### Evidence

- The public input declares only `conversationId`, call facts, raw `from`, reason, and optional caller; it has no relay/participants value or conversations repository dependency: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:307-326`.
- I12 says this operation owns roster-key presence/absence and semantic caller resolution, but its stated validation is only non-member-without-caller and member-caller-phone-equals-`From`: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:278-290,395-405`.
- `ConversationParticipant` is merely a caller-supplied value object with `contactId` and `phone`; it carries no proof of membership in a particular conversation: `app/src/repos/conversationsRepo.ts:104-108`.
- The roster key is derived directly from that object (contact ID if non-empty, otherwise phone), with no conversation check: `app/src/repos/messagesRepo.ts:156-160`.
- The planned tests cover a non-member *with* a caller and a member caller whose phone differs from raw `From`, but not membership in the selected conversation or conversation type: `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:527-538`.

### What it implies

The operation cannot uphold the exact invariant it was introduced to centralize: a stored non-member refusal can be attached to the wrong thread or assign a roster key for someone who is not in that thread. This reintroduces false attribution without using the generic append path. Make the operation accept and validate the resolved `ConversationItem`/roster (or obtain it through a narrow authoritative resolver), require `conversation.type === 'relay_group'`, require member callers to be the exact current roster entry, and derive non-member absence from that same roster. Add direct-operation tests for a non-roster caller with matching phone, a member passed as `non_member`, and a non-relay conversation ID.
