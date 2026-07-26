# A2P Campaign — changes to re-submit

**For:** the founder who submits the A2P campaign (Twilio / The Campaign Registry).
**From:** the app team. **Date:** 2026-07-26 (supersedes the 2026-06-30 version).
**Why:** We audited the app against the approved campaign and are updating the
**submission to describe what the app actually does**. Since the June version of
this doc, the app-side compliance hardening has **shipped** (consent checkbox,
consent recording, JIT consent gate, self-managed STOP/HELP/START, keyword lists,
first-contact identity + opt-out), and the app gained features the submission
must now cover: **MMS photo attachments**, **group relay texting**, and **staff
cell-verification codes**. This doc lists every field to change, the new copy to
paste in. All founder decisions were made 2026-07-26 (single opt-in posture,
one campaign, brand + DBA below) — everything here is ready to submit; the only
remaining items are the live-URL and number-inventory confirmations (8 and 9).

> **Heads-up on timing:** changing "embedded links" (item 1) and the opt-in flow
> (item 3) can trigger **re-vetting** of the campaign. Budget lead time before we
> flip live SMS on (`SMS_SENDING_ENABLED` stays off until this is approved).
> Submit as early as possible.

> **Why ONE campaign (not separate ones for verification codes or relay):** a
> phone number can belong to only one campaign, so splitting means dedicated
> numbers plus separate monthly TCR fees and separate vetting per campaign. Our
> verification codes go only to our own staff's verified phones (a handful of
> sends), and relay is low-volume transactional coordination — both fit a mixed
> use case declared honestly on this one campaign. If verification ever needs to
> stand alone, Twilio Verify (pre-registered, no campaign needed) is the escape
> hatch — not a second self-registered campaign.

---

## Summary of changes

| # | Field | Change | Type |
|---|-------|--------|------|
| 1 | Messages contain embedded links | **No → Yes** (we send links to our own property pages) | Required |
| 2 | Messages contain phone numbers | Keep **No** — confirmed 2026-07-26, no message body carries a phone number | Confirmed |
| 3 | Opt-in flow / "end-user consent" | Rewrite: web-form checkbox **+ customer-initiated inbound (text or call)** + advertised keyword + staff-recorded verbal consent (single opt-in — accepted 2026-07-26) | Required |
| 4 | Campaign / use-case description | Rewrite to cover the full surface: alerts, tour + application messages, 1:1 replies, missed-call auto-text, **group relay threads**, **MMS photos**, **staff verification codes** | Required |
| 5 | Sample messages | Replace all 5 with samples matching what we actually send (link, MMS note, relay intro, verification code) | Required |
| 6 | Sender brand name / DBA | **Tenant Place LLC** is the registered brand; register **"HousingChoice" as a DBA** on the brand (plus any other trade names in use). Verification code keeps "HousingChoice" | Required |
| 7 | Opt-in / opt-out keywords | No change — the app now honors your declared keyword lists (shipped) | Info |
| 8 | Terms & Privacy URLs | Confirm live at `tenant.place/terms` and `tenant.place/privacypolicy` | Confirm |
| 9 | Number inventory | Confirm **every** number is attached to this campaign: the main opt-in number **and all relay pool numbers** | Confirm |

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

## 2. Messages contain phone numbers — keep **No** (confirmed)

Confirmed 2026-07-26: no message body carries a phone number. This is enforced in
code — the HELP reply is unit-tested to contain no digits, and relay
intro/announcement copy uses member display names, never numbers. Keep **No**.

---

## 3. Opt-in flow — rewrite (required)

