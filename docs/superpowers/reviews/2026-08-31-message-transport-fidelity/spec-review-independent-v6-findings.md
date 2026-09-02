# Independent adversarial re-review - message transport fidelity spec v6

Date: 2026-09-01
Spec reviewed: `docs/superpowers/specs/2026-08-31-message-transport-fidelity-design.md`
at `83824f79` (v6). Prior artifacts read: my v5 report
(`spec-review-independent-v5-findings.md`), the v5 adjudications
(`spec-independent-v5-adjudications.md`), and
`docs/issues/rcs-fallback-transport-observation.md`.
Method: diffed v5 -> v6, re-verified every remedy against the live code cited
in the v5 report (worktree at `83824f79`, docs-only over base `5ce9912f`;
`main` drift noted in v5 L2 is unchanged) and against current official Twilio
documentation for the three provider facts v6 newly relies on.

Assessment lane: nothing edited or committed.

## Verdict

PASS. Safe to approve for implementation planning.

Counts: 0 BLOCKING, 0 HIGH, 0 MEDIUM, 9 LOW.

Every v5 finding is genuinely resolved, not relocated. The nine LOW items are
one-line clarifications the plan can absorb; none has a reachable failure that
changes routing, delivery, or a user-visible chip in the current SMS/MMS
product.

## v5 findings - resolution check

| v5 | v6 remedy | Verified against | Resolved |
| --- | --- | --- | --- |
| B1 evidence source | 4.1:105-163 drops `ChannelPrefix` as a general signal; precedence over `From`, SID, `ChannelMetadata`, rail facts; RCS fallback shape deferred to a probe | Twilio docs (below); `twilio.ts:2338`, `signer.ts:188-197` | Yes |
| B2 legacy relay abort | 5.4:293-308, 7.2:413-416, 14:912-913, 13.1 item 10, AC13: schema-absent sources bypass all transport steps | `relayFanOut.ts:381-390` reads the source before any slot write, so the branch is decidable; `relayQueuedMessages.ts:86-99` flush re-enters the same job | Yes |
| H1 same-status result | 8.5:603-615, AC14, 13.1 item 6: status and metadata independent; `accepted -> queued` named | `messaging.ts:533-548`, `messagesRepo.ts:120-129` | Yes (see L5) |
| M1 preflight slot status | 5.3:276-280, 7.2:427-428, 9.4:689-691: `queued`; excluded-no-code omitted | `messagesRepo.ts:142-149`, `Timeline.tsx:882-907` | Yes (see L6) |
| M2 announcements | 7.2:461-467, 13.1 item 11, AC15: announcement is an execution | `relayAnnouncements.ts:190-207`, `:230-316`; `main` per-recipient `bodyFor` loop has the same three points | Yes |
| M3 phone in logs | 8.3:554-558, 13.1 item 12 | `relayAnnouncements.ts:127-136` | Yes (see L8) |
| M4 import `Unknown` | 5.2:237-241, 11:748-751 | `apply.ts:409-431` carries no evidence field | Yes |
| M5 seed `Unknown` | 11:733-738 | `seed/index.ts:153`, `engine.ts:133-135` mints SM/MM | Yes |
| M6 relay classification input | 6:357-363, 13.1 item 2 | `relayFanOut.ts:395-396`, `:425-432`; `api.ts:1239-1245` | Yes |
| L1 stale RCS callback noise | 8.3:549-552 | - | Yes |
| L2 main drift | 12:807-809 | - | Yes |
| L3 section 1 vocabulary | 1:21-24 | - | Yes |

## Provider facts re-verified (current official documentation)

