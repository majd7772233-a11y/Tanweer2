# معمارية تنوير

تنوير: تطبيق أندرويد للدراسة الجماعية + خادم Cloudflare. هذا الملف يشرح كيف يتحرك الطلب داخل الخادم، وأين يعيش كل نوع من البيانات، ولماذا اختير كل قرار.

---

## 1. القاعدة الحاكمة

> كل يوم له محتواه، وكل مادة لها مكان، ولا يضيع درس.

لذلك كل معلومة رسمية **محتوى منظَّم** مربوط بسلسلة: **السنة الدراسية → المجموعة → التاريخ → الحصة → المادة → المحتوى**، والدردشة لا تحمل معلومة رسمية أبدًا.

## 2. طبقات الخادم

```
طلب HTTP
  └─ src/index.ts            CORS · /ws · /api/v1 · صفحة ترحيب · cron
       └─ src/router.ts      جدول المسارات + سلسلة middleware
            └─ src/services/*         قواعد العمل (20 خدمة)
                 ├─ src/db/queries/*  استعلامات D1 (17 وحدة)
                 ├─ src/storage/r2.ts الملفات (رفع/تحميل مباشر)
                 └─ src/realtime/*    Durable Object للدردشة الحيّة
```

| الطبقة | المكان | القاعدة |
| --- | --- | --- |
| الدخول | `src/index.ts` | لا منطق عمل هنا؛ CORS ثم `createCtx` ثم الموجّه |
| الموجّه | `src/router.ts` | كل مسار يعرف وسائطه: `auth`، `write`، `rateLimit`، `idempotent` |
| الخدمات | `src/services/` | القواعد والتحقق والصلاحيات والإشعارات |
| الاستعلامات | `src/db/queries/` | SQL فقط، بلا قواعد عمل، تُستدعى بـ `firstOrNull` / `allRows` |
| الملفات | `src/storage/r2.ts` | بايتات فقط، ولا تُخزَّن مسارات الملفات في جدول المحتوى بل معرّفات |
| الدردشة | `src/realtime/GroupChatDO.ts` | ترتيب الرسائل + البث + حلقة آخر ٢٠٠ رسالة |

## 3. أماكن البيانات

- **D1 (TANWEER_DB)** — كل ما يمكن الاستعلام عنه: السنوات، الصفوف، الشعب، المواد، المجموعات، الجداول، المحتوى، الواجبات، الاختبارات، الفعاليات، الاستفسارات، التصويتات، الإشعارات، الجلسات، التدقيق.
- **R2 (TANWEER_FILES)** — الصور والـPDF والمرفقات. المفتاح `tanweer/<purpose>/<owner>/<fileId>.<ext>`.
- **Durable Object (GROUP_CHAT)** — ترتيب الرسائل الحيّ، الحضور، حلقة الرسائل الأخيرة؛ سجلّ الدردشة الدائم في D1 جدول `chat_messages` مرتّبًا بـ`seq`.

السنة الدراسية سلسلة حقيقية: `groups.academic_year_id`, `content.academic_year_id`, `homeworks.academic_year_id` … وحين تُؤرشف سنة **لا يُحذف منها شيء**.

## 4. دورة حياة المحتوى

```
إنشاء (POST /content)
  ├─ duplicate؟ بصمة (checksum) + نفس المجموعة + نفس اليوم  → تُضاف كمساهمة للبطاقة القائمة
  ├─ موجود عنوان مشابه؟                                   → اقتراح دمج (لا يُدمج تلقائيًا أبدًا)
  └─ غير ذلك                                              → بطاقة جديدة + مراجعة 1 CREATED

تعديل المؤلف        → PATCH  (مراجعة جديدة)
تعديل غيره          → طلب تصحيح + تصويت أغلبية        → مراجعة 9998 CORRECTED_BY_COMMUNITY
إزالة               → طلب إزالة  + تصويت إجماعي        → مراجعة 9999 DELETED_BY_COMMUNITY + purge_after
دمج بتأكيد صريح     → canonical_id + علاقة DUPLICATE + أرشفة المصدر
```

حالات المحتوى: `DRAFT` · `PUBLISHED` · `EDITED` · `PENDING_CORRECTION` · `PENDING_DELETION` · `DELETED` · `ARCHIVED`.

