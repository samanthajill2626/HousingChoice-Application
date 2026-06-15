// db:seed — idempotent local seed data for DynamoDB Local.
//
// Fixed IDs + plain PutItem = safe to re-run forever (same items overwrite
// themselves; no duplicates). Data is realistic-but-fake (+1555 phones,
// example.com emails) and deliberately exercises EVERY GSI in lib/tables.ts,
// including the sparse cases indexes (tour_date / next_deadline_*) and the
// matches TTL attribute. IDs cross-reference coherently: the case joins the
// seeded tenant + unit, the invoice bills the seeded landlord, etc.
// Targets DYNAMODB_ENDPOINT (default http://localhost:8000) — never AWS.
//
// The seed data and seedAll() function live in src/lib/seedData.ts so they
// can also be imported from within the app's src/ rootDir (e.g. devReset.ts).
import { seedAll, LOCAL_DEFAULT_ENDPOINT } from '../src/lib/seedData.js';

export { seedAll, LOCAL_DEFAULT_ENDPOINT };

const endpoint = process.env.DYNAMODB_ENDPOINT ?? LOCAL_DEFAULT_ENDPOINT;
console.log(`db:seed — writing fixed-ID seed items at ${endpoint} (idempotent)`);
try {
  const count = await seedAll(endpoint);
  console.log(`db:seed — done (${count} items)`);
} catch (err) {
  console.error('db:seed failed — are the tables created? (npm run db:start && npm run db:create)');
  console.error(err);
  process.exit(1);
}
