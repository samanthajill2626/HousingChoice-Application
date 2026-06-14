# Build Cost Comparison: AI-Assisted vs. Traditional Development

**Project:** Housing Choice — SMS Relay Web Application & AWS Infrastructure
**Prepared:** June 13, 2026
**Subject:** Cost and timeline of building the Phase 1 codebase with AI assistance vs. commissioning it the traditional way

---

## Bottom line

> **The Phase 1 codebase — ~$30k–55k of contracted work — was reproduced for roughly $1k–2k in tooling and cloud costs: a ~96% cost reduction (~$40k avoided), delivered in comparable or shorter calendar time by one person instead of a team.**

The savings do not come from cutting quality. They come from **inverting the cost structure**: in traditional development, salaried labor is 95%+ of the bill. AI assistance collapses the implementation labor, leaving only the irreducible human work of architecture, review, and integration — which one skilled operator can carry.

---

## What was built (scope basis)

A production-grade Node.js/TypeScript application, fully tested and deployed via infrastructure-as-code:

- **~17,000 lines of source code** (9.8k production / 7.3k tests — a **0.74:1 test-to-code ratio**)
- Backend: auth (OAuth, sessions, CSRF, invite-based access, role control, session revocation), DynamoDB data layer, Twilio SMS integration (webhooks, signature validation, A2P), SQS job pipeline, web push, observability
- Frontend: React conversation-hub dashboard
- Infrastructure: 13 Terraform modules across dev + prod (networking, EC2, CloudFront, DynamoDB, SES, SQS, budgets, observability)
- Operational tooling, runbook, and security hardening

This is the *full* quality bar — the tests, infra-as-code, and security work that low-cost bids typically omit.

---

## Side-by-side comparison

| | Traditional overseas team | AI-assisted build |
|---|---|---|
| **People** | 2–3 (devs + lead/QA) | 1 capable operator |
| **Total effort** | 4–7 person-months | ~150–300 focused human-hours (~1 person-month) |
| **Calendar time** | ~2.5–4 months | ~6–12 weeks |
| **Total cash cost** | **$30k–55k** | **~$1k–2k** (founder-operated) |
| **Quality control** | Hope the bid includes tests & IaC | Operator demands and verifies it directly |
| **Rework risk** | 20–40% (team builds blind to spec) | Low (continuous review in the loop) |

*Paid alternative:* If the work were done by a hired AI-fluent contractor rather than the founder, cost would be **~$16k–42k** — still 25–50% below the traditional bid, because one leveraged person replaces a team. Labor remains the only meaningful line item.

---

## Cost breakdown (founder-operated)

| Component | Cost |
|---|---:|
| Human labor | $0 cash (opportunity cost only) |
| Claude Code (Max subscription, 2–3 months) | ~$400–600 |
| AWS + Twilio + domain (dev environment) | ~$150–900 |
| **Total cash outlay** | **~$1k–2k** |

On pay-as-you-go API pricing instead of a subscription, model spend might reach ~$1k–3k — still a rounding error against traditional labor.

---

## Why this works — and what it requires

**The leverage is real, but it is not automation-for-anyone.** The 96% saving is unlocked by a skilled operator, not by the absence of skill:

- **Architecture and decisions still belong to a human.** Data modeling, security posture, and the phased build plan were directed, not generated blindly.
- **Quality is a choice that must be enforced.** AI will ship an untested happy path if not steered. The test ratio, Terraform, and security hardening exist because they were *demanded and verified*.
- **Fixed costs don't compress either way.** A2P approval, AWS account setup, and human decision time are the same regardless of method — and gate the calendar more than coding does.

**Net effect:** the implementation grind that consumes a traditional team's salaried months is absorbed by the AI, and one person operating at ~10–20× leverage produces equivalent — and verifiably high — quality.

---

*Figures are grounded in the actual Phase 1 codebase metrics and standard industry productivity and offshore-rate ranges. Traditional estimate assumes a competent overseas team building to the same quality bar (tests + infrastructure-as-code + security review).*
