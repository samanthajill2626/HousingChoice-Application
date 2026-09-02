# Task 10 report - pure transport presenter and denominator carveout

## Commit

- `be6f2f7f feat: present requested and actual transports`

## Files

- Created `dashboard/src/lib/messageTransport.ts`.
- Created `dashboard/src/lib/messageTransport.test.ts`.
- Modified `dashboard/src/routes/contact/deliveryStatus.ts`.
- Modified `dashboard/src/routes/contact/deliveryStatus.test.ts`.

No Timeline component or e2e file was changed; those remain Task 11 and Task 12 scope.

## TDD evidence

Command used throughout:

```text
npm run test -w @housingchoice/dashboard -- src/lib/messageTransport.test.ts src/routes/contact/deliveryStatus.test.ts
```

- Initial sandboxed attempt: exit 1 before test execution. Vite could not create
  `dashboard/node_modules/.vite-temp/...mjs` and reported Windows `EPERM`. This was
  environmental and was not treated as the deliberate red proof.
- First executable attempt outside that write restriction: exit 1. It exposed the
  missing `messageTransport` module and the new delivery-carveout failures. One new
  staleness test also referenced the wrong local clock name; that test-only error was
  corrected before any production implementation.
- Authoritative red rerun: exit 1. `messageTransport.test.ts` failed collection
  because `./messageTransport.js` did not exist; `deliveryStatus.test.ts` ran 75 tests
  with 72 passed and 3 behavior failures (excluded recipient still staled, still
  counted in the rollup, and still received a leg presentation).
- Green run after implementation: exit 0. Two files passed; 112 tests passed
  (`messageTransport.test.ts`: 37, `deliveryStatus.test.ts`: 75).
- Final green rerun after the type-only generic correction: exit 0. Two files passed;
  112 tests passed.

Focused typecheck:

```text
npm run typecheck -w @housingchoice/dashboard
```

- First run: exit 1 on the new generic entry helper's all-optional constraint. The
  helper constraint was narrowed to the real recipient shape by including required
  `status`.
- Final run: exit 0 with no diagnostics.

Diff validation:

```text
git diff --check
```

- Exit 0. The same staged check also exited 0 before commit.

## Behavior shipped

- `presentMessageTransport` is the single pure source for uppercase protocol labels,
  ` -> ` arrows, `Mixed`, and `Unknown`.
- Optimistic SMS/MMS rows return no chip. Schema-absent SMS/MMS/CALL/EMAIL retain the
  existing uppercase legacy label.
- Version-1 inbound messages use actual transport only and show `Unknown` without
  actual evidence; a malformed requested value on inbound does not influence output.
- Version-1 outbound single-recipient messages cover all nine known requested/actual
  pairs. Pending requests show requested only, and a missing request shows `Unknown`
  even if message-level actual is present.
- Outbound recipient aggregation uses attempted legs as actual evidence, treats
  planned and state-absent slots as incomplete, ignores excluded slots, emits `Mixed`
  only for complete divergent attempted actuals, and never lets relay fan-out slots
  replace an inbound source chip.
- Recipient presentation supports requested-only, agreement, disagreement, honest
  actual-only, malformed `Unknown`, and null for excluded slots.
- `includedRecipientEntries` centralizes disclosure inclusion. It hides only
  excluded-without-code slots, retains state-absent/planned/attempted slots, and
  retains excluded slots carrying `contact_opted_out` or another suppression code.
  It accepts both recipient maps and arrays so the existing delivery-rollup API did
  not need a breaking signature change.
- Delivery rollups use that shared filter before their existing opted-out denominator
  exclusion. Excluded-without-code slots no longer affect counts or stale counts.
- `isStaleLeg` and `canEverGoStale` return false for excluded-without-code slots, so
  those slots cannot buy or keep a staleness timer. `presentLegDelivery` returns null
  for them.
- The opted-out per-leg copy runs before the general hide rule, preserving the exact
  existing Relay and Group Text wording. State-absent queued slots remain counted and
  all existing included-slot labels and tones remain unchanged.

## Constraints checked

- The pure presenter imports only normalized dashboard API types. It contains no
  Twilio/provider types, provider-ID inspection, media inference, or conversation-kind
  read.
- `MessageType` remains unchanged and is used only for legacy/non-carrier presentation.
- No route, send behavior, status semantics, Timeline rendering, or e2e fixture was
  changed.
- New files are ASCII-only; all added lines in modified files are ASCII.
- Commit staged only the four owned paths and used the required subject and
  `Co-Authored-By: Codex GPT-5 <noreply@openai.com>` trailer.

## Divergence

- No product or plan divergence. The helper accepts maps and arrays solely to reuse
  one exclusion rule in the new pure API and the existing array-based rollup without
  changing Task 11-owned Timeline call sites.
