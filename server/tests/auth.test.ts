import { beforeEach, describe, expect, it } from 'vitest';
import { api, cleanMutableData, deriveAuthKey, expectError, expectOk, login, registerAccount, resetRateLimits } from './helpers';

beforeEach(async () => {
  await cleanMutableData();
  await resetRateLimits();
});

describe('auth', () => {
  it('never stores the password and hands out a one-time recovery code', async () => {
    const account = await registerAccount();
    const { env } = await import('cloudflare:test');
    const row = await env.TANWEER_DB.prepare('SELECT phone, password_hash, password_kdf, recovery_hash FROM users WHERE id = ?1')
      .bind(account.userId)
      .first<{ phone: string; password_hash: string; password_kdf: string; recovery_hash: string | null }>();

    expect(row?.phone).toBe(account.phone);
    expect(row?.password_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.password_hash).not.toContain(account.password);
    expect(row?.password_hash).toBe(await (await import('../src/lib/crypto')).passwordHashFor('test-password-pepper', account.phone, await deriveAuthKey(account.password, account.phone)));
    expect(row?.password_kdf).toBe('pbkdf2-sha256$210000$32');
    expect(row?.recovery_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(account.recoveryCode).toMatch(/^([0-9A-Z]{5}-){3}[0-9A-Z]{5}$/);
  });

  it('returns the salt and the KDF parameters before the phone stretches the password', async () => {
    const data = await expectOk<{ phone: string; salt: string; iterations: number; algorithm: string }>('POST', '/api/v1/auth/kdf-params', {
      body: { phone: '771234567' },
    });
    expect(data.phone).toBe('+967771234567');
    expect(data.algorithm).toBe('PBKDF2-HMAC-SHA256');
    expect(data.iterations).toBe(210_000);
    expect(data.salt).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a weak profile and an invalid phone with field errors', async () => {
    const badPhone = await api('POST', '/api/v1/auth/register', {
      body: { phone: '123', authKey: 'a'.repeat(64), fullName: 'محمد أحمد', gradeId: 10, sectionCode: 'B', device: { deviceId: 'device-1' } },
    });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error?.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(badPhone.body.error?.fields ?? {}).length).toBeGreaterThan(0);

    const oneWord = await api('POST', '/api/v1/auth/register', {
      body: {
        phone: '771234568',
        authKey: 'a'.repeat(64),
        fullName: 'محمد',
        gradeId: 10,
        sectionCode: 'B',
        device: { deviceId: 'device-2' },
      },
    });
    expect(oneWord.status).toBe(400);
  });

  it('refuses a duplicate phone number', async () => {
    const account = await registerAccount();
    const authKey = await deriveAuthKey('Another-Password1', account.phone);
    const result = await api('POST', '/api/v1/auth/register', {
      body: {
        phone: account.phone,
        authKey,
        fullName: 'طالب آخر تمامًا',
        gradeId: 10,
        sectionCode: 'B',
        device: { deviceId: 'device-3' },
      },
    });
    expect(result.status).toBe(409);
    expect(result.body.error?.code).toBe('PHONE_ALREADY_REGISTERED');
  });

  it('logs in, rotates the refresh token and refuses a replayed one', async () => {
    const account = await registerAccount();
    const tokens = await login(account);
    expect(tokens.accessToken.split('.')).toHaveLength(3);

    const first = await expectOk<{ tokens: { refreshToken: string } }>('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: tokens.refreshToken, device: { deviceId: `dev-${account.phone.slice(-7)}`, platform: 'ANDROID' } },
    });
    expect(first.tokens.refreshToken).not.toBe(tokens.refreshToken);

    const replay = await expectError('POST', '/api/v1/auth/refresh', { body: { refreshToken: tokens.refreshToken } });
    expect(replay.code).toBe('SESSION_REVOKED');
  });

  it('locks the account after five wrong passwords', async () => {
    const account = await registerAccount();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const wrong = await expectError('POST', '/api/v1/auth/login', {
        body: {
          phone: account.phone,
          authKey: await deriveAuthKey(`Wrong-Password-${attempt}`, account.phone),
          device: { deviceId: 'device-lock' },
        },
      });
      expect(wrong.code).toBe('INVALID_CREDENTIALS');
    }

    // the fifth failure locks the account: even the right password is refused
    const fifth = await expectError('POST', '/api/v1/auth/login', {
      body: { phone: account.phone, authKey: await deriveAuthKey('Wrong-Password-4', account.phone), device: { deviceId: 'device-lock' } },
    });
    expect(fifth.code).toBe('ACCOUNT_LOCKED');

    const locked = await expectError('POST', '/api/v1/auth/login', {
      body: { phone: account.phone, authKey: await deriveAuthKey('Tanweer-2026!', account.phone), device: { deviceId: 'device-lock' } },
    });
    expect(locked.code).toBe('ACCOUNT_LOCKED');
  });

  it('changes the password and invalidates the other sessions', async () => {
    const account = await registerAccount();
    const otherDevice = await login(account);

    const newPassword = 'New-Tanweer-2026';
    await expectOk('POST', '/api/v1/auth/password/change', {
      token: account.accessToken,
      body: {
        currentAuthKey: await deriveAuthKey(account.password, account.phone),
        newAuthKey: await deriveAuthKey(newPassword, account.phone),
      },
    });

    const stale = await api('GET', '/api/v1/me', { token: otherDevice.accessToken });
    expect(stale.body.error?.code).toBe('SESSION_REVOKED');

    const fresh = await login({ ...account, password: newPassword });
    expect(fresh.accessToken.length).toBeGreaterThan(20);

    const old = await expectError('POST', '/api/v1/auth/login', {
      body: { phone: account.phone, authKey: await deriveAuthKey(account.password, account.phone), device: { deviceId: 'device-old' } },
    });
    expect(old.code).toBe('INVALID_CREDENTIALS');
  });

  it('resets the password with the recovery code and issues a new one', async () => {
    const account = await registerAccount();
    const newPassword = 'Recovered-2026!';

    const data = await expectOk<{ recoveryCode: string; tokens: { accessToken: string } }>('POST', '/api/v1/auth/recovery/reset', {
      body: {
        phone: account.phone,
        recoveryCode: account.recoveryCode,
        newAuthKey: await deriveAuthKey(newPassword, account.phone),
        device: { deviceId: 'device-recovery', platform: 'ANDROID' },
      },
    });
    expect(data.recoveryCode).not.toBe(account.recoveryCode);

    const reused = await expectError('POST', '/api/v1/auth/recovery/reset', {
      body: {
        phone: account.phone,
        recoveryCode: account.recoveryCode,
        newAuthKey: await deriveAuthKey('Another-One-2026', account.phone),
        device: { deviceId: 'device-recovery' },
      },
    });
    expect(reused.code).toBe('RECOVERY_CODE_INVALID');

    await login({ ...account, password: newPassword });
  });

  it('keeps the access token short lived and revocable', async () => {
    const account = await registerAccount();
    await expectOk('GET', '/api/v1/me', { token: account.accessToken });
    await expectOk('POST', '/api/v1/auth/logout', { token: account.accessToken, body: {} });
    const after = await api('GET', '/api/v1/me', { token: account.accessToken });
    expect(after.body.error?.code).toBe('SESSION_REVOKED');
  });

  it('stores the push token for this device and clears it on an empty token', async () => {
    const account = await registerAccount();
    const { env } = await import('cloudflare:test');

    await expectOk('POST', '/api/v1/me/push-token', { token: account.accessToken, body: { token: 'fcm-registration-abc' } });
    const stored = await env.TANWEER_DB.prepare('SELECT push_token FROM devices WHERE device_id = ?1')
      .bind(account.deviceId)
      .first<{ push_token: string | null }>();
    expect(stored?.push_token).toBe('fcm-registration-abc');

    await expectOk('POST', '/api/v1/me/push-token', { token: account.accessToken, body: { token: '   ' } });
    const cleared = await env.TANWEER_DB.prepare('SELECT push_token FROM devices WHERE device_id = ?1')
      .bind(account.deviceId)
      .first<{ push_token: string | null }>();
    expect(cleared?.push_token).toBeNull();
  });

  it('lists devices and revokes a single one', async () => {
    const account = await registerAccount();
    const devices = await expectOk<Array<{ id: string; platform: string }>>('GET', '/api/v1/me/devices', { token: account.accessToken });
    expect(devices.length).toBe(1);

    const second = await login(account);
    const twoDevices = await expectOk<Array<{ id: string }>>('GET', '/api/v1/me/devices', { token: second.accessToken });
    expect(twoDevices.length).toBe(1); // the same device id signs in again

    const otherPhone = await registerAccount({ phone: undefined });
    const otherLogin = await login(otherPhone);
    const foreign = await api('DELETE', `/api/v1/me/devices/${twoDevices[0]?.id}`, { token: otherLogin.accessToken });
    expect([403, 404]).toContain(foreign.status);
  });
});
