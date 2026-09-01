// Guards for the per-file DynamoDB Local isolation in
// app/test/setup/dynamoAccessKey.ts.
//
// Each of these has been mutation-probed: the defect it names was reintroduced
// and the assertion was confirmed to fail. A guard that has never failed is
// worth nothing.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CreateTableCommand,
  DeleteTableCommand,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';

import { fileAccessKeyId, testAccessKeyId } from '../../../e2e/support/lane.mjs';
import { createDynamoClient } from '../../src/lib/dynamo.js';
import {
  accessKeyForTestFile,
  optsIntoSharedLocalTables,
  SHARED_LOCAL_TABLES_MARKER,
  testFileId,
} from './dynamoAccessKey.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..', '..');
const TEST_DIR = path.resolve(APP_DIR, 'test');

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();

/**
 * Set when someone exported AWS_ACCESS_KEY_ID - a supported override that puts
 * every file back on ONE key. The per-file assertions below do not hold in that
 * regime, and must skip rather than red.
 */
const explicitKey = Boolean(process.env.HC_TEST_EXPLICIT_ACCESS_KEY);

/**
 * A suite carrying this marker keeps its container tables safe from concurrent
 * worktrees by deriving every access key it uses from the WORKTREE identity
 * (testAccessKeyId) instead of by randomising table names. Checked by the
 * fixed-name invariant below.
 */
const WORKTREE_DERIVED_KEYS_MARKER = 'hc:dynamo-lane worktree-derived-keys';

/**
 * A suite carrying this marker never opens a DynamoDB Local database - it
 * drives a stub client and creates no container tables; declared so the
 * creates-tables guard does not read its imports as container writes.
 *
 * The two markers above are the "this suite DOES create container tables, and
 * here is how it stays collision-free" declarations. This one is the third
 * answer: the premise is false. A pure stub suite legitimately names
 * ensureTable and CreateTableCommand in its source without ever sending them
 * anywhere, and salting its stub table names with randomUUID() to satisfy the
 * regex mechanically would pass the guard by pretending the names are
 * container tables.
 */
const NO_CONTAINER_TABLES_MARKER = 'hc:dynamo-lane none';

/**
 * Matched as a DECLARATION LINE, not as a substring - the rule
 * optsIntoSharedLocalTables already applies to the shared marker, and for a
 * concrete reason here: THIS file defines the constant above and imports the
 * container-reaching client factory, so a substring match would make the guard
 * exempt (and then flag) itself. Prose about the marker must never behave as
 * the marker. Built from the constant so the text exists in one place.
 */
const NO_CONTAINER_TABLES_LINE = new RegExp(
  `^\\s*//\\s*${NO_CONTAINER_TABLES_MARKER}\\.?\\s*$`,
  'm',
);

/** True when this suite has declared that it touches no DynamoDB Local database. */
function declaresNoContainerTables(absPath: string): boolean {
  return NO_CONTAINER_TABLES_LINE.test(readFileSync(absPath, 'utf8'));
}

/**
 * What a `none` suite must not contain. Kept beside the marker so the two rot
 * together or not at all.
 *
 * THIS IS A ONE-FILE SOURCE SCAN AND IT DOES NOT FOLLOW IMPORTS. It is a
 * statement about the declaring file's own text, not about its module graph, so
 * a helper module that builds a client on the suite's behalf is invisible to it.
 * What it does name is the set of entry points a test file uses to reach the
 * container directly: the app's own client factory (src/lib/dynamo.js) and its
 * three constructors, and the table-creating script/setup modules
 * (db-create.js, db-seed.js, globalSetup.js, globalTeardown.js) and the helpers
 * they export - because createAllTables builds its own client and creates all 22
 * specs under FIXED names, which is the cross-worktree collision this guard
 * exists to prevent. A quoted hc-local- prefix or a TABLE_PREFIX key is the
 * second half: a stub suite has no business naming real tables.
 *
 * THE KNOWN ONE-HOP GAP, live in the tree today: dynamoAdminRetry.test.ts
 * imports scripts/db-update-gsis.js, which imports the client factory. Harmless
 * - that module's client construction sits behind its CLI argv guard and never
 * runs under vitest - and db-update-gsis.js is deliberately NOT listed below,
 * since listing it would flag the one legitimate `none` suite in the tree. It is
 * the concrete measure of what a text scan cannot see.
 *
 * Every alternative is CODE-SHAPED on purpose - an import clause, a call, a
 * quoted prefix, an object key. The very comment that declares the marker has
 * to be able to explain what it is exempt from, and a bare-substring version of
 * this check flagged this file's own declaring suite for saying the words
 * "src/lib/dynamo.js" in that explanation.
 */
