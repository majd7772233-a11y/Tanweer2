/**
 * تنوير — نقطة الدخول إلى الخادم.
 *
 *   request → CORS → context → router → service → D1 / R2 / Durable Object
 *
 * The Worker itself is stateless: every fact lives in D1 (metadata), R2 (files)
 * or a Durable Object (the live order of a conversation) — §102.
 */
import { createCtx } from './lib/context';
import { ApiError, internal } from './lib/errors';
import { corsPreflightResponse, errorResponse, withCors } from './lib/response';
import { buildRouter } from './router';
import { handleWebSocketUpgrade } from './realtime/entry';
import { purgeExpiredObjects } from './services/files';
import type { Env } from './env';

// Wrangler requires the Durable Object class to be exported from the entrypoint.
export { GroupChatDO } from './realtime/GroupChatDO';

const router = buildRouter();
const API_PREFIX = '/api/';

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsPreflightResponse(request, env);

    // ── realtime ────────────────────────────────────────────────────────────
    if (url.pathname === '/ws' || url.pathname === '/ws/') {
      return handleWebSocketUpgrade(request, env, executionCtx);
    }

    if (!url.pathname.startsWith(API_PREFIX)) {
      if (url.pathname === '/' || url.pathname === '') return landingResponse(env);
      return withCors(request, env, errorResponse(new ApiError('NOT_FOUND', 'المسار غير موجود.')));
    }

    const ctx = createCtx({
      req: request,
      env,
      params: {},
      requestId: request.headers.get('cf-ray') ?? crypto.randomUUID(),
      ip: request.headers.get('cf-connecting-ip') ?? '0.0.0.0',
      executionCtx,
    });

    try {
      const response = await router.handle(ctx);
      return withCors(request, env, response);
    } catch (error) {
      if (error instanceof ApiError) return withCors(request, env, errorResponse(error));

      console.error(
        JSON.stringify({
          at: 'unhandled_error',
          requestId: ctx.requestId,
          path: url.pathname,
          method: request.method,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? (error.stack ?? '').slice(0, 1200) : null,
        }),
      );
      return withCors(request, env, errorResponse(internal()));
    }
  },

  /**
   * Housekeeping only. The app must stay fully usable with the cron disabled:
   * nothing user visible depends on it.
   */
  async scheduled(_event: ScheduledController, env: Env, executionCtx: ExecutionContext): Promise<void> {
    const ctx = createCtx({
      req: new Request('https://tanweer.internal/cron'),
      env,
      params: {},
      requestId: 'cron',
      ip: 'cron',
      executionCtx,
    });
    executionCtx.waitUntil(
      purgeExpiredObjects(ctx)
        .then((count) => {
          if (count > 0) console.log(JSON.stringify({ at: 'cron.purge', removed: count }));
        })
        .catch((error) => {
          console.error(JSON.stringify({ at: 'cron.purge.error', message: error instanceof Error ? error.message : String(error) }));
        }),
    );
  },
} satisfies ExportedHandler<Env>;

function landingResponse(env: Env): Response {
  return new Response(
    JSON.stringify(
      {
        app: 'تنوير',
        description: 'خادم تنوير — مادة دراسية منظّمة لكل يوم.',
        api: '/api/v1',
        realtime: '/ws',
        environment: env.APP_ENV ?? 'unknown',
      },
      null,
      2,
    ),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}
