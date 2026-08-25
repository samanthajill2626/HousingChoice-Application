// app/test/logCallSiteGuard.test.ts
// STATIC GUARD (log-hygiene spec section 3 guard 2): parse app/src with the
// TypeScript compiler and FAIL when an identifier DECLARED BY A CATCH CLAUSE
// (or any Error-typed value) is assigned to a logger-call property that is
// not a top-level wired key.
//
// WHY CATCH-CLAUSE, NOT TYPES ALONE: under `strict: true` every bare
// `catch (e)` binding is `unknown` (464 sites, zero annotations), so a
// purely type-based check flags nothing, forever; a name-regex check
// false-positives on domain uses (`refusal: err.code`,
// `message: errorMessage(err)`). A BARE identifier whose declaration is a
// CatchClause is exactly "an error", regardless of its static type.
//
// KNOWN LIMITS - do not mistake a green run for proof (the
// tourCopyCallSites.test.ts precedent): a payload hoisted into a const and
// passed as an identifier, a spread of a helper's return, a catch variable
// laundered through a local, and an error stringified into `msg` are all
// invisible to this guard. Accepted: the serializer (Task 1) plus the sweep
// baseline (Task 4) carry those; this is a ratchet against the common
// literal form, not a proof.
import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { LOG_SERIALIZER_KEYS } from '../src/lib/logSerializers.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(TEST_DIR, '..');
const WIRED = new Set<string>(LOG_SERIALIZER_KEYS);
const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const CANARY_NAME = '__guard_canary__.ts';
const CANARY_SOURCE = [
  'declare const log: { error(payload: object, msg: string): void };',
  'export function canary(): void {',
  '  try { JSON.parse("x"); } catch (err) { log.error({ ctx: { err } }, "boom"); }',
  '}',
  '',
].join('\n');

interface GuardProgram { program: ts.Program; checker: ts.TypeChecker }

/** Build over the REAL app tsconfig; optionally overlay the canary file. */
function buildProgram(withCanary: boolean): GuardProgram {
  const configPath = join(APP_DIR, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    { noEmit: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error('failed to parse app/tsconfig.json');
  const canaryPath = join(APP_DIR, 'src', CANARY_NAME);
  const rootNames = withCanary ? [...parsed.fileNames, canaryPath] : parsed.fileNames;
  const host = ts.createCompilerHost(parsed.options);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, langVersion, ...rest) =>
    fileName.endsWith(CANARY_NAME)
      ? ts.createSourceFile(fileName, CANARY_SOURCE, langVersion, true)
      : realGetSourceFile(fileName, langVersion, ...rest);
  const realFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fileName.endsWith(CANARY_NAME) || realFileExists(fileName);
  const program = ts.createProgram(rootNames, parsed.options, host);
  return { program, checker: program.getTypeChecker() };
}

/** Exact-format findings: `<relative-file>:<line> <key>`. */
function scanProgram({ program, checker }: GuardProgram): string[] {
  const findings: string[] = [];

  const isCatchDeclared = (sym: ts.Symbol | undefined): boolean => {
    const decl = sym?.valueDeclaration;
    return decl !== undefined && ts.isVariableDeclaration(decl) && ts.isCatchClause(decl.parent);
  };
  const isErrorTyped = (node: ts.Node): boolean => {
    const type = checker.getTypeAtLocation(node);
    return type.getSymbol()?.getName() === 'Error' || checker.typeToString(type) === 'Error';
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const inScope = sf.fileName.includes('/src/') || sf.fileName.includes('\\src\\') || sf.fileName.endsWith(CANARY_NAME);
    if (!inScope) continue;
    const report = (node: ts.Node, key: string): void => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      const rel = sf.fileName.slice(sf.fileName.lastIndexOf('src'));
      findings.push(`${rel}:${line + 1} ${key}`);
    };
    const walkPayload = (obj: ts.ObjectLiteralExpression, depth: number): void => {
      for (const prop of obj.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          const keyName = prop.name.text;
          const legal = depth === 0 && WIRED.has(keyName);
          const valueSym = checker.getShorthandAssignmentValueSymbol(prop);
          if (!legal && (isCatchDeclared(valueSym ?? undefined) || isErrorTyped(prop.name))) {
            report(prop, keyName);
          }
        } else if (ts.isPropertyAssignment(prop)) {
          const keyName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : '<computed>';
          const legal = depth === 0 && WIRED.has(keyName);
          const value = prop.initializer;
          if (!legal && ts.isIdentifier(value)
              && (isCatchDeclared(checker.getSymbolAtLocation(value) ?? undefined) || isErrorTyped(value))) {
            report(prop, keyName);
          }
          if (ts.isObjectLiteralExpression(value)) walkPayload(value, depth + 1);
        }
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        LOG_METHODS.has(node.expression.name.text) &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0]!)
      ) {
        walkPayload(node.arguments[0] as ts.ObjectLiteralExpression, 0);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return findings;
}

// ONE program answers all three questions (a full app/src compile is
// expensive; building it two or three times inside `npm test` is not worth
// paying - review round 2). The canary rides the real program; health
// diagnostics and the allowlist scan simply filter it out.
describe('logger call-site guard', () => {
  // beforeAll, NOT describe-body: describe bodies run at COLLECTION, where
  // no test timeout applies and a buildProgram throw fails the whole file
  // with no case to key on. The explicit timeout covers the full compile.
  let gp: GuardProgram;
  let findings: string[];
  beforeAll(() => {
    gp = buildProgram(true);
    findings = scanProgram(gp);
  }, 180_000);

  it('the real program is healthy: files resolved, no unresolved-module diagnostics', () => {
    const sourceCount = gp.program
      .getSourceFiles()
      .filter((f) => !f.isDeclarationFile && !f.fileName.endsWith(CANARY_NAME)).length;
    expect(sourceCount).toBeGreaterThan(50);
    // TS2307 = cannot find module. A misconfigured program resolves nothing,
    // reports these, and would otherwise scan an empty world and pass.
    const unresolved = ts
      .getPreEmitDiagnostics(gp.program)
      .filter((d) => d.code === 2307 && !(d.file?.fileName.endsWith(CANARY_NAME) ?? false))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
    expect(unresolved).toEqual([]);
  });

  it('the canary overlaid into the REAL program is flagged (positive control)', () => {
    expect(findings.some((f) => f.includes(CANARY_NAME))).toBe(true);
  });

  it('app/src has no error logged outside a wired key (allowlist starts EMPTY)', () => {
    // Reviewed exceptions: EXACT `file:line key` strings with a justifying
    // comment each. Starts empty (spec section 3).
    const ALLOWLIST = new Set<string>([]);
    const unexpected = findings
      .filter((f) => !f.includes(CANARY_NAME))
      .filter((f) => !ALLOWLIST.has(f));
    expect(unexpected).toEqual([]);
  });
});
