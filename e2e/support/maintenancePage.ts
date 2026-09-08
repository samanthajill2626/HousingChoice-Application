import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const templatePath = path.join(repoRoot, 'infra/modules/cloudfront/templates/maintenance.html.tftpl');
const copyPath = path.join(repoRoot, 'app/src/messages/edgeMaintenance.json');
const keys = ['action', 'body', 'brand', 'heading', 'title'] as const;
export type MaintenanceCopy = Record<(typeof keys)[number], string>;

function validateCopy(value: unknown): MaintenanceCopy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid maintenance copy object');
  }
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys) ||
      keys.some((key) => typeof record[key] !== 'string' ||
        (record[key] as string).trim().length === 0 ||
        /[^\x20-\x7e]/.test(record[key] as string))) {
    throw new Error('Invalid maintenance copy keys or text');
  }
  return record as MaintenanceCopy;
}

export function readMaintenanceCopy(): MaintenanceCopy {
  return validateCopy(JSON.parse(readFileSync(copyPath, 'utf8')) as unknown);
}

function hclPath(value: string): string {
  return JSON.stringify(value.replaceAll('\\', '/'))
    .replaceAll('${', () => '$${')
    .replaceAll('%{', () => '%%{');
}

export function renderMaintenancePage(copy = readMaintenanceCopy()): string {
  validateCopy(copy);
  const root = path.resolve(tmpdir());
  const scratch = mkdtempSync(path.join(root, 'hc-maintenance-render-'));
  try {
    const inputPath = path.join(scratch, 'copy.json');
    writeFileSync(inputPath, JSON.stringify(copy), 'utf8');
    const expression = 'base64encode(templatefile(' + hclPath(templatePath) +
      ', { copy = jsondecode(file(' + hclPath(inputPath) + ')) }))\n';
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('TF_')),
    );
    const result = spawnSync('terraform', ['console', '-no-color'], {
      cwd: scratch,
      shell: false,
      input: expression,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...env, TF_INPUT: '0', TF_IN_AUTOMATION: '1' },
    });
    if (result.error || result.status !== 0) {
      throw new Error('Terraform maintenance renderer failed; Terraform >=1.15 must be on PATH. ' +
        (result.error?.message ?? result.stderr));
    }
    const encoded: unknown = JSON.parse(result.stdout.trim());
    if (typeof encoded !== 'string') throw new Error('Unexpected Terraform render output');
    return Buffer.from(encoded, 'base64').toString('utf8');
  } finally {
    const resolved = path.resolve(scratch);
    if (path.dirname(resolved) !== root ||
        !path.basename(resolved).startsWith('hc-maintenance-render-')) {
      throw new Error('Refusing maintenance scratch cleanup outside owned temporary directory');
    }
    rmSync(resolved, { recursive: true, force: true });
  }
}
