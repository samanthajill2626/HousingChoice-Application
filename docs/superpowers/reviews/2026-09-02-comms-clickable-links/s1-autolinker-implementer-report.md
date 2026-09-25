# S1 Autolinker implementer report

Date: 2026-09-02
Slice: S1 safe shared linkifier

## Delivered

- Added direct dashboard runtime dependency `autolinker@4.1.5` and its only runtime
  transitive dependency `tslib@2.8.1` in `package-lock.json`.
- Added `LinkifiedText`, `tokenizeLinkifiedText`, `LinkifiedTextProps`, and
  `LinkifiedToken` exports. The parser call uses only public static
  `Autolinker.parse` with the approved URL-only configuration.
- The parser-only source replaces raw angle delimiters with same-code-unit
  full-width forms, while source ranges, labels, and candidates always slice the
  original input. Candidate normalization and `safeHttpUrl` rejection follow the
  approved protocol-relative and `tld` rules.
- Added focused coverage for normalization, parser-owned punctuation and brackets,
  current and international public domains, local/non-web rejection, unsupported
  schemes, raw tag/comment-shaped source, literal `&amp;`, clipping, escaped React
  rendering, anchor attributes, and click propagation.

## TDD and focused proof

- RED: `npm test --workspace @housingchoice/dashboard -- src/ui/LinkifiedText.test.tsx`
  exited 1 with the expected unresolved `./LinkifiedText.js` module error after the
  dependency was installed. The initial sandboxed test attempt also exited 1 before
  collection because Vite could not create its cache; the elevated rerun established
  the intended red state.
- GREEN: the same focused command exited 0: 1 file passed, 19 tests passed.
- `npm run typecheck --workspace @housingchoice/dashboard` exited 0.
- `npm run build --workspace @housingchoice/dashboard` exited 0. Vite built 377
  modules. It emitted the existing generic over-500-kB chunk-size advisory only.
- `npm ci` completed successfully in the Windows feature worktree before the final
  production build.

## Dependency and platform proof

- `npm ls --workspace @housingchoice/dashboard autolinker tslib --depth=1` showed
  `autolinker@4.1.5` with `tslib@2.8.1`.
- Installed manifest: MIT license; no `preinstall`, `install`, or `postinstall`
  lifecycle hook; zero optional dependencies and no native binary path.
- `npm audit --workspace @housingchoice/dashboard --omit=dev --json` reported four
  pre-existing high findings in `nanoid`, `postcss`, and `react-router`/
  `react-router-dom`; it reported no Autolinker finding. No remediation outside this
  dependency delta was made.
- Disposable `docker run --rm --platform linux/arm64 node:24-slim` installed with
  `--ignore-scripts`, imported the public API, and printed
  `linux-arm64-linkifier-ok` (exit 0) for port/path/query/fragment, protocol-relative,
  `www`, masked raw-tag offset, literal ampersand, and `.zip` checks.

## Implementation note

The public declaration accepts `hashtag: false`, but a plain object widens it to
`boolean` under TypeScript. The exact runtime object is declared `as const`, keeping
the approved value `false` and satisfying the public API type without changing the
parser configuration.

## Changed paths

- `dashboard/package.json`
- `package-lock.json`
- `dashboard/src/ui/LinkifiedText.tsx`
- `dashboard/src/ui/LinkifiedText.module.css`
- `dashboard/src/ui/LinkifiedText.test.tsx`
- `dashboard/src/ui/index.ts`

## Commit

`691e6291 feat(dashboard): add safe communications linkifier`

## S2 interface

Import from `dashboard/src/ui/index.js`:

```ts
import {
  LinkifiedText,
  tokenizeLinkifiedText,
  type LinkifiedTextProps,
  type LinkifiedToken,
} from '../../ui/index.js';
```

`LinkifiedText` accepts `{ text, displayEnd?, suffix? }`. For Timeline's collapsed
email body, S2 must parse the full body through this component, supply the computed
display end, and supply the existing suffix separately; link labels can be clipped
while their `href` remains based on the full source match.
