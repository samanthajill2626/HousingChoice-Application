---
id: poolnumbers-retry-unguarded-permanent-spinner
title: usePoolNumbers.retry() sets 'loading' without the enabled guard, so a non-admin retry would hang on a permanent spinner
type: bug
severity: low
status: open
area: dashboard/settings
created: 2026-08-06
refs: dashboard/src/routes/settings/NumbersSection.tsx:127-131, dashboard/src/routes/settings/NumbersSection.tsx:93-95
---

**Problem.** `usePoolNumbers` gates the admin-only pool inventory on an
`enabled` flag (the viewer's `isAdmin`). Two of its three entry points honour
that flag: `load()` returns early (`:94-95`) and the mount effect settles the
status to `'ready'` instead of fetching (`:113-118`). The third does not:

    const retry = useCallback(() => {
      setStatus('loading');   // <- unconditional
      void load();            // <- correctly no-ops when !enabled
    }, [load]);

`load()` still refuses to fire the admin-only request, so there is NO security
or 403 consequence. But `setStatus('loading')` runs regardless, and for a
non-admin nothing will ever resolve it - the component would sit on a spinner
forever.

**UNREACHABLE TODAY**, which is why this is low and not a defect in the shipped
UI: the retry button renders only inside the admin-gated pool block
(`NumbersSection.tsx:239`), so a non-admin has no way to invoke it. This is a
latent trap, not a live bug - it becomes real the moment someone renders a
retry affordance outside that block, or hoists the hook.

Found by the plan-blind adversarial reviewer during the pre-merge review of
`feat/business-number-config` (merged @25944207). The two guarded paths were
added deliberately to fix exactly this failure mode; `retry()` was missed.

**Suggested fix.** Move the guard to the top of the callback so all three entry
points agree:

    const retry = useCallback(() => {
      if (!enabled) return;
      setStatus('loading');
      void load();
    }, [enabled, load]);

Add a test that calls `retry()` with `viewerIsAdmin = false` and asserts the
status does not become `'loading'` - the existing suite already has the
`viewerIsAdmin` seam (`NumbersSection.test.tsx:23-32`).
