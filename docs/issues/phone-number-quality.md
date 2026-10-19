---
id: phone-number-quality
title: Phone number quality - the phone check accepts numbers that cannot exist, and the "can't be texted" flag is never cleared and is invisible on the contact page
type: improvement
severity: low
status: open
area: app/contacts
created: 2026-10-19
refs: app/src/lib/phone.ts:32, dashboard/src/lib/phone.ts:35, app/src/routes/contacts.ts:876, app/src/lib/import/quoSource.ts:185, app/src/lib/import/airtableSource.ts:130, app/src/routes/webhooks/twilio.ts:3925, app/src/jobs/broadcastFanOut.ts:267, app/src/repos/contactsRepo.ts:1467, dashboard/src/routes/broadcasts/RecipientPreview.tsx:275
---

**How this came up.** The 2026-10-19 prod error review (window 10-12 to 10-17,
prod on `dev-c12e6b70-20261014133916`) found 16 ERROR lines and two alarm
pairs on 10-16 (`hc-prod-error-logs` 18:28 EDT, `-sustained` 18:37 EDT, both
self-cleared). Most were carrier outcomes on dead numbers, logged at ERROR by
design. Two findings point here:

1. **A number that cannot exist reached Twilio.** At 2026-10-16 22:27Z a staff
   user texted imported contact `18700703-c92d-5d32-ad73-074160f9ef36`, whose
   stored number is `+1678123xxxx`. Its exchange starts with 1, which NANP does
   not allow, so Twilio rejected it with 21211 ("not a valid phone number").
   The send route turned that into a 500 and the dashboard said "Couldn't send
   - please try again", so staff retried 4 times in 11 seconds. That crash is
   fixed separately on `fix/send-invalid-number` (a rejected send now answers
   with a clear message). What is left is the ENTRY side: the number got in.
   The contact id is the importer's `uuidv5(contact:<e164>)` shape, so it most
   likely came in with the Quo/Airtable import.
2. **Staff re-sent twice to a contact already flagged unreachable.** A caller
   on 10-13 was a number that cannot take texts; the missed-call auto-text
   failed 30005 and the webhook correctly set `sms_unreachable`. Staff then
   re-sent the same 119-character text by hand on 10-13 and 10-15, and both
   failed 30005 again. Nothing on the contact page or the composer said the
   number was flagged.

Cameron's call (2026-10-19): bundle both as one "phone number quality"
feature at low severity, run it as a feature mission later, and drop it from
the immediate work. A read-only prod scan for other impossible numbers runs
separately, after the fix; its results stay out of the repo (they are names
and numbers).

**Problem A - the phone check is shape-only.** `normalizeToE164`
(`app/src/lib/phone.ts:32`, mirrored in `dashboard/src/lib/phone.ts:35`)
accepts any 10 digits as `+1` plus those digits. That is deliberate and
documented (no libphonenumber), but it means an area code or exchange that
starts with 0 or 1 is stored as valid. The importer (`quoSource.ts:185`,
`airtableSource.ts:130`) and the contact routes (`contacts.ts:876`) use the
same check.

Tightening the shared function is NOT the fix. It is called from about 23
server files and 6 dashboard files, including the inbound SMS and voice
webhooks, and 618 of the 753 distinct `+1` numbers in the repo's tests, seeds
and e2e specs would fail a 0/1 rule (for example `+14040000001`). The check
belongs at the HUMAN entry points only (contact create/edit, the public intake
form, the import), as a separate predicate.

**Problem B - `sms_unreachable` is sticky and mostly invisible.** The webhook
sets it on an SMS 30005/30006 (`twilio.ts:3925`), and the broadcast fan-out
sets it too. Nothing ever clears it: `clearFlag` exists
(`contactsRepo.ts:1467`) but no code path calls it for this flag. Once set,
broadcasts skip the contact forever (`broadcastFanOut.ts:267`) even after
staff correct the number. The only UI that reads the flag is the broadcast
recipient picker (`RecipientPreview.tsx:275`); the contact page and the
composer never show it.

**Design questions for the mission.**

- Where the stricter check applies, and what the user sees when it fails.
- What happens to an EXISTING contact with an impossible number when staff
  edit some other field - the edit must not be blocked by a number they did
  not touch.
- When `sms_unreachable` clears: on a phone change, on an inbound text from
  that number, by a manual action, or some mix.
- The flag is per CONTACT but the failure is per NUMBER, and a contact can
  hold several numbers.
- Where and how the flag shows on the contact page and the composer, and
  whether it warns or blocks.
- Whether a 21211 rejection should also set the flag (deliberately left out
  of `fix/send-invalid-number` until the flag can be cleared).
- Fixture and seed migration for whatever rule is chosen.

**Suggested fix.** One feature mission covering A and B, sized by the scan
results.
