const TTL_PATTERN = /^(\d+)([dhm])$/;
const TTL_MULTIPLIERS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000
};

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
  if (!unit || !(unit in TTL_MULTIPLIERS)) {
    throw new Error("TTL must look like 30m, 12h, or 7d");
  }

  return new Date(start.getTime() + amount * TTL_MULTIPLIERS[unit]!);
}

export function ttlToMs(ttl: string): number {
  const match = TTL_PATTERN.exec(ttl);
  if (!match) {
    throw new Error("TTL must look like 30m, 12h, or 7d");
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!unit || !(unit in TTL_MULTIPLIERS)) {
    throw new Error("TTL must look like 30m, 12h, or 7d");
  }

  return amount * TTL_MULTIPLIERS[unit]!;
}

export function ageOf(nowDate: Date, pastIso: string): string {
  const past = new Date(pastIso);
  if (Number.isNaN(past.getTime())) {
    throw new Error(`Invalid timestamp: ${pastIso}`);
  }

  const ageMs = Math.max(0, nowDate.getTime() - past.getTime());
  const totalMinutes = Math.floor(ageMs / (60 * 1000));
  if (totalMinutes === 0) return "0m";

  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes % (24 * 60) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

  return parts.join(" ");
}

export function assertIsoDate(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return toIso(parsed);
}
