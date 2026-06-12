export type ParsedArgs = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
};

export type CommandRunResult = { status: number; shouldCheckForUpdate: boolean };
