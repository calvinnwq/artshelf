export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `artshelf: ${message}\nRun \`artshelf help\` for usage.\n`;
}
