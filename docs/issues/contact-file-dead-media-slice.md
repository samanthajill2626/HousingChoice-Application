---
id: contact-file-dead-media-slice
title: Remove the dead `media` slice + getContactMedia fetch from useContactFile
type: debt
severity: low
status: open
area: dashboard/contact
created: 2026-06-18
refs: dashboard/src/routes/contact/useContactFile.ts:32, dashboard/src/routes/contact/useContactFile.ts:83
---

**Problem.** `useContactFile`'s `media` slice (a once-on-mount `GET /api/contacts/:id/media`
fetch) is no longer read by any consumer. `ContactDetail.tsx` derives the "Media from comms"
gallery from the LIVE timeline instead (`commsMedia(timeline.items)` in `media.ts` →
`MediaGallery`), so it updates on send. The slice + fetch are redundant. Verified
2026-06-18: the only remaining references are the dead fetch itself and test mocks.

**Suggested fix.** Delete the `media` field, its `loadSlice(getContactMedia…)` fetch, the
`getContactMedia` usage, and the related assertions in `useContactFile.test.tsx`. Consider
whether `getContactMedia` in `api/endpoints.ts` and the `GET /api/contacts/:id/media`
backend endpoint have any other consumer before removing those too.

Graduated 2026-06-18 from inline `TODO(dead-code)` markers in `useContactFile.ts`.
