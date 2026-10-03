# تشغيل تنوير — دليل العمليات

هذا الملف موجَّه لمن يدير خادم تنوير (Cloudflare Worker + D1 + R2 + Durable Objects). مكتوب ليُراجَع عند فتح سنة دراسية جديدة، أو عند ترقية، أو عند حادث.

> كل شيء هنا يُنفَّذ **داخل مجلد `server/`**، ولا يحتاج أي تعديل على تطبيق Android.

---

## 1. المتطلبات لمرة واحدة

```bash
cd server
npm ci --legacy-peer-deps          # .npmrc يثبّت legacy-peer-deps أصلًا
npx wrangler login                 # أو CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler d1 create tanweer-db  # انسخ database_id إلى wrangler.jsonc
npx wrangler r2 bucket create tanweer-files
```

ثم الأسرار (لا تُكتب في الملفات ولا في Git إطلاقًا):

```bash
npx wrangler secret put PASSWORD_PEPPER
npx wrangler secret put SESSION_PEPPER
npx wrangler secret put FILE_SIGNING_SECRET
```

استخدم لكل سر قيمة عشوائية طويلة (٣٢ بايت على الأقل). **لا تغيّر `PASSWORD_PEPPER` بعد إطلاق مستخدمين حقيقيين**: تغييره يعني أن كلمات المرور المخزّنة لم تعد صالحة، ويعيد الجميع إلى رمز الاستعادة. `SESSION_PEPPER` يمكن تدويره عند الحاجة (يُسجّل الخروج من كل الأجهزة). `FILE_SIGNING_SECRET` تدويره يبطل فقط روابط الرفع/التحميل المؤقتة الحالية.

ثم الترحيلات والنشر:

```bash
npm run db:migrate:remote   # تطبيق 0001 … أحدث ترحيل
npm run deploy              # wrangler deploy
curl https://tanweer.magd.workers.dev/health
```

## 2. ما يجب أن يكون صحيحًا في `wrangler.jsonc`

| المفتاح | القيمة | لماذا |
| --- | --- | --- |
| `name` | `tanweer` | نطاق المشروع `tanweer.magd.workers.dev` |
| `compatibility_date` | `2026-08-01` | مدعوم من بيئة الاختبار؛ لا ترفعه دون تجربة `npm test` |
| `d1_databases[0].database_id` | معرّف حقيقي | القيمة `0000…` مكانٌ مؤقت وتمنع `db:migrate:remote` |
| `r2_buckets[0].bucket_name` | `tanweer-files` | الملفات لا تمر عبر D1 ولا عبر الذاكرة |
| `migrations[0]` | `new_sqlite_classes: ["GroupChatDO"]` | دردشة SQLite داخل Durable Object |
| `triggers.crons` | `["0 3 * * *"]` | تنظيف دوري للملفات والصور المنتهية من R2 |
| `vars` | كما هي | `ALLOWED_ORIGINS` يجب أن يضيق من `*` عند إطلاق التطبيق |

## 3. نبض النظام

- **الصحة**: `GET /health` يعيد حالة D1 وعدد الجداول؛ إن فشل فهو أول ما يُفحص.
- **السجلات**: Cloudflare Dashboard → Workers → tanweer → Logs. كل خطأ غير متوقّع يُسجَّل مع `requestId`، فأبلغ به المستخدم عند الشكوى.
- **الحدود المجانية**: Workers ١٠٠٬٠٠٠ طلب/يوم و١٠ms CPU؛ D1 ٥M قراءة + ١٠٠k كتابة/يوم؛ R2 ١٠GB/شهر. الرموز والصور والملفات لا تمر عبر Worker: الرفع والتحميل مباشرة إلى/من R2 عبر روابط موقّتة. راقب العدّاد في اللوحة قبل فتح المدرسة على كل الصفوف.
- **التخزين**: راقب حجم الدلو من لوحة R2، أو استعرض المفاتيح بـ `npx wrangler r2 object list tanweer-files --prefix tanweer/`.

## 4. فتح سنة دراسية جديدة (المهمة السنوية)

