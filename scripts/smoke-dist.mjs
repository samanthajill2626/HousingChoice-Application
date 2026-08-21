// smoke-dist - prove the COMPILED output actually links under plain Node.
//
// WHY THIS EXISTS
// ---------------
// Every gate in this repo runs TypeScript through tsx/esbuild, which resolves
// imports like a bundler. Production runs the real `tsc` output under plain
// `node dist/index.js`, whose ESM loader is stricter. Nothing bridged that gap.
//
// It has already cost us a deploy: the email channel shipped a
// `nodemailer/lib/mail-composer` DIRECTORY import that every suite passed and
// the 2026-07-21 dev deploy crash-looped on (ERR_UNSUPPORTED_DIR_IMPORT). It
// was caught by the deploy health check, after image build and push.
// See docs/issues/compiled-dist-boot-unverified.md.
//
// WHY RESOLUTION, NOT EXECUTION
// -----------------------------
// The failure class is RESOLUTION - directory imports, extensionless deep
// subpaths, exports-map violations. `import()`ing the entrypoints would catch
// it, but it would also START THE APP: bind ports, open clients, run timers.
// `import.meta.resolve` runs Node's real ESM resolver and throws exactly the
// same ERR_UNSUPPORTED_DIR_IMPORT / ERR_MODULE_NOT_FOUND / ERR_PACKAGE_PATH_NOT_EXPORTED
// for the same inputs, with ZERO side effects. So this is fast, hermetic, and
// safe to run anywhere - no Docker, no ports, no network.
//
// Usage: npm run smoke   (after npm run build -w @housingchoice/app)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = path.join(repoRoot, 'app', 'dist');

if (!existsSync(distDir)) {
  process.stderr.write(
    `smoke-dist: ${distDir} does not exist. Build first:\n` +
      `  npm run build -w @housingchoice/app\n`,
  );
  process.exit(1);
}

/** Every emitted .js file under dist. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Static import/export specifiers in one emitted file.
 *
 * Deliberately regex rather than a parser: tsc's ESM output is boringly
 * regular (one specifier per statement, always quoted), and a parser
 * dependency for a smoke gate is not worth it. Dynamic import() with a
 * non-literal argument is skipped - it cannot be resolved statically, and the
 * bug class we are hunting is in static graphs.
 */
function specifiersIn(source) {
  const specs = new Set();
  const patterns = [
    /(?:^|\n)\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

const files = jsFiles(distDir);
if (files.length === 0) {
  process.stderr.write('smoke-dist: dist exists but contains no .js - build output is empty.\n');
  process.exit(1);
}

// SELF-CHECK: prove this tool is not vacuous before trusting a green result.
//
// `import.meta.resolve(specifier, parent)` needs --experimental-import-meta-resolve.
// WITHOUT it Node does not error - it SILENTLY IGNORES the parent and resolves
// against this script's own location. The first version of this file shipped
// that way and cheerfully reported "1325 specifiers OK" while checking nothing
// about dist at all. A gate that cannot fail is worse than no gate, so verify
// the parent argument is actually honoured and refuse to run if it is not.
{
  const probeParent = pathToFileURL(path.join(distDir, '__smoke_probe__.js')).href;
  let honoured = false;
  try {
    honoured = import.meta.resolve('./index.js', probeParent) ===
      pathToFileURL(path.join(distDir, 'index.js')).href;
  } catch {
    honoured = false;
  }
  if (!honoured) {
    process.stderr.write(
      'smoke-dist: import.meta.resolve is ignoring its parent argument, so this check would\n' +
        'be vacuous. Run it with the flag (that is what `npm run smoke` does):\n' +
        '  node --experimental-import-meta-resolve scripts/smoke-dist.mjs\n',
    );
    process.exit(1);
  }
}

const failures = [];
let checked = 0;

for (const file of files) {
  const parent = pathToFileURL(file).href;
  for (const spec of specifiersIn(readFileSync(file, 'utf8'))) {
    if (spec.startsWith('node:')) continue; // builtins always resolve
    checked += 1;
    try {
      const resolved = import.meta.resolve(spec, parent);
      // RESOLVE IS NOT ENOUGH, and this cost me a vacuous gate once already.
      // `import.meta.resolve` answers "what URL does this specifier map to",
      // NOT "is that a loadable module". ERR_UNSUPPORTED_DIR_IMPORT - the exact
      // error that crash-looped the 2026-07-21 deploy - is raised by the LOADER,
      // so a directory import resolves happily here and the check would pass.
      // Verified by injecting `import './lib'` into dist/app.js: resolve alone
      // reported OK. So stat the target the way the loader would.
      if (resolved.startsWith('file:')) {
        const target = fileURLToPath(resolved);
        if (!existsSync(target)) {
          throw Object.assign(new Error(`resolves to a path that does not exist: ${target}`), {
            code: 'ERR_MODULE_NOT_FOUND',
          });
        }
        if (statSync(target).isDirectory()) {
          throw Object.assign(
            new Error(`resolves to a DIRECTORY, which plain Node cannot import: ${target}`),
            { code: 'ERR_UNSUPPORTED_DIR_IMPORT' },
          );
        }
      }
    } catch (err) {
      failures.push({
        file: path.relative(repoRoot, file),
        spec,
        code: err?.code ?? err?.name ?? 'unknown',
        message: String(err?.message ?? err).split('\n')[0],
      });
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `\nsmoke-dist: ${failures.length} import(s) in the COMPILED output do not resolve under plain Node.\n` +
      `These pass under tsx/esbuild (bundler resolution) and would crash-loop the container.\n\n`,
  );
  for (const f of failures) {
    process.stderr.write(`  ${f.file}\n    imports '${f.spec}'\n    ${f.code}: ${f.message}\n\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `smoke-dist: OK - ${checked} import specifier(s) across ${files.length} emitted file(s) ` +
    `resolve under plain Node.\n`,
);
