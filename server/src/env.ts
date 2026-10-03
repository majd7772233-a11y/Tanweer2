/**
 * Every binding, secret and configuration value the Worker can see, collected
 * in one place so the rest of the code never reads process-wide globals.
 */
export interface Env {
  // ── bindings ──────────────────────────────────────────────────────────────
  TANWEER_DB: D1Database;
  TANWEER_FILES: R2Bucket;
  GROUP_CHAT: DurableObjectNamespace;

  // ── secrets (wrangler secret put …) ───────────────────────────────────────
  PASSWORD_PEPPER: string;
  SESSION_PEPPER: string;
  FILE_SIGNING_SECRET: string;

  // ── vars ──────────────────────────────────────────────────────────────────
  APP_ENV?: string;
  SCHOOL_TIMEZONE?: string;
  MAX_UPLOAD_BYTES?: string;
  ALLOWED_ORIGINS?: string;
  PUBLIC_BASE_URL?: string;

  // ── test-only ─────────────────────────────────────────────────────────────
  TEST_MIGRATIONS?: unknown;
}

export const DEFAULT_SCHOOL_TIMEZONE = 'Asia/Aden';
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const API_PREFIX = '/api/v1';
export const APP_NAME = 'تنوير';

/** KDF parameters published to clients (client-side stretching, see SESSION docs). */
export const PASSWORD_KDF = 'pbkdf2-sha256$210000$32';
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days

/** Community decision thresholds (see docs/GOVERNANCE.md). */
export const VOTE_RULES = {
  /** A deletion needs every eligible member to approve and nobody to refuse. */
  deletion: 'UNANIMOUS',
  /** A correction passes with a majority of eligible members. */
  correction: 'MAJORITY',
  /** A timetable change passes with a quarter of eligible members and more approvals than refusals. */
  schedule: 'QUARTER',
} as const;

export function schoolTimezone(env: Env): string {
  return env.SCHOOL_TIMEZONE || DEFAULT_SCHOOL_TIMEZONE;
}

export function maxUploadBytes(env: Env): number {
  const parsed = Number.parseInt(env.MAX_UPLOAD_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
}

export function allowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS || '*';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
