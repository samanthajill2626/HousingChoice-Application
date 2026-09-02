# Live hermetic self-QA - 2026-08-28

Harness: `npm run e2e:session` in this feature worktree, lane 4 only. The
session was started after the full E2E gate stopped and was ended with
`npm run e2e:stop`; the stop log confirms the launcher and children stopped,
lane tables were dropped, and the lane lease was released.

## New unknown caller

- Created a new open relay group in the hermetic dashboard and placed a fake
  inbound call from an otherwise unmatched number through fake Twilio.
- Fake call reached `completed` with zero Dial legs. The authenticated messages
  response carried `relay_refusal_reason: non_member`, the normalized caller
  phone, and no stored contact ID.
- Before expanding, the real dashboard card showed the formatted number plus
  `tried to call this relay number`, `Not connected`, minute time, and a
  card-specific collapsed Details control.
- After expanding, it showed the formatted phone, `Not a participant in this
  relay group`, `No linked contact`, and a full local date/time with seconds.
- Desktop visual capture confirmed the card face and detail layout. A 360 px
  viewport capture confirmed the card wraps without horizontal overflow; the
  viewport override was reset afterward.

## New named matched caller

- Created a distinct local tenant contact with a name and phone, but did not
  add it to the relay group. A fake inbound call from that number reached
  `completed` with zero Dial legs.
- The authenticated messages response retained the matched stored contact ID
  and hydrated `QA Known Caller` from that ID.
- The real dashboard card showed `QA Known Caller tried to call this relay
  number` and `Not connected`. Expanded Details contained the formatted phone,
  the non-member explanation, seconds-precise local time, and one `View
  contact` link targeting that stored contact ID.

No participant-facing or production endpoint was exercised.
