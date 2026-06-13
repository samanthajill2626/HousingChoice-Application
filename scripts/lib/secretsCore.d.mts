// Type declarations for secretsCore.mjs so app/test/secretsCore.test.ts
// typechecks under tsconfig.test.json (the .mjs stays plain JS — keep in sync).
export declare const MANAGED_BY_OTHERS: readonly string[];

export declare function parseDotenv(text: string): Record<string, string>;
export declare function maskValue(value: string): string;
export declare function findDenylistedKeys(keys: string[]): string[];
export declare function diffKeySets(
  realKeys: string[],
  exampleKeys: string[],
): { missing: string[]; extra: string[] };
export declare function syncEnvFromExample(
  exampleText: string,
  realText: string,
): {
  output: string;
  summary: {
    newKeys: string[];
    preservedKeys: string[];
    extraKeys: string[];
    changed: boolean;
  };
};
