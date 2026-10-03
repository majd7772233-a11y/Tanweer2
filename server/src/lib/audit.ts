/**
 * Append-only trail for sensitive actions. Written in the background so it
 * never slows a response down.
 */
import type { Ctx } from './context';
import { newId } from './ids';

export interface AuditInput {
  action: string;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  groupId?: string | null;
  meta?: Record<string, unknown>;
}

export function audit(ctx: Ctx, input: AuditInput): void {
  const id = newId('audit');
  ctx.waitUntil(
    ctx.env.TANWEER_DB.prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, group_id, meta, ip, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        id,
        input.actorId ?? ctx.user?.id ?? null,
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        input.groupId ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        ctx.ip,
        ctx.now,
      )
      .run()
      .then(() => undefined),
  );
}
