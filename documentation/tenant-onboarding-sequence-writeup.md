# Tenant Onboarding Sequence — Overview (Phase 1)

Companion notes for `tenant-onboarding-sequence.mermaid`. This explains how a prospective tenant gets from first contact to the point where we can hand them off to unit matching. It covers Phase 1 only: the app handles deterministic, repeatable steps automatically, while Sam handles the actual communication.

## How to read the diagram

The diagram has three participants:

- **Tenant** — the prospect.
- **Housing Choice App** — owns the phone number and sits in the middle of every exchange.
- **Sam** — the housing coordinator.

The key design rule is that **the app owns the phone number, so every message flows Tenant → App → Sam and back.** The tenant and Sam never contact each other directly; the app logs, stores, and relays each message. That is why most steps appear as a pair of arrows — one inbound to the app, one relayed out.

Notes on the app carry one of two tags:

- **[AUTO]** — the app does this automatically (logging an inbound text, sending auto-replies, creating a contact from a portal submission).
- **[MANUAL]** — a person (Sam) does this by hand today, such as saving the contact or recording intake answers. These are the natural candidates for automation later.

## The flow, stage by stage

### 1. Inbound — three ways in

A prospect can enter onboarding three ways. All three converge on the same state: a contact exists, it is marked as a Tenant, and the process has started.

**By text** — Having seen a listing on affordablehousing.com, the tenant texts to ask if it is still available. The app logs the text and creates a contact, then relays it to Sam. Sam replies that the unit is no longer available and asks for the prospect's full name, voucher size, and housing authority, which the app delivers.

**By phone call** — The call hits the app's number. Sam does not pick up, and the app sends an automatic reply text asking for the same three details.

In both the text and phone cases, the tenant then texts back their name, voucher size, and housing authority; Sam saves the contact and marks it as a Tenant (**[MANUAL]**), and the details are relayed to her.

**In person (housing fair)** — The goal is to house the person the same day: match each person to a specific property, which a landlord shows them (or they visit on their own) that day. The contact is created one of two ways — Sam sits down with them and enters their details on the new contact page (**[MANUAL]**), or the tenant fills in their own details through a self-serve portal that comes in as a contact (**[AUTO]**). Either way, the app fires an automatic text to start the process (**[AUTO]**).

### 2. Eligibility intake

Once a contact exists, Sam asks a deliberately narrow set of questions, relayed through the app: pets, evictions, and how long they have been at their current place — used for LIF eligibility. She then asks the qualifying question: do they have an RTA in hand (the paperwork required to move forward)? The app stores the answers and sets the LIF-eligibility and RTA flags.

### 3. RTA decision gate

This gate decides whether onboarding continues:

- **RTA in hand** → hand off to the separate **Send Unit** sequence, which handles matching them to listings.
- **No RTA in hand** → we cannot meaningfully help yet, so the lead is parked until they have an RTA in hand.

## Worth calling out

- The app is the system of record for all communication — nothing is one-to-one between Tenant and Sam.
- An RTA in hand is the hard requirement to proceed; without it, the lead is parked.
- The eligibility questions are intentionally narrow and tied to LIF.
- Same-day placement is the in-person goal, which is why the housing-fair path is built for speed.

## Scope

This diagram stops at the handoff. Showing units, collecting feedback, recording preferences, and arranging tours live in the separate **Send Unit** sequence. Phase 1 assumes the app handles the deterministic steps (**[AUTO]**) while Sam handles the conversations and the steps still marked **[MANUAL]**.
