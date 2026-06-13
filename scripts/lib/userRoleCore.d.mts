// Type declarations for userRoleCore.mjs so app/test/userRoleCore.test.ts
// typechecks under tsconfig.test.json (the .mjs stays plain JS — keep in sync).
export declare const USER_ROLES: readonly string[];
export declare const STACK_ENVS: readonly string[];

export declare function normalizeEmail(email: string): string;
export declare function parseUserRoleArgs(argv: string[]): {
  env: string;
  email: string;
  role: string;
};
export declare function buildRoleUpdate(role: string): {
  updateExpression: string;
  conditionExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, unknown>;
};
export declare function buildRoleChangedAuditItem(input: {
  userId: string;
  email: string;
  from: string;
  to: string;
  changedBy: string;
  nowIso: string;
  suffix: string;
}): {
  entityKey: string;
  ts: string;
  event_type: string;
  payload: { from: string; to: string; email: string; changed_by: string };
};
