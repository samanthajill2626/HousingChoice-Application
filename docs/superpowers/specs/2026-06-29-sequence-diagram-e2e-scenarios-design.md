<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed task, merged to `main` (2026-06-29).** This document
> describes the sequence-diagram→e2e scenario suite (tenant onboarding) as *designed at the
> time of writing*. The work shipped to `main` (merge `964c87e`): the `e2e/scenarios/steps.ts`
> vocabulary, the `fakeVoice` fixture, the tenant-onboarding scenario suite, structured contact
> intake fields, and a reseed/session-epoch-cache fix. **This file is NOT current documentation
> and may have drifted from the live code. Do not treat it as authoritative guidance on how the
> system is built or behaves today.** For current truth read the code and the living docs —
> especially the playbook `documentation/sequence-diagram-to-test.md`, plus `e2e/README.md`.
> Kept only as a point-in-time record of intent.
# Sequence-diagram → e2e scenario suite — design

**Date:** 2026-06-29
**Status:** Approved (brainstorming) — ready for implementation plan
**Source diagrams:** [`documentation/tenant-onboarding-sequence.mermaid`](../../../documentation/tenant-onboarding-sequence.mermaid)
(+ companion [`tenant-onboarding-sequence-writeup.md`](../../../documentation/tenant-onboarding-sequence-writeup.md))

## Goal

Turn each behavioral **sequence diagram** in `documentation/` into a runnable
end-to-end integration test, so we can prove the real flow works against the
local `--mock --local` stack. Tenant onboarding is the first; sending-unit, tours,
and future diagrams follow the **same repeatable method**, which we capture as a
playbook once tenant-onboarding is green.

This serves two purposes at once:
- **Regression protection** — lock in the behavior that works.
- **Gap discovery** — a diagram step the app can't yet satisfy is a real assertion
  that **fails red**, naming a feature we then build. We do not tag steps as
  "pending"; everything in a diagram is expected to be implemented, and a failing
  assertion *is* the signal to build the missing piece.

## Non-goals

- No machine-readable/parsed mermaid, no DSL, no generator. The diagram stays
  human-owned documentation; the test is written to match it by hand.
