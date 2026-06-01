const TTL_PATTERN = /^(\d+)([dhm])$/;

export function now(): Date {
  const forced = process.env.SHELF_NOW;
  if (!forced) return new Date();
  const parsed = new Date(forced);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid SHELF_NOW value: ${forced}`);
  }
  return parsed;
}

export function toIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addTtl(start: Date, ttl: string): Date {
  const match = TTL_PATTERN.exec(ttl);
  if (!match) {
    throw new Error("TTL must look like 30m, 12h, or 7d");
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  if (!unit || !(unit in multipliers)) {
    throw new Error("TTL must look like 30m, 12h, or 7d");
  }

  return new Date(start.getTime() + amount * multipliers[unit]!);
}

export function assertIsoDate(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return toIso(parsed);
}
