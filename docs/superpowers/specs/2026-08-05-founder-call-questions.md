# Moving your data into the new system - what I need from you

Hi Sam,

I've been through everything you exported from Quo and Airtable, cleaned it up,
and loaded it into the new system as a trial run. It worked - so what's below
isn't guesswork, it's what I actually found in your data.

**I've also done the tidying for you.** Duplicates merged, names cleaned up,
voucher sizes and landlords picked out automatically. What's left is a set of
spreadsheets with my best guesses filled in, for you to correct where I got it
wrong. They're attached alongside this note.

The short version: **your data came through well.** Better than I expected, and
mostly because of habits you already had. But there are some things only you can
answer, and a few things you should know before we switch over on **Monday 8/10**.

Here's what came across:

| | |
| --- | --- |
| People | **629** (from 828 Quo contact rows - a lot were duplicates) |
| Messages | **17,854** going back to March 5 |
| Calls | **1,571** |
| Conversations | **721**, including 123 group texts |
| Properties | **75** |

There are three spreadsheets - your people, your group texts, and your
properties. **Only 117 rows are marked for you to look at.** The other 512 I'm
mostly confident about, but I want you to take a look and see if everything looks
right. There's a guide to filling them in at the end of this note.

---

## Three things I need this week

### 1. Is the phone number transfer actually booked?

We started the transfer of **678-284-2537** to the new system, but I'm not certain
where it stands right now. Can you check and let me know, specifically if there's
a completion date confirmed anywhere.

I'm asking because moving a phone number between carriers usually takes one to
three weeks, not five days. Every single one of your 721 conversations is tied to
that number, so if the date slips I need to know now rather than Monday morning.

If it hasn't been submitted yet, or the date isn't firm, we should talk about the
alternative: going live on a new number and forwarding your Quo number to it. It
works, but your tenants and landlords would see a different number, so I'd rather
avoid it if we can.

### 2. A2P registration

Where does the new A2P registration stand?

You re-filed the campaign on **26 July** because the app had picked up things the
original filing didn't cover - photo attachments, group texting, and verification
codes for staff.

Worth knowing why I keep asking: **the system can't send any texts at all until
that campaign is approved.** Changing the link and opt-in answers can also trigger
a fresh review, which adds time. So if it's still pending on Monday, texting won't
work on day one even though everything else will.

**One number to add:** 678-284-2537 needs to go on that list too, once it
transfers across. It wasn't on the original because it wasn't ours yet. I can make
that update on Twilio once you let me know it's ported.

### 3. Please export from Quo one more time this week

Could you run the same three Quo exports again - contacts, messages, and calls -
in the next day or two? Nothing needs to have changed.

Two reasons. The first is that I need to check something technical: whether Quo
gives each message the same internal ID every time you export. My whole approach
to importing depends on it, and it takes a minute to verify with two files side by
side. Much better to find out this week than on Monday.

The second is that you'll be doing this export again on **Sunday 8/9**, and it's
worth having done it once already so it's familiar.

**And good news on timing:** you don't need to stop working in Quo before you
export. I'll take one export on Sunday to set everything up, then a final one
after the number moves across, which sweeps up anything that came in between. So
just keep working normally - nothing gets stranded.

**One thing to hold off on:** please don't close or cancel your Quo account until
I've taken that final export and confirmed it landed. Once the account is gone, so
is anything I haven't pulled out yet - including the photos below.

---

## Something that will work differently

I want to flag this now rather than have it surprise you on Monday.

**Group texts change.** Right now, when you text a landlord and a tenant together,
your phone creates a group message and everyone sees everyone. The new system
can't do that the same way - that kind of group text isn't something business
phone systems can send.

Instead, group conversations run through a **separate number** that connects
everyone. It works, and everyone still sees each other's replies - but the people
in that group will see a new number for it, not your 678 number.

You have **123 group conversations**, and **38 of them have been active in the
last two weeks** - including one with 299 messages and one with 144. Those look
like live deals.

**All 123 come across with their full history**, so nothing is lost and you can
read every one. Setting a group up to send again costs nothing until you actually
want it. So the only question is:

> **Are there any group conversations you'll need to send to on day one?** If so,
> which? If you'd rather just switch them on as you need them, that's completely
> fine - it takes seconds.

I've listed all 123 for you - who's in each one, how many messages, and when it
was last active - so you can decide by looking rather than from memory.

---

## Questions about how you work

These shape how your data gets set up. Short answers are fine.

### 4. What does the `*` in some names mean?

About 18 of your contacts have an asterisk - things like `Zariya Brown*-1bed` and
`Tiana White *-3bed`.

I worked out your other shortcuts on my own, but I can't work this one out, and I
don't want to guess. Does the star mean placed? Priority? Something to be careful
about?

### 5. What does the 🤝 mean?

You put a 🤝 in front of some landlord names, and I've been treating it as "this
person is a landlord" - it's how I picked your landlords out automatically.

