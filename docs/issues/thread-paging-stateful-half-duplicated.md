---
id: thread-paging-stateful-half-duplicated
title: The stateful half of thread paging is copy-pasted across three hooks and has already drifted
type: debt
severity: med
status: open
area: dashboard
created: 2026-08-13
refs: dashboard/src/routes/conversation/useRelayThread.ts:156, dashboard/src/routes/conversation/useRelayThread.ts:277, dashboard/src/routes/conversation/useRelayThread.ts:301, dashboard/src/routes/conversation/useGroupThread.ts:91, dashboard/src/routes/conversation/useGroupThread.ts:197, dashboard/src/routes/conversation/useGroupThread.ts:219, dashboard/src/routes/contact/useContactTimeline.ts:239, dashboard/src/routes/contact/useContactTimeline.ts:384, dashboard/src/routes/contact/useContactTimeline.ts:427, dashboard/src/routes/shared/threadPaging.ts
---

**Problem.** `dashboard/src/routes/shared/threadPaging.ts` shares only the PURE
half of thread paging: `mergeTimelineItems` and `THREAD_PAGE_SIZE`. The stateful
half - five refs (`loadingOlderRef`, `oldestFetchedIdRef`/`cursorRef`,
`olderAbortRef`, `loadedIdRef`/`loadedKeyRef`), the reset-on-key-change effect,
the `isFirstLoad` baseline block and the whole `loadOlder` body - was copied
instead. `useRelayThread` and `useGroupThread` hold it byte-identical apart from
comment wording; `useContactTimeline` holds a third copy with a server cursor in
place of a `before` bound.

This is not a style complaint. It costs real defects and real fix latency:

- The empty-older-page bug (an older page that merged NOTHING still bumped
  `olderPagesLoaded`, so `<Timeline>` fired a scroll restore for a prepend that
  never happened) existed in ALL THREE copies and had to be fixed three times.
- The late-settling-abort bug in `loadOlder`'s `finally` (an aborted request
  released the in-flight guard belonging to a newer one) existed in all three
  copies and had to be fixed three times.
- The `isFirstLoad` baseline guard - the rule the whole feature rests on, since
  re-baselining the bound discards pages already walked - existed in all three
  copies with zero tests. Mutating it to `if (true)` left every suite green.

And the pair has ALREADY drifted: `useGroupThread` filters SSE events by
`conversationId` (`useGroupThread.ts:294`) and `useRelayThread` does not, so the
"identical" hooks now answer a different set of events. The next divergence will
be a fix applied to two of the three copies, and the surface that missed it will
regress silently because its copy of the invariant has its own tests or none.

**Failure story.** A future change makes older-page reads resumable after an
error, and is applied to `useRelayThread` and `useContactTimeline` because those
are the two surfaces the reporter mentioned. Six weeks later an operator on a
native group text reports that "Load older messages" stops working after any
network blip. Nothing failed loudly; the third copy simply never got the change.

**Suggested fix.** Extract a `useOlderPages({ fetchPage, boundFrom, onMerged })`
hook holding the refs, the reset effect, the baseline block and `loadOlder`, and
have all three hooks call it. Give it ONE test suite covering the invariants that
currently need proving three times: merge-never-replace-except-first-load, the
monotonic counter, the baseline guard, the ref guard and the abort ownership
rules. The two `before`-bound hooks and the cursor hook differ only in how the
next bound is derived, which is exactly one callback.
