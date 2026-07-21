---
id: compiled-dist-boot-unverified
title: No gate boots the compiled dist - tsx-only suites miss plain-node ESM resolution failures
type: debt
severity: med
status: open
area: build
created: 2026-07-21
refs: app/src/adapters/email.ts:17
---

**Problem.** Every gate (unit, e2e, dev servers) runs TypeScript through
tsx/esbuild, which resolve imports like a bundler. The deployed container runs
the real `tsc` output under plain `node dist/index.js`, whose ESM loader is
stricter. The gap is real: the email channel shipped a
`nodemailer/lib/mail-composer` DIRECTORY import that every suite passed and
the 2026-07-21 dev deploy crash-looped on (ERR_UNSUPPORTED_DIR_IMPORT) -
caught only by the deploy health check, after image build + push. Any
future bundler-only resolution (directory imports, extensionless deep
subpaths, exports-map violations) will repeat this: green gates, dead
container.

**Suggested fix.** Add a cheap "dist boot smoke" gate: `npm run build`
(app workspace tsc) then launch `node dist/index.js` and `node
dist/worker.js` with a hermetic env just long enough to reach the ready log
line (module-link errors throw before any I/O, so even an
import-graph-only probe - `node --input-type=module -e "await
import('./dist/index.js')"` guarded against side effects - catches the
class). Wire it into `npm run typecheck` or a new `npm run smoke` the
branch-hygiene gate list adopts.
