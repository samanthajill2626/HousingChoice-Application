import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isCatalogPathIntercepted } from './firewall.js';
import { DASHBOARD_MUTATION_CATALOG } from './mutationCatalog.js';

type StaticMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Transport = 'request' | 'requestWithStatus' | 'fetch' | 'xhr_open';

interface RawDiscovery {
  file: string;
  enclosingSymbol: string;
  methodClass: `${Transport}:${StaticMethod | 'delegated_to_typed_request_options'}`;
  pathCategory: string;
}

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DASHBOARD_SRC = resolve(REPO_ROOT, 'dashboard/src');
const CLIENT_SOURCE = resolve(DASHBOARD_SRC, 'api/client.ts');

class DiscoveryError extends Error {
  constructor(readonly reason: 'unprovable_method' | 'unprovable_path') {
    super(reason);
  }
}

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === '__tests__' ? [] : sourceFilesUnder(fullPath);
      }
      if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) {
        return [];
      }
      return [fullPath];
    })
    .sort((left, right) => left.localeCompare(right));
}

function repositoryRelative(file: string): string {
  return relative(REPO_ROOT, file).replaceAll('\\', '/');
}

function enclosingSymbol(node: ts.Node, sourceFile: ts.SourceFile): string {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) || ts.isMethodDeclaration(current)) &&
      current.name !== undefined
    ) {
      return current.name.getText(sourceFile);
    }
    if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return '<module>';
}

function importedRequestBindings(file: string, sourceFile: ts.SourceFile): Map<string, Transport> {
  const bindings = new Map<string, Transport>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const importClause = statement.importClause;
    if (importClause?.namedBindings === undefined || !ts.isNamedImports(importClause.namedBindings)) continue;
    const modulePath = resolve(dirname(file), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'));
    if (modulePath !== CLIENT_SOURCE) continue;
    for (const element of importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === 'request' || imported === 'requestWithStatus') {
        bindings.set(element.name.text, imported);
      }
    }
  }
  return bindings;
}

function xhrBindings(sourceFile: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'XMLHttpRequest'
    ) {
      bindings.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function staticString(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return null;
}

function methodFromObject(expression: ts.Expression): StaticMethod | null {
  if (ts.isParenthesizedExpression(expression)) return methodFromObject(expression.expression);
  if (expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword ||
      ts.isIdentifier(expression) && expression.text === 'undefined') {
    return null;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return methodFromObject(expression.right);
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = methodFromObject(expression.whenTrue);
    const whenFalse = methodFromObject(expression.whenFalse);
    if (whenTrue !== null && whenFalse !== null && whenTrue !== whenFalse) {
      throw new DiscoveryError('unprovable_method');
    }
    return whenTrue ?? whenFalse;
  }
  if (!ts.isObjectLiteralExpression(expression)) throw new DiscoveryError('unprovable_method');

  let method: StaticMethod | null = null;
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadMethod = methodFromObject(property.expression);
      if (spreadMethod !== null && method !== null && spreadMethod !== method) {
        throw new DiscoveryError('unprovable_method');
      }
      method ??= spreadMethod;
      continue;
    }
    const name = property.name !== undefined && ts.isIdentifier(property.name)
      ? property.name.text
      : property.name !== undefined && ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    if (name !== 'method') continue;
    if (!ts.isPropertyAssignment(property)) throw new DiscoveryError('unprovable_method');
    const value = staticString(property.initializer)?.toUpperCase();
    if (value !== 'GET' && value !== 'POST' && value !== 'PUT' && value !== 'PATCH' && value !== 'DELETE') {
      throw new DiscoveryError('unprovable_method');
    }
    if (method !== null && method !== value) throw new DiscoveryError('unprovable_method');
    method = value;
  }
  return method;
}

function isCentralDelegatedFetch(file: string, symbol: string, call: ts.CallExpression): boolean {
  return file === CLIENT_SOURCE && symbol === 'requestWithStatus' &&
    call.arguments[0] !== undefined && ts.isCallExpression(call.arguments[0]) &&
    ts.isIdentifier(call.arguments[0].expression) && call.arguments[0].expression.text === 'buildUrl';
}

