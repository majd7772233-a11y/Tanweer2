import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// Real D1 database, real migrations: the tests run against the same schema that
// production uses.
beforeAll(async () => {
  await applyD1Migrations(env.TANWEER_DB, env.TEST_MIGRATIONS as never);
});
