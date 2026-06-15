import path from 'node:path';

// Saved storage state lives under the gitignored artifacts dir.
export const AUTH_DIR = path.join(import.meta.dirname, '..', '.artifacts', 'auth');
export const VA_STATE = path.join(AUTH_DIR, 'va.json');

// Seeded staff user (db-seed.ts): role 'va'.
export const VA_EMAIL = 'va@example.com';
