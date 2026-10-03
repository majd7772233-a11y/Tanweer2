import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('schema + seed', () => {
  it('has the school structure', async () => {
    const grades = await env.TANWEER_DB.prepare('SELECT COUNT(*) AS n FROM grades').first<{ n: number }>();
    const sections = await env.TANWEER_DB.prepare('SELECT COUNT(*) AS n FROM sections').first<{ n: number }>();
    const groups = await env.TANWEER_DB.prepare("SELECT COUNT(*) AS n FROM groups WHERE kind = 'CLASS'").first<{ n: number }>();
    const rooms = await env.TANWEER_DB.prepare('SELECT COUNT(*) AS n FROM chat_rooms').first<{ n: number }>();
    const versions = await env.TANWEER_DB.prepare('SELECT COUNT(*) AS n FROM schedule_versions').first<{ n: number }>();
    expect(grades?.n).toBe(6);
    expect(sections?.n).toBe(16);
    expect(groups?.n).toBe(16);
    expect(rooms?.n).toBe(16);
    expect(versions?.n).toBe(16);
  });
});
