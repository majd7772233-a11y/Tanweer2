-- ═══════════════════════════════════════════════════════════════════════════
-- Tanweer · 0009_seed_school_structure
--
-- This file contains school structure only: grades, sections, subjects, the
-- current academic year, one class group per section and an EMPTY timetable
-- version per group.
--
-- It deliberately contains no demo users, no demo posts, no bots and no fake
-- lessons. The app ships clean and waits for real people (§ "ممنوع إضافة
-- قوالب وهمية").
--
-- To open a new school year later, see docs/OPERATIONS.md (add the year, its
-- groups and its timetable versions).
-- ═══════════════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO academic_years (id, title, start_date, end_date, status, created_at, updated_at) VALUES
  ('ay_2026_2027', '2026 / 2027', '2026-08-30', '2027-06-24', 'ACTIVE', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

-- ── grades ──────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO grades (id, name, stage, order_index) VALUES
  (7,  'سابع',        'PREPARATORY', 1),
  (8,  'ثامن',        'PREPARATORY', 2),
  (9,  'تاسع',        'PREPARATORY', 3),
  (10, 'أول ثانوي',   'SECONDARY',   4),
  (11, 'ثاني ثانوي',  'SECONDARY',   5),
  (12, 'ثالث ثانوي',  'SECONDARY',   6);

-- ── sections ────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO sections (id, grade_id, code, label, order_index) VALUES
  (1,  7,  'A', 'أ', 1),
  (2,  8,  'A', 'أ', 1),
  (3,  8,  'B', 'ب', 2),
  (4,  9,  'A', 'أ', 1),
  (5,  9,  'B', 'ب', 2),
  (6,  10, 'A', 'أ', 1),
  (7,  10, 'B', 'ب', 2),
  (8,  10, 'C', 'ج', 3),
  (9,  10, 'D', 'د', 4),
  (10, 11, 'A', 'أ', 1),
  (11, 11, 'B', 'ب', 2),
  (12, 11, 'C', 'ج', 3),
  (13, 11, 'D', 'د', 4),
  (14, 12, 'A', 'أ', 1),
  (15, 12, 'B', 'ب', 2),
  (16, 12, 'C', 'ج', 3);

-- ── subjects ────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO subjects (id, name, short_name, emoji, color, order_index) VALUES
  (1,  'القرآن الكريم',     'قرآن',      '📖', 'amber',  1),
  (2,  'التربية الإسلامية', 'إسلامية',   '🕌', 'amber',  2),
  (3,  'اللغة العربية',     'عربي',      '📚', 'cyan',   3),
  (4,  'اللغة الإنجليزية',  'إنجليزي',   '🇬🇧', 'blue',   4),
  (5,  'الرياضيات',         'رياضيات',   '📐', 'cyan',   5),
  (6,  'الفيزياء',          'فيزياء',    '⚡', 'violet', 6),
  (7,  'الكيمياء',          'كيمياء',    '🧪', 'green',  7),
  (8,  'الأحياء',           'أحياء',     '🧬', 'green',  8),
  (9,  'العلوم',            'علوم',      '🔬', 'green',  9),
  (10, 'التاريخ',           'تاريخ',     '🏛️', 'amber',  10),
  (11, 'الجغرافيا',         'جغرافيا',   '🗺️', 'blue',   11),
  (12, 'الاجتماعيات',       'اجتماعيات', '🌍', 'blue',   12),
  (13, 'الحاسوب',           'حاسوب',     '💻', 'violet', 13),
  (14, 'التربية الفنية',    'فنية',      '🎨', 'rose',   14),
  (15, 'التربية الرياضية',  'رياضية',    '⚽', 'green',  15),
  (16, 'المهارات الحياتية', 'مهارات',    '🌱', 'green',  16),
  (17, 'اللغة الفرنسية',    'فرنسي',     '🇫🇷', 'blue',   17);

-- Preparatory stage (سابع → تاسع)
INSERT OR IGNORE INTO subject_grades (subject_id, grade_id)
SELECT s.id, g.id FROM subjects s CROSS JOIN grades g
WHERE g.id IN (7, 8, 9)
  AND s.id IN (1, 2, 3, 4, 5, 9, 12, 13, 14, 15, 16);

-- Secondary stage (أول → ثالث ثانوي)
INSERT OR IGNORE INTO subject_grades (subject_id, grade_id)
SELECT s.id, g.id FROM subjects s CROSS JOIN grades g
WHERE g.id IN (10, 11, 12)
  AND s.id IN (1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 16);

INSERT OR IGNORE INTO subject_grades (subject_id, grade_id)
SELECT 17, g.id FROM grades g WHERE g.id IN (10, 11);

-- ── one class group per section ─────────────────────────────────────────────
INSERT OR IGNORE INTO groups (id, academic_year_id, kind, name, description, subject_id, emoji,
                             visibility, join_policy, member_count, status, created_by,
                             created_at, updated_at)
SELECT 'grp_class_' || s.grade_id || '-' || s.code,
       'ay_2026_2027',
       'CLASS',
       g.name || ' — ' || s.label,
       'المجموعة الدراسية الأساسية لشعبة ' || g.name || ' ' || s.label,
       NULL,
       '🏫',
       'PRIVATE',
       'AUTO',
       0,
       'ACTIVE',
       NULL,
       '2026-08-30T00:00:00.000Z',
       '2026-08-30T00:00:00.000Z'
FROM sections s JOIN grades g ON g.id = s.grade_id;

INSERT OR IGNORE INTO group_sections (group_id, grade_id, section_id)
SELECT 'grp_class_' || s.grade_id || '-' || s.code, s.grade_id, s.id FROM sections s;

-- ── a conversation room for every class group ───────────────────────────────
INSERT OR IGNORE INTO chat_rooms (id, group_id, kind, title, created_at)
SELECT 'chat_grp_class_' || s.grade_id || '-' || s.code,
       'grp_class_' || s.grade_id || '-' || s.code,
       'GROUP',
       g.name || ' — ' || s.label,
       '2026-08-30T00:00:00.000Z'
FROM sections s JOIN grades g ON g.id = s.grade_id;

-- ── timetable version 1 · starts empty and is filled by the students ────────
-- Filling an empty period is a direct edit. Replacing a period that already
-- has a subject needs a proposal + group vote (§29).
INSERT OR IGNORE INTO schedule_versions (id, group_id, title, effective_from, effective_to,
                                        status, notes, created_by, created_at, updated_at)
SELECT 'schv_class_' || s.grade_id || '-' || s.code,
       'grp_class_' || s.grade_id || '-' || s.code,
       'الجدول الحالي',
       '2026-08-30',
       NULL,
       'ACTIVE',
       'يبدأ الجدول فارغًا ويتم تعبئته من المجتمع.',
       NULL,
       '2026-08-30T00:00:00.000Z',
       '2026-08-30T00:00:00.000Z'
FROM sections s;
