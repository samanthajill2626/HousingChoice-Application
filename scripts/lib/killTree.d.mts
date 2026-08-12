export function isAlive(pid: number | null | undefined): boolean;
export function killTree(pid: number | null | undefined): void;
export function pidsOnPort(port: number): number[];
export function killPort(port: number): number[];
