import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const tempRoot = path.resolve(tmpdir());
const scratch = mkdtempSync(path.join(tempRoot, 'hc-maintenance-infra-'));
const moduleDir = path.join(scratch, 'infra/modules/cloudfront');
const artifactDir = path.join(repo, '.superpowers/maintenance-infra', path.basename(scratch));
mkdirSync(artifactDir, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TF_') && !key.startsWith('AWS_')));
Object.assign(env, { TF_INPUT: '0', TF_IN_AUTOMATION: '1', AWS_EC2_METADATA_DISABLED: 'true' });
let sequence = 0;

function includeConfig(source) {
  const name = path.basename(source);
  if (name === '.terraform' || name.includes('tfstate')) return false;
  return statSync(source).isDirectory() || /\.(tf|tftpl|hcl|json)$/.test(name);
}

function terraform(label, args, expectedMarker, cwd = moduleDir) {
  const result = spawnSync('terraform', args, {
    cwd, env, shell: false, encoding: 'utf8',
    timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = result.stdout + result.stderr;
  writeFileSync(path.join(artifactDir, String(++sequence).padStart(2, '0') + '-' + label + '.log'), output, 'utf8');
  if (result.error || result.signal) throw new Error(label + ': ' + (result.error?.message ?? result.signal));
  if (expectedMarker) {
    if (result.status === 0 || !output.includes(expectedMarker) || !output.includes('Test assertion failed')) {
      throw new Error(label + ': expected the named contract assertion to fail; exit=' + result.status);
    }
  } else if (result.status !== 0) {
    throw new Error(label + ': unexpected Terraform exit ' + result.status + '; see ' + artifactDir);
  }
  process.stdout.write(label + ': expected result (Terraform exit ' + result.status + ')\n');
  return output;
}

function requireBothMockRuns(label, output, outcomes) {
  const passed = Object.values(outcomes).filter(Boolean).length;
  const failed = Object.values(outcomes).length - passed;
  const expected = [
    `run "maintenance_contract"... ${outcomes.maintenance_contract ? 'pass' : 'fail'}`,
    `run "media_stays_independent"... ${outcomes.media_stays_independent ? 'pass' : 'fail'}`,
    failed === 0 ? `Success! ${passed} passed, 0 failed.` : `Failure! ${passed} passed, ${failed} failed.`,
  ];
  if (expected.some((line) => !output.includes(line)) || output.includes('skip')) {
    throw new Error(label + ': expected both named mock runs with the required per-run outcome and 0 skipped');
  }
}

function stripHclComments(source) {
  let result = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (lineComment) {
      if (character === '\r' || character === '\n') {
        lineComment = false;
        result += character;
      }
      continue;
    }

    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      } else if (character === '\r' || character === '\n') {
        result += character;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === '#') {
      lineComment = true;
    } else if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else {
      result += character;
    }
  }

  return result;
}

function defaultForwardingSourceContract(label, source, expectedMarker) {
  const uncommentedSource = stripHclComments(source);
  const blocks = uncommentedSource.match(/  default_cache_behavior \{[\s\S]*?\n  \}/g) ?? [];
  const expectedAssignment = /^\s*origin_request_policy_id\s*=\s*data\.aws_cloudfront_origin_request_policy\.all_viewer_except_host\.id\s*$/gm;
  const valid = blocks.length === 1 && (blocks[0].match(expectedAssignment) ?? []).length === 1;
  const output = valid
    ? 'source assertion passed (in-process check): default cache behavior preserves the app origin request policy.\n'
    : 'source assertion failed (in-process check): HC_MAINTENANCE_APP_PARITY: default cache behavior must preserve the app origin request policy.\n';
  writeFileSync(path.join(artifactDir, String(++sequence).padStart(2, '0') + '-' + label + '.log'), output, 'utf8');
  if (expectedMarker) {
    if (valid || !output.includes(expectedMarker) || !output.includes('source assertion failed (in-process check)')) {
      throw new Error(label + ': expected the anchored default-behavior source contract to fail');
    }
    process.stdout.write(label + ': expected result (in-process source assertion failed)\n');
  } else if (!valid) {
    throw new Error(label + ': default cache behavior source contract failed; see ' + artifactDir);
  } else {
    process.stdout.write(label + ': expected result (in-process source assertion passed)\n');
  }
}

function requireDefaultForwardingSourceFixtures(main, defaultBlock) {
  const expectedLine = 'origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id';
  const quotedLiteral = '"quoted # // /* */ /api/* \\"still quoted\\""';
  const validCommentedSource = `${main}\nlocals {\n  source_guard_fixture = ${quotedLiteral}\n}\n# ${expectedLine}\n/* ${expectedLine} */\n`;
  const fixtures = [
    ['default-forwarding-comment-hash', replaceOne(main, defaultBlock,
      replaceOne(defaultBlock, expectedLine, `origin_request_policy_id = null # ${expectedLine}`)),
      'HC_MAINTENANCE_APP_PARITY'],
    ['default-forwarding-comment-block', replaceOne(main, defaultBlock,
      replaceOne(defaultBlock, expectedLine, `origin_request_policy_id = null /* ${expectedLine} */`)),
      'HC_MAINTENANCE_APP_PARITY'],
    ['default-forwarding-null-expression', replaceOne(main, defaultBlock,
      replaceOne(defaultBlock, expectedLine,
        'origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id == "" ? null : null')),
      'HC_MAINTENANCE_APP_PARITY'],
    ['default-forwarding-commented-quoted-strings', validCommentedSource, undefined],
  ];

  if (!stripHclComments(validCommentedSource).includes(quotedLiteral)) {
    throw new Error('Source fixture lost quoted or escaped comment markers');
  }
  for (const [label, source, expectedMarker] of fixtures) {
    defaultForwardingSourceContract(label, source, expectedMarker);
  }
}

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Fault target must occur exactly once: ' + before);
  return source.replace(before, () => after);
}

