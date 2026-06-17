// API entity types — the dashboard's view of the wire shapes it exchanges with
// the backend (/api, /auth). Mirrors the server contract exactly. This file
// starts with the auth shapes (B0.3); page phases extend it with the legacy
// reuse + the §API Contract types (C1–C7) from the build plan.

/** Team role. admin = the founder role; va = virtual assistant. */
export type UserRole = 'admin' | 'va';

/** GET /auth/me — the authenticated principal (returned unwrapped, not under a key). */
export interface Me {
  userId: string;
  email: string;
  role: UserRole;
}

/** POST /auth/dev-login — the seeded dev principal (hermetic-LOCAL only). */
export interface DevLoginResult {
  userId: string;
  email: string;
  role: UserRole;
}