Looking more closely, though, I don't think that's quite what you meant by it. In
your Airtable landlord table only **17 of 40 rows** have it, and **6 of your 18
landlords never have it at all**. Some numbers even appear with it in one row and
without it in another.

So it looks like it marks something *about* a landlord rather than marking who is
one. Someone you've signed an agreement with? Someone you've actually placed a
tenant with? Someone worth going back to? What were you recording?

### 6. When do you stop thinking of someone as active?

If you haven't heard from a tenant in a while, at what point do you stop counting
them as someone you're actively working with? A month? Two?

I'm using **30 days** as a starting point - anyone you've spoken to in the last 30
days comes across as **Searching**, and anyone older comes across as **On hold**.
It's one setting and I can change it in seconds, but it decides what your
dashboard looks like on day one, so I'd rather use your number than mine.

### 7. When you write `-3bed`, what does that mean exactly?

Is that the voucher size they've been **approved for**, or the size they're
**looking for**?

I think it's the size they're approved for, but I'd rather have it confirmed than
assume. It matters more than it sounds - someone approved for a 3-bed might
happily take a 2-bed, and I want the system to suggest the right properties.

### 8. How do you think about caseworkers?

I found about 16 in your contacts. Are they a different kind of person to you than
tenants and landlords? Do you often work *through* a caseworker to reach someone?

I ask because the system currently doesn't have a proper "caseworker" category -
I've put them in as partner contacts for now. If they're a real part of how you
work, I'd rather build it properly than leave it as a workaround.

### 9. Voucher programs and housing authorities

I want to make sure I've got these separated correctly. It looks like there are
two different things in your data:

- **The program** - Georgia Housing Voucher (GHV), HUD VASH
- **The housing authority** - Atlanta Housing, DeKalb Housing, Jonesboro Housing

And then **Claratel** and **Hope Atlanta**, which look more like the organizations
caseworkers work for than either of the above.

Is that right? Are those three separate things, or am I over-thinking it?

### 10. Is Quo your whole book?

Are there tenants, landlords, or caseworkers who **aren't** in Quo - saved in your
phone, written down somewhere, or in another app?

Anyone not in the export simply won't exist in the new system on Monday, so it's
worth a think.

Related: I found **86 phone numbers you've texted but never saved as contacts** -
642 messages between them. The busiest has 51 messages and you were texting them
two days ago. They'll come across as unnamed contacts you can name later.

### 11. Was there anything before March?

Your message history starts **March 5**, but a couple of contacts were created back
in January. Did you use Quo before March, or were you working from somewhere else -
another app, a personal phone, a different number?

If there's older history, I'd like to know whether it's worth chasing.

---

## Your properties

**Is Airtable actually where your properties live, or is it somewhere else?** Your
head, your texts, a notebook, another spreadsheet? No wrong answer - I just want
to point the system at the real thing.

I ask because the numbers don't line up. Your Airtable properties table has **10
rows**, and most of its columns were never filled in. But you text property
addresses constantly, so I went looking through your sent messages - and found
**65 properties that aren't in Airtable at all.** Here are the ten you text most:

| Times you've texted it | Address | In Airtable? |
| --- | --- | --- |
| 88 | 1460 Lavender Dr NW Atlanta, GA 30314 | **no** |
| 80 | 1721 Browning St. SW, Atlanta, GA 30314 | **no** |
| 71 | 2018 Ruth St 30318 | yes |
| 62 | 470 Bolton Rd NW Atlanta, GA 30331 | **no** |
| 47 | 934 Joseph E Boone Blvd NW, Atlanta, GA 30314 | **no** |
| 45 | 846 Durant Pl NE Unit 2 Atlanta, GA 30308 | **no** |
| 42 | 2840 Alexandria Drive SW 30331 | yes |
| 42 | 1940 Fremont St SE Atlanta, GA 30315 | **no** |
| 41 | 1385 Nash Road NW Atlanta, GA 30331 | **no** |
| 40 | 944 Joseph E Boone Blvd NW Atlanta, GA 30314 | **no** |

The property you text most in the world - 88 times - isn't in your properties
table. And only 5 of the 10 that *are* in Airtable show up in your texts at all.

I've written up all 75 with how often you've texted each one, so you can confirm
or delete rather than typing them out. The ones I spotted in your texts are marked
as such, so you can tell them apart from your Airtable ones.

**Also:** rent, bedrooms, application fee, pet policy, requirements - those columns
exist in Airtable but were never filled in. Where does that information live for
you day to day?

---

## Twelve people I couldn't pin down

Twelve of your contacts are saved in Quo under **two or more different voucher
sizes** - a 3-bed in one saved name and a 4-bed in another, that sort of thing. I
didn't want to pick one for you: voucher size decides which properties I suggest,
so a wrong guess would quietly cause problems for months.