غرفة العمليات: إضافة السنة، ثم مجموعات صفوفها، ثم نسخة جدول فارغة لكل مجموعة. **لا تُحذف سنة سابقة أبدًا — تُؤرشف.** المحتوى القديم يبقى مرتبطًا بسنة `ay_2026_2027` ومجموعاتها، والمجموعات الجديدة تحمل معرّفات السنة الجديدة حتى لا يختلط محتوى العامين.

الطريقة الموصى بها: ملف ترحيل جديد `0010_ay_2027_2028.sql` داخل `server/src/db/migrations/`، انسخ فيه كتل `INSERT OR IGNORE` من الترحيل `0009_seed_school_structure.sql` مع تغيير المعرّفات، ثم:

```bash
cd server
npm run db:migrate:remote
```

محتوى الملف الجديد بالترتيب:

1. **السنة الجديدة**:
   ```sql
   INSERT OR IGNORE INTO academic_years (id,title,start_date,end_date,status,created_at,updated_at) VALUES
     ('ay_2027_2028','2027 / 2028','2027-08-29','2028-06-23','ACTIVE','2027-08-29T00:00:00.000Z','2027-08-29T00:00:00.000Z');
   UPDATE academic_years SET status='ARCHIVED', updated_at='2027-08-29T00:00:00.000Z' WHERE id='ay_2026_2027';
   ```
2. **مجموعات الصفوف** — لا تُعد المعرّفات القديمة، بل أنشئ نظيراتها للسنة الجديدة، ثم أرشف القديمة:
   ```sql
   INSERT OR IGNORE INTO groups (id,academic_year_id,kind,name,description,subject_id,emoji,
                                 visibility,join_policy,member_count,status,created_by,created_at,updated_at)
   SELECT 'grp_class_2027_' || s.grade_id || '-' || s.code, 'ay_2027_2028', 'CLASS',
          g.name || ' — ' || s.label, 'المجموعة الدراسية الأساسية لشعبة ' || g.name || ' ' || s.label,
          NULL, '🏫', 'PRIVATE', 'AUTO', 0, 'ACTIVE', NULL,
          '2027-08-29T00:00:00.000Z', '2027-08-29T00:00:00.000Z'
   FROM sections s JOIN grades g ON g.id = s.grade_id;

   UPDATE groups SET status='ARCHIVED', updated_at='2027-08-29T00:00:00.000Z' WHERE id LIKE 'grp_class_%';
   ```
   (نفّذ التحديث الأخير **بعد** الإدراج، وبقيد `academic_year_id='ay_2026_2027'` إن أردت الاحتفاظ بالقديمة صراحةً: `WHERE academic_year_id = 'ay_2026_2027'`.)
3. **ربط الشعب** `group_sections`، وغرف الدردشة `chat_rooms` (نفس نمط 0009 مع المعرّف الجديد).
4. **الحصص (الجدول)** تبدأ فارغة تمامًا — لا تنسخ جدول العام الماضي ولا تضع حصصًا وهمية:
   ```sql
   INSERT OR IGNORE INTO schedule_versions (id,group_id,title,effective_from,effective_to,status,notes,created_by,created_at,updated_at)
   SELECT 'schv_class_2027_' || s.grade_id || '-' || s.code,
          'grp_class_2027_' || s.grade_id || '-' || s.code,
          'الجدول الحالي', '2027-08-29', NULL, 'ACTIVE',
          'يبدأ الجدول فارغًا ويتم تعبئته من المجتمع.', NULL,
          '2027-08-29T00:00:00.000Z', '2027-08-29T00:00:00.000Z'
   FROM sections s;
   ```
5. **أيام الإجازات الرسمية** في `holidays` (وإلا حَسِب التطبيق «غدًا» يومًا دراسيًا خاطئًا):
   ```sql
   INSERT OR IGNORE INTO holidays (id,academic_year_id,group_id,date,end_date,title,kind,created_by,created_at) VALUES
     ('hol_2027_09_23','ay_2027_2028',NULL,'2027-09-23',NULL,'اليوم الوطني','HOLIDAY',NULL,'2027-08-29T00:00:00.000Z');
   ```
6. **لا تنشئ مستخدمين ولا محتوى تجريبيًا.** التطبيق يُسلَّم فارغًا ليدخل الطلاب وحدهم (سياسة صريحة: لا قوالب وهمية ولا روبوتات). أول حساب يظهر هو حساب حقيقي يسجّل نفسه من التطبيق.

