---
id: missed-call-autotext-partial-intake
title: Missed-call auto-text goes silent on a caller we hold SOME intake facts for
type: improvement
severity: low
status: deferred
area: app
created: 2026-08-19
refs: app/src/jobs/missedCallAutoText.ts, dashboard/src/routes/settings/TemplatesSection.tsx
---

**Problem.** The 2026-08-19 intake gate sends the missed-call auto-text only to a
caller we hold NONE of the intake facts for (firstName, lastName, voucherSize,
housingAuthority - and never to a landlord/partner/team member). Any single fact
already on file suppresses the send entirely.

That is deliberate, but it leaves a gap: a caller we hold a NAME for and nothing
else gets no auto-reply at all, even though we still want their voucher size and
housing authority. The filed copy asks for all three at once, so re-sending it
reads as not having listened - which is why the gate suppresses rather than
re-asks. The result is silence where a narrower ask would do real work.

Scope note (2026-08-19): the founder judged the name-only state uncommon in the
current traffic - a first text is usually "is this still available?", with no
name attached - so the silent population is expected to be small. Revisit if the
skip log (`missed-call auto-text skipped - caller intake details already on
file`) shows otherwise.

**Suggested fix.** A second founder-editable template that asks only for what is
missing, selected when the contact holds at least one fact but not all of them.
Two open questions before building it:

  - Per-field composition vs. a small fixed set of templates. Composing the body
    from the missing fields fights both the founder-editable catalog entry and
    the A2P template-validation floor (brand prefix + opt-out line), so a fixed
    "we have your name, still need the housing details" variant is the cheaper
    shape.
  - Whether the name is load-bearing at all. Gating on voucherSize +
    housingAuthority alone and treating the name as incidental would collapse
    this case into the existing rule with no new copy - at the cost of
    occasionally re-asking for a name we already have.

Whatever ships, the settings hint in TemplatesSection.tsx describes the gate to
operators in plain language and has to be updated in the same change.
