import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside workerd (the real Workers runtime) through Miniflare:
 * a real D1 database migrated with the real SQL migrations, a real R2 bucket
 * and a real Durable Object. The platform is not mocked.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./src/db/migrations');

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            APP_ENV: 'test',
            SCHOOL_TIMEZONE: 'Asia/Aden',
            MAX_UPLOAD_BYTES: '26214400',
            ALLOWED_ORIGINS: '*',
            PUBLIC_BASE_URL: 'https://tanweer.magd.workers.dev',
            PASSWORD_PEPPER: 'test-password-pepper',
            SESSION_PEPPER: 'test-session-pepper',
            FILE_SIGNING_SECRET: 'test-file-signing-secret',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ['tests/**/*.test.ts'],
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
