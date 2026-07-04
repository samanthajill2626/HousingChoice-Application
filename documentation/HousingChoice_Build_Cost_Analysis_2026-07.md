# Build Cost & Effort Analysis — Housing Choice Platform (Current Codebase)

**Project:** Housing Choice — SMS/MMS/Voice relay communications platform, navigator dashboard, and AWS infrastructure
**Prepared:** July 3, 2026
**Supersedes (for scope):** `HousingChoice_AI_vs_Traditional_Build_Cost_Memo.md` (June 13, 2026), which priced an early ~17k-line slice. This document re-runs the analysis against the **current, measured codebase**, which is roughly **8× the scope** of that first memo.

---

## Bottom line

> **Built conventionally to the quality bar this codebase actually meets, this platform represents ~38–50 person-months of engineering — roughly 6,500–8,500 skilled labor-hours, or a 5–7 person team for ~7–10 calendar months.**
>
> - **Offshore / outsourced team (the "normal" build), to this same quality bar:** **~$250k–$450k** and **~8–12 months**. (A *cheap* offshore bid comes in lower — ~$80k–$160k — but only by silently cutting the tests, infrastructure-as-code, and security work that make this codebase what it is. You would not get this system.)
> - **AI-enabled US development shop** (small senior team, AI used to ideate/build/test): **~$90k–$220k** (central ~$150k) and **~2.5–4 months** — comparable-to-lower total cost than full-quality offshore, delivered 2–3× faster, onshore, same-timezone, with the quality controlled directly.
> - **What it actually cost (reality anchor):** one founder-operator + Claude Code produced this in ~3–4 focused weeks for **~$0.5k–$2k of out-of-pocket tooling/cloud spend** — roughly **a 12–15× compression of human labor** and a **~99% reduction in cash cost** versus the full-quality offshore build.

The savings are not from cutting corners. They come from **inverting the cost structure**: in conventional development, salaried labor is ~95% of the bill. AI collapses the implementation grind, leaving the irreducible human work — architecture, data modeling, security/compliance judgment, and verification — which one skilled operator can carry.

---

## What was built (measured scope basis)

Every figure below is measured from the current repository, not estimated. This is the *full* quality bar — the tests, infrastructure-as-code, provider simulator, and security work that low-cost bids typically omit.

