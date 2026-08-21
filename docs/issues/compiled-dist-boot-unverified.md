---
id: compiled-dist-boot-unverified
title: No gate boots the compiled dist - tsx-only suites miss plain-node ESM resolution failures
type: debt
severity: med
status: resolved
area: build
created: 2026-07-21
resolved: 2026-08-21
refs: scripts/smoke-dist.mjs, package.json, app/src/adapters/email.ts:17
---

**Resolution (2026-08-21, `fix/test-suite-hardening`).** `npm run smoke` -
builds the app workspace, then checks that every static import specifier in the
COMPILED output resolves the way plain Node would.

**Resolution, not execution.** The suggested fix floated importing the
entrypoints. That works but STARTS THE APP - binds ports, opens clients, runs
timers - which makes the gate heavy and environment-dependent. The failure class
is purely resolution (directory imports, extensionless deep subpaths,
exports-map violations), so the check drives Node's own ESM resolver instead:
no Docker, no ports, no network, ~1 second.

**Two vacuous versions were caught before this shipped, by mutation-probing the
gate itself rather than trusting a green tick.** Both are worth knowing because
either would have produced a permanently-passing check:

1. `import.meta.resolve` answers "what URL does this map to", NOT "is that
   loadable". A DIRECTORY import - the exact 2026-07-21 crash - resolves
   happily; `ERR_UNSUPPORTED_DIR_IMPORT` is raised by the LOADER. Fixed by
   stat-ing the resolved target the way the loader would.
2. Worse: `import.meta.resolve(specifier, parent)` requires
   `--experimental-import-meta-resolve`. Without it Node does not error - it
   SILENTLY IGNORES the parent and resolves against the script's own directory.
   The first version happily reported "1325 specifiers OK" while checking
   nothing about `dist` at all.

Because (2) degrades silently, the script now SELF-CHECKS that the parent
argument is honoured and refuses to run if it is not. A gate that cannot fail is
worse than no gate.

Proven against the real failure modes:

```
baseline                      OK - 1325 specifiers across 232 files   exit 0
inject `import './lib'`       ERR_UNSUPPORTED_DIR_IMPORT              exit 1
inject `'./lib/nope.js'`      ERR_MODULE_NOT_FOUND                    exit 1
restored                      OK                                      exit 0
```

**Open for the human:** `AGENTS.md` lists three required completion gates
(typecheck / test / e2e). This should arguably be the fourth - it is ~1s and
catches a class none of the other three can see. Editing that list is shared
project law, so it is flagged rather than done.

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
