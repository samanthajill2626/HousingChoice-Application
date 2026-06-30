# Sending Unit Sequence — Overview (Phase 1)

Companion notes for `sending-unit-sequence.mermaid`. This is the second stage of the tenant journey. It picks up after onboarding — once a tenant has an RTA in hand and has been handed off from the **Tenant Onboarding** sequence — and its job is to find a listing the tenant actually wants. It ends by handing off to the separate **Tours** workflow. As elsewhere in Phase 1, the app handles deterministic steps automatically and the team handles the communication.

## How to read the diagram

Three participants, same as onboarding:

- **Tenant** — the prospect, now an active, RTA-ready tenant.
- **Housing Choice App** — owns the phone number and relays every message.
- **Team** — the housing coordinators.

The same relay rule applies: **the app owns the phone number, so every message flows Tenant → App → Team and back** — the two never message each other directly. Notes on the app are tagged **[AUTO]** (the app does it automatically) or **[MANUAL]** (the team does it by hand today).

## The flow, stage by stage

### 1. Starting principle — show first, capture preferences from feedback

The defining rule of this stage is that **preferences are captured from feedback, not asked upfront.** The team is not the tenant's personal shopper: rather than interview them about what they want, the team sends a real listing and learns their preferences from how the tenant reacts to it.

### 2. The matching loop

The core of the sequence is a loop that repeats until a listing fits:

1. **The team sends a specific listing** for feedback, and the app delivers it to the tenant.
2. **Optionally, the tenant shares preferences** in response — for example, no stairs (because of a walker), near MARTA, near their kid's school, or must fit a king bed. When they do, the app saves those preferences to the tenant's profile so they are remembered for future matches (**[MANUAL]**), and relays them to the team.
3. **The team finds another match**, and the app returns the next matching listing.

The loop then repeats, with each pass informed by any preferences captured so far, until a listing fits.

### 3. Exit — hand off to Tours

Once a listing fits, the sequence hands off to the separate **Tours** workflow, where the tenant arranges to see the unit.

## Worth calling out

- **Show first, ask later.** Preferences come from reactions to real listings, not an upfront questionnaire — this is the deliberate "not a personal shopper" approach.
- **Preferences persist.** Anything the tenant tells us is saved to their profile and shapes every later match, not just the next one.
- **Feedback is optional each round.** The loop still advances even if the tenant does not volunteer any preferences on a given listing.
- **Everything routes through the app**, consistent with the rest of the system.

## Scope

This diagram covers only the listing-and-feedback matching loop. Getting the tenant to this point (intake and the RTA check) lives in the **Tenant Onboarding** sequence, and actually visiting a unit lives in the separate **Tours** workflow.
