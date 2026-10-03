/**
 * "Do not create the same thing twice when the network is bad" (§85).
 *
 * The Android client sends the same client_upload_id with every retry. The
 * first successful answer is stored, and every later call with the same key
 * gets that exact answer back instead of a second row.
 */
import type { Ctx, Middleware } from '../lib/context';
import { sha256Hex } from '../lib/crypto';
import { firstOrNull } from '../db/queries/shared';

const TTL_HOURS = 24;

export function clientUploadId(ctx: Ctx, body: Record<string, unknown>): string | null {
  const fromHeader = ctx.req.headers.get('x-client-upload-id');
  const fromBody = typeof body.clientUploadId === 'string' ? body.clientUploadId : typeof body.client_upload_id === 'string' ? (body.client_upload_id as string) : null;
  const candidate = (fromHeader ?? fromBody ?? '').trim();
  if (candidate.length < 6 || candidate.length > 120) return null;
  return candidate;
}

export function idempotent(endpoint: string): Middleware {
  return async (ctx, next) => {
    if (ctx.req.method !== 'POST') return next();
    const body = await ctx.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const key = clientUploadId(ctx, body);
    if (!key || !ctx.user) return next();

    const db = ctx.env.TANWEER_DB;
    const rowKey = `${ctx.user.id}:${endpoint}:${key}`;
    const requestHash = await sha256Hex(JSON.stringify(body));

    const existing = await firstOrNull<{ request_hash: string; response_json: string; status_code: number }>(
      db.prepare('SELECT request_hash, response_json, status_code FROM idempotency_keys WHERE key = ?1 AND expires_at > ?2').bind(rowKey, ctx.now),
    );

    if (existing) {
      if (existing.request_hash === requestHash) {
        return new Response(existing.response_json, {
          status: existing.status_code,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-tanweer-idempotent-replay': '1',
          },
        });
      }
      // Same key, different payload: the client must generate a new key.
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'IDEMPOTENT_REPLAY', message: 'تم تنفيذ هذا الطلب مسبقًا ببيانات مختلفة.' },
        }),
        { status: 409, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    const response = await next();

    if (response.status < 400) {
      const text = await response.clone().text();
      const expiresAt = new Date(Date.now() + TTL_HOURS * 3_600_000).toISOString();
      ctx.waitUntil(
        db
          .prepare(
            `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, response_json, status_code, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (key) DO NOTHING`,
          )
          .bind(rowKey, ctx.user.id, endpoint, requestHash, text, response.status, ctx.now, expiresAt)
          .run()
          .then(() => undefined),
      );
    }

    return response;
  };
}
