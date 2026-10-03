/**
 * Accounts, sessions and recovery (§4, §6, §57).
 *
 * Login is phone + password. No SMS and no paid verification provider is
 * involved: the phone number is the identifier, and the one-time recovery code
 * handed out at registration is the way back into the account.
 *
 * The phone stretches the password (PBKDF2-HMAC-SHA256, 210 000 rounds) and
 * sends only the derived key; the server stores an HMAC of that key. See
 * lib/crypto.ts for why the split is done this way.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import { ACCESS_TOKEN_TTL_SECONDS, PASSWORD_KDF, REFRESH_TOKEN_TTL_SECONDS } from '../env';
import {
  generateRecoveryCode,
  hashRecoveryCode,
  hashRefreshToken,
  passwordHashFor,
  passwordSaltFor,
  randomToken,
  signAccessToken,
  verifyPassword,
} from '../lib/crypto';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import * as V from '../lib/validation';
import { parseOrThrow } from '../lib/validation';
import {
  clearFailedLogins,
  findSessionByRefreshHash,
  findUserByEmail,
  findUserById,
  findUserByPhone,
  insertSession,
  insertUser,
  registerFailedLogin,
  revokeAllSessionsForUser,
  revokeSession,
  rotateSession,
  updateUserPassword,
  upsertDevice,
  type DeviceRow,
  type UserRow,
} from '../db/queries/users';
import { findActiveAcademicYear, findSection } from '../db/queries/structure';
import { addMember, findClassGroup } from '../db/queries/groups';
import { addRoomMember, findRoomForGroup } from '../db/queries/chat';
import { upsertPreferences } from '../db/queries/notifications';
import { selfUser } from './dto';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

const deviceSpec = {
  deviceId: V.string({ min: 6, max: 128, trim: true }),
  platform: V.withDefault(V.oneOf(['ANDROID', 'IOS', 'WEB', 'OTHER'] as const), 'ANDROID'),
  model: V.optional(V.string({ max: 80 })),
  appVersion: V.optional(V.string({ max: 30 })),
  osVersion: V.optional(V.string({ max: 30 })),
  pushToken: V.optional(V.string({ max: 255 })),
};

export const deviceSchema = V.object(deviceSpec);

export type DeviceInput = V.InferObject<typeof deviceSpec>;

const registerSchema = V.object({
  phone: V.phone(),
  authKey: V.authKey(),
  fullName: V.string({ min: 5, max: 60 }),
  gradeId: V.number({ min: 7, max: 12 }),
  sectionCode: V.sectionCode(),
  email: V.optional(V.email()),
  device: deviceSchema,
  clientUploadId: V.optional(V.string({ max: 120 })),
});

const loginSchema = V.object({
  phone: V.phone(),
  authKey: V.authKey(),
  device: deviceSchema,
  clientUploadId: V.optional(V.string({ max: 120 })),
});

const refreshSchema = V.object({
  refreshToken: V.string({ min: 20, max: 200 }),
  device: V.optional(deviceSchema),
});

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

function deviceUpsertInput(ctx: Ctx, userId: string, device: DeviceInput) {
  return {
    id: newId('dev'),
    userId,
    deviceId: device.deviceId,
    platform: device.platform,
    model: device.model ?? null,
    appVersion: device.appVersion ?? null,
    osVersion: device.osVersion ?? null,
    pushToken: device.pushToken ?? null,
    now: ctx.now,
  };
}

async function issueTokens(ctx: Ctx, user: UserRow, deviceRow: DeviceRow): Promise<TokenBundle> {
  const sessionId = newId('ses');
  const refreshToken = randomToken(32);
  const refreshHash = await hashRefreshToken(ctx.env.SESSION_PEPPER, refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();

  await insertSession(ctx.env.TANWEER_DB, {
    id: sessionId,
    userId: user.id,
    deviceRowId: deviceRow.id,
    refreshHash,
    expiresAt,
    ip: ctx.ip,
    userAgent: ctx.req.headers.get('user-agent'),
    now: ctx.now,
  });

  const seconds = Math.floor(Date.now() / 1000);
  const accessToken = await signAccessToken(ctx.env.SESSION_PEPPER, {
    sub: user.id,
    sid: sessionId,
    dev: deviceRow.id,
    role: user.role,
    iat: seconds,
    exp: seconds + ACCESS_TOKEN_TTL_SECONDS,
    v: 1,
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
  };
}

/** GET /auth/kdf-params — the salt the phone needs before stretching (§57). */
export async function kdfParams(ctx: Ctx, rawPhone: string) {
  const { phone } = parseOrThrow(V.object({ phone: V.phone() }), { phone: rawPhone });
  const salt = await passwordSaltFor(ctx.env.PASSWORD_PEPPER, phone);
  return {
    phone,
    kdf: PASSWORD_KDF,
    algorithm: 'PBKDF2-HMAC-SHA256',
    iterations: 210000,
    keyLength: 32,
    salt,
  };
}

