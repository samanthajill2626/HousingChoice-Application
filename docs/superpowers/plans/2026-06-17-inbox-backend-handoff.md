# Inbox Backend Handoff — Contract C8 / "BE7" (ORCHESTRATOR PROMPT)

> **You are the ORCHESTRATOR for this backend slice.** Do NOT write all the code
> yourself. Drive specialist subagents — a **builder**, a **reviewer**, and an
> **adversarial reviewer** — and triage their findings, exactly as this project has
> done for every slice so far. Use the **superpowers:subagent-driven-development**
> sub-skill to run each phase (builder implements TDD-style → reviewer checks →
> adversarial reviewer attacks). You are responsible for deciding which findings are
> real; fix those, drop the pedantic/nitpicky ones. **Self-QA before you declare
> done — do not hand back a slice for the human to find bugs in.**

## Goal

Implement **Contract C8 — Inbox feed** in the Express backend (`app/`): a
contact-aggregated inbox endpoint + mark-read + assign + a live (SSE) change event.

## Read first (source of truth — the design is owned by the main session)

- **`docs/superpowers/specs/2026-06-17-inbox-design.md`** — esp. *"Data — Contract
  C8"* and *"Live updates & nav badge"*. **The wire shapes there ARE the contract —
  implement them verbatim. Do not invent or rename fields.**
- `docs/superpowers/specs/2026-06-16-new-dashboard-design.md` — product framing
  (entity-centric; Inbox is a contact-row lens, one row per contact).
- `.claude/CLAUDE.md` + `documentation/GLOSSARY.md` — terminology (one `unit`;
  "group text" **not** "relay"; never "property").

## Worktree (isolation — required)

- From the main checkout, create a NEW worktree **under `w:\tmp`** (NOT in
  `.claude/worktrees/`): `git worktree add w:/tmp/hc-inbox-backend -b inbox-backend HEAD`
  then `cd` into it. Branch from **local HEAD** (origin/main is often behind).
- **Do NOT switch HEAD in the main checkout. Work only in your worktree.**
- **Do NOT merge or push to `main`.** When done, leave the branch for the human to
  merge and report back (see *Reporting*).

## Scope

Implement to the C8 wire shapes (copy the `InboxRow` / `InboxPage` / filter/channel
types from the spec verbatim into the route serializer):

1. **`GET /api/inbox?filter=all|unread|unknown|mine&cursor=&limit=` → `InboxPage`.**
   - **One row per contact**, newest-`lastActivityAt`-first. Resolve each
     conversation's number → contact; aggregate ALL of a contact's numbers into one
     row. Numbers with no contact → `kind:'unknown'` rows (`needsTriage:true`).
   - Compute `unreadCount` **across the contact's numbers**; derive
     `preview`/`channel`/`direction`/`lastActivityAt` from the contact's latest item;
     include `role`, `caseContext` (when tied to a case), `assignment`.
   - Filters: `unread` → `unreadCount>0`; `unknown` → `needsTriage`; `mine` →
     assigned to the requesting user; `all` → everything. **Cursor pagination** that
     is correct under per-contact aggregation (a contact must not split across pages).
2. **`POST /api/inbox/:contactId/read`** (and unknowns by phone — your call on
   keying, document it) → marks the contact's comms read.
3. **`POST /api/inbox/:contactId/assign { userId | null }`** → set/clear assignment.
4. **SSE:** emit an inbox-affecting change (new inbound / read / assignment) — either
   a dedicated `inbox.updated` or confirm the existing `conversation.updated` carries
   enough for a client to reconcile. **Document which** so the frontend agent can
   bind to it.

**Reuse existing storage/serializers.** The backend already lists conversations
(with unread/assignment/resolved name) and runs an SSE stream — aggregate over that;
do not duplicate or fork it. Endpoints require the same **auth + origin-verify** as
all other `/api` routes.

## Suggested phases (formalize with writing-plans, then build)

1. Read model + `GET /api/inbox` (aggregation + filters + cursor) with integration
   tests over the hermetic seed.
2. Mutations (`read`, `assign`) + SSE emission, with tests.
3. Wire-shape conformance sweep + adversarial review; fix real findings.

## Conventions & guardrails

- **DynamoDB Local / hermetic only.** Do not touch real AWS. If any AWS access
  arises, use the project's **named profile + account-ID guard** — the default creds
  point at the WRONG account (ABT `961902293381`). HousingChoice is a different
  account.
- `.env` edits are **template-first** (`.env.<stage>.example` first, then merge).
- Match existing code style; TypeScript strict; keep route handlers thin and the
  aggregation logic unit-testable in isolation.

## Adversarial review — make the adversarial subagent hunt for

Security/authz (can a user read/mutate another workspace's inbox?), **contract
drift** vs the spec (field names/types/shapes), **aggregation correctness** (a
contact spanning multiple numbers; unknown rows; empty inbox; read/unread math),
**pagination correctness** (no split contacts, stable cursor), **SSE/race**
correctness (event fires on every relevant change; no stale/duplicate), **N+1 /
perf** over the resolve-number→contact path, and missed renames. **You confirm each
finding is real before acting; drop pedantic ones.**

## Acceptance / verification (run the stack only transiently — see Ports)

- `npm test -w @housingchoice/app` green (existing suite + your new tests).
- `npm run typecheck` clean.
- The endpoint returns `InboxPage` per C8 over the hermetic seed; filters work;
  mutations update read/assignment; an SSE event fires on change; all auth-gated.

## Ports (coordination — important)

The hermetic stack uses **fixed ports** (app 8080, vites 5173/5174, fake-twilio
8889, MinIO 9000, DynamoDB Local). Your worktree shares them with the main checkout
and the frontend worktree. **Do not assume you can run `e2e:session` while another
stack is up** — run it only transiently to verify, then `npm run e2e:stop`. Avoid
simultaneous stacks across worktrees.

## Reporting (do not merge)

When green + reviewed, **STOP**. Write a short handoff summary: what changed, how you
verified, the SSE event name you chose, and any contract notes. Leave branch
`inbox-backend` for the human to merge. **If you find C8 needs to change, do NOT
silently diverge** — the design is owned by the main session; propose the change in
your summary and flag it.
