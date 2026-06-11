declare const process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  execPath: string;
  exitCode?: number;
  version: string;
  stdout: { write(value: string): void };
  stderr: { write(value: string): void };
};

declare class AbortController {
  readonly signal: any;
  abort(): void;
}

declare function fetch(url: string, init?: any): Promise<{ ok: boolean; json(): Promise<unknown> }>;
declare function setTimeout(callback: () => void, ms: number): any;
declare function clearTimeout(timeout: any): void;

declare const Buffer: {
  from(value: string): { toString(encoding: string): string };
};

declare module "node:assert/strict" {
  const assert: any;
  export = assert;
}

declare module "node:child_process" {
  export function spawn(...args: any[]): any;
  export function spawnSync(...args: any[]): any;
}

declare module "node:crypto" {
  export function randomBytes(size: number): { toString(encoding: string): string };
}

declare module "node:fs" {
  export const constants: any;
  export function chmodSync(path: string, mode: number): void;
  export function existsSync(path: string): boolean;
  export function lstatSync(path: string): any;
  export function mkdirSync(path: string, options?: any): void;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function realpathSync(path: string): string;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: any): void;
  export function statSync(path: string): any;
  export function symlinkSync(target: string, path: string): void;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
