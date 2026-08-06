---
id: seed-addresses-unstructured
title: Seeded unit addresses are plain postal-noise strings, so reminder copy reads "Tour at 350 Boulevard SE, Atlanta, GA 30312" in every demo
type: improvement
severity: low
status: open
area: app
created: 2026-08-05
refs: app/src/lib/seed/cast.ts:428, app/src/lib/seed/lean.ts:146, app/src/lib/seed/lean.ts:169, app/src/lib/address.ts
---

**Problem.** Tour reminder copy renders `{where}` via `formatStreet`, which is
street-only (`line1 [line2]`) for a STRUCTURED `Address` but returns a legacy
plain-string address trimmed and VERBATIM (spec D5, deliberate). The seeds
store plain strings that include city/state/zip:

- `app/src/lib/seed/cast.ts` (demo world, `profile=full`): e.g.
  `'350 Boulevard SE, Atlanta, GA 30312'` - so every dev demo shows reminder
  bodies like `Good morning! Tour at 350 Boulevard SE, Atlanta, GA 30312 is
  today at 3:00 PM.` (postal noise included; verified live 2026-08-05).
- `app/src/lib/seed/lean.ts` (byte-stable e2e world): same shape
  (`'1450 Joseph E. Boone Blvd NW, Atlanta, GA 30314'`, `'88 Sycamore St,
  Decatur, GA 30030'`).

TWO PRECISIONS the original spec text got wrong, recorded so nobody chases
them: (1) the seed directory is `app/src/lib/seed/`, not `app/src/seed/`;
(2) the e2e CONSUMER SPECS are NOT affected - they create their units at
runtime through `POST /api/units` with a structured address, so e2e reminder
bodies already render street-only (`<digits> Sender Way NW`). Only seed-backed
worlds (dev demos, `profile=full`, the lean fixtures themselves) show the
postal noise. `app/src/lib/seed/live.ts` is already structured.

**Why deferred.** Converting `lean.ts` touches the byte-stable world the e2e
goldens depend on - a real regression risk for a cosmetic gain. The behavior
is honest (we render what is stored, never parse or rewrite user-shaped data).

**Suggested fix.** Convert `cast.ts`, `lean.ts` and `matrix.ts` unit addresses
to structured `Address` objects in a dedicated change that also re-baselines
any e2e/golden expectations that embed the strings; verify the reminder
bodies and unit cards on the full profile afterward.
