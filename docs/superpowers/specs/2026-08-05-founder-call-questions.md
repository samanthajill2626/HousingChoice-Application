# Founder call - questions (2026-08-06)

Context: go-live **2026-08-10**. Number `+16782842537` ports, this application
becomes the system of record, Quo and Airtable switch off.

Everything below is grounded in the actual exports (profiled 2026-08-05):
828 Quo contacts -> 543 people, 17,854 messages, 1,571 calls, 707 conversations,
2026-03-05 -> 2026-08-03. Airtable: 40 landlord rows, 10 properties, 17 tenants,
13 tours.

Questions are ordered by what blocks us. Tier 1 can stop the cutover; tier 2
changes what we import; tier 3 is nice to have.

---

## Tier 1 - could stop 8/10

### 1. Is the number port actually booked?

**Ask:** Has the port order for `+16782842537` been submitted to Twilio, and do we
have a confirmed port date in writing?

**Why it matters:** Carrier ports commonly take 1-3 weeks, not 5 days. Every one
of the 707 threads hangs off this number, and the whole cutover plan assumes it
moves on 8/10.

**Follow-up if it has not been submitted, or the date is soft:**
- What is the fallback - do we go live on a *new* Twilio number and forward the
  Quo number, accepting that tenants see a new number?
- Does she keep Quo running in parallel for a week?

This one is worth asking first, because a slip changes the shape of everything
else rather than just the timing.

### 2. A2P / 10DLC registration status

**Ask:** Where does the 10DLC brand and campaign registration stand, and is the
DBA / EIN paperwork consistent with what was filed?

**Why it matters:** Sending on the ported number without a registered campaign
means carrier filtering and error 30034. Our prod SMS flags are still unflipped
and this is a known open gate.

### 3. Please run the Quo export again this week

**Ask:** Can she run the same three Quo exports (contacts, messages, calls) again
in the next day or two - even though nothing has changed?

**Why it matters:** Two reasons, and the first is the important one.

1. **We need to prove record ids are stable across exports.** Our entire
   re-runnability design keys on Quo's ids (`AC...` messages, `CN...`
   conversations, ObjectId contacts). If Quo mints fresh ids per export, we need
   to know on 8/06, not on 8/10. The check is a one-minute diff.
2. It is a dry run of the export procedure she will perform on 8/09, so cutover
   morning is not the first time she does it.

**Also confirm:** the export she gives us on 8/09 must be taken *after* she stops
working in Quo, or we lose whatever she does between export and cutover.

### 4. Group texting changes on day one

**Ask:** After the port, texting three people at once will not work the way it
does now. Which conversations must still work as a group on day one?

**Why it matters:** She is using carrier group MMS today - 123 threads, 89 of them
a landlord and a tenant together. **Twilio does not support carrier group
messaging.** Post-port, a group thread has to run through a relay group fronted by
a *separate* number, so participants will see a new number for that thread.

We can import all 123 with full history at zero cost and let her switch a group
"live" whenever she needs it. The only question is whether any need to be live
*before* she walks in on 8/10.

**Data to offer her:** 38 groups had activity in the last 14 days, including one
with 299 messages and one with 144. Those are almost certainly live deals.

---

## Tier 2 - changes what we import

### 5. What does the `*` mean?

**Ask:** 18 contacts have an asterisk in the name - `Zariya Brown*-1bed`,
`Michael Johnson Sr *-2bed`, `Tiana White *-3bed`. What does the star mean?

**Why it matters:** She has three naming conventions and we decoded two with high
confidence (`-Nbed` = voucher size, handshake = landlord). This is the third and we
will not guess at it. If it means "placed" or "priority" or "do not contact", it
maps to a real field.

### 6. When does someone stop being active?

**Ask:** If you have not heard from a tenant in N weeks, at what point do you stop
considering them an active client?

**Why it matters:** We derive each imported tenant's status from last contact -
recent means `searching`, stale means `on_hold`. We are using 30 days as a
placeholder. **It should be her number.** It decides what her pipeline looks like
on day one, and it is one constant we can change in seconds.

### 7. Does `-Nbed` mean approved-for or looking-for?

**Ask:** When you write `-3bed`, is that the voucher size she is *approved* for, or
the size she is *looking* for?

**Why it matters:** 88% of contacts carry it, so it is the most-populated tenant
attribute in the whole corpus and it drives matching. Those are different fields
with different behaviour - a 3-bed voucher holder may be willing to take a 2-bed.

### 8. The four conflicting bed sizes

**Ask:** These four people appear with two different voucher sizes. Which is right?

| Names seen | Sizes |
| --- | --- |
| `Jasmine Maddox-2bed` / `Jasmine Maddox*-3bed` | 2 or 3 |
| `Candy Faulk-3bed` / `Candy-4bed` / `Candy Faulk-4bed` | 3 or 4 |
| `Maliko Hawkins-2bed` / `Maliko Hawkins-3 Bed` | 2 or 3 |
| `there-1bed` / `June-2bed` / `sam-3bed` / `June-5bed` / `Davis-3bed` / `Sam-2bed` (all one number) | 1, 2, 3, 5 |

