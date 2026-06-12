export function printJson(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

export function printCompactJson(value: unknown): number {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}
