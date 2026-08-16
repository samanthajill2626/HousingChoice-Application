---
id: sms-brand-diverges-from-registered-a2p-brand
title: SMS-facing brand is now "HousingChoice" while the registered A2P brand is still "Tenant Place LLC"
type: decision
severity: med
status: open
area: app
created: 2026-08-15
refs: app/src/lib/smsCompliance.ts:24, dashboard/src/lib/consentCopy.ts:17, docs/a2p/campaign-resubmission.md:41
---

**Problem.** On 2026-08-15 the SMS-facing brand string was changed from the legal
entity name "Tenant Place LLC" to the trade name "HousingChoice" across every
filed copy string (welcome, HELP, opt-in confirmation, web-form consent
disclosure, missed-call auto-text, relay intro / member-added, team sender
label). Cameron asked for the copy change explicitly and scoped the A2P side
OUT of that work, so the registered brand and the campaign filing were NOT
touched.

That leaves the code deliberately ahead of the filing in three ways:

1. **Brand / DBA registration.** "Tenant Place LLC" remains the registered A2P
   brand. Carriers expect the brand named in message copy to be a registered
   brand or a DBA on it. `docs/a2p/campaign-resubmission.md` row 6 already calls
   for registering "HousingChoice" as a DBA; that step is still outstanding.
2. **Filed sample copy.** The campaign submission quotes the old brand in its
   opt-in, welcome, HELP, and relay-intro samples. The app now sends the
   "HousingChoice" variants, so the samples no longer match what goes out.
3. **Domain.** `tenant.place` is UNCHANGED by decision -- the HELP reply still
   ends "More info: tenant.place." and the Privacy Policy / Terms links still
   point at `https://tenant.place/...`. So live copy now mixes the
   HousingChoice name with the tenant.place domain.

None of this breaks a gate or a send path; it is a compliance-posture gap to
close deliberately, not a defect in the code.

**Suggested fix.** Before (or alongside) the prod cutover: register
"HousingChoice" as a DBA on the Tenant Place LLC brand, refresh the sample copy
in `docs/a2p/campaign-resubmission.md` from the current constants, and decide
whether the public domain in the copy should follow the name to
housingchoice.org. Operationally the brand change also requires the RUNBOOK
step 3b re-paste (Help message + Opt-in confirmation) on every messaging
service -- see `RUNBOOK.md` "Keyword auto-replies (Advanced Opt-Out)".
