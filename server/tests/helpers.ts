/**
 * Test helpers.
 *
 * The tests talk to the real Worker through `SELF.fetch`, against a real D1
 * database created by the real migrations, so an endpoint that passes here
 * really works.
 */
import { SELF, env } from 'cloudflare:test';
import { passwordSaltFor } from '../src/lib/crypto';

export const BASE = 'https://tanweer.test';
export const PASSWORD_PEPPER = 'test-password-pepper';

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: { success?: boolean; data?: T; error?: { code: string; message: string; fields?: Record<string, string> }; meta?: unknown } & Record<string, unknown>;
}

export async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await SELF.fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: ApiResult<T>['body'];
  try {
    body = text.length > 0 ? (JSON.parse(text) as ApiResult<T>['body']) : {};
  } catch {
    body = { raw: text } as ApiResult<T>['body'];
  }
  return { status: response.status, body };
}

/** Calls an endpoint and fails loudly with the server's own error message. */
export async function expectOk<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<T> {
  const result = await api<T>(method, path, options);
  if (result.status >= 400 || result.body.success === false) {
    throw new Error(`${method} ${path} → ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body.data as T;
}

export async function expectError(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<{ status: number; code: string }> {
  const result = await api(method, path, options);
  const code = result.body.error?.code ?? '';
  if (result.status < 400) throw new Error(`${method} ${path} unexpectedly succeeded: ${JSON.stringify(result.body)}`);
  return { status: result.status, code };
}

/** Clears the fixed-window counters so one test cannot exhaust another. */
export async function resetRateLimits(): Promise<void> {
  await env.TANWEER_DB.prepare('DELETE FROM rate_limits').run();
}

export async function resetAll(): Promise<void> {
  await resetRateLimits();
}

// ── password stretching, exactly like the phone does it ──────────────────────

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizePhoneForTest(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '').replace(/^967/, '').replace(/^0+/, '');
  return `+967${digits}`;
}

/**
 * authKey = PBKDF2-HMAC-SHA256(password, utf8(hexSalt), 210_000, 32 bytes).
 * The password itself never leaves the device.
 */
export async function deriveAuthKey(password: string, phone: string): Promise<string> {
  const normalized = normalizePhoneForTest(phone);
  const saltHex = await passwordSaltFor(PASSWORD_PEPPER, normalized);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 210_000, hash: 'SHA-256' },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export interface TestAccount {
  userId: string;
  phone: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  recoveryCode: string;
  classGroupId: string;
  deviceId: string;
  gradeId: number;
  sectionCode: string;
  fullName: string;
}

let phoneCounter = 0;

export function nextPhone(): string {
  phoneCounter += 1;
  const suffix = String(1_000_000 + phoneCounter).slice(-7);
  return `+96777${suffix}`; // 77 + 7 digits → matches 7[01378]\d{7}
}

export async function registerAccount(overrides: Partial<{ fullName: string; gradeId: number; sectionCode: string; password: string; phone: string }> = {}): Promise<TestAccount> {
  const phone = overrides.phone ?? nextPhone();
  const password = overrides.password ?? 'Tanweer-2026!';
  const fullName = overrides.fullName ?? 'محمد أحمد الشامي';
  const gradeId = overrides.gradeId ?? 10;
  const sectionCode = overrides.sectionCode ?? 'B';

  const authKey = await deriveAuthKey(password, phone);
  const data = await expectOk<{
    user: { id: string; gradeId: number; sectionCode: string; classId: string };
    tokens: { accessToken: string; refreshToken: string };
    recoveryCode: string;
    groups: Array<{ id: string; kind: string }>;
  }>('POST', '/api/v1/auth/register', {
    body: {
      phone,
      authKey,
      fullName,
      gradeId,
      sectionCode,
      device: { deviceId: `dev-${phone.slice(-7)}`, platform: 'ANDROID', model: 'Test', appVersion: '1.0.0' },
    },
  });

  return {
    userId: data.user.id,
    phone: normalizePhoneForTest(phone),
    password,
    accessToken: data.tokens.accessToken,
    refreshToken: data.tokens.refreshToken,
    recoveryCode: data.recoveryCode,
    classGroupId: data.groups.find((group) => group.kind === 'CLASS')?.id ?? '',
    deviceId: `dev-${phone.slice(-7)}`,
    gradeId,
    sectionCode,
    fullName,
  };
}

export async function login(account: TestAccount, password = account.password): Promise<{ accessToken: string; refreshToken: string }> {
  const authKey = await deriveAuthKey(password, account.phone);
  const data = await expectOk<{ tokens: { accessToken: string; refreshToken: string } }>('POST', '/api/v1/auth/login', {
    body: { phone: account.phone, authKey, device: { deviceId: `dev-${account.phone.slice(-7)}`, platform: 'ANDROID' } },
  });
  return data.tokens;
}

/** sha256 hex — the canonical fingerprint used for duplicate detection (§19). */
export async function checksumOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

export interface UploadedFile {
  fileId: string;
  checksum: string;
  sizeBytes: number;
}

/**
 * The real upload path: intent → PUT the bytes into R2 through the signed URL →
 * complete. Nothing is mocked, so a broken signature or a broken R2 key fails
 * here instead of in production.
 */
export async function uploadFile(account: TestAccount, options: { bytes?: Uint8Array; mimeType?: string; purpose?: string; fileName?: string } = {}): Promise<UploadedFile> {
  const bytes = options.bytes ?? new TextEncoder().encode(`tanweer-image-${Math.random()}`);
  const mimeType = options.mimeType ?? 'image/jpeg';
  const checksum = await checksumOf(bytes);

  const intent = await expectOk<{ fileId: string; uploadUrl: string; method: string }>('POST', '/api/v1/files/upload-intent', {
    token: account.accessToken,
    body: { purpose: options.purpose ?? 'CONTENT_MEDIA', mimeType, sizeBytes: bytes.length, checksum, fileName: options.fileName ?? 'page.jpg' },
  });

  const upload = await SELF.fetch(intent.uploadUrl, { method: 'PUT', headers: { 'content-type': mimeType }, body: bytes });
  if (upload.status >= 400) throw new Error(`PUT ${intent.uploadUrl} → ${upload.status} ${await upload.text()}`);

  await expectOk('POST', '/api/v1/files/complete', {
    token: account.accessToken,
    body: { fileId: intent.fileId, width: 1080, height: 1440, sizeBytes: bytes.length, checksum },
  });

  return { fileId: intent.fileId, checksum, sizeBytes: bytes.length };
}

/** Clears everything a test wrote, keeping the seeded school structure. */
export async function cleanMutableData(): Promise<void> {
  const statements = [
    'DELETE FROM votes',
    'DELETE FROM deletion_requests',
    'DELETE FROM correction_requests',
    'DELETE FROM content_relations',
    'DELETE FROM content_revisions',
    'DELETE FROM comments',
    'DELETE FROM reactions',
    'DELETE FROM bookmarks',
    'DELETE FROM pins',
    'DELETE FROM content_contributions',
    'DELETE FROM content_media',
    'DELETE FROM content',
    'DELETE FROM homework_completions',
    'DELETE FROM homeworks',
    'DELETE FROM exams',
    'DELETE FROM events',
    'DELETE FROM issue_comments',
    'DELETE FROM issues',
    'DELETE FROM schedule_proposals',
    'DELETE FROM schedule_slots',
    'DELETE FROM notifications',
    'DELETE FROM notification_preferences',
    'DELETE FROM notes',
    'DELETE FROM upload_intents',
    'DELETE FROM files',
    'DELETE FROM chat_messages',
    'DELETE FROM chat_read_state',
    'DELETE FROM chat_room_members',
    "DELETE FROM chat_rooms WHERE kind = 'DIRECT'",
    'DELETE FROM group_join_requests',
    "DELETE FROM group_members WHERE group_id NOT IN (SELECT id FROM groups WHERE kind = 'CLASS')",
    "DELETE FROM group_sections WHERE group_id NOT IN (SELECT id FROM groups WHERE kind = 'CLASS')",
    "DELETE FROM groups WHERE kind <> 'CLASS'",
    'DELETE FROM audit_log',
    'DELETE FROM sessions',
    'DELETE FROM devices',
    'DELETE FROM group_members',
    'DELETE FROM users',
    'DELETE FROM idempotency_keys',
    'DELETE FROM rate_limits',
  ];

  for (const statement of statements) {
    try {
      await env.TANWEER_DB.prepare(statement).run();
    } catch {
      // a table may not exist yet in an older migration set; keep going
    }
  }

  // Counters are recomputed, never zeroed by hand.
  try {
    await env.TANWEER_DB.prepare(
      `UPDATE groups SET member_count = (
         SELECT COUNT(*) FROM group_members m WHERE m.group_id = groups.id AND m.status = 'ACTIVE'
       )`,
    ).run();
  } catch {
    // ignore
  }
}