- `ChannelPrefix` is listed only under "If the Message resource uses RCS,
  WhatsApp, or another messaging channel" on the status-callback contract
  (<https://www.twilio.com/docs/messaging/api/message-resource#twilios-request-to-the-statuscallback-url>,
  same table on
  <https://www.twilio.com/docs/messaging/guides/track-outbound-message-status>,
  whose standard parameter list includes `From`). Not on the inbound list
  (<https://www.twilio.com/docs/messaging/guides/webhook-request>). v6 4.1
  states exactly this.
- `From: rcs:<SenderId>` on successful RCS delivery
  (<https://www.twilio.com/docs/rcs/send-an-rcs-message>); RCS channel address
  format `rcs:{unique_id}`, SMS/MMS "Phone number in E.164 format" with no
  prefix (<https://www.twilio.com/docs/messaging/channels>). Supports rule 1
  and the E.164 discriminator in rules 2 and 4.
- `ChannelMetadata` on the inbound webhook: "The complete JSON response that
  Twilio receives from the rich-messaging channel", JSON with a `type` field
  whose documented example is `"rcs"`
  (<https://www.twilio.com/docs/messaging/guides/webhook-request>). Supports
  rule 1.
- Message SID pattern `^(SM|MM)[0-9a-fA-F]{32}$` on the Message resource; the
  SID glossary (<https://www.twilio.com/docs/glossary/what-is-a-sid>) lists
  both `SM` and `MM` as "Message" without distinguishing them. The cited help
  article (<https://help.twilio.com/articles/223134387>) is JS-rendered and
  returned no body to this reviewer, so the "SM = text, MM = media" sentence
  could not be quoted from it. It is corroborated by live-account evidence in
  the repo: a text-only group MMS arrived as `MM...` with `NumMedia=0`
  (`docs/superpowers/specs/2026-08-10-group-texting-spike-report.md:28-44`),
  and the fake mints `MM` on media presence with an explicit override for that
  shape (`fake-twilio/src/engine/engine.ts:229-232`). See L1.
- Whether an automatic RCS fallback keeps the Message SID or what its callback
  carries remains undocumented; v6 says so (4.1:157-163), gates it behind
  `docs/issues/rcs-fallback-transport-observation.md`, and lists the claim as
  out of scope (15:925-926) with a browser-proof disclaimer (13.2:874-875).

Net product effect of the corrected precedence: inbound 1:1, unknown-sender
and relay-member texts to an E.164 endpoint now normalize from `SM`/`MM`, so
`Unknown` becomes the rare malformed-evidence case rather than the dominant
inbound chip. The v5 regression is gone.

## Findings

### L1. SM/MM semantics rest on an unquotable citation

4.1:120-125 says Twilio "documents" `SM` = text and `MM` = media via the help
article. The reviewer could not read it; the docs glossary does not
distinguish the two. Cite the Message resource SID pattern plus the repo's
own live observation (`spike-report.md:33-44`) alongside the article, and
phrase the rule as Twilio's create-time resource classification (assigned when
the Message resource is minted, before carrier delivery), which is what rule 3
actually consumes.

### L2. Rule 2's "known E.164 SMS/MMS number" is not a webhook-decidable predicate

4.1:146-148. The inbound handler cannot enumerate "known" numbers for the
unknown-sender branch or a freshly bought pool number, and it does not need
to: Twilio's channel-address doc makes the discriminator "an E.164 `To` with
no channel prefix". Reword rule 2 to that, so a valid inbound to an
unrecognized E.164 endpoint is not classified `Unknown` by accident.

### L3. Rule 4 and rule 5 overlap on the one undocumented shape

4.1:151-155. A callback with `From` E.164 and `ChannelPrefix: rcs` satisfies
rule 4 (record fallback) and rule 5 (conflict -> absent + warning). Rule 1's
"when it does not conflict with `From`" implies rule 5 wins, but say so:
rule 4 applies only when no channel field is present; any `From`/channel
disagreement is pending. RCS is out of scope, so no failure is reachable
today; the probe issue already lists `ChannelPrefix`.

### L4. Non-`SM`/`MM` SIDs will warn on fixtures and dev seams

4.1:154-155 and 14:903-904 make any non-empty unrecognized SID "one safe
structured warning". e2e inbound helpers accept caller-supplied SIDs
(`e2e/fixtures/fakeTwilio.ts:54-66`), and the dev fixture mints `dev-<uuid>`
(`app/src/routes/dev.ts:845`). Production traffic is always `SM`/`MM`, so
this is log hygiene: define a SID that does not match `^(SM|MM)` as missing
evidence (no warning) or scope the warning to signed provider traffic, so the
warn sweep is not polluted by hermetic runs.

### L5. Result operation: stale transient error code and `sentAt` semantics

8.5:603-611. Today the whole-slot SET on success drops a prior transient
`errorCode` (`relayFanOut.ts:527` writes `queued` + `30022`, then `:539-544`
replaces the slot). Under child-field writes the code lingers on a leg that
later reads `sent`/`delivered`. No chip changes (`presentLegDelivery` shows a
reason only on failure), but state that a success result REMOVEs a prior
transient `errorCode`, and state whether `sentAt` is absent-only or
overwritten on a continuation resend (13.1 item 6 should assert both).

### L6. Excluded-without-code omission changes the delivery rollup, and 15 says delivery semantics are out of scope

5.3:277-279 and 9.4:689-691 omit an `excluded` removed member from "delivery
aggregation and expanded recipient rows". That is a deliberate improvement
to the existing `Delivered N/M` denominator (`Timeline.tsx:892-898`,
`deliveryStatus.ts:387`) and makes the delivery presenter read
`transportAggregationState`; 15:931-932 still lists "delivery status
semantics" as unchanged. Carve this one case out explicitly. Also note the
timing asymmetry it leaves: a source-time slot for a member removed before
the first preflight stays state-absent and `queued`, so it is still counted,
while the same removal after a preflight is hidden. Acceptable, but say it.

### L7. 7.3's channel-SID ban now contradicts rule 3

7.3:482-484 forbids the group receipt service from deriving transport from the
channel message SID; 4.1 rule 3 admits `SM`/`MM` SIDs as outbound evidence.
The group rail fact is authoritative either way. Reword to "the rail fact
takes precedence; a receipt's channel SID may corroborate or raise a conflict
warning, never originate transport".

### L8. "prefix values" in warnings must mean the scheme only

7.4:492-494 permits logging "enum/prefix values". A `From` on a foreign
channel is `whatsapp:+1555...`; only the scheme before `:` is safe. State it.

### L9. Callback no-op classification lacks a "legacy" outcome

8.5:582-583 classifies a conditional miss as idempotent, allowed fallback or
conflict; 8.4 emits SSE on a real write and 14:905-906 warns on conflict. A
transport write refused solely because the row is schema-absent must be a
fourth, silent outcome, or every late callback on a legacy relay leg warns.
5.4:306-307 already calls it a "recorded compatibility no-op"; 8.5 should
list it.

## Attacked but not broken

- Provider-evidence precedence: each of rules 1-5 traced to a documented
  field (above); the current adapter and webhook read sites (`messaging.ts:614-678`,
  `twilio.ts:589-601`, `:961`, `:1697-1708`, `:2108`, `:2336-2346`) all have
  `MessageSid` and, for inbound, `To`; outbound results carry `message.sid`
  (`messaging.ts:673-677`), so rule 3 can populate actual at append time
  without any callback.
- Schema-absent relay compatibility: the fan-out reads the source row before
  any slot write (`relayFanOut.ts:381-390`); continuations and redeliveries
  re-read it; `flushQueuedMessages` only flips status and enqueues
  (`relayQueuedMessages.ts:86-99`); announcements and group sends always
  create their own post-deploy rows; group receipts and 1:1 callbacks on
  legacy rows degrade to a conditional no-op with status still advancing.
- Same-status result writes: `accepted`/`queued` -> `queued` on a seeded
  `queued` slot now records SID (absent-only, matching
  `messagesRepo.ts:2865-2887`), `sentAt`, error and actual; forward-only
  status guard preserved; expressible as one conditional update for
  status/SID/sentAt/error plus the existing separate actual-transport child
  method.
- Preflight-created slot presentation: `queued` is non-terminal for
  `isTerminal` (`relayFanOut.ts:158-160`); the callback cannot reach the slot
  before its pointer exists (`relayFanOut.ts:544-549`, `twilio.ts:2406-2432`);
  the inbound-source disclosure gate change was already accepted in R1-A3.
- Persisted announcements: the three transition points map onto the existing
  loop (suppression `relayAnnouncements.ts:238-250`, send `:255-259`, result
  `:281-303`); the `persist: false` replay seam has no source and no slots.
- Imports: `apply.ts:409-431` has no provider transport field, so every
  current import row is schema-absent and keeps its legacy label; AC2's
  "runtime writer" wording and 5.2:222-223 agree.
- Seeds: direct `PutCommand` writers can author `actual_transport`; the fake
  mints `SM`/`MM` by media presence, so seeded and fake-driven rows agree.
- Relay media classification: `mediaAttachmentsOf` is the only media the
  worker forwards (`relayFanOut.ts:395`, `:494-500`); raw `mediaUrls` are
  never replayed; the no-bucket case yields a truthful `MMS -> SMS` once rule
  3 supplies the `SM` SID, and the existing body-only send is unchanged.
- Safe logging: `logSafeMemberKey` exists and is already the announcement
  convention; the spec now names it for relay too.
- Optimistic marker, retry lineage, native-group isolation of `type: 'sms'`,
  fresh per-leg media, one-slot-per-recipient continuation, and the
  aggregation state machine are unchanged from v5 and still hold.
- RCS fallback: correctly fenced as unverified (4.1:157-163, 13.2:874-875,
  15:925-926, the deferred issue); no live claim is made.

## Explicit unknowns

1. The help-center SID article body (JS-rendered) - see L1; the rule is
   corroborated by repo evidence and the SID regex, not by a quotable doc.
2. Live RCS fallback callback/resource shape - already owned by
   `rcs-fallback-transport-observation.md`.

## Safe to approve?

Yes. Fold L1-L9 into the implementation plan as clarifications; none blocks
planning, and none needs a further spec review round.
