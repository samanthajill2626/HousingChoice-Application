---
id: pool-audit-reimport-strands-business-number
title: pool:audit --reimport can write a pool_numbers row for the business number when BUSINESS_PHONE_NUMBER is unset
type: bug
severity: med
status: open
area: scripts/pool-audit
created: 2026-08-06
refs: scripts/poolNumbersAudit.mjs:183, scripts/poolNumbersAudit.mjs:197, scripts/poolNumbersAudit.mjs:279
---

**Problem.** `scripts/poolNumbersAudit.mjs` classifies every number the Twilio
account owns by comparing it against the business number read FROM DISK out of
the real `.env.<env>`:

```
const configured = (entries.BUSINESS_PHONE_NUMBER ?? '').trim();
const businessNumbers = new Set(configured.length > 0 ? [configured] : []);
```

An absent or blank key degrades SILENTLY to an EMPTY set (`:183-184`). Nothing
fails; the classifier simply has no business number to exclude. Every
Messaging-Service-attached number - including the real business line - then
falls through to `pool, tracked` or `pool, STRANDED`, and post-wipe (no rows at
all) the business number lands in STRANDED. `npm run pool:audit -- <env>
--reimport` writes rows for exactly the STRANDED class, so it would create a
`pool_numbers` row for the business number: `lifecycle_state 'active'`, empty
burn set. That makes the business line an ASSIGNABLE relay number - the next
group text can claim it and start multiplexing group traffic onto the number on
our flyers.

The only warning is the existing header line, which prints
`(BUSINESS_PHONE_NUMBER is empty!)` in the business slot (`:197`) and
`(the owned numbers do not include BUSINESS_PHONE_NUMBER)` under the Business
section. Both are easy to scroll past, and neither blocks `--reimport`.

**This is PRE-EXISTING, not introduced by the rename.** An empty
`OUR_PHONE_NUMBERS` produced exactly the same empty set and the same
misclassification before `feat/business-number-config`; the change is a rename
in both the script and the templates, and the classification is unchanged in
meaning (design D6). It is filed rather than fixed inside that change because
N5 forbids pool-lifecycle changes there.

What the rename DOES do is widen the window in which the hazard can be hit: an
operator whose real `.env.<env>` still says `OUR_PHONE_NUMBERS` while the script
reads `BUSINESS_PHONE_NUMBER` has a half-done cutover with an empty business
set, and that is a state nobody was ever in before. See RUNBOOK (Twilio,
"Renaming the key") for the required order: rename in `.env.<env>` FIRST, then
`secrets:push`, then deploy, then `secrets:prune`.

**Suggested fix.** Make an empty value fatal instead of silent, in the style of
the `TWILIO_MESSAGING_SERVICE_SID` guard immediately above it (`:177-182`):

```
if (!entries.BUSINESS_PHONE_NUMBER) {
  fail(
    `[pool:audit] .env.${env} does not define BUSINESS_PHONE_NUMBER - without it ` +
      `the business line cannot be told apart from a relay pool number. Nothing was read or written.`,
  );
}
```

The script already fails before reading or writing anything when the Messaging
Service SID is missing, for the same reason, so this is the established shape.
A narrower alternative is to gate only `--reimport` (a read-only report with no
business number is merely incomplete, not dangerous), but the guard above is
simpler and the report is misleading either way.
