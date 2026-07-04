---
id: consent-copy-cross-stack-drift
title: Consent/compliance copy is hand-mirrored across app ↔ dashboard (drift risk)
type: debt
severity: med
status: open
area: dashboard
created: 2026-07-03
refs: app/src/lib/smsCompliance.ts, dashboard/src/lib/consentCopy.ts, dashboard/src/routes/public/IntakeForm.tsx
---

**Problem.** Five compliance constants are **hand-copied** from
`app/src/lib/smsCompliance.ts` into `dashboard/src/lib/consentCopy.ts`
(`WEB_FORM_CONSENT_COPY`/`_LABEL`, `SMS_BRAND_NAME`/`SMS_BRAND`, `CONSENT_VERSION`,
`PRIVACY_POLICY_URL`, `TERMS_URL`, `HUMAN_CONSENT_METHODS`) because the dashboard
cannot import from `app/`. The most sensitive consumer is the **public,
unauthenticated** intake form (`dashboard/src/routes/public/IntakeForm.tsx`),
which renders the CTIA disclosure **verbatim at the moment of consent**.

Each side independently pins its own copy verbatim in tests
(`app/test/smsCompliance.test.ts`, `dashboard/.../IntakeForm.test.tsx`), but —
before the guard below — **nothing asserted the two sides matched each other**,
so they could lock two *different* strings and both stay green. If they drift,
the dashboard misrepresents the filed consent language: a compliance-accuracy
bug, not a cosmetic one.

**Mitigation in place (2026-07-03).** A drift-guard test asserts the app's five
consent constants `===` the dashboard's. This closes the immediate risk but the
copy is still duplicated.

**Considered and rejected — runtime API.** Having the dashboard fetch the copy
from an app endpoint at runtime was evaluated and rejected for the public consent
disclosure: legal copy shown at the point of consent must render deterministically
and self-contained; a failed/slow fetch means either no disclosure (can't consent)
or a bundled fallback — and a fallback *reintroduces the duplicate* it was meant
to remove. It also loses the verbatim-ships guarantee the current test provides,
and adds a public endpoint for static legal text. (For the authed
`HUMAN_CONSENT_METHODS` enum an API would be fine but is low-value — it's tied to
backend validation.)

**Suggested fix — shared workspace package (do when the generic Templates UI
lands).** Extract a zero-dependency package (e.g. `@housingchoice/shared` or
`packages/messages`) holding the message catalog + pure resolver + the consent
constants; both stacks import it, and the hand-mirror + drift-guard test are
deleted. The real work is **not** Vite/bundler config (the dashboard's Vite
build tree-shakes any imported TS fine) — it is the **app's compile-to-`dist`,
run-under-Node prod path**: `app` builds via `tsc` (`rootDir: src`) and runs the
emitted JS under Node, which (a) refuses files outside `rootDir` and (b) treats a
workspace dep as external and does not inline it into `dist`, so Node needs real
`.js` at runtime. Therefore the shared package needs its **own `tsc` build +
`exports` map** (built `.js` + `.d.ts`), added to the deploy build ordering
(shared builds before app), with `exports` conditions so `tsx`-dev / vitest / vite
all resolve it. Modest, isolated build-config work — keep it out of a copy-only
change. This pairs with [[message-catalog-legacy-override-migration]] (the
Templates UI is the first dashboard-side consumer of the catalog).
