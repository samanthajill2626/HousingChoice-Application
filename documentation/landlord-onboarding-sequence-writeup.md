# Landlord & Unit Onboarding Sequence — Overview (Phase 1)

Companion notes for `landlord-onboarding-sequence.mermaid`. This is the supply-side
counterpart to Tenant Onboarding: it takes a landlord from first contact through a signed
contract, a short onboarding call, and a property (unit) intake, ending with an **available
unit** ready for matching. Landlord onboarding and unit onboarding are deliberately blended —
the same conversation that onboards the landlord also captures their property. As elsewhere in
Phase 1, the app handles deterministic steps automatically and the team handles the
communication.

## How to read the diagram

Three participants, same relay model as the other sequences:

- **Landlord** — the supply-side contact (an owner or property manager).
- **Housing Choice App** — owns the phone number and relays every call/text.
- **Team** — the housing coordinators.

The relay rule applies to the **phone number**: every call/text flows Landlord → App → Team
and back — the two never contact each other directly on that line. Notes on the app are tagged
**[AUTO]** (the app does it automatically) or **[MANUAL]** (the team does it by hand today).

**One channel exception:** the **welcome email and DocuSign contract are a separate channel,
outside the app** in Phase 1 — the team runs them with external tools, so they show as direct
Team ↔ Landlord steps. (Email is a likely future in-scope channel — see
`docs/issues/email-as-first-class-channel.md`.)

## The flow, stage by stage

### 1. First touch — two ways in

**Outbound cold call.** The team sources a lead on affordablehousing.com (a number, maybe a
name or company, and a property address) and cold-calls with the non-exclusive
tenant-finding pitch and the voucher-holder demand they can bring. If the landlord is
interested, the team creates the landlord contact and marks the lead interested. If they
decline, the team logs the reason (e.g. commission too high, or a PM rather than the owner)
and **parks** the lead.

**Inbound text.** A landlord texts in first. The app logs the inbound and creates an unknown
contact; the team qualifies by asking for the property address (is it worth the time?). If it
is, the team triages the contact to Landlord and marks it interested; if not, the team logs the
reason and **parks** the lead.

Both paths converge on scheduling the ~10-minute onboarding call.

### 2. Welcome & contract — sales-first

The defining change from the old process: **the salesy part comes first.** Before onboarding
any details, the team sends the welcome email and the DocuSign contract (the separate channel
above). If the landlord signs, the team records the contract as signed; if they never sign, the
lead is **parked**. Only after the contract is in hand do we spend time on onboarding.

### 3. Onboarding call (~10 minutes)

A short, team-led call captures the landlord and deal terms — the data source is the call
itself (Phase 1: the team records it). The checklist: voucher size needed, expected rent,
utilities the tenant is responsible for, hold fee / deposit / LIF, tour-coordination logistics,
communication preferences (text preferred; explain the group text), whether they are a
registered landlord, confirmation they will submit the RTA within 48 hours, and confirmation
they will pass inspection on the first try. The team also captures the landlord's **approval
criteria** — how they treat evictions, utility debt, credit, and references, plus their income
rules (the voucher itself counts as income) — which later feed the matching engine. All of it
is saved to the landlord record.

### 4. Property & unit intake

The property details are captured — **often via text/MMS, but not exclusively** (they can also
come on the call). This runs as a loop until the unit record is complete: the landlord sends
address, photos/video, beds/baths, whether a bedroom fits a king bed, a Zillow link, and the
voucher size the unit accepts (e.g. a 3bd/2ba that takes a 2BR voucher); the app logs the
inbound and attaches the media; the team creates or updates the unit record and follows up for
anything missing. Once complete, the team publishes the unit (marks it available) and the app
makes the shareable **listing link** available (address, beds/baths, sq ft, w/d hookups, app
fee, qualifications, photos/video, exterior photo).

### 5. Exit — hand off to matching

Onboarding is done once the unit is **available**. It hands off to **Property Sharing &
Matching** — the unit surfaces to qualifying tenants (the separate **Sending Unit** sequence).
The team's next contact with the landlord is **Tours** (also separate).

## Worth calling out

- **Sales-first, then details.** Prove the value and get the contract signed before spending a
  ~10-minute call onboarding the landlord and unit. This is a deliberate flip of the older
  "everything on one call" approach.
- **Email & DocuSign are external in Phase 1.** DocuSign is fine to keep external for now;
  email is expected to become an in-scope channel later (tracked separately).
- **`[AUTO]` is intentionally minimal.** Only deterministic app behavior is automated — logging
  an inbound text, creating the unknown contact, attaching MMS media, and exposing the listing
  link on publish. The calls, triage, checklist capture, and contract recording are all
  `[MANUAL]` team work in Phase 1.
- **Blended onboarding.** One flow onboards both the landlord (terms + approval criteria) and
  the unit (property intake), because they come from the same conversation.
- **Everything routes through the app** (the phone line), consistent with the rest of the
  system — except the email/DocuSign channel.

## Scope

This diagram covers landlord onboarding through a first available unit. Getting that unit in
front of tenants (matching and share → react → refine) lives in the **Sending Unit** sequence;
tours live in the separate **Tours** workflow; the Section 8 approval process comes later. The
DocuSign e-sign integration and email-as-a-channel are out of scope for this diagram (email is
tracked as a future addition).
