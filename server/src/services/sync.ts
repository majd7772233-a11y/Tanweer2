/**
 * Delta synchronisation (§83, §84).
 *
 * The client never re-downloads a day it already has. It sends the cursor it
 * received last time and gets back only what changed after it, grouped per
 * entity, with a fresh cursor.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import { allRows } from '../db/queries/shared';
import { listGroupsForUser } from '../db/queries/groups';
import { listMediaForContents } from '../db/queries/content';
import { contentDto, examDto, eventDto, homeworkDto, issueDto } from './dto';

export async function pull(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const since = ctx.q('since') ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const requestedGroup = ctx.q('groupId');

  const groups = await listGroupsForUser(db, user.id);
  const scope = requestedGroup ? groups.filter((group) => group.id === requestedGroup) : groups;
  if (requestedGroup && scope.length === 0) throw new ApiError('NOT_A_MEMBER');
  const ids = scope.map((group) => group.id);
  if (ids.length === 0) return { cursor: ctx.now, changed: emptyChanges() };

  const list = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  const limit = Math.min(ctx.qInt('limit') ?? 100, 300);

  const [content, homeworks, exams, events, issues] = await db.batch([
    db
      .prepare(
        `SELECT c.*, u.full_name AS author_name, u.grade_id AS author_grade, u.section_code AS author_section,
                s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color, g.name AS group_name
           FROM content c JOIN users u ON u.id = c.created_by JOIN groups g ON g.id = c.group_id LEFT JOIN subjects s ON s.id = c.subject_id
          WHERE c.group_id IN (${list}) AND c.updated_at > ?1 ORDER BY c.updated_at ASC LIMIT ?2`,
      )
      .bind(since, limit),
    db
      .prepare(
        `SELECT h.*, u.full_name AS author_name, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color, g.name AS group_name,
                COALESCE((SELECT hc.status FROM homework_completions hc WHERE hc.homework_id = h.id AND hc.user_id = ?3), 'NOT_DONE') AS done
           FROM homeworks h JOIN users u ON u.id = h.created_by JOIN groups g ON g.id = h.group_id LEFT JOIN subjects s ON s.id = h.subject_id
          WHERE h.group_id IN (${list}) AND h.updated_at > ?1 ORDER BY h.updated_at ASC LIMIT ?2`,
      )
      .bind(since, limit, user.id),
    db
      .prepare(
        `SELECT e.*, u.full_name AS author_name, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color
           FROM exams e JOIN users u ON u.id = e.created_by LEFT JOIN subjects s ON s.id = e.subject_id
          WHERE e.group_id IN (${list}) AND e.updated_at > ?1 ORDER BY e.updated_at ASC LIMIT ?2`,
      )
      .bind(since, limit),
    db
      .prepare(
        `SELECT v.*, u.full_name AS author_name, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color
           FROM events v JOIN users u ON u.id = v.created_by LEFT JOIN subjects s ON s.id = v.subject_id
          WHERE v.group_id IN (${list}) AND v.updated_at > ?1 ORDER BY v.updated_at ASC LIMIT ?2`,
      )
      .bind(since, limit),
    db
      .prepare(
        `SELECT i.*, u.full_name AS author_name, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color
           FROM issues i JOIN users u ON u.id = i.created_by LEFT JOIN subjects s ON s.id = i.subject_id
          WHERE i.group_id IN (${list}) AND i.updated_at > ?1 ORDER BY i.updated_at ASC LIMIT ?2`,
      )
      .bind(since, limit),
  ]);

  const contentRows = (content?.results ?? []) as never[];
  const media = await listMediaForContents(
    db,
    (contentRows as Array<{ id: string }>).map((row) => row.id),
  );

  const cursor = [content, homeworks, exams, events, issues]
    .flatMap((result) => (result?.results ?? []) as Array<{ updated_at: string }>)
    .reduce((latest, row) => (row.updated_at > latest ? row.updated_at : latest), since);

  return {
    since,
    cursor: cursor === since ? ctx.now : cursor,
    changed: {
      content: (contentRows as never[]).map((row) => contentDto(row, { media: media.get((row as { id: string }).id) ?? [] })),
      homeworks: (homeworks?.results ?? []).map((row) => homeworkDto(row as never)),
      exams: (exams?.results ?? []).map((row) => examDto(row as never)),
      events: (events?.results ?? []).map((row) => eventDto(row as never)),
      issues: (issues?.results ?? []).map((row) => issueDto(row as never)),
    },
  };
}

function emptyChanges() {
  return { content: [], homeworks: [], exams: [], events: [], issues: [] };
}

/**
 * The offline queue (§86). The client pushes what it captured while offline;
 * entries are idempotent through client_upload_id, so a retry is harmless.
 */
export async function queuedCount(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const row = await allRows<{ n: number }>(
    ctx.env.TANWEER_DB.prepare("SELECT COUNT(*) AS n FROM upload_intents WHERE user_id = ?1 AND completed_at IS NULL")
      .bind(user.id),
  );
  return { pendingUploads: row[0]?.n ?? 0 };
}
