export function printJson(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

// Agent/compact surface: a single minified JSON line. The default `--json`
// stays pretty-printed for audit/debug; agent packets optimize for tokens.
export function printCompactJson(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}
