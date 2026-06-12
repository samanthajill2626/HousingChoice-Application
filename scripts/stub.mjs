// Stub for npm scripts whose real implementation lands in a later milestone.
// Usage: node scripts/stub.mjs <scriptName> <milestone>
const [scriptName = 'this script', milestone = 'a later milestone'] =
  process.argv.slice(2);
console.error(
  `\`npm run ${scriptName}\` is implemented in milestone ${milestone} — not available yet.`,
);
process.exit(1);
