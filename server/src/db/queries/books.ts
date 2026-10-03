/**
 * 📚 مكتبة الكتب.
 *
 * rights = OWNED         : we host the PDF in R2 (we must hold the right to redistribute it)
 * rights = OFFICIAL_LINK : we only link to the official source
 */
import { allRows, firstOrNull, limitOrDefault } from './shared';

export interface BookRow {
  id: string;
  academic_year_id: string | null;
  grade_id: number;
  subject_id: number | null;
  title: string;
  edition: string | null;
  publisher: string | null;
  cover_key: string | null;
  file_id: string | null;
  source_url: string | null;
  rights: 'OWNED' | 'OFFICIAL_LINK';
  pages: number | null;
  size_bytes: number | null;
  status: string;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  subject_name?: string | null;
  subject_emoji?: string | null;
  subject_color?: string | null;
  grade_name?: string;
}

const SELECT = `SELECT b.*, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color, g.name AS grade_name
                  FROM books b
                  LEFT JOIN subjects s ON s.id = b.subject_id
                  JOIN grades g ON g.id = b.grade_id`;

export interface BookFilter {
  gradeId?: number | null;
  subjectId?: number | null;
  query?: string | null;
  limit?: number;
}

export async function listBooks(db: D1Database, filter: BookFilter = {}): Promise<BookRow[]> {
  const where: string[] = ["b.status = 'PUBLISHED'"];
  const bindings: unknown[] = [];
  if (filter.gradeId) {
    where.push(`b.grade_id = ?${bindings.length + 1}`);
    bindings.push(filter.gradeId);
  }
  if (filter.subjectId) {
    where.push(`b.subject_id = ?${bindings.length + 1}`);
    bindings.push(filter.subjectId);
  }
  if (filter.query) {
    where.push(`(b.title LIKE ?${bindings.length + 1} OR COALESCE(b.publisher, '') LIKE ?${bindings.length + 1})`);
    bindings.push(`%${filter.query}%`);
  }
  const limit = limitOrDefault(filter.limit, 100, 200);
  bindings.push(limit);
  return allRows<BookRow>(
    db
      .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY b.grade_id ASC, b.subject_id ASC, b.title ASC LIMIT ?${bindings.length}`)
      .bind(...bindings),
  );
}

export function findBookById(db: D1Database, id: string): Promise<BookRow | null> {
  return firstOrNull<BookRow>(db.prepare(`${SELECT} WHERE b.id = ?1`).bind(id));
}

export function listBooksForSubject(db: D1Database, gradeId: number, subjectId: number): Promise<BookRow[]> {
  return allRows<BookRow>(
    db
      .prepare(`${SELECT} WHERE b.grade_id = ?1 AND b.subject_id = ?2 AND b.status = 'PUBLISHED' ORDER BY b.created_at ASC LIMIT 10`)
      .bind(gradeId, subjectId),
  );
}

export interface InsertBookInput {
  id: string;
  academicYearId: string | null;
  gradeId: number;
  subjectId: number | null;
  title: string;
  edition: string | null;
  publisher: string | null;
  fileId: string | null;
  coverKey: string | null;
  sourceUrl: string | null;
  rights: 'OWNED' | 'OFFICIAL_LINK';
  pages: number | null;
  sizeBytes: number | null;
  uploadedBy: string;
  now: string;
}

export async function insertBook(db: D1Database, input: InsertBookInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO books (id, academic_year_id, grade_id, subject_id, title, edition, publisher, cover_key, file_id,
                          source_url, rights, pages, size_bytes, status, uploaded_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'PUBLISHED', ?14, ?15, ?15)`,
    )
    .bind(
      input.id,
      input.academicYearId,
      input.gradeId,
      input.subjectId,
      input.title,
      input.edition,
      input.publisher,
      input.coverKey,
      input.fileId,
      input.sourceUrl,
      input.rights,
      input.pages,
      input.sizeBytes,
      input.uploadedBy,
      input.now,
    )
    .run();
}

export async function updateBook(
  db: D1Database,
  id: string,
  patch: Partial<Pick<BookRow, 'title' | 'edition' | 'publisher' | 'subject_id' | 'file_id' | 'source_url' | 'rights' | 'pages' | 'size_bytes' | 'status' | 'cover_key'>>,
  now: string,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?${values.length + 1}`);
    values.push(value);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = ?${values.length + 1}`);
  values.push(now);
  values.push(id);
  await db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?${values.length}`).bind(...values).run();
}

export interface BookSourceRow {
  id: string;
  book_id: string;
  label: string;
  url: string;
  kind: string;
  created_at: string;
}

export function listBookSources(db: D1Database, bookId: string): Promise<BookSourceRow[]> {
  return allRows<BookSourceRow>(db.prepare('SELECT * FROM book_sources WHERE book_id = ?1 ORDER BY created_at ASC').bind(bookId));
}

export async function insertBookSource(db: D1Database, input: { id: string; bookId: string; label: string; url: string; kind: string; now: string }): Promise<void> {
  await db
    .prepare('INSERT INTO book_sources (id, book_id, label, url, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(input.id, input.bookId, input.label, input.url, input.kind, input.now)
    .run();
}