**Why it matters:** Four out of 478 is a remarkably clean rate and we do not want
to auto-resolve them. The last one looks like a shared or reassigned phone - worth
understanding on its own.

### 9. Where does your real property list live?

**Ask:** The Airtable properties table has 10 rows, and 26 of its 38 columns are
completely empty. Is that everything, or do properties live somewhere else?

**Why it matters:** She texts addresses constantly - the same address bodies repeat
49, 40, 26 and 23 times in her outbound messages. That does not look like a
10-property operation. We are pre-filling the workbook with addresses mined from
her texts so she can confirm or delete them rather than typing from scratch.

**Follow-ups:** Rent, bedrooms, application fee, pet policy, requirements - the
columns exist in Airtable and were never filled. Where does that live today?
In her head, in texts, or somewhere we have not seen?

### 10. Is the 543-person list your whole book?

**Ask:** Are there tenants, landlords or caseworkers who are *not* in Quo - saved
in her phone contacts, on paper, or in another app?

**Why it matters:** Anyone not in the export does not exist to the system on 8/10.
Also: 80 phone numbers have real message traffic but no saved contact record (642
messages; the busiest has 51 and was active two days ago) - so we know she does not
always save people.

### 11. Did you use Quo before March?

**Ask:** The message history starts 2026-03-05, but two contacts were created back
in January. Was there anything before March - an earlier tool, a personal phone,
another number?

**Why it matters:** If the message export is date-limited rather than complete, we
are missing history and should ask Quo for a full range.

### 12. Caseworkers - how do you think about them?

**Ask:** We detected 16 caseworkers. Are they a distinct kind of person to her, or
just contacts? Does she work *through* caseworkers to reach tenants?

**Why it matters:** Our contact model has no `caseworker` type (open decision:
`docs/issues/caseworker-contact-type.md`). We are mapping them to `partner` with a
note. Her answer decides whether that issue gets resolved properly. The Airtable
tenants table also has a `tenant type` column with "Casewoker" values, so the
concept clearly matters to her.

### 13. Voucher programs vs housing authorities

**Ask:** Confirm these are two different things: the program (Georgia Housing
Voucher / GHV, HUD VASH) versus the authority administering it (Atlanta Housing,
DeKalb Housing, Jonesboro Housing). And where do Claratel and Hope Atlanta fit -
those look like caseworker organisations rather than either.

**Why it matters:** Our contact model has one `housingAuthority` field (a GSI) and
units have a separate `jurisdiction`. If she is tracking three concepts we need to
know before we collapse them into two.

---

## Tier 3 - worth asking if there is time

### 14. The photos are gone. Do you need them?

Quo's export has **no media column at all** - every MMS image is lost. 694 messages
have an empty body and were almost certainly photo sends. If any of those matter
(property photos she sent, documents tenants sent her), she may still have them on
her phone, and we should know before Quo is switched off.

Same for **call recordings and transcripts** - the export has only duration and
direction.

### 15. Which email address is canonical?

`Sam@affordableplacements.com` appears 24 times in her outbound texts, but her Quo
account is `samjjames26@gmail.com`. Neither is a `housingchoice.org` address. Which
should the system use, and should tenants see it?

### 16. Did anyone else use Quo?

The export shows exactly one user and one number. Confirm nobody else was texting
tenants from their own device or account - if they were, those threads are not in
what we have.

### 17. Landlord vs property manager

Our unit model supports a roster with roles (landlord / PM / owner / other) and one
designated voice contact. Her data has hints of the distinction -
`BNS Property Management`, `Leora PM`, `Lolita Property Manager`,
`Robert Esther- Work #`. Does she deal with owners, managers, or both, and who does
she actually call?

### 18. Duplicate landlord rows

The Airtable landlord table has 40 rows but only 18 distinct phone numbers, and
seven numbers carry two or more different names - e.g. `+14049188226` appears as
`Raj`, `Kristy` and `Natraj Subramaniam`. Are those the same person, colleagues
sharing a line, or an office number?

---

## Things to tell her (not questions)

- **The photos and call recordings do not come across.** Quo's export does not
  include them. Say it plainly before Quo is switched off.
- **Her naming conventions became the schema.** `-Nbed` and the handshake emoji
  gave us voucher size for 478 people and landlord identification for 16, for free.
  That is worth telling her - it will make the workbook make sense to her.
- **The workbook is hers to overrule.** Every suggestion in it is a suggestion. If
  she changes a name, a type, or a voucher size, that is what gets imported.
- **She only has to review the flagged rows.** Roughly 150 of 543 need her eyes;
  the rest are a spot-check.
- **Do not edit the `row_key` column**, and if she opens it in Excel, the phone
  column may lose its `+`. That is expected and harmless - we do not join on it.
