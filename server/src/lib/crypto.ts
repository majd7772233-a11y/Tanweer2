/**
 * Tanweer password model
 * ══════════════════════
 * Cloudflare Workers on the free plan give 10 ms of CPU per request while
 * PBKDF2 with a serious iteration count costs tens of milliseconds. So we split
 * the work the way Bitwarden and 1Password do:
 *
 *   1. the phone computes   authKey = PBKDF2-HMAC-SHA256(password, salt, 210000, 32)
 *      where                 salt    = HMAC-SHA256(PASSWORD_PEPPER, 'tanweer.salt.v1:' + phone)
 *   2. the server stores    password_hash = HMAC-SHA256(PASSWORD_PEPPER, 'tanweer.pw.v1:' + phone + ':' + authKey)
 *
 * The plain password never leaves the phone, the server never stores anything
 * that can be brute forced cheaply, and an attacker who steals the database
 * still has to run the full 210 000 round stretch for every guess (the salt is
 * derived from a pepper that is not in the database).
 *
 * The registered KDF parameters travel with the account so they can be raised
 * later without breaking existing accounts (see PASSWORD_KDF in env.ts).
 */
import { DEFAULT_SCHOOL_TIMEZONE } from '../env';

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(signature));
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

export function randomHex(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toHex(buffer);
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}

/** Constant-time comparison for hex/base64 secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── password helpers ─────────────────────────────────────────────────────────

/** The salt the phone must use before stretching the password. */
export async function passwordSaltFor(pepper: string, phone: string): Promise<string> {
  return hmacSha256Hex(pepper, `tanweer.salt.v1:${phone}`);
}

/** Server side hash of the stretched key received from the phone. */
export async function passwordHashFor(pepper: string, phone: string, authKey: string): Promise<string> {
  return hmacSha256Hex(pepper, `tanweer.pw.v1:${phone}:${authKey.toLowerCase()}`);
}

export async function verifyPassword(params: {
  pepper: string;
  phone: string;
  authKey: string;
  expectedHash: string;
}): Promise<boolean> {
  const computed = await passwordHashFor(params.pepper, params.phone, params.authKey);
  return timingSafeEqual(computed, params.expectedHash);
}

// ── session tokens ───────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  /** user id */
  sub: string;
  /** session id */
  sid: string;
  /** device id */
  dev: string;
  /** role */
  role: string;
  /** issued at (seconds) */
  iat: number;
  /** expires at (seconds) */
  exp: number;
  /** token version */
  v: 1;
}

export async function signAccessToken(secret: string, payload: AccessTokenPayload): Promise<string> {
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacSha256Hex(secret, `${header}.${body}`);
  return `${header}.${body}.${toBase64Url(fromHex(signature))}`;
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessTokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = toBase64Url(fromHex(await hmacSha256Hex(secret, `${header}.${body}`)));
  if (!timingSafeEqual(expected, signature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as AccessTokenPayload;
    if (payload.v !== 1) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function hashRefreshToken(pepper: string, token: string): Promise<string> {
  return hmacSha256Hex(pepper, `tanweer.refresh.v1:${token}`);
}

// ── recovery codes ───────────────────────────────────────────────────────────

/** Crockford base32: no I, L, O, U — nothing that can be misread on paper. */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCode(groups = 4, groupLength = 5): string {
  const bytes = new Uint8Array(groups * groupLength);
  crypto.getRandomValues(bytes);
  const chunks: string[] = [];
  for (let g = 0; g < groups; g += 1) {
    let chunk = '';
    for (let i = 0; i < groupLength; i += 1) {
      chunk += RECOVERY_ALPHABET[(bytes[g * groupLength + i] as number) % RECOVERY_ALPHABET.length];
    }
    chunks.push(chunk);
  }
  return chunks.join('-');
}

export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

export async function hashRecoveryCode(pepper: string, code: string): Promise<string> {
  return hmacSha256Hex(pepper, `tanweer.recovery.v1:${normalizeRecoveryCode(code)}`);
}

// ── signed R2 URLs ───────────────────────────────────────────────────────────

export async function signObjectKey(secret: string, objectKey: string, expiresAt: number): Promise<string> {
  return hmacSha256Hex(secret, `tanweer.file.v1:${objectKey}:${expiresAt}`);
}

export async function verifyObjectSignature(secret: string, objectKey: string, expiresAt: number, signature: string): Promise<boolean> {
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = await signObjectKey(secret, objectKey, expiresAt);
  return timingSafeEqual(expected, signature);
}

// ── internal worker → durable object authentication ─────────────────────────
export async function internalToken(env: { SESSION_PEPPER: string }): Promise<string> {
  return hmacSha256Hex(env.SESSION_PEPPER, 'tanweer.internal.v1');
}

export { DEFAULT_SCHOOL_TIMEZONE };
