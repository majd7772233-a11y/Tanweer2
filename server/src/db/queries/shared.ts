/**
 * Small helpers shared by the query modules.
 *
 * D1 bills per row read, so every list query is index backed and every cursor
 * is derived from an indexed column (see docs/ARCHITECTURE.md).
 */
export async function firstOrNull<T>(statement: D1PreparedStatement | null): Promise<T | null> {
  if (!statement) return null;
  const row = await statement.first<T>();
  return row ?? null;
}

export async function allRows<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}

export async function runAndCount(statement: D1PreparedStatement): Promise<number> {
  const result = await statement.run();
  return result.meta?.changes ?? 0;
}

export interface Cursor {
  ts: string;
  id: string;
}

export function encodeCursor(ts: string, id: string): string {
  return `${ts}|${id}`;
}

export function decodeCursor(cursor: string | null | undefined): Cursor | null {
  if (!cursor) return null;
  const index = cursor.lastIndexOf('|');
  if (index <= 0) return null;
  return { ts: cursor.slice(0, index), id: cursor.slice(index + 1) };
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function jsonColumn(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `IN (?, ?, ?)` placeholder builder. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export const limitOrDefault = (value: number | undefined, fallback: number, max: number): number => {
  if (!value || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
};