They're the **first twelve rows** of the contacts file, with the voucher size left
**blank** and every version of the name you had saved shown alongside. Just fill in
the right one.

**Two of them are worth a conversation rather than just a number:**

- **HC-0002** - this is *one phone number* saved under six different names (June,
  Sam, Davis, "there") with four different voucher sizes, and 157 messages on it.
  Is that a household sharing a phone? A number that got reassigned? An office
  line? The new system keeps one person per phone number, so I need to know what
  this actually is.
- **HC-0005** - three spellings of what might be the same name (`Mohammed Katib`,
  `mohammed grady`, `Muhammad Khateeb`), a caseworker note, and three voucher
  sizes across 53 messages. My guess is this is a **caseworker whose number covers
  several different clients**. If that's right, and if you have more like this, we
  should sort out how to handle it before Monday - one phone number can only be one
  person right now.

---

## Things you should know

### Your photos don't come across

This is the one genuinely disappointing thing. **Quo's export doesn't include any
of the images** - there's no place in the file where they would even go. About 694
of your messages are photo sends with no text, and those images are gone.

**Call recordings and voicemail transcripts are the same** - the export has only
who called, when, and how long.

If any of those photos matter - property pictures you sent, documents tenants sent
you - they may still be on your phone, and it's worth grabbing them **before Quo
gets switched off**. Once it's off, they're not recoverable.

### Your naming habits did a lot of work

You've been putting the voucher size in the contact name (`-3bed`, `- 2 Bed`) and a
🤝 in front of some landlords. You probably did it just to keep yourself straight,
but it meant I could pull **voucher sizes for 478 people** and identify most of
your landlords automatically, without you typing anything.

That's genuinely the reason this import is in good shape rather than a mess. It also
means the spreadsheets should look familiar - they're mostly your own shorthand,
tidied up.

### The spreadsheets are yours to overrule

Everything in them is my best guess, not a decision. If you change a name, a voucher
size, or say someone's a landlord rather than a tenant, **that's what goes in.** If
someone shouldn't come across at all, put a `Y` in the **drop** column.

**Which columns are yours to edit:**

| Column | Yours? | What it's for |
| --- | --- | --- |
| `name` `type` `voucher_beds` `status` | **edit these** | My best guess. Correct anything I got wrong. |
| `drop` | **edit this** | Put `Y` here if someone shouldn't come across at all. |
| `notes` | **edit this** | Anything you want to tell me about that person. |
| `needs_your_input` | leave it | Says `YES` on the rows I'd like you to check. |
| `change` | leave it | Mine, for tracking. When I refresh the file it'll say `new` or `unchanged` so I can see what moved - nothing for you to do. |
| `why` | leave it | Why I flagged the row. |
| `phone` `last_contact` `messages` `calls` | leave it | Just so you can tell who it is. |
| `quo_names_seen` | leave it | Every version of the name you had saved in Quo, so you can see why I asked. |
| `airtable_program` `airtable_caseworker_org` `airtable_note` | leave it | Copied across from Airtable so it's all in one place. |

A few practical notes:

- **You only need to take a hard look at the 117 rows marked `YES`** in the "needs
  your input" column. They're sorted to the top. The rest is a lighter lift.
- **Please don't edit the first column** (`row_key`, things like `HC-0001`) - that's
  how I match your answers back up.
- If you open it in Excel, the **phone numbers may lose their leading `+`**. That's
  expected and completely harmless - I don't rely on that column.
- **Start whenever you like.** Even though I'll take a fresh export on Sunday, your
  answers carry forward automatically. You won't be asked anything twice - the
  second pass only shows people who are genuinely new, probably 20 or 30 of them.

### Your affordableplacements email address

You've given out **Sam@affordableplacements.com** in at least 24 of your texts, so
some tenants and landlords have it.

The new system sends and receives email on its own address. **Anything sent to
your affordableplacements address won't reach it** - it'll keep landing wherever
it lands today, invisible to the system and to anyone else on the team.

Two questions:

- **Do you want to keep using that address**, or move over to the new one?
- Either way, **should I forward it** into the new system, so replies from people
  who already have it don't get missed?

Forwarding is easy to set up and means nothing falls through the cracks. I just
need to know whether you want it.

### A couple of smaller things

- **Did anyone else send texts from Quo?** The export shows just you and one number.
  If anyone else was texting tenants from their own phone or login, those
  conversations aren't in what I have.
- **Landlords vs property managers.** I see names like `BNS Property Management`,
  `Leora PM`, and `Lolita Property Manager`. Do you deal with owners, managers, or
  both - and when you pick up the phone, who are you actually calling?
- **Some landlord numbers have several names.** In Airtable, `+1 404-918-8226` is
  saved as `Raj`, `Kristy`, and `Natraj Subramaniam`. Same person? Colleagues
  sharing a line? An office?

---

Thanks Sam - and genuinely, the data is in better shape than most. The naming
habits made a real difference.