function removeRootOnlyRandomLockStanza(lockPath) {
  const source = readFileSync(lockPath, 'utf8');
  const marker = 'provider "registry.terraform.io/hashicorp/random" {';
  if (source.split(marker).length !== 2) {
    throw new Error('Expected exactly one root-only random provider lock stanza');
  }
  const start = source.indexOf(marker);
  const end = source.indexOf('\n}', start);
  if (end === -1) throw new Error('Unable to find the end of the root-only random provider lock stanza');
  writeFileSync(lockPath, source.slice(0, start) + source.slice(end + 2), 'utf8');
}

try {
  cpSync(path.join(repo, 'infra/modules/cloudfront'), moduleDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== '.terraform.lock.hcl' && includeConfig(source),
  });
  const copyDir = path.join(scratch, 'app/src/messages');
  mkdirSync(copyDir, { recursive: true });
  cpSync(path.join(repo, 'app/src/messages/edgeMaintenance.json'), path.join(copyDir, 'edgeMaintenance.json'));
  const moduleLockPath = path.join(moduleDir, '.terraform.lock.hcl');
  cpSync(path.join(repo, 'infra/envs/dev/.terraform.lock.hcl'), moduleLockPath);
  removeRootOnlyRandomLockStanza(moduleLockPath);
  const initArgs = ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'];
  if (process.argv[2]) {
    const mirror = path.resolve(process.argv[2]);
    if (!existsSync(mirror)) throw new Error('Provider mirror does not exist: ' + mirror);
    initArgs.push('-plugin-dir=' + mirror);
  }
  terraform('init', initArgs);
  terraform('validate', ['validate', '-no-color']);
  const testArgs = ['test', '-no-color', '-test-directory=tests', '-filter=' + path.join('tests', 'maintenance.tftest.hcl')];
  const mainPath = path.join(moduleDir, 'main.tf');
  const maintenancePath = path.join(moduleDir, 'maintenance.tf');
  const main = readFileSync(mainPath, 'utf8');
  const maintenance = readFileSync(maintenancePath, 'utf8');
  const blocks = main.match(/  custom_error_response \{[^{}]*\}/g) ?? [];
  const block504 = blocks.find((block) => /error_code\s*=\s*504\b/.test(block));
  if (!block504) throw new Error('No unique 504 block available for fault tests');
  const defaultBlock = main.match(/  default_cache_behavior \{[^{}]*\}/)?.[0];
  if (!defaultBlock) throw new Error('No default behavior block available for fault tests');
  const terraformFaults = [
    ['missing-504', mainPath, replaceOne(main, block504, ''), 'HC_MAINTENANCE_MAPPINGS'],
    ['extra-503', mainPath, replaceOne(main, block504, block504 + '\n' + block504.replaceAll('504', '503')), 'HC_MAINTENANCE_MAPPINGS'],
    ['false-success', mainPath, replaceOne(main, block504, block504.replace(/response_code\s*=\s*504\b/, 'response_code = 200')), 'HC_MAINTENANCE_MAPPINGS'],
    ['wide-s3-read', maintenancePath, replaceOne(maintenance,
      '"${aws_s3_bucket.maintenance.arn}/${aws_s3_object.maintenance.key}"',
      '"${aws_s3_bucket.maintenance.arn}/*"'), 'HC_MAINTENANCE_POLICY'],
    ['media-oac-removed', mainPath, replaceOne(main,
      'aws_cloudfront_origin_access_control.media[0].id', 'null'), 'HC_MAINTENANCE_MEDIA_PARITY'],
  ];
  const defaultForwardingFault = replaceOne(main, defaultBlock,
    replaceOne(defaultBlock, 'data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id', 'null'));
  requireDefaultForwardingSourceFixtures(main, defaultBlock);
  defaultForwardingSourceContract('baseline-default-forwarding-source', main);
  requireBothMockRuns('baseline', terraform('baseline', testArgs), {
    maintenance_contract: true,
    media_stays_independent: true,
  });
  for (const [label, target, changed, marker] of terraformFaults) {
    writeFileSync(mainPath, main, 'utf8');
    writeFileSync(maintenancePath, maintenance, 'utf8');
    writeFileSync(target, changed, 'utf8');
    requireBothMockRuns(label, terraform(label, testArgs, marker), {
      maintenance_contract: label === 'media-oac-removed',
      media_stays_independent: label === 'media-oac-removed' ? false : true,
    });
  }
  defaultForwardingSourceContract('default-forwarding-removed', defaultForwardingFault,
    'HC_MAINTENANCE_APP_PARITY');
  writeFileSync(mainPath, main, 'utf8');
  writeFileSync(maintenancePath, maintenance, 'utf8');
  defaultForwardingSourceContract('restored-baseline-default-forwarding-source', main);
  requireBothMockRuns('restored-baseline', terraform('restored-baseline', testArgs), {
    maintenance_contract: true,
    media_stays_independent: true,
  });
  const compositionRoot = path.join(scratch, 'compositions');
  cpSync(path.join(repo, 'infra'), path.join(compositionRoot, 'infra'), {
    recursive: true,
    filter: includeConfig,
  });
  cpSync(copyDir, path.join(compositionRoot, 'app/src/messages'), { recursive: true });
  for (const file of ['stack.tf', 'outputs.tf']) {
    const dev = readFileSync(path.join(compositionRoot, 'infra/envs/dev', file), 'utf8');
    const prod = readFileSync(path.join(compositionRoot, 'infra/envs/prod', file), 'utf8');
    if (dev !== prod) throw new Error('Dev/prod composition differs: ' + file);
  }
  for (const environment of ['dev', 'prod']) {
    const root = path.join(compositionRoot, 'infra/envs', environment);
    terraform(environment + '-init', initArgs, undefined, root);
    terraform(environment + '-validate', ['validate', '-no-color'], undefined, root);
  }
  process.stdout.write('Maintenance HCL, both root compositions, five mocked Terraform fault probes and in-process source fixtures passed. Logs: ' + artifactDir + '\n');
} finally {
  const resolved = path.resolve(scratch);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('hc-maintenance-infra-')) {
    throw new Error('Refusing cleanup outside owned maintenance scratch directory');
  }
  rmSync(resolved, { recursive: true, force: true });
}