export async function register(ctx: Ctx) {
  const input = await ctx.require(registerSchema);
  const words = input.fullName.trim().split(/\s+/);
  if (words.length < 2) {
    throw new ApiError('VALIDATION_ERROR', 'اكتب الاسم الثلاثي كاملًا.', {
      fields: { fullName: 'اكتب الاسم الثلاثي كاملًا.' },
    });
  }

  const db = ctx.env.TANWEER_DB;
  const existing = await findUserByPhone(db, input.phone);
  if (existing) throw new ApiError('PHONE_ALREADY_REGISTERED');
  if (input.email) {
    const emailOwner = await findUserByEmail(db, input.email);
    if (emailOwner) throw new ApiError('EMAIL_ALREADY_REGISTERED');
  }

  const section = await findSection(db, input.gradeId, input.sectionCode);
  if (!section) {
    throw new ApiError('VALIDATION_ERROR', 'الصف أو الشعبة غير صحيحة.', {
      fields: { sectionCode: 'الصف أو الشعبة غير صحيحة.' },
    });
  }

  const academicYear = await findActiveAcademicYear(db);
  const userId = newId('usr');
  const classId = `${input.gradeId}-${input.sectionCode}`;
  const passwordHash = await passwordHashFor(ctx.env.PASSWORD_PEPPER, input.phone, input.authKey);
  const recoveryCode = generateRecoveryCode();
  const recoveryHash = await hashRecoveryCode(ctx.env.SESSION_PEPPER, recoveryCode);

  await insertUser(db, {
    id: userId,
    phone: input.phone,
    email: input.email ?? null,
    fullName: input.fullName.trim(),
    gradeId: input.gradeId,
    sectionCode: input.sectionCode,
    classId,
    academicYearId: academicYear?.id ?? null,
    passwordHash,
    passwordKdf: PASSWORD_KDF,
    recoveryHash,
    now: ctx.now,
  });

  // Every account belongs to its class group, automatically (§3).
  const classGroup = await findClassGroup(db, input.gradeId, input.sectionCode, academicYear?.id ?? null);
  if (classGroup) {
    await addMember(db, { groupId: classGroup.id, userId, role: 'MEMBER', now: ctx.now });
    const room = await findRoomForGroup(db, classGroup.id);
    if (room) await addRoomMember(db, room.id, userId, ctx.now);
  }

  await upsertPreferences(db, userId, {}, ctx.now);
  const deviceRow = await upsertDevice(db, deviceUpsertInput(ctx, userId, input.device));

  const user = await findUserById(db, userId);
  if (!user) throw new ApiError('INTERNAL_ERROR');
  const tokens = await issueTokens(ctx, user, deviceRow);

  audit(ctx, { action: 'auth.register', actorId: userId, entityType: 'USER', entityId: userId, meta: { classId } });

  return {
    user: selfUser(user),
    tokens,
    /** Shown exactly once. It is the only way back in without a password. */
    recoveryCode,
    groups: classGroup ? [{ id: classGroup.id, kind: classGroup.kind, name: classGroup.name }] : [],
  };
}

export async function login(ctx: Ctx) {
  const input = await ctx.require(loginSchema);
  const db = ctx.env.TANWEER_DB;
  const user = await findUserByPhone(db, input.phone);

  if (!user) {
    // Equalise timing so a stranger cannot probe which numbers are registered.
    await passwordHashFor(ctx.env.PASSWORD_PEPPER, input.phone, input.authKey);
    throw new ApiError('INVALID_CREDENTIALS');
  }
  if (user.locked_until && user.locked_until > ctx.now) throw new ApiError('ACCOUNT_LOCKED');
  if (user.status === 'SUSPENDED') throw new ApiError('ACCOUNT_SUSPENDED');

  const ok = await verifyPassword({
    pepper: ctx.env.PASSWORD_PEPPER,
    phone: user.phone,
    authKey: input.authKey,
    expectedHash: user.password_hash,
  });

  if (!ok) {
    const failed = user.failed_logins + 1;
    const lockedUntil = failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
    await registerFailedLogin(db, user.id, lockedUntil, ctx.now);
    audit(ctx, { action: 'auth.login.failed', actorId: user.id, entityType: 'USER', entityId: user.id, meta: { failed } });
    throw failed >= MAX_FAILED_LOGINS ? new ApiError('ACCOUNT_LOCKED') : new ApiError('INVALID_CREDENTIALS');
  }

  await clearFailedLogins(db, user.id);
  const deviceRow = await upsertDevice(db, deviceUpsertInput(ctx, user.id, input.device));
  const tokens = await issueTokens(ctx, user, deviceRow);
  audit(ctx, { action: 'auth.login', actorId: user.id, entityType: 'USER', entityId: user.id });

  return { user: selfUser(user), tokens, classId: user.class_id };
}