- No new CI wiring (the harness is already CI-ready; that's a separate decision).
- No relabeling of the `.mermaid`/writeup source files in this work (they still
  say "Sam"). A later pass may relabel them; out of scope here.

## Terminology in tests: "Team", never "Sam"

The diagram's coordinator participant is the founder ("Sam"), but **the test
framework never uses that name.** The coordinator role is **Team**, backed by the
seeded VA dev-login (`va@example.com`). All vocabulary and copy use `team*`
(`teamReplies`, `teamSavesContact`, …). The three test-facing actors are:

- **Tenant** — the prospect. Acts via the fake-twilio party seam (inbound SMS/calls).
- **App** — the system under test (the real backend + dashboard).
- **Team** — the coordinator. Acts by **driving the real dashboard UI**.

## Architecture — three layers

```
diagram (.mermaid + writeup)                 ← source of intent, human-owned
   │  mapped 1:1, by hand
scenario spec   e2e/tests/scenarios/tenant-onboarding.spec.ts
   │  written purely in verbs from ↓
step library    e2e/scenarios/steps.ts       ← the diagram vocabulary (new)
   │  wraps ↓
existing fixtures  fakeTwilio / outbox / auth / reseed
```

The **scenario spec reads like the diagram**. The **step library is the only new
infrastructure**: it encapsulates the "mostly-UI, API-for-setup" decision and the
recurring relay round-trip, so every additional diagram is cheap to add and new
diagrams mostly reuse existing verbs.

**Fidelity rule (mostly-UI, API for setup):** Team's meaningful in-flow actions
(reply, save contact, record intake, set flags) are driven through the **real
dashboard UI**. The **tenant's** actions (inbound text/call) and pure
setup/teardown (reseed, fake reset, occasionally seeding a pre-existing contact)
use the API directly. Outbound proof-of-send is asserted via the fake-twilio
`listThreads` control surface.

## The step vocabulary

A small, typed set of verbs mirroring the diagram. Each is backed by an existing
fixture. New verbs are added here once and reused across diagrams.

| Verb | Meaning | Backed by | UI / API |
|---|---|---|---|
| `tenantTexts(body)` | inbound SMS from the tenant | `sendAsParty` | API |
| `tenantCalls()` | inbound voice (then no-answer) from the tenant | **new** `fakeVoice` fixture (wraps fake-twilio `voiceControl`) | API |
| `expectRelayedToTeam(phone, body)` | inbound surfaces in Inbox; an **untriaged unknown** is nameless → locate **by phone under the "Unknown" tab**, not by name | dashboard | UI assert |
| `teamReplies(body)` | Team sends from the contact thread | dashboard | **UI** |
| `expectDeliveredToTenant(/re/)` | outbound reaches tenant's fake thread, `delivered` | `listThreads` | API assert |
| `expectAutoReply(/re/)` | the missed-call auto-text fires with **no** Team action; assert the **operator-template body** (requires `missedCallAutoTextEnabled` seeded on) | `listThreads` | API assert |
| `expectUnknownCaptured(phone)` | an inbound from an unrecognized number auto-creates an **unknown** contact (not yet Tenant) | dashboard/API | assert |
| `teamTriagesUnknownToTenant(phone, {…})` | triage the captured unknown → Tenant ("Mark as Tenant" / edit-type change). **Not** "New contact" — that hits the proven 409 since the number already exists | dashboard | **UI** |
| `teamCreatesContact({…})` | New-contact dialog, mark Tenant — **housing-fair in-person path only** (no prior number) | dashboard | **UI** |
| `expectTypedTenant(phone)` | the contact is now typed Tenant | dashboard/API | assert |
| `teamRecordsIntake({pets,evictions,tenure,lifEligible})` | record intake into the **structured intake fields** (to be built — see Decision: structured intake) | dashboard | **UI** |
| `teamRecordsRtaDecision(inHand)` | move the tenant lifecycle status per the RTA gate (there is **no** RTA flag) | dashboard | **UI** |
| `expectParked()` | no-RTA → tenant status `on_hold` (an override/exit state) | dashboard | UI assert |
| `expectHandoffToSendUnit()` | RTA-in-hand → tenant status `searching` (ready for Send-Unit matching) | dashboard | UI assert |

(Exact verb list is a starting point; the conformance audit may add/rename a few.)

**The RTA gate is on the tenant contact's `status`, not a placement.** The tenant
lifecycle is `needs_review → onboarding → searching → placing → placed → on_hold →
inactive` ([statusModel.ts](../../../app/src/lib/statusModel.ts)). RTA-in-hand →
`searching` (the Send-Unit handoff); no-RTA → `on_hold` (parked). The placement RTA
*phase* (`collect_rta…`) is a **separate, later** workflow — do not conflate them.

### Step wrapper

Each verb runs inside a thin `step(name, fn)` helper built on Playwright's
`test.step`, so the trace/report reads as the diagram's narrative
(`Tenant texts in`, `App relays to Team`, …). No pending/annotation machinery —
a verb is an ordinary assertion that either passes or fails.

## One diagram → many tests (alt-path expansion)

The diagram's nested `alt/else` blocks expand to **one `test()` per leaf path**,
all sharing a common intake + RTA-gate tail (written once as a helper). For
tenant-onboarding the leaf paths are:

- `inbound · by text → RTA in hand → handoff`
- `inbound · by text → no RTA → parked`
- `inbound · by phone call → RTA in hand → handoff`
- `housing fair · Team enters details → … (RTA branch)`
- `housing fair · self-serve portal → … (RTA branch)`

Each `test()` is a linear script of vocabulary verbs. The shared tail
(eligibility intake → RTA gate → parked/handoff) is a helper invoked at the end of
each path so it isn't duplicated.

**Isolation (self-clean, NOT per-test reseed):** `/__dev/reseed` wipes the users
table and **breaks the dev-login session**, so no scenario calls it per-test (the
newest spec deliberately routes around it —
[placement-board.spec.ts:13-27](../../../e2e/tests/dashboard-next/placement-board.spec.ts#L13-L27)).
Instead, follow the harness convention:

- **Self-clean with per-run uniqueness** — each scenario uses fresh, timestamped
  phone numbers / names, so it creates its own contacts from its own inbound and
  never collides with prior runs or seeded data.
- **Targeted, session-safe reset** for any seeded entity a scenario must mutate —
  an authenticated `page.request` reset of that one entity (the
  `devLoginAndReset` pattern), never a global wipe.

Because most tenant-onboarding paths originate a brand-new contact from a
brand-new number, they are naturally self-isolating with no reset at all.

## Conformance audit (scoping, before writing the spec)

Before writing `tenant-onboarding.spec.ts`, walk the diagram against the live
`--mock --local` stack and record, **with evidence**, which steps already work and
which need building. Known candidates for gaps (to confirm, not assume):

- Does an inbound from an **unknown** number auto-create an **unknown** contact
  (existing comms specs used a *seeded* tenant), and is the **triage → Tenant** UI
  the expected path (vs. the 409 on "New contact")?
- Does the **ignored-call → auto-text** job fire end-to-end with
  `missedCallAutoTextEnabled` seeded on, and what is the operator-template body to
  assert against?
- The **structured intake fields** do not exist yet (decided to build) — confirm
  the contact schema + edit-form insertion points.
- The RTA gate is a **tenant-status move** (`searching` / `on_hold`) — confirm the
  dashboard affordance that performs it (no RTA flag exists).

The audit's only output is a **scoped gap list**. It does not change the test
structure; missing pieces become normal build tasks.

### Decision: structured intake (build, not customFields)

Eligibility intake (pets / evictions / tenure / LIF-eligible) is recorded into
**first-class structured fields on the contact, to be built** — chosen over
reusing `customFields` so eligibility is reportable/filterable later. The
`teamRecordsIntake` verb writes these fields and the suite asserts them, so
**building the structured intake fields (schema + UI) is an explicit build task**,
not just a test concern.

## Build gaps, then go green

Any feature the audit finds missing is built with the normal TDD workflow until
the flow is fully supported. The scenario is "done" only when
`tenant-onboarding.spec.ts` runs **green end-to-end** against the local stack.

## Verifying the framework itself

A trivial self-check scenario (one verb that passes, one deliberately pointed at
absent behavior to confirm it fails loudly) proves the `step` wrapper and verbs
behave before we rely on them. Kept minimal.

## Deliverables

1. `e2e/scenarios/steps.ts` — the Team-based step vocabulary + `step` wrapper.
2. `e2e/fixtures/fakeVoice.ts` — **new** fixture wrapping fake-twilio
   `voiceControl` (place-call / answer / no-answer) for the by-phone path.
3. `e2e/tests/scenarios/tenant-onboarding.spec.ts` — one `test()` per alt-path.
4. **Structured intake fields** (schema + edit-form UI) — the build task from the
   intake decision above.
5. Whatever else the conformance audit proves missing (separate tasks), plus a
   **settings seed** turning `missedCallAutoTextEnabled` on for the voice path.
6. **Playbook doc** — `documentation/sequence-diagram-to-test.md` (or under
   `docs/`): the repeatable method (read diagram → expand alt-paths → map verbs →
   audit → build gaps → green), written **after** tenant-onboarding is green so it
   reflects what actually worked. Future diagrams follow it.

Existing specs/fixtures are unchanged; the new `fakeVoice` fixture sits alongside
`fakeTwilio` without touching it.

## Workflow summary

1. Build `steps.ts` (Team vocabulary) + `fakeVoice` fixture + trivial self-check.
2. Conformance audit of tenant-onboarding → scoped gap list.
3. Build missing features (TDD) until the flow is supported — known so far:
   **structured intake fields**, `missedCallAutoTextEnabled` settings seed, and
   anything else the audit surfaces.
4. Write `tenant-onboarding.spec.ts` (alt-path per `test()`) → run green.
5. Write the playbook doc capturing the method.
