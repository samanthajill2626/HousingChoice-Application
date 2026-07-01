# A2P Campaign — changes to re-submit

**For:** the founder who submits the A2P campaign (Twilio / The Campaign Registry).
**From:** the app team. **Date:** 2026-06-30.
**Why:** We audited the app against the approved campaign. Rather than degrade the
product to match the original submission, we're updating the **submission to
describe what the app actually does** (a better tenant experience). This doc lists
every field to change, the new copy to paste in, and a few decisions only you can
make. Items marked **[DECISION]** need your input; the rest are ready to submit.

> **Heads-up on timing:** changing "embedded links" (item 1) and the opt-in flow
> (item 3) can trigger **re-vetting** of the campaign. Budget lead time before we
> flip live SMS on. Submit these as early as possible.

---

## Summary of changes

| # | Field | Change | Type |
|---|-------|--------|------|
| 1 | Messages contain embedded links | **No → Yes** (we send links to our own property pages) | Required |
| 2 | Messages contain phone numbers | Keep **No** (confirm) | [DECISION] |
| 3 | Opt-in flow / "end-user consent" | Rewrite: web-form checkbox **+ customer-initiated inbound** (no forced "reply YES" step) | Required |
| 4 | Sample messages | Replace all 5 with samples that match what we actually send (incl. a link) | Required |
| 5 | Sender brand name in messages | Confirm "Tenant Place LLC" (or a registered DBA) — app currently says "HousingChoice" | [DECISION] |
| 6 | Opt-in / opt-out keywords | No change needed — the **app** is being updated to honor your declared keyword lists | Info |
| 7 | Terms & Privacy URLs | Confirm live at `tenant.place/terms` and `tenant.place/privacypolicy` | Confirm |

---

## 1. Embedded links: **No → Yes** (required)

**Current submission says:** *Messages contain embedded links: No.*
**Reality:** Our core value is texting a tenant a specific home that fits their
voucher, with a link to that home's page (e.g. `tenant.place/p/<id>`). Sending
links under a "no links" campaign is a top cause of carrier filtering/blocking.

**Change to:** **Yes.** Suggested description if a field asks what the links are:

> Links point only to our own property-listing pages on tenant.place (e.g.
> tenant.place/p/<id>), where a tenant can view photos and details of a specific
> home that accepts their voucher. No third-party, affiliate, or shortener links.

*(Use your real listing domain if it differs from tenant.place.)*

---

## 2. Messages contain phone numbers — keep **No** [DECISION]

The app does **not** put phone numbers in message bodies today, so **No** is
accurate and lower-scrutiny. **Only change to Yes if** you want messages to include
a call-back number (e.g. "call us at …"). Recommend leaving **No** and we'll keep
phone numbers out of message text.

---

## 3. Opt-in flow — rewrite (required)