export async function refresh(ctx: Ctx) {
  const input = await ctx.require(refreshSchema);
  const db = ctx.env.TANWEER_DB;
  const hash = await hashRefreshToken(ctx.env.SESSION_PEPPER, input.refreshToken);
  const session = await findSessionByRefreshHash(db, hash);
  if (!session || session.revoked_at !== null || session.expires_at <= ctx.now) {
    throw new ApiError('SESSION_REVOKED');
  }

  const userRow = await findUserById(db, session.user_id);
  if (!userRow || userRow.status === 'SUSPENDED') throw new ApiError('SESSION_REVOKED');

  const newRefresh = randomToken(32);
  const newHash = await hashRefreshToken(ctx.env.SESSION_PEPPER, newRefresh);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  await rotateSession(db, session.id, newHash, expiresAt, ctx.now);

  const seconds = Math.floor(Date.now() / 1000);
  const accessToken = await signAccessToken(ctx.env.SESSION_PEPPER, {
    sub: userRow.id,
    sid: session.id,
    dev: session.device_id,
    role: userRow.role,
    iat: seconds,
    exp: seconds + ACCESS_TOKEN_TTL_SECONDS,
    v: 1,
  });

  return {
    user: selfUser(userRow),
    tokens: {
      accessToken,
      refreshToken: newRefresh,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    },
  };
}

export async function logout(ctx: Ctx) {
  const session = ctx.session;
  if (!session) throw new ApiError('UNAUTHORIZED');
  await revokeSession(ctx.env.TANWEER_DB, session.id, ctx.now);
  audit(ctx, { action: 'auth.logout', entityType: 'SESSION', entityId: session.id });
  return { loggedOut: true };
}

const changePasswordSchema = V.object({
  currentAuthKey: V.authKey(),
  newAuthKey: V.authKey(),
  rotateRecoveryCode: V.withDefault(V.boolean(), false),
});

export async function changePassword(ctx: Ctx) {
  const input = await ctx.require(changePasswordSchema);
  const current = ctx.user;
  if (!current) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findUserById(db, current.id);
  if (!row) throw new ApiError('UNAUTHORIZED');

  const ok = await verifyPassword({
    pepper: ctx.env.PASSWORD_PEPPER,
    phone: row.phone,
    authKey: input.currentAuthKey,
    expectedHash: row.password_hash,
  });
  if (!ok) throw new ApiError('INVALID_CREDENTIALS', 'كلمة المرور الحالية غير صحيحة.');

  const newHash = await passwordHashFor(ctx.env.PASSWORD_PEPPER, row.phone, input.newAuthKey);
  let recoveryCode: string | null = null;
  let recoveryHash: string | null = null;
  if (input.rotateRecoveryCode) {
    recoveryCode = generateRecoveryCode();
    recoveryHash = await hashRecoveryCode(ctx.env.SESSION_PEPPER, recoveryCode);
  }
  await updateUserPassword(db, row.id, newHash, PASSWORD_KDF, recoveryHash, ctx.now);

  // Every other device is signed out at once; the device that changed the
  // password keeps its session so the user is not thrown out mid-flow (§5).
  const students = ctx.session?.id;
  await revokeAllSessionsForUser(db, row.id, ctx.now, students);
  audit(ctx, { action: 'auth.password.changed', entityType: 'USER', entityId: row.id, meta: { keptSession: students ?? null } });

  return { changed: true, recoveryCode, otherDevicesSignedOut: true };
}

const recoverySchema = V.object({
  phone: V.phone(),
  recoveryCode: V.string({ min: 10, max: 40 }),
  newAuthKey: V.authKey(),
  device: deviceSchema,
});

/** Uses the one-time recovery code (§4) — no SMS, no email, no paid provider. */
export async function resetWithRecovery(ctx: Ctx) {
  const input = await ctx.require(recoverySchema);
  const db = ctx.env.TANWEER_DB;
  const user = await findUserByPhone(db, input.phone);
  if (!user || !user.recovery_hash) throw new ApiError('RECOVERY_CODE_INVALID');

  const provided = await hashRecoveryCode(ctx.env.SESSION_PEPPER, input.recoveryCode);
  if (provided !== user.recovery_hash) {
    audit(ctx, { action: 'auth.recovery.failed', actorId: user.id, entityType: 'USER', entityId: user.id });
    throw new ApiError('RECOVERY_CODE_INVALID');
  }

  const newHash = await passwordHashFor(ctx.env.PASSWORD_PEPPER, user.phone, input.newAuthKey);
  const freshCode = generateRecoveryCode();
  const freshHash = await hashRecoveryCode(ctx.env.SESSION_PEPPER, freshCode);
  await updateUserPassword(db, user.id, newHash, PASSWORD_KDF, freshHash, ctx.now);
  await revokeAllSessionsForUser(db, user.id, ctx.now);

  const deviceRow = await upsertDevice(db, deviceUpsertInput(ctx, user.id, input.device));
  const tokens = await issueTokens(ctx, user, deviceRow);
  audit(ctx, { action: 'auth.recovery.used', entityType: 'USER', entityId: user.id });

  return { user: selfUser(user), tokens, recoveryCode: freshCode };
}