## 5. الملفات: لا تمر عبر الخادم

```
POST /files/upload-intent   → صف في files + رابط موقّع (HMAC + انتهاء ساعة)
PUT  /files/upload/:id?…    → تمرير تدفّق الطلب إلى R2 مباشرة (لا تحميل في الذاكرة)
POST /files/complete        → width/height/checksum → الحالة READY
GET  /files/:id/content     → بموقّع أو بعضوية المجموعة، ويدعم Range
cron 0 3 * * *              → حذف ما تجاوز purge_after من R2
```

لا تُرسل البايتات إلى Worker لتُحفظ، ولا تُقرأ كاملة في الذاكرة. هذا ما يبقي الاستخدام داخل الحد المجاني (R2 مجانًا 10GB/شهر، Workers 100k طلب/يوم).

## 6. الدردشة الحيّة

```
Android ──wss──► /ws?token=…  ──► src/realtime/entry.ts
                                   ├─ يتحقق من الوصول + الجلسة + الجهاز + المستخدم
                                   ├─ يحدد الغرفة: groupId أو with=… (DM)
                                   └─ يمرّر الاتصال إلى GroupChatDO
                                         ├─ /ingest  (رقم تسلسلي + بث)
                                         ├─ /typing · /presence · /history · /health
                                         └─ بث: message · presence · typing · read · ready · error
```

إرسال الرسالة: الخدمة تُنشئ صفًا في D1 (`chat_messages`) برقم التسلسل الذي يمنحه الـDO، ثم تُحدَّث حالة القراءة. الرقم التسلسلي هو مرجع المزامنة عند انقطاع الشبكة (`?since=`).

## 7. وسائط الطلب

| الوسيط | ما يفعله |
| --- | --- |
| `auth` / `optionalAuth` | رمز الوصول → الجلسة → الجهاز، وتحديث `last_seen` بحد أدنى ٥ دقائق |
| `rateLimit` | عدّاد في D1 بمفتاح (نطاق/مستخدم/IP) ويرد `429` مع `retryAfterSeconds` |
| `idempotent` | ترويسة `x-client-upload-id`: إعادة الطلب خلال ٢٤ ساعة تعيد نفس الاستجابة |
| `permissions` | `requireMembership` · `requireModerator` · `requireVoteRight` + نطاق الشعبة |

## 8. حدود Cloudflare المجانية — كيف نبقى داخلها

- **ترقيم دائم**: كل قائمة تأخذ `limit` بحد أقصى ١٠٠ (افتراضي ٣٠–٦٠)، والصفحة التالية بمؤشر (`cursor`/`since`) لا بـ`OFFSET`.
- **عدّادات مخزَّنة** بدل `COUNT(*)` المتكرر: `media_count`, `contribution_count`, `comment_count`, `useful_count`, `member_count`, `completion_count`.
- **لا تفريع للإشعارات**: صف لكل مستخدم مستهدف فقط، مع `batchKey` لتجميع («٥ تحديثات جديدة»).
- **حلقة ٢٠٠ رسالة** داخل الـDO بدل إعادة قراءة السجل كاملًا.
- **الملفات مباشرة إلى R2** عبر روابط موقّعة، والتنظيف في cron واحد.
- **كاش الاستجابة**: `cache-control` خاص على الملفات، و`etag` للأجسام الثابتة.

## 9. العقد مع تطبيق أندرويد

- القاعدة: `https://tanweer.magd.workers.dev` — كل المسارات تحت `/api/v1/`.
- كل استجابة ناجحة: `{ "success": true, "data": …, "meta"?: … }`.
- كل خطأ: `{ "success": false, "error": { "code": "…", "message": "…", "fields"?: {…} } }` مع رمز HTTP مناسب.
- التوقيت UTC بصيغة ISO-8601، والتواريخ الدراسية `'YYYY-MM-DD'` بتوقيت `Asia/Aden`.
- الترتيب: اليوم → التقويم → الواجبات → أكثر (اختبارات، Issues، المكتبة)، والدردشة ثانوية عبر زر عائم.

تفاصيل الأمان في `docs/SECURITY.md`، وقواعد المجتمع في `docs/GOVERNANCE.md`، والتشغيل في `docs/OPERATIONS.md`.
