# MMS image viewer design review - round 3A

## 1. [HIGH] Independent navigation can restore the prior route's scroll position into the new route

### What is wrong

The provider is deliberately mounted above the route tree and remains alive across
route changes. Section 6.3 correctly says an independent route navigation is
authoritative when it removes a marker. But section 7.1 unconditionally restores
every still-connected saved scroll owner "on dismissal." Those two rules conflict
for an independent navigation while the viewer is open.

The page scroll owner is not route-local: `AppFrame` stays mounted and keeps the
same `.content` element around its `<Outlet/>`. A navigation from route A to route
B therefore removes the marker while the snapshot from A's `.content` is still
connected. The provider's specified restoration writes A's old x/y into B's page
container after B has mounted. That changes the authoritative destination route's
scroll position; it is not an image-viewer dismissal back to A. The disconnected
trigger rule does not help because the scroll owner remains connected.

### Evidence

- Spec section 4.1 places the provider above the route tree; section 6.3 says an
  independent route navigation remains authoritative when it removes the marker.
- Spec section 7.1 unconditionally restores every still-connected recorded owner
  on dismissal, without distinguishing a viewer Back/Close from a route change.
- `AppFrame` renders a persistent `<main className={styles.content}><Outlet /></main>`
  (`dashboard/src/app/AppFrame.tsx:174-197`), and that element is the scroll owner
  (`dashboard/src/app/AppFrame.module.css:383-387`).
- The test plan covers Back, Close, Escape, and backdrop restoration (spec section
  11.1 item 8), but does not navigate to a different route while the viewer is
  open and assert that the destination keeps its own scroll/focus behavior.

### What it implies

Record whether the marker was removed by a verified viewer dismissal back to its
underlying entry versus an unrelated location change. Restore old snapshots and
trigger focus only for the former; on independent navigation, tear down inert and
the portal without writing the prior route's scroll or focusing its trigger. Add
a browser-router test that opens from a scrolled contact Timeline, performs an
independent navigation, and proves the destination route's scroll and focus stay
authoritative.
