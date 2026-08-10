---
id: resolution-fault-injection-hooks-in-prod-path
title: Suggestion-resolution fault-injection hooks ship inside the production request path
type: debt
severity: low
status: open
area: app/suggestion-resolution
created: 2026-08-09
refs: app/src/services/suggestionResolution.ts:40, app/src/services/suggestionResolution.ts:262, app/src/routes/suggestions.ts:37, app/src/routes/api.ts:224
---

**Problem.** `SuggestionResolutionHooks.afterBoundary`
(`app/src/services/suggestionResolution.ts:40`) exists purely so tests can kill
the process between resolution phases, but it is plumbed through production
wiring and awaited by the production executor. At HEAD the local helper

```ts
async function boundary(name: ResolutionBoundary, journal: ActiveSuggestionResolution): Promise<void> {
  await deps.hooks?.afterBoundary?.(name, journal);
}
```

sits at `:262-263` and is awaited at four points on the live accept/dismiss
path: `:319` (`domain_applied`), `:360` (`activity_applied`), `:396`
(`verdict_attempted`) and `:518` (`claimed`). The hook is carried on
`SuggestionsRouterDeps` (`app/src/routes/suggestions.ts:37`) and
`ApiRouterDeps` (`app/src/routes/api.ts:224`).

It is not reachable over HTTP - nothing parses a request into a hook - so this
is a shape problem, not a vulnerability: production code awaits an
injection seam whose only purpose is test-time failure. Removing it is not free:
`app/test/aiRunVerdicts.test.ts` references `afterBoundary` 24 times, so the
crash/interleaving suite has to be re-expressed first.

**Suggested fix.** Replace the hook with a test-only seam that cannot exist in a
production build - the most direct option is to have the crash suite drive
failures through the already-injected repo doubles (throw from the specific
`commit*Effect` / `advancePhase` / `setVerdict` call the test wants to
interrupt) instead of a dedicated boundary callback, then delete
`SuggestionResolutionHooks`, the `boundary()` helper, and both `deps` entries.
Do it as its own change, with the crash suite green before and after.
