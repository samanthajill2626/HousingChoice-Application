// Type declarations for userInviteCore.mjs so app/test/userInviteCore.test.ts
// typechecks under tsconfig.test.json (the .mjs stays plain JS — keep in sync).
export declare const USER_ROLES: readonly string[];
export declare const STACK_ENVS: readonly string[];

export declare function normalizeEmail(email: string): string;
export declare function userIdForEmail(email: string): string;
export declare function parseUserInviteArgs(argv: string[]): {
  env: string;
  email: string;
  role: string;
};
export declare function buildInvitedUserItem(input: {
  userId: string;
  email: string;
  role: string;
  nowIso: string;
}): {
  userId: { S: string };
  email: { S: string };
  role: { S: string };
  status: { S: string };
  session_epoch: { N: string };
  created_at: { S: string };
};
export declare function buildInvitedAuditItem(input: {
  userId: string;
  email: string;
  role: string;
  invitedBy: string;
  nowIso: string;
  suffix: string;
}): {
  entityKey: string;
  ts: string;
  event_type: string;
  payload: { email: string; role: string; invited_by: string };
};