The original submission described a **double opt-in** on the text path ("…reply
**YES** to sign up…" before any enrollment). The app uses a cleaner single opt-in.
Replace the **"How do end-users opt in to receive messages?"** narrative with:

> Recipients opt in four ways. **(1) Website consent form** at tenant.place: the
> tenant enters their mobile number and checks a box agreeing to receive recurring
> texts. The form states the message purpose (new properties that accept their
> voucher, tour reminders, and updates), that message frequency varies, that
> message and data rates may apply, STOP/HELP instructions, and links to our Terms
> and Privacy Policy. **(2) Customer-initiated contact:** a tenant texts or calls
> our number to ask about housing; because they contacted us first about our
> service, we record their consent (with date and method) and reply. Our first
> message identifies Tenant Place LLC and includes STOP/HELP. **(3) Advertised
> keyword:** "Text START to (404) 982-4978" is advertised on tenant.place.
> **(4) Verbal or written consent recorded by staff:** for a tenant or property
> owner who asks in person, by phone, or on paper to receive texts, staff record
> the consent method, date, and note before any message can be sent — the
> application blocks outbound texts to any contact with no recorded consent.
> Every opt-in is stored with its date and method. Opt-outs (STOP and the full
> declared keyword list) are honored immediately on every number and confirmed.
> Mobile opt-in data is not shared with third parties.

**Decision recorded (founder, 2026-07-26): single opt-in — accepted.** Context:
enrolling someone into recurring property alerts off their inbound question is
more permissive than the originally-filed "reply YES" double opt-in. Accepted
because our messaging is informational/transactional (our filed classification —
not marketing), and mitigated in the app: the **first outbound reply** discloses
the program + STOP/HELP, and consent date/method is recorded per contact. The
narrative above describes exactly this — submit it as written. If Twilio's
vetting pushes back and demands an explicit confirmation step, tell the app team
and we'll add it.

---

## 4. Campaign / use-case description — rewrite (required)

Wherever the form asks to describe the campaign / what messages are sent, use:

> Tenant Place LLC helps Section 8 / Housing Choice Voucher holders find and
> lease homes that accept their voucher. Messages sent: (a) alerts about a
> specific home matching the tenant's voucher, with a link to that home's page
> on tenant.place and sometimes a photo of the home attached (MMS); (b) tour
> scheduling, confirmations, reminders, and follow-ups; (c) rental-application
> status check-ins and deadline reminders; (d) two-way conversational replies
> between the recipient and our staff; (e) a one-time auto-reply when we miss
> someone's phone call; (f) group text threads that connect a tenant, a property
> owner, and our team to coordinate a specific placement — each member's reply
> is relayed to the other members from our number, and every thread opens with
> our brand identity and STOP instructions; (g) account-verification codes sent
> to our own staff members' phones when they verify their number in our
> dashboard. All recipients have a recorded opt-in; STOP/HELP/START and the full
> declared keyword lists are honored on every number we send from.

If the form asks for use-case categories and allows more than one, declare the
mix accordingly (e.g. account notifications / customer care / delivery
notifications + 2FA for the staff verification codes).

---

## 5. Sample messages — replace all five (required)

Swap the old "reply YES" samples for ones that reflect what the app actually
sends. Sample 2 may carry a photo of the home as an MMS attachment — note that
if the form has anywhere to say so.

**Sample 1 — Welcome (after web-form or keyword opt-in)**
> Welcome to Tenant Place LLC! You're signed up for new properties that accept your
> voucher, plus tour reminders and updates. Msg frequency varies. Msg & data rates
> may apply. Reply STOP to unsubscribe, HELP for help.

**Sample 2 — New-property alert (link; may include an MMS photo)**
> Hi Maria — a new 2-bedroom that accepts your voucher just opened at 1234 Maple
> Ave, Lakewood, $1,400–$1,650/mo. See photos & details: tenant.place/p/ab12cd.
> Reply STOP to opt out.

**Sample 3 — Tour reminder (sent within an existing conversation)**
> Reminder: your property tour is tomorrow.

**Sample 4 — Group relay thread intro (first message on a relay number)**
> Tenant Place LLC. You're now connected with Maria Lopez and John Smith on this
> number. Reply here and everyone in the group sees it. Reply STOP to opt out.

**Sample 5 — Staff cell-verification code (to our own staff only)**
> Your HousingChoice verification code is 482913. It expires in 10 minutes.

*(This one intentionally says "HousingChoice" — covered by the DBA registration
in item 6.)*

---

## 6. Sender brand name + DBA registration (decided 2026-07-26)

**Tenant Place LLC** is the real/legal company and stays the registered brand.
The app's SMS-facing copy uses "Tenant Place LLC" everywhere a tenant or
property owner is the recipient (single constant in code).

**Action for the submission:** register **"HousingChoice" as a DBA** of Tenant
Place LLC on the brand (Trust Hub brand registration has a DBA / brand-name
field). While you're in there, **add any other company or trade names we
operate under as DBAs too** — every name that could ever appear in a message
should be on the brand.

With the DBA registered, the staff cell-verification SMS **keeps** "Your
**HousingChoice** verification code…" (decided — its only recipients are our own
staff, who know the product by its internal name, and the DBA makes the name
carrier-legitimate). No app change.

---

## 7. Keywords — no campaign change (info)

Your declared keyword lists are unchanged and the app now honors them (shipped,
self-managed — Twilio Advanced Opt-Out confirmed OFF and must stay off):
- **Opt-out:** OPTOUT, CANCEL, END, QUIT, UNSUBSCRIBE, REVOKE, STOP, STOPALL.
- **Opt-in:** START, JOIN, HOME (+ we also accept YES and UNSTOP).

The self-managed auto-replies use your filed copy:
- **Opt-out reply:** "You have successfully been unsubscribed. You will not receive
  any more messages from this number. Reply START to resubscribe."
- **HELP reply:**
  > Tenant Place LLC: housing listing alerts for voucher holders. Msg frequency
  > varies. Msg & data rates may apply. Reply STOP to opt out. More info:
  > tenant.place.

---

## 8. Terms & Privacy Policy — confirm

Submission references `tenant.place/terms` and `tenant.place/privacypolicy`.
Confirm both are **live and reachable** at submission time (vetting checks them).
If the public site launches on a different domain, update both URLs to match.

---

## 9. Number inventory — confirm (new)

Group relay runs on a **pool of numbers**, not just the main opt-in number.
Every number the app can send from — the main number (404) 982-4978 **and every
relay pool number** — must be attached to this campaign's Messaging Service.
Any number we buy for the pool later must be added to the same service before
it carries traffic.

---

## What the app already does (shipped 2026-07-01, so the submission is truthful)

Tracked in `docs/issues/a2p-compliance-hardening.md`. In brief: required consent
checkbox on the web form (server-enforced); Tenant Place LLC branding +
STOP/HELP language on first-contact messages; the full keyword lists above
honored on every inbound path (1:1, closed relay, open relay); self-managed
STOP/HELP/START auto-replies using the filed copy; consent method + date + version
recorded on every contact (web form, inbound text, inbound call, staff-entered);
a just-in-time consent gate so staff can't proactively text a contact with no
recorded consent; a broadcast fence that skips non-consented recipients; opt-out
enforcement on every send path including relay fan-out; and a template-validation
floor so opt-out language can't be edited out of first-contact templates.
Live SMS stays disabled (`SMS_SENDING_ENABLED=false`) until this re-filed
campaign is approved.