function methodClassFor(
  file: string,
  symbol: string,
  transport: Transport,
  call: ts.CallExpression,
): RawDiscovery['methodClass'] {
  if (transport === 'xhr_open') {
    const method = call.arguments[0] === undefined ? null : staticString(call.arguments[0])?.toUpperCase();
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
      throw new DiscoveryError('unprovable_method');
    }
    return `xhr_open:${method}`;
  }
  if (transport === 'fetch' && isCentralDelegatedFetch(file, symbol, call)) {
    return 'fetch:delegated_to_typed_request_options';
  }
  const options = call.arguments[1];
  const method = options === undefined ? 'GET' : methodFromObject(options) ?? 'GET';
  return `${transport}:${method}`;
}

function placeholderFor(expression: ts.Expression): string {
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'encodeURIComponent' && expression.arguments[0] !== undefined) {
    return placeholderFor(expression.arguments[0]);
  }
  if (ts.isIdentifier(expression)) return `:${expression.text}`;
  if (ts.isPropertyAccessExpression(expression)) return `:${expression.name.text}`;
  throw new DiscoveryError('unprovable_path');
}

function literalArgument(call: ts.CallExpression, index: number): string {
  const argument = call.arguments[index];
  const value = argument === undefined ? null : staticString(argument);
  if (value === null) throw new DiscoveryError('unprovable_path');
  return value;
}

function helperPath(call: ts.CallExpression): string | null {
  if (!ts.isIdentifier(call.expression)) return null;
  if (call.expression.text === 'rosterPath') {
    const resource = literalArgument(call, 0);
    const id = call.arguments[1];
    if ((resource !== 'tours' && resource !== 'placements') || id === undefined) {
      throw new DiscoveryError('unprovable_path');
    }
    return `/api/${resource}/${placeholderFor(id)}/roster`;
  }
  if (call.expression.text === 'pendingActionPath') {
    const resource = literalArgument(call, 0);
    const id = call.arguments[1];
    const actionId = call.arguments[2];
    const action = literalArgument(call, 3);
    if ((resource !== 'tours' && resource !== 'placements') || id === undefined || actionId === undefined ||
        (action !== 'cancel' && action !== 'apply-now' && action !== 'dismiss')) {
      throw new DiscoveryError('unprovable_path');
    }
    return `/api/${resource}/${placeholderFor(id)}/roster/pending/${placeholderFor(actionId)}/${action}`;
  }
  return null;
}

function normalizePathCategory(category: string): string {
  return category
    .replace('/api/unmatched-email/:id', '/api/unmatched-email/:unmatchedId')
    .replace('/messages/:providerSid/retry', '/messages/:messageId/retry')
    .replace('/members/:phone', '/members/:memberKey')
    .replace('/phones/:phone', '/phones/:phoneKey')
    .replace('/emails/:email', '/emails/:emailKey');
}

function pathCategoryFor(expression: ts.Expression, allowComputedRead: boolean): string {
  const literal = staticString(expression);
  if (literal !== null) return literal;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'post' && expression.name.text === 'url') {
    return 'external_presigned_storage';
  }
  if (ts.isCallExpression(expression)) {
    const helper = helperPath(expression);
    if (helper !== null) return normalizePathCategory(helper);
    if (ts.isIdentifier(expression.expression) && expression.expression.text === 'buildUrl') {
      return 'delegated_to_typed_request_options';
    }
  }
  if (ts.isTemplateExpression(expression)) {
    let category = expression.head.text;
    for (const span of expression.templateSpans) {
      if (ts.isCallExpression(span.expression)) {
        category += helperPath(span.expression) ?? placeholderFor(span.expression);
      } else {
        category += placeholderFor(span.expression);
      }
      category += span.literal.text;
    }
    return normalizePathCategory(category);
  }
  if (allowComputedRead && ts.isIdentifier(expression)) return 'computed_read_path';
  throw new DiscoveryError('unprovable_path');
}

