/**
 * Fixed window rate limiting backed by D1 (our stack has no KV binding).
 * One row per (bucket, identity, window) and one upsert per request, so a
 * request costs a single write — cheap enough for the free plan.
 */
import type { Middleware } from '../lib/context';
import { ApiError } from '../lib/errors';

export interface RateLimitOptions {
  /** 'ip' (default) or 'user' — falls back to ip when the user is unknown. */
  by?: 'ip' | 'user';
  message?: string;
  /** Skip counting when this returns true. */
  exempt?: (identity: string) => boolean;
}

const CLEANUP_PROBABILITY = 0.01;

export function rateLimit(bucket: string, limit: number, windowSeconds: number, options: RateLimitOptions = {}): Middleware {
  const windowMs = windowSeconds * 1000;

  return async (ctx, next) => {
    const identity = options.by === 'user' && ctx.user ? `user:${ctx.user.id}` : `ip:${ctx.ip}`;
    if (options.exempt?.(identity)) return next();

    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const key = `${bucket}:${identity}:${windowStart}`;
    const expiresAt = windowStart + windowMs + 60_000;

    const row = await ctx.env.TANWEER_DB.prepare(
      `INSERT INTO rate_limits (key, bucket, identity, window_start, count, expires_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
       ON CONFLICT (key) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
       RETURNING count`,
    )
      .bind(key, bucket, identity, windowStart, expiresAt, ctx.now)
      .first<{ count: number }>();

    const count = row?.count ?? 1;
    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - Date.now()) / 1000));
      throw new ApiError('RATE_LIMITED', options.message, {
        status: 429,
        details: { retryAfterSeconds: retryAfter, limit, windowSeconds },
      });
    }

    if (Math.random() < CLEANUP_PROBABILITY) {
      ctx.waitUntil(
        ctx.env.TANWEER_DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?1')
          .bind(Date.now())
          .run()
          .then(() => undefined),
      );
    }

    return next();
  };
}

/** Common policies, kept in one place so they are easy to audit. */
export const POLICIES = {
  register: { bucket: 'auth:register', limit: 5, windowSeconds: 3600 },
  /** Salt lookups: cheap, but they reveal nothing, so the limit is generous. */
  kdf: { bucket: 'auth:kdf', limit: 60, windowSeconds: 3600 },
  login: { bucket: 'auth:login', limit: 10, windowSeconds: 600 },
  recovery: { bucket: 'auth:recovery', limit: 5, windowSeconds: 3600 },
  refresh: { bucket: 'auth:refresh', limit: 60, windowSeconds: 3600 },
  write: { bucket: 'write', limit: 120, windowSeconds: 600 },
  upload: { bucket: 'upload', limit: 120, windowSeconds: 3600 },
  issue: { bucket: 'issue', limit: 30, windowSeconds: 3600 },
  comment: { bucket: 'comment', limit: 120, windowSeconds: 3600 },
  vote: { bucket: 'vote', limit: 120, windowSeconds: 3600 },
  chat: { bucket: 'chat', limit: 300, windowSeconds: 600 },
  search: { bucket: 'search', limit: 120, windowSeconds: 600 },
  joinRequest: { bucket: 'join', limit: 20, windowSeconds: 3600 },
} as const;
