---
id: broadcast-draft-curation-persistence
title: Broadcast composer loses mid-curation state on navigation - no draft resume
type: improvement
severity: low
status: open
area: dashboard
created: 2026-07-08
refs: dashboard/src/routes/broadcasts/BroadcastComposer.tsx, dashboard/src/routes/broadcasts/RecipientPreview.tsx
---

**Problem.** The broadcast composer's review-recipients step holds its curation
state - which candidates are checked, manually-added tenants, the search box -
in component memory only. Navigating away (in-tab) and coming back loses all of
it: the composer remounts at step one with empty state, even though a DRAFT
broadcast row exists server-side (created before preview). This is why the
recipient rows' profile links open in a NEW TAB (the 2026-07-08 full-names
change): in-tab navigation would silently discard the operator's curation.
Related gap: the Broadcasts list's Drafts tab shows draft rows, but opening one
cannot resume composition either.

**Suggested fix.** Persist the curation so the review step survives a round
trip and drafts are resumable:

- Server-side is preferable to sessionStorage: PATCH the draft with the curated
  recipient selection (checked contactIds + manually-added ids) as the operator
  edits, then let /broadcasts/new?draftId=<id> (or the Drafts-tab row) rehydrate
  the composer - audience filter + message already live on the draft row, so
  the missing piece is the selection snapshot + a rehydrate path.
- Once resume works, the profile links can become ordinary in-tab links (and
  the review step reachable via browser Back), though new-tab remains a fine
  affordance.
- Mind the A2P fences on rehydrate: re-run the preview so consent/opt-out/
  already-sent flags are CURRENT, then re-apply the stored selection on top
  (never trust a stale snapshot's checked state for a no-consent row).