بعد الترحيل: `curl https://tanweer.magd.workers.dev/health`، ثم تحقق من `GET /api/v1/class-group?gradeId=10&sectionCode=A` بحساب حقيقي أنه يعيد المجموعة الجديدة.

## 5. الجدول الأسبوعي ومقترحات التعديل

- الجدول يُبنى من نسخ (`schedule_versions`)؛ كل نسخة تحمل حصصًا لكل يوم (`schedule_slots`).
- تغيير حصة **لا يُطبَّق تلقائيًا**: ينشئ الطالب مقترحًا (`schedule_proposals`) ويصوّت الأعضاء حتى بلوغ عتبة الربع، وحينها فقط يُحدَّث الجدول.
- عند تغيير الجدول الرسمي من إدارة المدرسة: أنشئ نسخة جديدة بتاريخ بدء سريان، ولا تعدّل النسخة القديمة، حتى لا تتغيّر أيام قديمة وثّقها الطلاب بالفعل.

## 6. النسخ الاحتياطي واستعادة البيانات

- **D1**: لوحة Cloudflare → D1 → tanweer-db → Backups (متاحة تلقائيًا)؛ وقبل أي ترحيل كبير صدّر نسخة:
  ```bash
  npx wrangler d1 export tanweer-db --remote --output backup-$(date +%F).sql
  ```
- **R2**: الملفات الأصلية للمستخدمين. لا تحذف مفاتيح `tanweer/…` يدويًا؛ الحذف يمر عبر حالة الملف (`DELETED` + التنظيف الدوري) حتى تبقى السجلات متسقة.
- **الاستعادة الكاملة**: `wrangler d1 execute ... --file backup.sql` على قاعدة جديدة، ثم اربطها في `wrangler.jsonc`.
- **قبل كل نشر**: `npm run typecheck && npm test` يجب أن ينجحا.

## 7. الحوادث الشائعة

| العرض | السبب المرجَّح | العلاج |
| --- | --- | --- |
| كل الطلبات `VALIDATION_ERROR` مع رسالة عربية | تغيير حقل في تطبيق قديم | راجع `.d.ts` في العقد ثم أصلح الخادم أو التطبيق؛ لا ترخي التحقق |
| الجميع يشتكي من «الرابط غير صالح» عند الرفع | تغيّر `FILE_SIGNING_SECRET` أو انتهت ساعة الرابط | أعد المحاولة من التطبيق؛ الروابط صالحة ساعة واحدة |
| الدردشة تتوقف فجأة | Durable Object معاد تشغيله | التطبيق يعيد الاتصال تلقائيًا (`/ws` + `since`)، ولا يحتاج تدخلًا |
| `429` متكرر | حدود المعدل لكل IP/مستخدم | راجع `src/middleware/rateLimit.ts`؛ لا تُعطّل الحدود، ارفعها بحذر |
| D1 كتابة يومية تقترب من السقف | نشاط غير طبيعي أو حلقة إشعارات | راجع جدول `notifications` و`audit_log`، واستخدم التجميع (`batchKey`) |
| ظهور بيانات سنة قديمة في «اليوم» | مجموعة مرتبطة بسنة مؤرشفة | حدّث `groups.academic_year_id` للمجموعة النشطة |

## 8. الخصوصية والأمان عند التشغيل

- لا تضع بيانات الطلاب (أرقام الهواتف، الصور) في سجلات خارجية أو في محادثات الدعم؛ استخدم `requestId` فقط.
- الأسرار في Cloudflare Secrets أو GitHub Secrets فقط. لا في الكود، ولا في ملفات `.env` المرفوعة، ولا في لقطات الشاشة.
- عند تسريب سر: دوّر السر فورًا، ثم أعلن أن على الجميع إعادة تسجيل الدخول (تغيير `SESSION_PEPPER` يفعل ذلك).
- طلبات الإزالة تحتاج إجماع الأعضاء، ويمكن للمشرف تعليق محتوى مسيء فورًا عبر طلب إزالة مع إشعار عالي الأولوية؛ التوثيق الكامل في `docs/GOVERNANCE.md`.
