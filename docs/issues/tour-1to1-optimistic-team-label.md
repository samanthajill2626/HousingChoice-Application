---
id: tour-1to1-optimistic-team-label
title: "Tour page 1:1 tabs: optimistic bubble briefly shows a 'Team' sender label"
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-08
refs: dashboard/src/routes/conversation/useRelayThread.ts:117, dashboard/src/routes/tours/TourConversation.tsx:256, dashboard/src/routes/contact/Timeline.tsx:138
---

**Problem (review finding, 2026-07-08 - cosmetic, transient).** The tour page
drives its Tenant/Landlord 1:1 tabs through useRelayThread, whose addOptimistic
unconditionally stamps relay_sender_key: 'team'. Timeline renders that as a
"Team" attribution line - an artifact real 1:1 bubbles never show. For the
~300-600ms until the SSE-debounced refetch replaces the optimistic bubble with
the server row (which carries no relay_sender_key), an outbound 1:1 message on
the tour page displays the spurious label. The contact page is unaffected (its
useContactTimeline.addOptimistic does not set relay_sender_key). Self-heals on
refetch; display-only.

**Suggested fix.** Make addOptimistic's relay_sender_key opt-in (parameter or a
variant for 1:1 use), or have TourConversation's ContactThread strip it from
optimistic items. Add a test pinning that a 1:1 optimistic bubble renders no
attribution line.
