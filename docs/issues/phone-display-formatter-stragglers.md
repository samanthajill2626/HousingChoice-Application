---
id: phone-display-formatter-stragglers
title: Two pre-existing local phone display formatters bypass the shared lib formatter
type: debt
severity: low
status: open
area: dashboard
created: 2026-07-02
refs: dashboard/src/routes/settings/UserRow.tsx, dashboard/src/routes/today/buildToday.ts:84
---

**Problem.** The flexible-phone-entry work consolidated phone display formatting into ONE
implementation (`dashboard/src/lib/phone.ts` `formatPhoneDisplay`; `routes/contact/format.ts`
`formatPhone` now re-exports it, 12 importers unchanged). The adversarial review found two
PRE-EXISTING local display-only formatters that predate the consolidation and were out of
that spec's scope: `UserRow.tsx`'s `formatCell` (Team page cell display) and a local
formatter in `today/buildToday.ts:84`. Both are correct today; the risk is drift — a future
format tweak lands in the lib and these two silently diverge.

**Suggested fix.** Replace both local formatters with imports of `formatPhoneDisplay` from
`dashboard/src/lib/phone.ts` (display-only call sites; behavior preserved). Trivial, low
priority — batch with any next dashboard tidy-up pass.
