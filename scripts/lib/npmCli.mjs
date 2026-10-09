// Locate npm's JS entry point (npm-cli.js) so a launcher can run npm as
// `process.execPath npm-cli.js ...` - no PATH lookup, no shell, no npm.cmd.
//
// Where npm lives depends on how Node was installed:
//
//   Windows installer   <dir>\node.exe        + <dir>\node_modules\npm
//   POSIX tarball/nvm   <prefix>/bin/node     + <prefix>/lib/node_modules/npm
//
// The launcher used to assume the Windows layout everywhere, so on Linux the
// fake-phones UI build died with `Cannot find module .../bin/node_modules/npm/
// bin/npm-cli.js` and the e2e stack never booted.
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Absolute path of npm-cli.js. Prefers `npm_execpath` - npm sets it for every
 * script it runs, so it names the npm actually in use - then probes both
 * install layouts beside `execPath`. Throws, listing every place it looked,
 * when none exists.
 */
export function resolveNpmCli({ env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  const candidates = [];
  // npx sets npm_execpath to npx-cli.js, which would turn `run build` into
  // `npx run build`; only an npm-cli.js is a usable npm.
  const fromEnv = env.npm_execpath;
  if (fromEnv && path.basename(fromEnv) === 'npm-cli.js') candidates.push(fromEnv);
  const binDir = path.dirname(execPath);
  candidates.push(path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const found = candidates.find((candidate) => exists(candidate));
  if (found === undefined) {
    throw new Error(`cannot locate npm-cli.js for ${execPath}; looked in:\n  ${candidates.join('\n  ')}`);
  }
  return found;
}
