// Types for access-check-lib.mjs (used by tests/check-access.test.ts).
export type Status = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'SKIPPED';
export interface ApiResponse { data?: unknown; error?: { code?: string; message?: string } | null; status?: number }
export interface FnResponse { status?: number; json?: Record<string, unknown>; error?: unknown }
export interface Client {
  select(table: string, options?: { columns?: string; eq?: [string, unknown]; limit?: number }): Promise<ApiResponse>;
  write(w: { op: string; table: string; values?: Record<string, unknown>; eq?: [string, unknown] }): Promise<ApiResponse>;
  rpc(fn: string, args: Record<string, unknown>): Promise<ApiResponse>;
  fn(name: string, body: unknown): Promise<FnResponse>;
  signOut?(): Promise<void>;
}
export const MEMBERS: { A: string; B: string; C: string; D: string };
export const OFFICER_ONLY: string[];
export const PRIVILEGED_SAFE: [string, Record<string, unknown>][];
export const NOT_PROBED_LIVE: string[];
export const MUTATING_PROBES: string[];
export function classify(res: unknown): { kind: 'ok' | 'denied' | 'validation' | 'unexpected'; detail: string };
export class Results {
  constructor(log?: (line: string) => void);
  items: { who: string; status: Status; name: string; detail: string }[];
  notRun: string[];
  counts(): Record<Status, number>;
  exitCode(): 0 | 1 | 3;
  summary(): string;
}
export function judgeRefused(R: Results, who: string, name: string, res: unknown): void;
export function judgeHidden(R: Results, who: string, name: string, res: unknown, rowsThatExist: number | null): void;
export function judgeHttp(R: Results, who: string, name: string, res: unknown, expected: number): void;
export function runChecks(o: {
  anon: Client;
  signIn: (label: string) => Promise<{ client?: Client; error?: string }>;
  anonOnly?: boolean;
  includeMutating?: boolean;
  log?: (line: string) => void;
}): Promise<Results>;