const CONTAINER_REACHING = new RegExp(
  [
    String.raw`from\s+['"][^'"]*\/dynamo\.js['"]`,
    String.raw`from\s+['"][^'"]*\/db-create\.js['"]`,
    String.raw`from\s+['"][^'"]*\/db-seed\.js['"]`,
    String.raw`from\s+['"][^'"]*\/globalSetup\.js['"]`,
    String.raw`from\s+['"][^'"]*\/globalTeardown\.js['"]`,
    String.raw`\b(?:createDynamoClient|createDocumentClient|getDocumentClient)\s*\(`,
    String.raw`\b(?:createAllTables|dropAllTables|ensureKeyedLocalTables|dropKeyedLocalTables)\s*\(`,
    String.raw`['"\`]hc-local-`,
    String.raw`\bTABLE_PREFIX\b\s*:`,
  ].join('|'),
);

/** Every *.test.ts under the app workspace - i.e. everything this hook governs. */
function allAppTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) allAppTestFiles(full, out);
    else if (full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('per-file DynamoDB Local access keys', () => {
  it('the setup hook actually ran, and pinned THIS file to the key it computes', () => {
    // The end-to-end proof that setupFiles fires and that the key it computes
    // is the one the SDK will pick up. Without this, every other assertion here
    // could pass while the hook never ran at all.
    //
    // Asserted through accessKeyForTestFile rather than against the per-file
    // key directly, because an exported AWS_ACCESS_KEY_ID is a SUPPORTED way to
    // run this suite (it is how the old shared-key regime was measured), and
    // pinning the per-file branch unconditionally made that configuration a
    // false red.
    expect(process.env.AWS_ACCESS_KEY_ID).toBe(
      accessKeyForTestFile(fileURLToPath(import.meta.url), {
        worktreeKey: process.env.HC_TEST_WORKTREE_ACCESS_KEY ?? '',
        explicitKey: process.env.HC_TEST_EXPLICIT_ACCESS_KEY,
      }),
    );
  });

  it.skipIf(explicitKey)('gives THIS file a key of its own, distinct from the worktree key', () => {
    // The per-file branch specifically. Skipped only when an explicit key has
    // deliberately overridden the whole scheme.
    expect(process.env.AWS_ACCESS_KEY_ID).toBe(
      fileAccessKeyId(testFileId(fileURLToPath(import.meta.url))),
    );
    expect(process.env.AWS_ACCESS_KEY_ID).not.toBe(testAccessKeyId());
  });

  it('mints a DISTINCT key for every test file in the app workspace', () => {
    // djb2 is 32-bit. With ~350 files a collision is unlikely but not
    // impossible, and a collision means two suites silently share a database
    // and its locks again - the exact bug this hook removes, reappearing for
    // one arbitrary pair. Enumerate rather than trust the birthday bound.
    const files = allAppTestFiles(APP_DIR);
    expect(files.length).toBeGreaterThan(100);

    const byKey = new Map<string, string[]>();
    for (const f of files) {
      const key = fileAccessKeyId(testFileId(f));
      byKey.set(key, [...(byKey.get(key) ?? []), testFileId(f)]);
    }

    const collisions = [...byKey.entries()].filter(([, fs]) => fs.length > 1);
    expect(collisions).toEqual([]);
  });

  it('mints keys DynamoDB Local will accept - alphanumeric only', () => {
    // Once -sharedDb is off the access key is validated: '-' or '_' raise
    // UnrecognizedClientException (e2e/support/lane.mjs records the 2026-07-02
    // verification). Test file ids are full of both, so the hash must swallow
    // them rather than pass them through.
    for (const f of allAppTestFiles(APP_DIR)) {
      expect(fileAccessKeyId(testFileId(f))).toMatch(/^[a-z0-9]+$/i);
    }
  });

  it('is deterministic - the same file yields the same key across calls', () => {
    // Determinism is what bounds growth at one database per FILE. DynamoDB
    // Local can neither enumerate nor drop a database, so a key that varied
    // per run would strand one database per run, forever.
    const f = fileURLToPath(import.meta.url);
    expect(fileAccessKeyId(testFileId(f))).toBe(fileAccessKeyId(testFileId(f)));
  });

  it('is MACHINE-WIDE - the key depends on nothing but the file id', () => {
    // Pinned against literals computed once from djb2(fileId) alone. This is
    // the 2026-08-23 change: the first version folded worktree identity into
    // the hash, which cost ~50 never-reclaimable databases (~55 MiB of
    // container RSS) for EVERY worktree ever created since the last container
    // restart. Hashing only the file id caps the whole machine at one database
    // per test file.
    //
    // If either literal fails, someone has re-salted the hash with something
    // machine- or worktree-varying. That reintroduces the unbounded growth,
    // so it must be a deliberate decision made against
    // docs/issues/npm-test-dynamodb-local-contention.md - not a drive-by.
    expect(fileAccessKeyId('app/test/a.test.ts')).toBe('hcf1riw2q0');
    expect(fileAccessKeyId('app/test/messaging.integration.test.ts')).toBe('hcfm0zwlz');
  });

  it('gives the same file the same id regardless of path casing', () => {
    const f = fileURLToPath(import.meta.url);
    expect(testFileId(f.toUpperCase())).toBe(testFileId(f.toLowerCase()));
  });

  describe('the shared-tables opt-in', () => {
    it('routes a marked file to the WORKTREE key and an unmarked file to its own', () => {
      // The marked exemplar is a WRITTEN FIXTURE, not a real suite: the last
      // in-tree shared-tables suite (devOutbox.integration) was deleted with
      // /__dev/outbox (remove-dev-outbox-proof-of-send, 2026-08-24), but the
      // opt-in mechanism must keep working for the next suite that needs it.
      const dir = mkdtempSync(path.join(tmpdir(), 'hc-marker-'));
      try {
        const marked = path.join(dir, 'marked.test.ts');
        writeFileSync(marked, `// ${SHARED_LOCAL_TABLES_MARKER}\nexport {};\n`);
        const unmarked = path.join(TEST_DIR, 'contactsRepo.integration.test.ts');

        expect(accessKeyForTestFile(marked, { worktreeKey: 'hctestwork' })).toBe('hctestwork');
        expect(accessKeyForTestFile(unmarked, { worktreeKey: 'hctestwork' })).toBe(
          fileAccessKeyId(testFileId(unmarked)),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('treats the marker as a DECLARATION LINE, never as a substring', () => {
      // Regression pin (2026-08-23). The check was a bare `.includes()`, and a
      // suite that had just ESCAPED the shared key wrote "deliberately NOT
      // `<marker>`" in its header comment - which CONTAINS the marker, so the
      // substring match silently opted the file back into the very key it was
      // escaping. The suite stayed green under either key (its throwaway table
      // works anywhere), so nothing surfaced until a probe printed the access
      // key the worker actually held. Prose ABOUT the marker must never behave
      // as the marker.
      const dir = mkdtempSync(path.join(tmpdir(), 'hc-marker-'));
      const write = (name: string, content: string): string => {
        const f = path.join(dir, name);
        writeFileSync(f, content);
        return f;
      };
      try {
        // The declaration forms that must count.
        expect(
          optsIntoSharedLocalTables(write('a.test.ts', `// ${SHARED_LOCAL_TABLES_MARKER}\nexport {};\n`)),
          'a line-start comment declares',
        ).toBe(true);
        expect(
          optsIntoSharedLocalTables(write('b.test.ts', `  // ${SHARED_LOCAL_TABLES_MARKER}\nexport {};\n`)),
          'an indented comment declares',
        ).toBe(true);

        // The mentions that must NOT.
        expect(
          optsIntoSharedLocalTables(
            write('c.test.ts', `// deliberately NOT \`${SHARED_LOCAL_TABLES_MARKER}\` (see header)\nexport {};\n`),
          ),
          'the exact early-draft prose that caused the regression',
        ).toBe(false);
        expect(
          optsIntoSharedLocalTables(
            write('d.test.ts', `const s = '${SHARED_LOCAL_TABLES_MARKER}';\nexport {};\n`),
          ),
          'a string literal in code',
        ).toBe(false);
        expect(
          optsIntoSharedLocalTables(
            write('e.test.ts', `// ${SHARED_LOCAL_TABLES_MARKER}-nothing else like it\nexport {};\n`),
          ),
          'the marker with trailing words',
        ).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('lets an explicitly exported AWS_ACCESS_KEY_ID win over both', () => {
      const unmarked = path.join(TEST_DIR, 'contactsRepo.integration.test.ts');
      expect(
        accessKeyForTestFile(unmarked, { worktreeKey: 'hctestwork', explicitKey: 'mine' }),
      ).toBe('mine');
    });

    it('every suite using the SHARED hc-local- tables carries the marker', () => {
      // The rot-proof half. An opt-OUT list inside the hook would go stale the
      // moment someone adds suite 54; this asserts the property directly, so a
      // new hc-local- suite fails HERE with an explanation rather than failing
      // later as ResourceNotFoundException in an unrelated file.
      const offenders = allAppTestFiles(TEST_DIR)
        .filter((f) => /TABLE_PREFIX:\s*'hc-local-'/.test(readFileSync(f, 'utf8')))
        .filter((f) => !optsIntoSharedLocalTables(f))
        .map((f) => testFileId(f));

      expect(
        offenders,
        `These suites read the shared hc-local- tables but do not declare it. ` +
          `Add the marker "${SHARED_LOCAL_TABLES_MARKER}" to a comment at the top ` +
          `of each, or give the suite its own hc-test-<uuid>- prefix.`,
      ).toEqual([]);
    });

    it('does not mark suites that mint their own throwaway prefix', () => {
      // The other direction: a stray marker silently drags a suite back onto
      // the shared key and back into the shared lock, and nothing would fail.
      const strays = allAppTestFiles(TEST_DIR)
        .filter((f) => optsIntoSharedLocalTables(f))
        .filter((f) => /TABLE_PREFIX: `hc-\w+-\$\{randomUUID/.test(readFileSync(f, 'utf8')))
        .map((f) => testFileId(f));

      expect(strays).toEqual([]);
    });
  });

  it('every unmarked suite that CREATES container tables mints per-run random names', () => {
    // THE INVARIANT MACHINE-WIDE KEYS STAND ON. Per-file databases are shared
    // across worktrees (2026-08-23), so two worktrees running the same file
    // concurrently write into ONE database. That is data-safe today only
    // because every such suite builds its table names from a per-run random
    // component - concurrent runs write disjoint tables. A suite 54 that
    // creates container tables under a FIXED name would have two worktrees
    // reading and deleting each other's rows, as an unreproducible cross-
    // worktree flake. Fail HERE instead, with the fix in the message.
    //
    // Audited by hand 2026-08-23 before machine-wide keys shipped; this pins
    // the audit. Marked suites are exempt (they keep the worktree key, which
    // stays private per worktree), as is anything that never creates a table.
    const offenders = allAppTestFiles(TEST_DIR)
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        const createsTables = /ensureTable|CreateTableCommand|createAllTables|ensureKeyedLocalTables/.test(src);
        if (!createsTables) return false;
        if (optsIntoSharedLocalTables(f)) return false;
        // The other accepted mechanism: every container table the suite makes
        // lives under a key DERIVED FROM THE WORKTREE IDENTITY, so worktrees
        // cannot collide by construction and table names may stay fixed (which
        // some suites need for deterministic sweep counts). Declared, like the
        // shared marker, in the suite's own source. First caught for real on
        // dynamoKeyLedger.test.ts, whose fixed probe key this guard flagged
        // the day keys went machine-wide.
        if (src.includes(WORKTREE_DERIVED_KEYS_MARKER)) return false;
        // The third accepted answer: the suite creates no container tables at
        // all - it names ensureTable/CreateTableCommand only to drive a stub
        // client (test/dynamoAdminRetry.test.ts). Declared the same way, and
        // held honest by the rot-proof case below.
        if (declaresNoContainerTables(f)) return false;
        return !/randomUUID|Math\.random/.test(src);
      })
      .map((f) => testFileId(f));

    expect(
      offenders,
      `These suites create DynamoDB Local tables in a SHARED per-file database ` +
        `without a per-run random component in their table names. Two worktrees ` +
        `running the suite concurrently would collide on the same tables. Mint the ` +
        `prefix with randomUUID() (see contactsRepo.integration.test.ts); or derive ` +
        `every key the suite uses from testAccessKeyId() and declare it with ` +
        `"${WORKTREE_DERIVED_KEYS_MARKER}" (see dynamoKeyLedger.test.ts); or - only ` +
        `if the suite truly needs the shared hc-local- tables - add the marker ` +
        `"${SHARED_LOCAL_TABLES_MARKER}"; or - only if the suite creates NO ` +
        `container tables at all, because it drives a stub client - declare ` +
        `"${NO_CONTAINER_TABLES_MARKER}" on a comment line of its own (see ` +
        `dynamoAdminRetry.test.ts).`,
    ).toEqual([]);
  });

  it('a suite declared as touching NO container tables really cannot reach one', () => {
    // The rot-proof half of the third marker. The marker asserts a NEGATIVE
    // ("this file opens no DynamoDB Local database"), which nothing else would
    // notice going stale: someone adds one real client to a stub suite, the
    // marker keeps exempting it, and the fixed table names it now creates
    // collide across worktrees exactly as the guard above exists to prevent.
    //
    // What counts as reaching a database is listed at CONTAINER_REACHING: the
    // app's client factory and its constructors, the table-creating script and
    // setup entry points and their helpers, or a real table name. Read the
    // limitation stated there before trusting this case - it is a one-file
    // source scan that does not follow imports, so a suite that opens a
    // database through a helper module of its own passes it.
    //
    // Constructing a bare DynamoDBClient from the SDK is NOT caught here, and
    // should not be: dynamoAdminRetry.test.ts case 13 makes two of them purely
    // to read config.endpoint, and never sends.
    const offenders = allAppTestFiles(TEST_DIR)
      .filter((f) => declaresNoContainerTables(f))
      .filter((f) => CONTAINER_REACHING.test(readFileSync(f, 'utf8')))
      .map((f) => testFileId(f));

    expect(
      offenders,
      `These suites declare "${NO_CONTAINER_TABLES_MARKER}" - that they open no ` +
        `DynamoDB Local database - but their CODE imports the app client factory ` +
        `module or a table-creating script/setup module, calls one of their ` +
        `constructors or table helpers, or names a real table. Either ` +
        `drop the marker and satisfy the creates-tables guard the normal way ` +
        `(a per-run random prefix, or worktree-derived keys), or keep the suite ` +
        `on stubs.`,
    ).toEqual([]);
  });

  describe.skipIf(!reachable || explicitKey)('against DynamoDB Local', () => {
    it('reaches a database no OTHER key can see', async () => {
      // The claim the whole design rests on, asserted end to end rather than
      // inferred: a table created under this file's key is invisible under the
      // worktree key. Distinct database => distinct SQLiteDBAccess => distinct
      // queueLock, which is the resource that was starving suites.
      const name = `hc-guard-${Date.now().toString(36)}`;

      // process.env.AWS_ACCESS_KEY_ID is already this file's key (asserted
      // above), so the default client lands in this file's database.
      const mine = createDynamoClient({ endpoint });

      const savedKey = process.env.AWS_ACCESS_KEY_ID;
      process.env.AWS_ACCESS_KEY_ID = testAccessKeyId();
      const worktree = createDynamoClient({ endpoint });
      process.env.AWS_ACCESS_KEY_ID = savedKey;

      try {
        await mine.send(
          new CreateTableCommand({
            TableName: name,
            AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            BillingMode: 'PAY_PER_REQUEST',
          }),
        );

        const here = await mine.send(new ListTablesCommand({}));
        expect(here.TableNames ?? []).toContain(name);

        const there = await worktree.send(new ListTablesCommand({}));
        expect(there.TableNames ?? []).not.toContain(name);
      } finally {
        try {
          await mine.send(new DeleteTableCommand({ TableName: name }));
        } catch {
          /* best effort */
        }
        mine.destroy();
        worktree.destroy();
      }
    }, 60_000);
  });
});
