/**
 * Every successful answer has the same envelope:
 *   { "success": true, "data": …, "meta": { … } }
 * so the Android client has exactly one parser.
 */
import { allowedOrigins } from '../env';
import { ApiError } from './errors';

interface CorsEnv {
  ALLOWED_ORIGINS?: string;
}

/** Echo the caller's origin only when the deployment allows it. */
function resolveOrigin(request: Request, env: CorsEnv): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const allowed = allowedOrigins(env as never);
  if (allowed.includes('*')) return origin;
  return allowed.includes(origin) ? origin : null;
}

const CORS_METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS';
const CORS_HEADERS = 'authorization, content-type, x-client-upload-id, x-tanweer-version, x-device-id, x-request-id';

/** Adds the CORS headers to an existing response (never to a 101 upgrade). */
export function withCors(request: Request, env: CorsEnv, response: Response): Response {
  const origin = resolveOrigin(request, env);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-credentials', 'true');
  headers.set('vary', 'origin');
  headers.set('access-control-expose-headers', 'x-tanweer-idempotent-replay, x-tanweer-api');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function corsPreflightResponse(request: Request, env: CorsEnv): Response {
  const origin = resolveOrigin(request, env) ?? '*';
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': CORS_METHODS,
      'access-control-allow-headers': CORS_HEADERS,
      'access-control-max-age': '86400',
      vary: 'origin',
    },
  });
}

export interface Meta {
  cursor?: string | null;
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
  serverTime?: string;
  today?: string;
  [key: string]: unknown;
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'x-tanweer-api': 'v1',
};

export function jsonResponse(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { ...BASE_HEADERS, ...(init.headers ?? {}) },
  });
}

export function ok(data: unknown, meta?: Meta): Response {
  return jsonResponse({ success: true, data, ...(meta ? { meta } : {}) });
}

export function created(data: unknown, meta?: Meta): Response {
  return ok(data, meta);
}

export function listResponse<T>(items: T[], meta: Meta = {}): Response {
  return ok(items, meta);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse(error.toJSON(), { status: error.status });
  }
  const fallback = new ApiError('INTERNAL_ERROR');
  return jsonResponse(fallback.toJSON(), { status: 500 });
}

export function notFoundResponse(path: string): Response {
  return jsonResponse(
    { success: false, error: { code: 'NOT_FOUND', message: `المسار غير موجود: ${path}` } },
    { status: 404 },
  );
}

export function methodNotAllowedResponse(method: string, path: string): Response {
  return jsonResponse(
    { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: `الطريقة ${method} غير مدعومة على ${path}` } },
    { status: 405 },
  );
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'x-tanweer-api': 'v1' } });
}

export function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export function binaryResponse(body: ReadableStream | ArrayBuffer, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers });
}
