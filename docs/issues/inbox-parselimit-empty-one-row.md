---
id: inbox-parselimit-empty-one-row
title: Inbox ?limit= (empty value) serves a one-row page instead of the default
type: bug
severity: low
status: open
area: app
created: 2026-08-09
refs: app/src/routes/inbox.ts
---

**Problem.** `parseLimit` in `app/src/routes/inbox.ts` treats an empty string
as a number: `Number('') === 0`, which IS an integer, so the clamp floor turns
`?limit=` (and `?limit=%20`) into `Math.max(1, 0) = 1` - a one-row inbox page
where the caller plainly wanted the default. `raw === undefined` is the only
absent shape it recognizes.

**Pre-existing on main** - noticed during the ai-run-log follow-up wave's
re-review, when `app/src/routes/aiRuns.ts` adopted this function as its model
and then had to harden exactly this case (empty/whitespace/non-string now fall
back to the default there). The two copies now deliberately diverge; the
aiRuns copy carries a do-not-re-sync warning pointing here.

**Fix direction.** Adopt the aiRuns variant:
`if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_INBOX_LIMIT;`
plus a test that `?limit=` answers the default page size.

**Evidence.** `.superpowers/review/fixwave-rereview.md` (P3-6) on branch
feat/ai-run-log.
