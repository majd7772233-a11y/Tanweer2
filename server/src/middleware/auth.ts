/**
 * Session middleware: verifies the short lived access token, then confirms the
 * session, the device and the user are all still valid. Revoking a device in
 * the app therefore kills its access immediately, not in an hour.
 */
import type { Middleware } from '../lib/context';
import { ApiError } from '../lib/errors';
import { verifyAccessToken } from '../lib/crypto';
import { findDeviceById, findSessionById, findUserById, toAuthUser, touchDevice, touchUserSeen } from '../db/queries/users';

const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

async function resolve(ctx: Parameters<Middleware>[0]): Promise<void> {
  const token = bearerToken(ctx.req);
  if (!token) throw new ApiError('UNAUTHORIZED');

  const payload = await verifyAccessToken(ctx.env.SESSION_PEPPER, token);
  if (!payload) throw new ApiError('TOKEN_EXPIRED');

  const [userRow, sessionRow] = await Promise.all([
    findUserById(ctx.env.TANWEER_DB, payload.sub),
    findSessionById(ctx.env.TANWEER_DB, payload.sid),
  ]);

  if (!userRow) throw new ApiError('UNAUTHORIZED');
  if (!sessionRow || sessionRow.revoked_at !== null || sessionRow.expires_at <= ctx.now) {
    throw new ApiError('SESSION_REVOKED');
  }
  if (sessionRow.device_id !== payload.dev) throw new ApiError('SESSION_REVOKED');
  if (userRow.status === 'SUSPENDED') throw new ApiError('ACCOUNT_SUSPENDED');

  const deviceRow = await findDeviceById(ctx.env.TANWEER_DB, sessionRow.device_id);
  if (!deviceRow || deviceRow.session_status !== 'ACTIVE' || deviceRow.user_id !== userRow.id) {
    throw new ApiError('SESSION_REVOKED');
  }

  ctx.user = toAuthUser(userRow);
  ctx.session = { id: sessionRow.id, deviceRowId: deviceRow.id, expiresAt: sessionRow.expires_at };
  ctx.device = {
    id: deviceRow.id,
    deviceId: deviceRow.device_id,
    platform: deviceRow.platform,
    appVersion: deviceRow.app_version,
  };

  const lastSeen = userRow.last_seen_at ? Date.parse(userRow.last_seen_at) : 0;
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > LAST_SEEN_WRITE_INTERVAL_MS) {
    ctx.waitUntil(
      Promise.all([
        touchUserSeen(ctx.env.TANWEER_DB, userRow.id, ctx.now),
        touchDevice(ctx.env.TANWEER_DB, deviceRow.id, ctx.now),
      ]),
    );
  }
}

export const auth: Middleware = async (ctx, next) => {
  await resolve(ctx);
  return next();
};

/** For endpoints that behave better when they know the user (feeds, search). */
export const optionalAuth: Middleware = async (ctx, next) => {
  try {
    await resolve(ctx);
  } catch {
    ctx.user = undefined;
    ctx.session = undefined;
    ctx.device = undefined;
  }
  return next();
};
