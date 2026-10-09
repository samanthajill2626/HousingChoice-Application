// "Was this module run as the CLI entry point, or merely imported?" - the
// guard a dual-use script (exports for tests, side effects when run) needs.
//
// Node resolves process.argv[1] to an ABSOLUTE path before any user code runs,
// and import.meta.url is that path as a file URL. pathToFileURL is the one
// conversion that gets both platforms right:
//
//   Windows  C:\repo\e2e\support\lane.mjs  -> file:///C:/repo/e2e/support/lane.mjs
//   POSIX    /home/u/repo/e2e/support/lane.mjs -> file:///home/u/repo/e2e/support/lane.mjs
//
// The hand-rolled `file:///${argv1.replace(/\\/g, '/')}` it replaces was only
// right on Windows: a POSIX argv[1] already starts with '/', so it produced
// `file:////home/...` (four slashes), never matched, and every guarded CLI
// silently did nothing on Linux - lane.mjs printed no JSON, so the e2e config
// died on `Unexpected end of JSON input` before any test ran.
import { pathToFileURL } from 'node:url';

/**
 * True when `moduleUrl` (pass `import.meta.url`) is the module Node was asked
 * to run, i.e. `argv1` names it. `windows` selects the path flavour and
 * defaults to the running platform; it exists so tests can pin both flavours
 * on one machine.
 */
export function isMainModule(moduleUrl, argv1 = process.argv[1], { windows } = {}) {
  if (typeof argv1 !== 'string' || argv1 === '') return false;
  return moduleUrl === pathToFileURL(argv1, { windows }).href;
}
