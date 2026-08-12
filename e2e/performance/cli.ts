import { parseRunConfig, toSafeRunConfig } from './config.js';

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = parseRunConfig(argv);
  if (config.printConfig) {
    process.stdout.write(`${JSON.stringify(toSafeRunConfig(config))}\n`);
    return;
  }
  throw new Error('performance profiler lifecycle not implemented');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unexpected profiler failure';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
