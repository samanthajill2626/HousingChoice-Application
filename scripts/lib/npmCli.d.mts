// Type declarations for npmCli.mjs (the .mjs itself stays plain JS - keep
// both in sync).
export declare function resolveNpmCli(options?: {
  env?: Record<string, string | undefined>;
  execPath?: string;
  exists?: (candidate: string) => boolean;
}): string;