function scanSource(file: string, text: string): RawDiscovery[] {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const requestBindings = importedRequestBindings(file, sourceFile);
  const xhrVariables = xhrBindings(sourceFile);
  const discoveries: RawDiscovery[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let transport: Transport | null = null;
      if (ts.isIdentifier(node.expression)) {
        transport = requestBindings.get(node.expression.text) ?? (node.expression.text === 'fetch' ? 'fetch' : null);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'open' &&
        ts.isIdentifier(node.expression.expression) &&
        xhrVariables.has(node.expression.expression.text)
      ) {
        transport = 'xhr_open';
      }
      if (transport !== null) {
        const symbol = enclosingSymbol(node, sourceFile);
        const methodClass = methodClassFor(file, symbol, transport, node);
        const method = methodClass.slice(methodClass.indexOf(':') + 1);
        const pathArgument = transport === 'xhr_open' ? node.arguments[1] : node.arguments[0];
        if (pathArgument === undefined) throw new DiscoveryError('unprovable_path');
        discoveries.push({
          file: repositoryRelative(file),
          enclosingSymbol: symbol,
          methodClass,
          pathCategory: pathCategoryFor(pathArgument, method === 'GET'),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return discoveries;
}

function scanDashboard(): RawDiscovery[] {
  return sourceFilesUnder(DASHBOARD_SRC).flatMap((file) => scanSource(file, readFileSync(file, 'utf8')));
}

function fingerprint(discovery: RawDiscovery): string {
  return [
    discovery.file,
    discovery.enclosingSymbol,
    discovery.methodClass,
    discovery.pathCategory,
  ].join(' :: ');
}

function catalogDiscoveries(raw: RawDiscovery[]): RawDiscovery[] {
  return raw.filter((discovery) =>
    !discovery.methodClass.endsWith(':GET') ||
    discovery.methodClass === 'fetch:delegated_to_typed_request_options',
  );
}

describe('dashboard mutation inventory', () => {
  const raw = scanDashboard();
  const catalogedRaw = catalogDiscoveries(raw);

  it('independently finds every live positive-control transport and automatic write', () => {
    expect(raw.filter((entry) => entry.enclosingSymbol === 'markInboxRead' && entry.methodClass === 'request:POST'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ pathCategory: '/api/inbox/:contactId/read' }),
        expect.objectContaining({ pathCategory: '/api/inbox/read' }),
      ]));
    expect(raw).toEqual(expect.arrayContaining([
      expect.objectContaining({ enclosingSymbol: 'markConversationRead', methodClass: 'request:POST', pathCategory: '/api/conversations/:conversationId/read' }),
      expect.objectContaining({ enclosingSymbol: 'markUnmatchedRead', methodClass: 'request:POST', pathCategory: '/api/unmatched-email/:unmatchedId/read' }),
      expect.objectContaining({ enclosingSymbol: 'provisionPlacementRelay', methodClass: 'requestWithStatus:POST', pathCategory: '/api/placements/:placementId/relay' }),
      expect.objectContaining({ enclosingSymbol: 'createTourRelay', methodClass: 'requestWithStatus:POST', pathCategory: '/api/tours/:tourId/relay' }),
      expect.objectContaining({ enclosingSymbol: 'uploadToPresignedPost', methodClass: 'xhr_open:POST', pathCategory: 'external_presigned_storage' }),
      expect.objectContaining({ enclosingSymbol: 'uploadToPresignedPost', methodClass: 'fetch:POST', pathCategory: 'external_presigned_storage' }),
      expect.objectContaining({ enclosingSymbol: 'submitHousingFair', methodClass: 'request:POST', pathCategory: '/public/housing-fair' }),
      expect.objectContaining({ enclosingSymbol: 'getMe', methodClass: 'request:GET', pathCategory: '/auth/me' }),
      expect.objectContaining({ enclosingSymbol: 'requestWithStatus', methodClass: 'fetch:delegated_to_typed_request_options', pathCategory: 'delegated_to_typed_request_options' }),
    ]));
  });

  it('rejects computed, spread-derived, and aliased methods in synthetic source', () => {
    const fixtures = [
      "export function unsafe(method: string) { return fetch('/api/x', { method }); }",
      "export function unsafe(options: RequestInit) { return fetch('/api/x', { ...options }); }",
      "export function unsafe(options: RequestInit) { return fetch('/api/x', options); }",
    ];
    for (const fixture of fixtures) {
      expect(() => scanSource(resolve(DASHBOARD_SRC, 'synthetic.ts'), fixture)).toThrowError('unprovable_method');
    }
  });

  it('matches the complete checked-in catalog in both directions without line fingerprints', () => {
    const discoveredFingerprints = catalogedRaw.map(fingerprint).sort();
    const checkedInFingerprints = DASHBOARD_MUTATION_CATALOG.map((entry) => entry.fingerprint).sort();
    // 103 = the 102 pre-manual-trigger mutations + runExtraction
    // (manual-extraction-trigger 4.6's POST /api/contacts/:contactId/extraction-run).
    expect(catalogedRaw.filter((entry) => !entry.methodClass.includes('delegated_to_typed_request_options'))).toHaveLength(103);
    expect(new Set(discoveredFingerprints).size).toBe(discoveredFingerprints.length);
    expect(new Set(checkedInFingerprints).size).toBe(checkedInFingerprints.length);
    expect(checkedInFingerprints).toEqual(discoveredFingerprints);
    expect(DASHBOARD_MUTATION_CATALOG.every((entry) => !('line' in entry) && !('lineNumber' in entry))).toBe(true);
    expect(checkedInFingerprints.every((value) => !/\.(?:ts|tsx):\d+\b/.test(value))).toBe(true);
  });

  it('classifies the exact automatic and residual-interception surfaces', () => {
    const byPath = (pathCategory: string) => DASHBOARD_MUTATION_CATALOG.filter((entry) => entry.pathCategory === pathCategory);
    expect(DASHBOARD_MUTATION_CATALOG.filter((entry) => entry.behavior === 'automatic_in_scope'))
      .toHaveLength(4);
    expect(DASHBOARD_MUTATION_CATALOG.filter((entry) => entry.behavior === 'automatic_in_scope'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ pathCategory: '/api/inbox/:contactId/read', interception: 'first_party_api' }),
        expect.objectContaining({ pathCategory: '/api/inbox/read', interception: 'first_party_api' }),
        expect.objectContaining({ pathCategory: '/api/conversations/:conversationId/read', interception: 'first_party_api' }),
        expect.objectContaining({ pathCategory: '/api/unmatched-email/:unmatchedId/read', interception: 'first_party_api' }),
      ]));
    expect(byPath('/api/broadcasts')).toContainEqual(expect.objectContaining({
      enclosingSymbol: 'createBroadcast',
      behavior: 'automatic_out_of_scope',
    }));
    expect(byPath('/api/broadcasts/:broadcastId')).toContainEqual(expect.objectContaining({
      enclosingSymbol: 'deleteBroadcast',
      behavior: 'automatic_out_of_scope',
    }));
    expect(byPath('external_presigned_storage')).toHaveLength(2);
    expect(byPath('external_presigned_storage')).toEqual(expect.arrayContaining([
      expect.objectContaining({ behavior: 'workflow_only', interception: 'outside_interception', methodClass: 'fetch:POST' }),
      expect.objectContaining({ behavior: 'workflow_only', interception: 'outside_interception', methodClass: 'xhr_open:POST' }),
    ]));
    expect(byPath('/public/housing-fair')).toEqual([
      expect.objectContaining({ behavior: 'workflow_only', interception: 'outside_interception' }),
    ]);
    for (const entry of DASHBOARD_MUTATION_CATALOG) {
      expect(entry.interception).toBe(
        isCatalogPathIntercepted(entry.pathCategory) ? 'first_party_api' : 'outside_interception',
      );
    }
    expect(DASHBOARD_MUTATION_CATALOG.filter((entry) => entry.behavior === 'automatic_in_scope')
      .every((entry) => isCatalogPathIntercepted(entry.pathCategory))).toBe(true);
  });
});
