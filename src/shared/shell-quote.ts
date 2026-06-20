const SHELL_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;

export function shellArg(value: string): string {
  if (value.length > 0 && SHELL_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
