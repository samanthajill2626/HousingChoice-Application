// db:seed — idempotent local seed data for DynamoDB Local.
//
// Fixed IDs + plain PutItem = safe to re-run forever (same items overwrite
// themselves; no duplicates). Data is realistic-but-fake (+1555 phones,
// example.com emails) and deliberately exercises EVERY GSI in lib/tables.ts,
// including the sparse placements indexes (tour_date / next_deadline_*) and the
// matches TTL attribute. IDs cross-reference coherently: the placement joins the
// seeded tenant + unit, the invoice bills the seeded landlord, etc.
// Targets DYNAMODB_ENDPOINT (default http://localhost:8000) — never AWS.
//
// The seed data and seedAll() function live in src/lib/seedData.ts so they
// can also be imported from within the app's src/ rootDir (e.g. devReset.ts).
//
// SEED_PROFILE env: 'full' seeds the extended cast + matrix + live items on top
// of the lean base; omit (or any other value) for lean-only (default).
import { seedAll, LOCAL_DEFAULT_ENDPOINT } from '../src/lib/seedData.js';

export { seedAll, LOCAL_DEFAULT_ENDPOINT };

const endpoint = process.env.DYNAMODB_ENDPOINT ?? LOCAL_DEFAULT_ENDPOINT;
const profile = process.env.SEED_PROFILE === 'full' ? 'full' : 'lean';
console.log(`db:seed — writing fixed-ID seed items at ${endpoint} (idempotent, profile: ${profile})`);
try {
  const count = await seedAll(endpoint, profile);
  console.log(`db:seed — done (${count} items)`);
} catch (err) {
  console.error('db:seed failed — are the tables created? (npm run db:start && npm run db:create)');
  console.error(err);
  process.exit(1);
}
