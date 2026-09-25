# S1 plaintext-node follow-up report

## Scope

- Owned tracked files: `dashboard/src/ui/LinkifiedText.tsx` and `dashboard/src/ui/LinkifiedText.test.tsx` only.
- No parser options, source mapping, URL safety boundary, link attributes, CSS, public exports, or integration sites changed.

## TDD evidence

- RED: `npm test --workspace @housingchoice/dashboard -- src/ui/LinkifiedText.test.tsx` exited 1 after the new direct-render regression. The expected failure showed direct child 0 was `<span>before </span>` where the contract requires a `Node.TEXT_NODE` with `nodeValue: 'before '`.
- GREEN: replaced text-token `<span>` output with keyed React `Fragment` output. The focused command then exited 0: 1 test file, 20 tests.

## Requested verification

- `npm run typecheck --workspace @housingchoice/dashboard` exited 0.
- `npm run build --workspace @housingchoice/dashboard` exited 0. Vite emitted its pre-existing chunk-size advisory only; build completed successfully.

## Changed-path summary

- `LinkifiedText.tsx`: import and use keyed `Fragment` for text token output, so unlinked content remains direct DOM text nodes.
- `LinkifiedText.test.tsx`: assert the two non-link tokens around an anchor are direct text nodes and no span exists in the component's direct render.

## Commit

- `97f0661c fix(dashboard): preserve plain linkifier text nodes`
