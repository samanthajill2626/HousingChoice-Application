# Spec review r2 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-23-today-checklist-design.md` at e6b5a3cb
(r2). Read alongside `adjudications.md` and `spec-r1-reviewer-b.md`. Repo
read-only at `W:\tmp\today-checklist`; nothing run. Every claim about current
behavior cites a line I read; UNVERIFIED marks the rest.

Not re-litigated (Cameron's decisions): shares and broadcasts do not move
`last_reached_out_at`; Identify lists only owners of type `unknown`.

Order: new problems in the r2 changes first, then the adjudication I contest
(I don't contest it), then smaller issues.

---

## N1. HIGH - The W6 call stamp puts an awaited DynamoDB write on the press-1 -> <Dial> path the code forbids slowing

r2 moves the call stamp to the outbound whisper-gate branch "at the point it
returns the `<Dial>` to the target". 7.3 says the helper is "awaited inline"
and emits `contact.updated`.

The whisper gate is a TwiML response path, and the code carries an explicit
invariant against adding round trips there:

- `app/src/routes/webhooks/voice.ts:1339-1347`: "two more sequential DynamoDB
  round trips, AWAITED between a human pressing 1 and the <Dial> that joins the
  two parties ... overrun Twilio's TwiML-fetch ceiling during a DynamoDB spike
  and the caller hears an application error and THE BRIDGE NEVER HAPPENS."
- `voice.ts:1697-1698`, in the exact branch W6 names: "nothing may be read
  between press-1 and the <Dial> below (fix wave 4, N-1)".
- The branch already does one awaited write there (`updateCallStatus`,
  `voice.ts:1672-1678`). W6 adds a second sequential write (the conditional
  UpdateItem), and the helper's event emit.

`resolveOutboundTarget` (`voice.ts:1305-1321`) also returns no contactId - it
reads the contact by phone and drops it - so the stamp needs that function
changed too, which the spec does not say.

The failure mode is a dropped call. The try/catch the spec requires bounds
errors, not latency, as the comment at 1343 says. Fix: stamp AFTER
`sendTwiml(res, vr)` (fire-and-forget, or awaited after the response is sent),
return the contactId from `resolveOutboundTarget`, and state the exception to
7.3's "awaited inline" rule for this one writer.

## N2. MEDIUM - W7 points at the wrong send loop: the relay intro is not sent through the fan-out's legs

W7 says the staff-edited intro stamps "as W4, for the intro's legs", with
"`jobs/relayFanOut.ts` applies it". W4's stamp point is "where each member's
leg is SENT in the relay fan-out". The intro does not use those legs:

- The `relay.intro` job reads `intro_body` (`app/src/jobs/relayFanOut.ts:1090`)
  and then calls `sendRelayAnnouncement` (`relayFanOut.ts:1124-1140`).
- `sendRelayAnnouncement` (`app/src/services/relayAnnouncements.ts:172`) has
  its own member loop and provider sends (`relayAnnouncements.ts:266-321`),
  separate from `sendOneRelayLeg` (`relayFanOut.ts:1917`).
- That loop is SHARED by every system announcement W7's own no-stamp table
  excludes: member added, group closed, group tour reminder (`kind` parameter,
  `relayFanOut.ts:1137`).

A builder who follows W7 literally finds no intro legs in the fan-out. One who
puts the stamp in `sendRelayAnnouncement` stamps every system announcement
unless it gates on `kind === 'relay.intro'` AND an edited body. The spec must
name the right function and that gate. The stamp also has to know which member
sends went out (the announcement loop's per-member results), the same per-leg
rule as W4.

## N3. MEDIUM - W2 stamps a staff Retry of a failed SHARE, which 7.2 says must not count

W2 gives every manual Retry the staff-outreach option. The Retry route also
retries share texts: it copies the pressed row's `broadcast_id` onto the retry
(`app/src/routes/api.ts:1880-1886`, "a manual retry of a share text stays
attributed to its broadcast"; also `services/sendMessage.ts:667-672`).

So retrying a failed property share stamps `last_reached_out_at` and restarts
the quiet clock on every OTHER property shared with that person - the exact
effect Cameron ruled out ("Sending someone another property does not restart
the clock", 6.1; "property shares and broadcasts" do not count, 7.2). Fix: W2
passes the option only when the retried row has no `broadcast_id`, and add
that case to the no-stamp table and to the writer tests.

## N4. MEDIUM - The post-stamp `contact.updated` does not "close the race": the quiet-shares read is eventually consistent

7.3 and 8 claim emitting `contact.updated` after the stamp makes an open Today
refetch "AFTER the stamp has landed", closing the race. Today then reads the
stamp through `buildFollowUps`' contacts batch, `getRecipientDisplaysByIds`,
which is a BatchGet with NO consistent-read option
(`app/src/repos/contactsRepo.ts:1369-1373`; the default is eventually
consistent, `contactsRepo.ts:780-790`; only `getManyByIds` can ask for
ConsistentRead).

The codebase already knows this exact trap for this exact event: the contact
page re-reads on `contact.updated` with `{ consistent: true }` because "an
eventually consistent GET could hand back the pre-write contact"
(`dashboard/src/routes/contact/useContact.ts:60-67`). Today's refetch fires
300 ms after the event (`useToday.ts`), and no later event corrects a stale
read, so a person a staff member just texted can stay in Quiet shares until an
unrelated event. The same applies to inbound replies (`last_heard_from_at`).
The e2e cannot catch it: DynamoDB Local reads are consistent. Either let the
core's batch read consistently on the Today path (twice the read cost, state
it in 6.5) or downgrade the claim to "usually".

## N5. MEDIUM - Reusing `contact.updated` for every stamp multiplies events and the reads behind them

`contact.updated` is documented as the "status or type changed" signal
(`app/src/lib/events.ts:291-317`). Its consumers re-read on every emit: Today
(`useToday.ts:156`), the inbox head read on every client
(`dashboard/src/routes/inbox/useInbox.ts:586-591`), the open contact page (a
CONSISTENT GET, `useContact.ts:74-91`) and its timeline
(`useContactTimeline.ts:548-552`).

r2 emits it from the stamp helper once per stamped contact. For W4 that is
once per relay LEG: a team post to five members is five events, raised in the
WORKER and bridged one POST each to the app (`lib/events.ts:5-16`), arriving
spread out by A2P pacing, so the 300 ms debounce does not merge them. Each one
re-runs the full Today load, now including the Follow up core (6.5), plus an
inbox head read, on every open dashboard. 6.5 sizes cost per load and never
counts loads per event. Also, every 1:1 send already emits
`conversation.updated` (`services/sendMessage.ts:723`), so each send now
triggers two Today loads.

Fix: emit once per POST (after its last stamp), not once per contact or leg;
update the `ContactUpdatedEvent` doc comment to the new meaning; and put the
event multiplicity in 6.5.

## N6. LOW - W5 group texts stamp suppressed members, the defect r2 fixed only for relay

The A18c fix made relay stamp per SENT leg. W5 still stamps "every resolved
member contact". A native group post seeds each suppressed member's slot as
`excluded` (`app/src/services/groupSend.ts:607-637`, `readNumberSuppression`):
the member is part of the post but is not texted. Stamp only members whose slot
is not excluded.

## N7. LOW - The per-leg relay stamp leaves its call site, its instant and two leg outcomes undecided

- `sendOneRelayLeg` is shared with the 30003 retry rung
  (`app/src/jobs/relayRetryLeg.ts:836`), which must NOT stamp. The stamp
  belongs in the fan-out loop (`relayFanOut.ts:1535`) gated on
  `senderKey === TEAM_SENDER_KEY`, not inside `sendOneRelayLeg`. Say so.
- Instant: 7.3 says "the outbound row's own timestamp". For a queued post
  (stamped "when its legs go out") the row's timestamp is compose time
  (`routes/api.ts:1948`). State whether it is the row time or the leg
  send time.
- A leg whose text went out but whose record failed (`sent_unrecorded`), or
  whose outcome was unknown and is later ADOPTED by reconcile (owner kind
  `relay_leg`, `jobs/sendReconcile.ts:381-386`), is neither in the stamp rule
  nor in the no-stamp table (which lists only share and retry adoption).

## N8. LOW - 2.5 and section 3 disagree on a failed unit lookup in Tours to book

2.5 lists "a units lookup" among the throws that make a section unavailable.
Section 3 says "A failed unit lookup degrades to the unitId ... for Tours to
book it does not make the section unavailable." The only section that does
unit point reads is Tours to book (Quiet shares walks units). Delete the
example from 2.5.

## N9. LOW - Copy still says what the r2 decisions made untrue

- The Quiet shares help line (2.2): "A message or call from either side
  restarts the clock." A share is a message from our side, and since r2 it does
  NOT restart the clock (7.2). Say "a reply, or a staff text or call".
- 6.2: "an unknown leaves Quiet shares when staff ... identify them (a tenant's
  page then has the buttons)". Re-typing does not change the share outcome
  (`lib/listingSendOutcome.ts:69-87` depends on the row, the reply and tours,
  not type, except tour reads for tenants), so the person stays; identifying
  them only makes the buttons reachable. Reword.

## N10. LOW - The Identify owner rule reverses a pinned #30 behavior; the spec calls it containment

Section 4 says the new owner test "replaces #30's narrower Inactive skip,
which it contains". It also REVERSES #30's other half: an ACTIVE team member's
unread thread kept its row on purpose (`app/src/routes/today.ts:756-758`),
pinned by `app/test/todayApi.test.ts:1037` ("PIN: an unread unknown_1to1
thread from an ACTIVE team member is still in needs_you_now (unchanged)") and
`todayApi.test.ts:1089`. After r2 a team member's text is on no part of Today.
That follows from Cameron's ruling, but section 9's "update deliberately" list
should say these PINs are INVERTED, not moved to Identify. Otherwise a builder
will move them and see a red test that looks like a regression.

## N11. LOW - Labeling every Past row costs a read per tenant per tour event, now more often

5.3 now labels every Past row (prod about 23). Tenants are re-read on every
pass by design (`dashboard/src/routes/today/useTodayPastTours.ts:81-87`), and
the section reloads on every `tour.updated` (`useTodayPastTours.ts:174-183`),
which r2 now ALSO emits on every tour create (section 8). Every new request
therefore costs one contact GET per Past row on every open Today. The first
render also waits for every label before the section settles, and "All caught
up" waits on that settle (2.3). Fine at 23 rows; put it in 6.5's cost note.

## N12. LOW - The fallback now always renders two error lines

3.1 makes a fallback load mark Quiet shares and Tours to book unavailable.
2.5 renders "We couldn't load <section>." for each unavailable section. The
fallback page therefore always shows two load errors for sections it never
attempted. Say the fallback hides those two sections (still withholding "All
caught up") rather than showing errors.

---

## Contested adjudications

- A3 (Tours to book unbounded) - REJECTED by the coordinator. I concede: with
  13 requests in prod and a "Requested N days ago" urgency on each row, the
  section shows the backlog and does not hide it. The book-or-cancel reasoning
  holds.

No other finding of mine was rejected. The r1 fixes I checked against code
(tour create emit sites `routes/tours.ts:367`, `routes/units.ts:1654` are the
only two `tours.create` calls; `TEAM_SENDER_KEY` is set only by staff posts,
`routes/api.ts:1964,2056,2072` and `services/relayQueuedMessages.ts:96`;
inbound SMS paths stamp `last_heard_from_at` before their `conversation.updated`,
`routes/webhooks/twilio.ts:961/1076, 1388/1421, 2192/2225, 2695/2768`) hold.