| Artifact | Measured |
|---|---:|
| Production code (TypeScript/TSX: backend + dashboard + simulator) | **~66,750 lines** |
| Test code (151 backend + ~103 dashboard unit/integration + 28 e2e specs) | **~68,700 lines** (≈ **1:1** test-to-code) |
| Total hand-written application code | **~135,000 lines** across **6 workspaces** |
| Infrastructure-as-code (Terraform, dev + prod) | **13 modules**, 42 files, ~2,500 lines |
| Data model | **18 DynamoDB tables**, **~34 GSIs**, streams + TTL |
| API surface | **~142 route handlers** across 23 route files |
| Documentation | **201 markdown files**, ~35,000 lines (runbook, 6 sequence diagrams, glossary, status model, A2P compliance, ADRs) |
| Tracked issues (in-repo registry) | 78 triaged items (schema'd frontmatter, derived index) |
| Version-control history | **937 commits** over **23 calendar days**, conventional commits, **35 feature branches**, 78 merges |

### Subsystems (not a CRUD app)

**Backend (~39k LOC, 118 files):** Google OAuth with PKCE + invite-gated access + RBAC; AES-256-GCM **sealed-cookie sessions with server-side epoch revocation**; layered CSRF/origin controls; a 17-repo DynamoDB data layer using conditional writes, optimistic-concurrency version guards, and claim-item locks; Twilio **SMS** integration with HMAC signature validation and persist-at-send dedupe; a **masked-calling voice** subsystem (whisper + press-1 gate, recording pipeline, SSRF-guarded media); an **SMS relay / group-messaging** engine with a pool-number lifecycle state machine, two-layer fan-out idempotency, and a per-recipient error taxonomy; a **placement pipeline** with a 17-stage status model, atomic tour→placement conversion (sentinel-claim + compensation chain), and stage-guarded writes; a **scheduling/deadline/reminder** system with deterministic-id idempotent deadlines, claim-before-send exactly-once semantics, and dual SQS/EventBridge delay routing; broadcasts, activity/audit trails, a merged contact timeline, web push, rate limiting, SSE live updates, OTLP observability, and an **A2P/TCPA compliance layer** (consent state machine, number-scoped opt-out, JIT consent, kill-switch) enforced structurally through a single send wrapper.

**Frontend (~24k LOC, ~89 components):** a hand-rolled React 18 dashboard — inbox/conversation hub with live SSE timelines, a deep contact-detail surface (~40 components), a drag-and-drop placement board with gated transitions and stage-data recorders, a two-step broadcast composer with live reach preview, tours, listings, role-guarded settings, masked in-app calling, and public intake pages.

**Test & QA engineering (~69k LOC):** a **from-scratch Twilio simulator** (SMS/MMS delivery engine **and** a deterministic voice CallEngine + TwiML interpreter, with its own 26-file test suite and a React operator UI); a Playwright e2e harness with a **hermetic stack, 16-lane port isolation, and per-lane DynamoDB access keys**; a **3,045-line diagram-driven test DSL** whose verbs map 1:1 to the mermaid sequence diagrams; and ~254 unit/integration test files including real-DynamoDB concurrency, idempotency, and drift-alarm tests.

**Infrastructure & ops:** 13 Terraform modules across separate dev/prod environments (VPC, EC2, ECR, CloudFront, ACM, SES, DynamoDB, SQS, Parameter Store, observability, budgets); tag-based deploy with rollback; guarded secrets tooling; 14 CloudWatch alarms; and a **~76 KB operator runbook** with per-alarm response playbooks.

### Independent quality read

A multi-agent code review of this repository characterized the engineering as **"senior-to-staff level"**: `strict` + `noUncheckedIndexedAccess` TypeScript with **zero real `any`** in ~79k LOC, **114 `ConditionExpression` concurrency guards**, idempotency reasoned end-to-end (webhook-echo dedupe, SQS at-least-once execution markers written before side effects), correct sealed-cookie session crypto, pervasive PII discipline enforced by a custom lint rule, and only **5 tracked TODOs** across the entire codebase. The hardest subsystems (relay/group messaging, tour→placement conversion, scheduling) were rated *very hard / hard* — the kind of distributed-systems correctness that a competent team gets wrong before it gets it right.

**The implication for cost:** the scarce, expensive competence here is not typing speed — it is the systems judgment encoded in these choices (DynamoDB consistency semantics, TCPA/A2P constraints, telecom failure modes, cookie cryptography). That decision layer is exactly what a conventional team must re-derive, and exactly what commands senior rates.

---

## Effort estimate: building this "properly," from zero

Estimated **bottom-up by subsystem** (person-weeks of a competent professional building to this quality bar, including their own testing), then cross-checked against scope. A person-week = one engineer for ~40 hours.

| Workstream | Person-weeks |
|---|---:|
| Backend — auth/session/security, 17-repo data layer, SMS, **relay (very hard)**, **voice (hard)**, **placements (hard)**, **scheduling (hard)**, jobs, broadcasts, activity/audit, A2P/compliance, rate-limit/push/SSE/observability, 142-route API | ~54 |
| Frontend — foundations/design system, inbox, contact detail, placement board, broadcasts composer, tours, listings, settings, public, voice UI | ~34 |
| Test engineering — the Twilio simulator, the e2e harness + lane isolation, the diagram-driven DSL + 28 specs, concurrency/integration depth | ~22 |
| Infrastructure & DevOps — 13 Terraform modules × dev/prod, deploy/secrets tooling, observability wiring, runbook | ~12 |
| Architecture, data modeling, sequence/spec design, security & A2P research | ~6 |
| **Hands-on subtotal** | **~128** |
| Team overhead (integration, code review, rework, coordination) at ~20% | ~26 |
| **Total** | **~154 person-weeks** |

**Headline (proper conventional build):**
- **Effort: ~6,500–8,500 skilled labor-hours (~38–50 person-months), central ~7,200 hours / ~40 person-months.**
- **Calendar: ~7–10 months with a 5–7 person team.** (A *single* conventional developer would need on the order of **~2–3.5 years**.)

> **A note on line-count cross-checks.** A naïve lines-of-code productivity model (delivered, tested, reviewed code per developer-day) applied to ~135k lines lands *higher* than this bottom-up estimate — a reminder that (a) LOC estimation is notoriously unreliable, and (b) much of this volume is the unusually high 1:1 test ratio and dense inline rationale. We use the bottom-up figure as the honest number and treat the LOC method only as a sanity ceiling. Either way, the direction is the same: this is a multi-quarter, multi-person conventional build.

---

## The three delivery scenarios

Human labor is the only material line item in every scenario; the approaches differ in **rate** and in **how many hours the work actually takes**.

### 1. Offshore / outsourced team — the "normal" build

| | |
|---|---|
| **Team** | 5–8 (offshore devs + lead + QA + PM) |
| **Effort to this quality bar** | ~7,500–9,500 hours (base effort + 20–30% rework, building to a spec they did not author) |
| **Blended billed rate** | ~$35–50/hr (dev $25–45 + loaded lead/QA/PM) |
| **Cost (full quality bar)** | **~$250k–$450k** (central ~$320k) |
| **Calendar** | ~8–12 months (coordination + timezone drag) |

**The important caveat:** offshore is chosen because it is cheap, and a typical low-cost bid for "a texting app with a dashboard" would quote **~$80k–$160k**. That number is real — but it buys a happy-path application with thin tests, minimal infrastructure-as-code, and little of the security/compliance/concurrency work. It would **not** reproduce this codebase. The ~$250k–$450k figure is what it costs offshore to hit *this* bar, and rework risk (20–40%, building blind to intent) is highest here.

### 2. AI-enabled US development shop

| | |
|---|---|
| **Team** | 1–3 senior, AI-fluent operators |
| **Effort (human hours)** | ~800–1,500 hours — AI collapses the implementation grind; client-engagement overhead (comms, handoff, docs, QA-for-client) does not compress as far as a solo founder's |
| **Blended rate** | ~$100–175/hr (senior US, AI-leveraged) |
| **Cost** | **~$90k–$220k** (central ~$150k) |
| **Calendar** | ~2.5–4 months |

This is the standout commercial option: **at or below the cost of a full-quality offshore build, delivered 2–3× faster**, onshore and same-timezone, in native English, with quality demanded and verified directly rather than hoped for in a bid. Against the *cheap* offshore bid, it is modestly more expensive but delivers a categorically better system.

### 3. Reality anchor — founder + Claude Code (what actually happened)

| | |
|---|---|
| **Team** | 1 founder-operator |
| **Effort (human hours)** | ~400–600 focused hours over ~3–4 weeks (937 commits, 23 calendar days) |
| **Cash outlay** | **~$0.5k–$2k** — Claude Code subscription + AWS dev + Twilio + domain |
| **Metered-model equivalent** | ~$3k–$8k if the same work were billed at pay-as-you-go API rates (given the subagent/workflow volume) — still a rounding error |
| **Opportunity cost of founder time** | ~$60k–$90k if valued at senior US rates — but **out-of-pocket ~$1–2k** |

**Leverage realized:** ~7,200 conventional labor-hours compressed into ~500 human hours ≈ **~12–15× labor compression**, at **~99% lower cash cost** than the full-quality offshore build. This exceeds the original June memo's ~10–20× / ~96% claim, because the scope that compressed is larger and now includes the hard distributed-systems and test-harness work that AI accelerated most.

---

## Side-by-side

| | Offshore team (full bar) | AI-enabled US shop | Founder + Claude Code (actual) |
|---|---|---|---|
| **People** | 5–8 | 1–3 senior | 1 |
| **Human effort** | ~7,500–9,500 hrs | ~800–1,500 hrs | ~400–600 hrs |
| **Calendar** | ~8–12 months | ~2.5–4 months | ~3–4 weeks |
| **Cash cost** | **~$250k–$450k** | **~$90k–$220k** | **~$0.5k–$2k** |
| **Quality control** | Hope the bid includes tests + IaC + security | Operator demands & verifies directly | Operator demands & verifies directly |
| **Rework risk** | 20–40% (builds blind to intent) | Low | Low (continuous review in-loop) |
| **Timezone / language** | Offset, translated | Onshore, native | Onshore, native |

---

## Why this works — and what it requires

The leverage is real, but it is **not automation-for-anyone**. The compression is unlocked by a skilled operator, not by the absence of skill:

- **Architecture and decisions still belong to a human.** The data model, security posture, compliance strategy, sequence diagrams, and phased plan were *directed*, not generated blindly. The six sequence diagrams and the status-model spec are where the intellectual work lives — the code is downstream of them.
- **Quality is a choice that must be enforced.** AI will ship an untested happy path if not steered. The 1:1 test ratio, the provider simulator, the Terraform, and the A2P hardening exist because they were **demanded and verified** — visible in the 89 dedicated test commits and 204 docs commits.
- **Fixed costs don't compress either way.** A2P/carrier approval, AWS account setup, DNS/TLS, and human decision time are the same regardless of method — and gate the calendar more than coding does.

**Net effect:** the implementation grind that consumes a conventional team's salaried months is absorbed by the AI, and one person operating at ~12–15× leverage produces equivalent — and independently verified as senior-to-staff-grade — quality.

---

## Assumptions & method

- **Scope basis:** a faithful rebuild of exactly what exists in the repository today (measured), at the same quality bar. Not priced: unbuilt Phase-1 items (bulk data import, production cutover, some pre-go-live ops) and future phases (expanded voice, later roadmap).
- **Effort:** bottom-up per-subsystem estimation by a competent professional including their own testing, plus 20% team overhead; cross-checked against measured scope. Difficulty weightings reflect an independent multi-agent code assessment of this repository.
- **Rates:** standard 2026 market ranges — offshore blended $35–50/hr; senior US AI-fluent $100–175/hr. Cost ranges are intentionally wide to reflect genuine market variance.
- **Reality-anchor cash figures:** founder subscription + measured dev-environment cloud/Twilio/domain spend (dev idle ≈ $33–34/mo per the cost doc). Human-hour figure inferred from commit cadence over the 23-day window; treat as an order-of-magnitude estimate, not a timesheet.

*Figures are grounded in the actual current codebase metrics and standard industry productivity and rate ranges. The traditional estimate assumes a competent team building to the same quality bar — tests, infrastructure-as-code, provider simulation, and security/compliance review — not a corner-cutting bid.*
