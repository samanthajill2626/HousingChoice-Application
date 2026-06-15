// Triggers an app+worker restart in a running `npm run e2e:session` stack by
// rewriting the sentinel the launcher watches. Vite, DynamoDB, and any attached
// browser are untouched. No-op-ish if no session is running (just writes a file).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dir = path.join(repoRoot, 'e2e', '.artifacts');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, '.restart'), String(Date.now()));
process.stdout.write('[e2e-restart] signaled app+worker restart\n');
