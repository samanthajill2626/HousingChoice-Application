<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-20).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Relay open-path STOP/HELP processing - design

Date: 2026-07-17
Issue: docs/issues/relay-open-path-stop-not-processed.md (med, A2P)
Branch: feat/relay-open-path-stop (cut from main @d3ab23c)
Status: DRAFT for human review

## 1. Problem

A relay-group member who texts STOP (or any opt-out keyword) to their pool
number while the group is OPEN never has the keyword processed. The open
inbound path `handleRelayInbound` (app/src/routes/webhooks/twilio.ts)
persists the message and enqueues the fan-out - nothing else. Consequences:

- The member keeps receiving relayed messages and announcements from the
  pool number (A2P/CTIA violation: an opt-out request must stop messages).
- No `sms_opt_out` is registered anywhere.
- The bare "STOP" text is RELAYED to the other group members as if it were
  group content (a context-free "STOP" SMS lands on the landlord's phone).
- No STOP confirmation / HELP reply is sent (we own replies; Twilio
  Advanced Opt-Out is OFF).

The closed-group path already has full parity (relay-number-lifecycle
AF-4): `handleClosedGroupInbound` runs the shared `processInboundKeywords`
and returns the filed reply to ride the TwiML. This feature gives the OPEN
path the same guarantees.

## 2. Decided semantics (human decisions, 2026-07-17)

1. STOP scope: the member STAYS on the roster, suppressed, and the opt-out
   is GLOBAL - the contact `sms_opt_out` flag is set (primary-number scoped
   per the BE1 rule), exactly like the closed path and the 1:1 path. The
   existing per-leg skip machinery (fan-out + announcements) does the
   silencing. START re-enables.
2. Keyword fan-out: a message whose body IS a keyword (the same
   trim/uppercase exact match `processInboundKeywords` performs, or a
   Twilio `OptOutType` param) is a command to the SYSTEM, not group
   content: persist it on the relay thread for the audit trail, process
   it, reply via TwiML - but NEVER enqueue the fan-out. A message that
   merely contains the word ("please stop by at 3") does not match and
   relays normally.

Adjudicated by the planner (parity with the closed path, not new product
surface):

3. HELP replies the filed HELP copy (`keyword.help`), no flag change.
4. Opt-in keywords (START/JOIN/HOME/YES/UNSTOP) clear suppression and
   reply the welcome copy (`welcome.sms`, settings-resolved).
5. The reply rides the webhook's TwiML response (never the send wrapper -
   it would refuse a send to a just-opted-out number).
6. All reply copy comes from the existing message catalog - no new copy.

## 3. Design

### 3.1 Keyword classification - one source of truth

Extract the detection logic currently inlined in `processInboundKeywords`
into a PURE helper in `app/src/lib/smsCompliance.ts` (the compliance
single-source-of-truth module; it already owns the keyword sets):

    export type InboundKeywordKind = 'help' | 'opt_out' | 'opt_in';
    export function classifyInboundKeyword(
      body: string | undefined,
      optOutType: string | undefined,
    ): InboundKeywordKind | undefined

Precedence identical to today's `processInboundKeywords` logic: HELP first
(OptOutType === 'HELP' or keyword === 'HELP'), then opt-out (OptOutType
=== 'STOP' or OPT_OUT_KEYWORDS has the trimmed-uppercased body), then
opt-in (OptOutType === 'START' or OPT_IN_KEYWORDS). Anything else ->
undefined. `processInboundKeywords` is refactored to call this helper so
the open path, the closed path, and the 1:1 path can never drift on what
counts as a keyword.

### 3.2 Open-path handling in `handleRelayInbound`

`handleRelayInbound` changes its return type from `Promise<void>` to
`Promise<string | undefined>` (the keyword reply, exactly like
`handleClosedGroupInbound`). Both open-path call sites in the `/sms`
router (the open-roster match and the unknown-sender open fallback) send
`messageTwiml(reply)` when defined, `EMPTY_TWIML` otherwise.

Inside the handler, after the existing persist + media mirror:

1. `const kind = classifyInboundKeyword(Body, msg.params['OptOutType'])`.
2. If `kind` is undefined: behavior is UNCHANGED (fan-out enqueue rules
   exactly as today), return undefined.
