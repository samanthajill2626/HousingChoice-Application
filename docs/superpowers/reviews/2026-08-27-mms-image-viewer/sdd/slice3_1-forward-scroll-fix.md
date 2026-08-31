# Slice 3.1 - Forward scroll review adjudication

## Result

- No source or test change was required.
- The reported defect is not present in commit `313017a891717ee4667206507de8466ac7eb62e3`.
- No commit was created. The branch remains at `313017a891717ee4667206507de8466ac7eb62e3`.

## Reproduction evidence

The focused provider suite already contains the exact reported sequence in
`reopens a retained descriptor on Forward and refreshes connected scroll snapshots`:

1. Capture page/timeline snapshot A at `140/9` and `420/3`.
2. Open the viewer and use browser Back.
3. Set the surviving owners to distinct snapshot B values `240/19` and `520/13`.
4. Use browser Forward to reopen the retained token.
5. Mutate both owners while the viewer is open.
6. Close and require exact restoration to snapshot B.

Command:

`npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx`

Result on unmodified `313017a8`: exit 0; 1 file passed; 8 tests passed.

## Mutation proof

The current activation predicate is:

`previous?.marker.token !== active.marker.token && active.entry.trigger.isConnected`

After Back clears `previousActiveRef`, Forward evaluates the token comparison as
`undefined !== active.marker.token`, which is true. It therefore refreshes the
connected trigger's scroll-owner snapshots before recording the active transition.

To prove the existing test detects the alleged regression, I temporarily changed
the predicate to require `previous !== undefined`. That mutation disables refresh
after Back. The same focused command then exited 1 with 7 tests passed and 1 failed:

`expected [140, 9] to deeply equal [240, 19]`

The temporary mutation was reverted. No tracked diff remains.

## Final transition invariant

The first active transition and any later same-session Forward transition record
the current connected scroll owners in `previousActiveRef`. A verified dismissal
restores that transition-local snapshot only when the return location key matches;
independent navigation, disconnected owners, and disconnected triggers receive no
stale scroll or focus write.

## Final state

- `git diff -- ImageViewerProvider.tsx ImageViewerProvider.test.tsx`: empty.
- `git status --short --branch`: clean `feat/mms-image-viewer`.
- `.git/MERGE_HEAD`: absent.
- Full tests, smoke, e2e, typecheck, and ESLint were not run because no tracked
  change was made and the orchestrator stopped the corrective slice after the
  defect was refuted.
