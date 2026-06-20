---
id: status-pin-vs-terminal-derivation
title: Should a terminal placement outcome override a stale non-terminal manual pin?
type: decision
severity: med
status: resolved
area: app
created: 2026-06-19
resolved: 2026-06-19
refs: documentation/STATUS-MODEL.md, app/src/services/statusTransition.ts
---

**Resolution.** Only override/exit states pin (listing on_hold/off_market,
tenant on_hold/inactive); baseline progression states stay derivation-eligible
regardless of source. Implemented in statusModel.ts (override-state sets) +
statusTransition.ts applyDerivation (state-gated).


**Problem.** Per STATUS-MODEL.md §8, a non-`derived` status write (`manual` /
`ai` / `automation` / `import`) **pins** the value and permanently blocks future
`derived` writes until the next explicit (non-derived) write replaces it
(`canOverwrite` in `app/src/lib/statusModel.ts`).

Consequence at the terminal outcomes: if a tenant or listing has been **manually
pinned** (e.g. tenant `on_hold`, listing `on_hold`) and the placement later
reaches a terminal outcome, the derived terminal state is **NOT** applied — the
entity stays at the stale pin:

- `moved_in` ⇒ derived tenant `placed` / listing `occupied` — **not applied** if
  pinned.
- `lost` ⇒ derived bounce tenant `searching` / listing `available` — **not
  applied** if pinned.

This is faithful to §8 as written ("an explicit write pins and wins"), but it may
**surprise operators**: a placement can be `Moved in` while the tenant card still
reads `On hold`.

**Decision for the human.** Should terminal placement outcomes (`moved_in` /
`lost`) **override** a stale *non-terminal* manual pin (treating a closing
placement as authoritative), or continue to **respect the pin** (current
behavior)? A middle option: override only when the pin is non-terminal
(`on_hold`) but never an explicit terminal pin (`inactive` / `off_market`).

**Current behavior:** the pin is left untouched (no override). Documented here
pending a decision; no code change made.
