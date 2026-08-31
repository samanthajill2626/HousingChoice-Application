# MMS image viewer design review - round 4A

No findings.

The revised return-location-key protocol resolves the prior persistent-shell
scroll/focus write: a verified traversal back to the exact saved key restores the
snapshot, while every other location transition tears down only the overlay and
inert state. This matches the current persistent `AppFrame`/`Outlet` structure
(`dashboard/src/app/AppFrame.tsx:174-197`) and its persistent `.content` scroll
owner (`dashboard/src/app/AppFrame.module.css:383-387`). The revised tests cover
both branches.
