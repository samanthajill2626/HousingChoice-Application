// gen-tables — generate the Terraform `tables` variable value from the single
// source of truth, app/src/lib/tables.ts (TABLES).
//
// Writes IDENTICAL infra/envs/{dev,prod}/tables.auto.tfvars.json files
// ({ "tables": { <baseName>: <definition> } }) which terraform auto-loads;
// the dynamodb module for_eaches over the map. The map KEYS are the table
// base names and become the state addresses
// (module.dynamodb.aws_dynamodb_table.this["<key>"]) — never rename them
// without a state move.
//
// Output is deterministic (alphabetical table keys, fixed field order,
// 2-space indent, trailing newline) so diffs are meaningful. NEVER hand-edit
// the generated JSON — edit tables.ts and re-run `npm run gen:tables`.
//
// Modes:
//   default   write both files            (npm run gen:tables)
//   --check   byte-compare against disk; exit 0 if fresh, exit 3 if stale.
//             `npm run plan`/`drift` run this automatically and fail on stale.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TABLES } from '../src/lib/tables.js';

/** Exit code signalling "generated files are stale" to callers (tf.mjs). */
export const STALE_EXIT_CODE = 3;

interface TfKeyAttribute {
  name: string;
  type: string;
}

interface TfGsi {
  index_name: string;
  hash_key: TfKeyAttribute;
  range_key?: TfKeyAttribute;
}

interface TfTable {
  hash_key: TfKeyAttribute;
  range_key?: TfKeyAttribute;
  gsis: TfGsi[];
  stream: boolean;
  ttl_attribute?: string;
  pitr: boolean;
}

export interface TablesTfvars {
  tables: Record<string, TfTable>;
}

/**
 * Pure builder: TABLES -> the tfvars object. Optional fields (range keys,
 * TTL) are OMITTED rather than null'd; the module's optional() attributes
 * fill them with null. PITR is a per-table flag for future flexibility but is
 * true for every table today (architecture doc §5).
 */
export function buildTablesTfvars(): TablesTfvars {
  const tables: Record<string, TfTable> = {};
  for (const spec of [...TABLES].sort((a, b) => (a.baseName < b.baseName ? -1 : 1))) {
    tables[spec.baseName] = {
      hash_key: { name: spec.hashKey.name, type: spec.hashKey.type },
      ...(spec.rangeKey
        ? { range_key: { name: spec.rangeKey.name, type: spec.rangeKey.type } }
        : {}),
      gsis: spec.gsis.map((g) => ({
        index_name: g.indexName,
        hash_key: { name: g.hashKey.name, type: g.hashKey.type },
        ...(g.rangeKey ? { range_key: { name: g.rangeKey.name, type: g.rangeKey.type } } : {}),
      })),
      stream: spec.stream === 'NEW_AND_OLD_IMAGES',
      ...(spec.ttlAttribute ? { ttl_attribute: spec.ttlAttribute } : {}),
      pitr: true,
    };
  }
  return { tables };
}

/** Exact bytes both generated files must contain (incl. trailing newline). */
export function renderTablesTfvarsJson(): string {
  return `${JSON.stringify(buildTablesTfvars(), null, 2)}\n`;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET_FILES = ['dev', 'prod'].map((env) =>
  path.join(repoRoot, 'infra', 'envs', env, 'tables.auto.tfvars.json'),
);

function main(): void {
  const check = process.argv.includes('--check');
  const want = renderTablesTfvarsJson();
  const stale: string[] = [];

  for (const file of TARGET_FILES) {
    const rel = path.relative(repoRoot, file);
    if (check) {
      let onDisk: string | undefined;
      try {
        onDisk = readFileSync(file, 'utf8');
      } catch {
        onDisk = undefined; // missing counts as stale
      }
      if (onDisk === want) {
        console.log(`  fresh    ${rel}`);
      } else {
        console.error(`  STALE    ${rel}${onDisk === undefined ? ' (missing)' : ''}`);
        stale.push(rel);
      }
    } else {
      writeFileSync(file, want, 'utf8');
      console.log(`  wrote    ${rel} (${TABLES.length} tables)`);
    }
  }

  if (stale.length > 0) {
    console.error(
      `\ngen-tables: STALE — run npm run gen:tables.\n` +
        `Out of date with app/src/lib/tables.ts: ${stale.join(', ')}.\n` +
        `Regenerate, review the diff, commit the JSON alongside the tables.ts change.`,
    );
    process.exit(STALE_EXIT_CODE);
  }
  if (check) console.log('gen-tables --check: generated tfvars are fresh.');
}

// Run the CLI only when executed directly (tsx app/scripts/gen-tables.ts),
// not when imported by tests. Case-insensitive compare for Windows drive
// letters.
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() ===
    import.meta.url.toLowerCase();
if (invokedDirectly) main();