The original submission described a **double opt-in** on the text path ("…reply
**YES** to sign up…" before any enrollment). The app uses a cleaner single opt-in.
Replace the **"How do end-users opt in to receive messages?"** narrative with:

> Tenants opt in three ways. **(1) Website consent form** at tenant.place: the
> tenant enters their mobile number and checks a box agreeing to receive recurring
> texts. The form states the message purpose (new properties that accept their
> voucher, tour reminders, and updates), that message frequency varies, that
> message and data rates may apply, STOP/HELP instructions, and links to our Terms
> and Privacy Policy. **(2) Customer-initiated text:** a tenant texts our number to
> ask about housing; because they contacted us first about our service, we record
> their consent (with date) and reply. Our first message identifies Tenant Place
> LLC and includes STOP/HELP. **(3) Advertised keyword:** "Text START to (404)
> 982-4978" is advertised on tenant.place. Every opt-in is recorded with a date and
> method. Opt-outs (STOP and related keywords) are honored immediately and
> confirmed. Mobile opt-in data is not shared with third parties.

**⚠ Compliance note for you to weigh:** replying 1:1 to someone who texted us first
is clearly fine. Enrolling that same person into **recurring** property alerts on
the strength of their inbound question is more permissive than the "reply YES"
double opt-in. We mitigate it by making our **first outbound reply** disclose the
program + STOP/HELP, and by recording the consent date/method per contact. This is
a defensible, common approach — but you (or Twilio's vetting) may prefer to keep an
explicit confirmation for the recurring-alert enrollment. **Your call.** If you
want the explicit confirmation kept, tell us and we'll add it to the app instead.

---

## 4. Sample messages — replace all five (required)

Swap the old "reply YES" samples for ones that reflect what the app actually sends
(and that show a link, per item 1). Brand shown as "Tenant Place LLC" — adjust per
item 5.

**Sample 1 — Welcome (after web-form or inbound opt-in)**
> Welcome to Tenant Place LLC! You're signed up for new properties that accept your
> voucher, plus tour reminders and updates. Msg frequency varies. Msg & data rates
> may apply. Reply STOP to unsubscribe, HELP for help.

**Sample 2 — New-property alert (with a link)**
> Hi Maria — a new 2-bedroom that accepts your voucher just opened at 1234 Maple
> Ave, Lakewood, $1,400–$1,650/mo. See photos & details: tenant.place/p/ab12cd.
> Reply STOP to opt out.

**Sample 3 — Tour reminder**
> Reminder from Tenant Place LLC: your tour of 1234 Maple Ave is tomorrow at
> 2:00 PM. Reply here with any questions. Reply STOP to opt out.

**Sample 4 — Customer-initiated question (1:1 reply)**
> Tenant: Hi, is 1294 North Ave still available?
> Tenant Place LLC: Hi! Yes — 1294 North Ave NW is a 2-bedroom that accepts Section
> 8 vouchers. Want me to send the full details and photos? Reply STOP to opt out.

**Sample 5 — Opt-out / opt-in exchange**
> Tenant: STOP
> Tenant Place LLC: You have successfully been unsubscribed. You will not receive
> any more messages from this number. Reply START to resubscribe.

---

## 5. Sender brand name [DECISION]

Your registration and these samples use **Tenant Place LLC** (your legal entity).
The **app's** copy currently says "HousingChoice." Carriers expect the name in
messages to match the registered brand (or a **registered DBA** of it).

**Pick one:**
- **(a) Use "Tenant Place LLC" in all texts** (recommended — matches registration,
  no extra paperwork). We'll update the app's SMS-facing copy to Tenant Place LLC.
  "HousingChoice" can remain the internal/staff dashboard name only.
- **(b) Use "HousingChoice" in texts** — then register "HousingChoice" as a DBA of
  Tenant Place LLC and reference it in the brand/campaign. More paperwork.

Tell us which; the app copy and these samples follow your choice.

---

## 6. Keywords — no campaign change (info)

Your declared keyword lists are good and we're **updating the app to honor them**
(this is our work, not yours):
- **Opt-out:** OPTOUT, CANCEL, END, QUIT, UNSUBSCRIBE, REVOKE, STOP, STOPALL.
- **Opt-in:** START, JOIN, HOME (+ we also accept YES).

The self-managed opt-out, opt-in, and HELP auto-replies will use your filed copy:
- **Opt-out reply:** "You have successfully been unsubscribed. You will not receive
  any more messages from this number. Reply START to resubscribe."
- **HELP reply** (finalize this one — the submitted copy was cut off):
  > Tenant Place LLC: housing listing alerts for voucher holders. Msg frequency
  > varies. Msg & data rates may apply. Reply STOP to opt out. More info:
  > tenant.place.

---

## 7. Terms & Privacy Policy — confirm

Submission references `tenant.place/terms` and `tenant.place/privacypolicy`.
Confirm both are **live and reachable** at submission time (vetting checks them).
If the public site launches on a different domain, update both URLs to match.

---

## What the app team is doing in parallel (so the submission is truthful)

Tracked in `docs/issues/a2p-compliance-hardening.md`. In brief: required consent
checkbox on the web form; Tenant Place LLC branding + STOP/HELP language on
first-contact messages; honor the full keyword lists above; self-managed
STOP/HELP/START auto-replies using the filed copy; record consent method + date on
every contact (web form, inbound, staff-entered); and a just-in-time consent gate
so staff can't proactively text a contact who has no recorded consent.
