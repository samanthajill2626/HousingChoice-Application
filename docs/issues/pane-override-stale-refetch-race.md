---
id: pane-override-stale-refetch-race
title: An in-flight contact refetch can clear ContactCommsPane's fresher local override
type: bug
severity: low
status: open
area: dashboard
created: 2026-08-04
refs: dashboard/src/routes/contact/ContactCommsPane.tsx:102, dashboard/src/routes/contact/ContactCommsPane.tsx:312, dashboard/src/routes/contact/ContactCommsTab.tsx:60, dashboard/src/routes/tours/useTour.ts:115, dashboard/src/routes/placements/PlacementDetail.tsx:177
---

**Problem.** `ContactCommsPane` keeps a local `override` for contact mutations it
makes itself - consent recorded in `ConsentCaptureModal`, addresses added in
`EmailManager` - so its send gates (`sms_opt_out`, `deleted_at`, the email
channel) read as updated immediately on ANY caller. It then drops that override
whenever the caller hands down a new `contact` object identity:

```ts
useEffect(() => { setOverride(null); }, [contact]);   // ContactCommsPane.tsx:107
```

That rule is right in the steady state (the caller's record must win), but it
cannot distinguish a FRESHER caller record from a STALER one. The losing
interleaving is ordinary on the tour and placement hubs, both of which hold
tenant/landlord state and refetch it on their own SSE (useTour.ts:115-122 on
`tour.updated`; PlacementDetail.tsx:177-183 on `placement.updated`):

- T1 an SSE-driven `getContact` starts (pre-consent row in flight)
- T2 the operator records consent in the pane; `applyContact` sets `override`;
  the blocked send is retried and goes out
- T3 the T1 response lands with the PRE-consent contact -> new identity ->
  `override` cleared -> the composer reverts to the pre-consent gates

Both triggers that emit `tour.updated` here (the send's own status change, "Open
group text") are on the same screen, so the window is easy to hit.

Impact is display-only and self-healing: the next refetch carries the real row,
and every send is re-checked server-side (the just-in-time consent gate returns
409 `contact_no_consent` regardless of what the composer thinks). Nothing is
sent that should not be.

Adjudicated OUT of the contact-comms-pane fix wave on its stated condition - the
fix was to keep the override when the incoming props.contact is STALER, compared
by a freshness stamp, and there is no stamp to compare. `Contact`
(dashboard/src/api/types.ts) and `ContactItem` (app/src/repos/contactsRepo.ts)
carry `created_at`, `captured_at`, `consent_at` and `deleted_at` but NO
`updated_at`/`updatedAt`, and none of the ones that exist moves when (say) an
email address is added. A grep for `updated_at` across app/src returns only
broadcasts, listingSends, placements and units.

**Suggested fix.** Add a monotonic `updated_at` to ContactItem, stamp it on every
contact write, surface it on the read/PATCH responses, then keep the override
when `incoming.updated_at < override.updated_at` and clear it otherwise. Cheaper
half-measure if that write path is too broad: have the pane hand its mutation up
to the hubs (an `onContactUpdated` they apply into their bundle) so the override
and the page agree - that shrinks the window to the in-flight request but does
not close it.