3. If `kind` is defined: the message is a system command -
   - SKIP the fan-out enqueue entirely (the persisted message stays on
     the relay thread for the audit trail; other members never see it).
     The inbox touch / unread / SSE block still runs - staff should see
     the STOP in the group transcript.
   - Resolve the sender's contact and 1:1 conversation exactly as the
     closed intercept does: `contacts.findByPhone(From)` +
     `conversations.createOrGetByParticipantPhone(From,
     conversationTypeFor(contact))`.
   - Call the SHARED `processInboundKeywords({ conversation: the 1:1,
     effectiveContact, From, Body, OptOutType, MessageSid })`. This sets
     the 1:1 conversation flag, the contact flag when From is the
     contact's primary number (BE1 scope), stamps consent on opt-in,
     audits, and returns the filed reply.
   - Member-scoped relay suppression needs NO extra write: the 1:1
     conversation flag `processInboundKeywords` just set/cleared is what
     the widened `isMemberSuppressed` reads (3.3).
   - Immediate staff-visibility annotation (3.4) when the sender is a
     current roster member.
   - Return the reply to ride the TwiML.

The conversation-level flag deliberately lands on the sender's own 1:1
thread (closed-path idiom) - NEVER on the relay group conversation. One
member's STOP must not flag the whole group, and the group conversation's
opt-out flag is not a meaningful object (the send path for groups is the
fan-out, gated per member).

The unknown-sender open-fallback branch gets the same treatment minus the
member marker (the sender is on no roster; there is nothing to suppress -
but their STOP still flags their 1:1 + contact and they still get the
confirmation, matching what the main number would have done).

### 3.3 Per-phone suppression via the 1:1 conversation flag (closes the
BE1 corner)

The A2P floor is "messages from THIS number to THIS person stop". Today's
only leg gate is `isMemberSuppressed` = the CONTACT flag
(services/relayAnnouncements.ts, used by both the fan-out and
announcements). The BE1 number-scope rule sets the contact flag ONLY when
the STOP arrives from the contact's PRIMARY number - so a member whose
roster phone has become a secondary attached number (primary swap after
rostering) would STOP and keep receiving legs. Reachable, rare, and a
compliance violation.

BE1 already defines the per-PHONE suppression record: the phone's own 1:1
conversation `sms_opt_out` flag ("the correct per-number scope" - set and
cleared by `processInboundKeywords` on every path, including the new open
path in 3.2). So no new state is introduced; the leg gate simply learns
to read it:

