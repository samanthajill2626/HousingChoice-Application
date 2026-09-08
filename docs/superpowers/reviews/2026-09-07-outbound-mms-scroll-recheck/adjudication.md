# Review adjudication

Accept P2. Direct source inspection confirms that the first viewer session
checks both owners but the subsequent Ctrl-wheel session only checks scale.
Add exact equality on reopening and after Ctrl-wheel, plus focus restoration
and polled exact offsets after Close. Keep the original expected baseline;
do not recapture a moved offset or add tolerances/delays.

The eight focused browser tests passed after main sync before this review fix
(exit 0, 56.5s). E2E typecheck and the 68 targeted unit tests also passed again.
Rerun E2E typecheck, touched-file lint, and the eight browser tests after the
assertion change; unit-covered production code is unaffected by this change.

Main was synced once at `c8ed0348`, incorporating `2cc8fd33`, conflict-free.
The sync imported a separate visibility issue that is now canonical for this
mechanism. The previous delivery-scroll issue and duplicate remain resolved.
