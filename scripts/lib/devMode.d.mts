// Type declarations for devMode.mjs so app/test/devMode.test.ts typechecks
// under tsconfig.test.json (the .mjs itself stays plain JS — keep both in sync).
export declare const LIVE_TABLE_PREFIX: string;
export declare const LIVE_AWS_PROFILE: string;
export declare const LOCAL_TABLE_PREFIX: string;

export declare function resolveDevEnv(opts: {
  local?: boolean;
  processEnv: Record<string, string | undefined>;
  fileEnv: Record<string, string>;
  localEndpoint: string;
}): { mode: 'live' | 'local'; overlay: Record<string, string> };