- `isMemberSuppressed(contacts, conversations, member)` (signature gains
  the conversations repo; both call sites - relayFanOut and
  relayAnnouncements - already construct/hold it):
  1. the member's contact (by contactId-or-phone) has `sms_opt_out` ->
     suppressed (today's check, unchanged);
  2. else `conversations.findByParticipantPhone(member.phone)` (read-only
     byParticipantPhone GSI query - NEVER the createOrGet variant, a leg
     check must not mint conversations) returns any non-relay_group
     conversation with `sms_opt_out === true` -> suppressed.
  No 1:1 exists -> not suppressed (no create).

Scope notes:

- STOP on the pool number from a member (3.2) creates/gets their 1:1 and
  flags it via the shared seam -> legs stop, whether or not the contact
  flag was settable (primary vs secondary). START clears it -> legs
  resume. Symmetric with the main-number behavior by construction.
- The flag lives on the 1:1 conversation, not the roster entry - so
  roster churn (remove then re-add) can never resurrect messaging to an
  opted-out phone.
- A phone whose 1:1 was suppressed via the MAIN number is also skipped on
  relay legs. That is deliberate over-suppression in the A2P-safe
  direction: the phone told us to stop texting it.
- Accepted race: the byParticipantPhone GSI is eventually consistent, so
  a leg evaluated within seconds of the STOP could miss the fresh flag in
  the secondary-number corner (the primary case is covered by the
  strongly-read contact flag). The fan-out enqueue happens after the
  webhook completes, making the window practically empty.
- The closed path needs nothing extra (closed groups never fan out or
  announce).

### 3.4 Immediate staff visibility

The fan-out already annotates the group when it SKIPS an opted-out member
(`conversations.setRelayMemberOptedOut` -> Today attention item + failed
legs marked `contact_opted_out`). The open-path STOP handler calls the
SAME annotation immediately for a roster-member sender (best-effort,
never crashes the webhook), so staff see the Today attention item when
the STOP happens - not on the next fan-out. The open-path START from a
roster member clears it (`clearRelayMemberOptedOut` - the existing
helper). The map stays a display/attention ANNOTATION - suppression
truth lives in the flags (3.3), never in this map. No new dashboard
surface: the group transcript shows the persisted STOP bubble, later
sends show the skipped leg, Today shows the attention item.

### 3.5 What does NOT change

- The closed-group path (AF-4) - already correct; it now shares the
  classifier helper, byte-identical behavior.
- The 1:1 `/sms` section (4) keyword block - refactored to use the
  classifier, byte-identical behavior.
- Fan-out / announcement skip machinery - only the `isMemberSuppressed`
  predicate widens (contact flag OR the member phone's 1:1 conversation
  flag) and gains the conversations repo in its signature.
- No schema/GSI/infra changes; no new deps; no new catalog copy; the
  do-not-remove consent gates are untouched.

## 4. Error handling

- All keyword side effects (flags, annotation, audit) are best-effort
  inside the existing try/catch idiom: the message is already persisted;
  a repo failure is ERROR-logged and never 5xxes the webhook. The
  annotation failing loses only display immediacy (the fan-out skip
  re-annotates on the next send); the flag writes are the compliance
  substance and live inside the shared seam's own guard.
- Twilio redelivery (dedupe) re-runs keyword processing idempotently -
  same flags re-set, annotation re-stamped with a fresh timestamp
  (accepted: the timestamp is provenance, not an invariant), confirmation
  re-rides the TwiML (a duplicate confirmation on a redelivery is the
  existing 1:1 behavior - unchanged risk).
- PII: phones never logged (member keys / conversation ids / SIDs only) -
  the existing rule; the annotation stores the phone as DATA (already the
  existing helper's shape).

## 5. Testing

Unit (app):
- classifyInboundKeyword: keyword-set membership, OptOutType precedence,
  HELP-over-STOP precedence, trim/uppercase, containing-vs-being a
  keyword, undefined body.
- processInboundKeywords refactor: existing tests stay green
  (byte-identical behavior proof).
- Open-path webhook tests (twilioSmsWebhook / relayWebhook tests): STOP
  from a roster member -> persisted on relay thread, NO fan-out enqueue,
  contact flag set (primary case), 1:1 conversation flag set,
  setRelayMemberOptedOut called, STOP confirmation TwiML; STOP from a
  roster member whose phone is NOT the contact primary -> contact flag
  NOT set, 1:1 conversation flag set (the BE1 corner); HELP -> reply +
  no flags + no fan-out; START -> flags cleared + clearRelayMemberOptedOut
  called + welcome TwiML; non-keyword body containing "stop" -> fans
  out, no flags; unknown-sender STOP on the open fallback -> 1:1 +
  contact flagged, no annotation, confirmation TwiML; redelivery
  (dedupe) -> no fan-out enqueue, idempotent re-writes only.
- isMemberSuppressed: contact flag alone suppresses; 1:1 conversation
  flag alone suppresses (contact flag false); relay_group rows returned
  by the phone query are ignored; no 1:1 and no contact flag -> not
  suppressed; no conversation is ever created by the check.
- Fan-out: a member suppressed ONLY via their 1:1 conversation flag is
  skipped and marked `contact_opted_out` (existing skip-path tests
  extended).

E2E (extend the relay spec):
- Member texts STOP to the pool number -> outbox shows the STOP
  confirmation FROM the pool number to the member; the other members did
  NOT receive the STOP text; a subsequent group message reaches the
  others and SKIPS the opted-out member; the member texts START -> next
  group message reaches them again.

## 6. Rollout

Pure app-code change: no migration, no reseed requirement, no flags, no
operator steps. Pre-existing opted-out contacts behave exactly as today
(contact-flag path unchanged).
