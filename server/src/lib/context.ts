/**
 * Request context: everything a handler needs, threaded through middlewares.
 */
import type { Env } from '../env';
import { schoolTimezone } from '../env';
import { todayIso, nowIso } from './date';
import { parseOrThrow, type Fields, type Schema } from './validation';
import { ApiError } from './errors';

export type Role = 'MEMBER' | 'GROUP_MODERATOR' | 'VERIFIED_TEACHER' | 'OFFICIAL_TEACHER' | 'SCHOOL_ADMIN';

export interface AuthUser {
  id: string;
  phone: string;
  email: string | null;
  fullName: string;
  gradeId: number;
  sectionCode: string;
  classId: string;
  role: Role;
  status: string;
  academicYearId: string | null;
  lastSeenAt: string | null;
  avatarKey: string | null;
}

export interface AuthSession {
  id: string;
  deviceRowId: string;
  expiresAt: string;
}

export interface ClientDevice {
  id: string;
  deviceId: string;
  platform: string;
  appVersion: string | null;
}

export interface Ctx {
  readonly req: Request;
  readonly env: Env;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly ip: string;
  readonly requestId: string;
  readonly timeZone: string;
  /** The school day this request belongs to ('YYYY-MM-DD'). */
  readonly today: string;
  readonly now: string;
  user?: AuthUser;
  session?: AuthSession;
  device?: ClientDevice;
  waitUntil(promise: Promise<unknown>): void;
  /** Parsed JSON body (cached, size limited, never throws on empty body). */
  json<T = Fields>(): Promise<T>;
  /** Parse the body against a schema or fail with a 400 + field errors. */
  require<T>(schema: Schema<T>): Promise<T>;
  param(name: string): string;
  /** Query parameter shortcuts. */
  q(name: string): string | null;
  qInt(name: string, fallback?: number): number | undefined;
  qBool(name: string, fallback?: boolean): boolean;
}

/** A route handler returns a ready Response. */
export type Handler = (ctx: Ctx) => Promise<Response>;

/**
 * Middleware wraps a handler:
 *   export const auth: Middleware = async (ctx, next) => { …; return next(); }
 */
export type Middleware = (ctx: Ctx, next: () => Promise<Response>) => Promise<Response>;

export interface CreateCtxInput {
  req: Request;
  env: Env;
  params: Record<string, string>;
  requestId: string;
  ip: string;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

const MAX_BODY_BYTES = 512 * 1024; // bodies carry metadata only, files go to R2

export function createCtx(input: CreateCtxInput): Ctx {
  const url = new URL(input.req.url);
  const timeZone = schoolTimezone(input.env);
  const now = nowIso();
  let bodyPromise: Promise<unknown> | null = null;

  const ctx: Ctx = {
    req: input.req,
    env: input.env,
    url,
    params: input.params,
    query: url.searchParams,
    ip: input.ip,
    requestId: input.requestId,
    timeZone,
    today: todayIso(timeZone),
    now,
    waitUntil(promise: Promise<unknown>) {
      if (input.executionCtx) input.executionCtx.waitUntil(promise.catch(() => undefined));
      else void promise.catch(() => undefined);
    },
    async json<T = Fields>(): Promise<T> {
      if (!bodyPromise) {
        bodyPromise = (async () => {
          const contentLength = Number.parseInt(input.req.headers.get('content-length') ?? '0', 10);
          if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
            throw new ApiError('PAYLOAD_TOO_LARGE', 'حجم الطلب كبير جدًا.');
          }
          const text = await input.req.text();
          if (text.length > MAX_BODY_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'حجم الطلب كبير جدًا.');
          if (text.trim().length === 0) return {} as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new ApiError('VALIDATION_ERROR', 'صيغة JSON غير صحيحة.');
          }
        })();
      }
      return (await bodyPromise) as T;
    },
    async require<T>(schema: Schema<T>): Promise<T> {
      const body = await ctx.json();
      return parseOrThrow(schema, body);
    },
    param(name: string): string {
      return ctx.params[name] ?? '';
    },
    q(name: string): string | null {
      const value = url.searchParams.get(name);
      return value === null || value === '' ? null : value;
    },
    qInt(name: string, fallback?: number): number | undefined {
      const raw = ctx.q(name);
      if (raw === null) return fallback;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    qBool(name: string, fallback = false): boolean {
      const raw = ctx.q(name);
      if (raw === null) return fallback;
      return raw === '1' || raw === 'true' || raw === 'yes';
    },
  };

  return ctx;
}

export function requireUser(ctx: Ctx): AuthUser {
  if (!ctx.user) throw new ApiError('UNAUTHORIZED');
  return ctx.user;
}

export function userId(ctx: Ctx): string {
  return requireUser(ctx).id;
}
